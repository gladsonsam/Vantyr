//! SQL for the bounded network management read contracts.
//!
//! Every statement is household-scoped or, for self-service discovery, bound to
//! the authenticated user id passed in by the handler. Page and count use the
//! SAME predicate builder inside ONE repeatable-read transaction, so a
//! concurrent insert cannot make `total` contradict `rows`. No statement here
//! writes anything and none falls back to a global/other-tenant table.

use sqlx::{PgPool, Postgres, QueryBuilder};
use uuid::Uuid;

use super::dto::NetworkAudit;
use super::read_dto::{
    AuditFilters, AuditPage, EnrollmentContext, EnrollmentContextPage, StoredPolicyRow,
};

/// Exact immutable policy row, or the newest saved revision when `revision` is
/// `None`. "Current" means the highest SAVED revision — never a desired
/// assignment, an applied state or a verified receipt (none of which exists).
pub async fn policy_row(
    pool: &PgPool,
    household_id: Uuid,
    revision: Option<i64>,
) -> sqlx::Result<Option<StoredPolicyRow>> {
    let mut qb = QueryBuilder::new(
        "SELECT household_id, revision, schema_version, source_kind, \
         rolled_back_from_revision, published_at, published_by, body_sha256, body \
         FROM network_policies WHERE household_id = ",
    );
    qb.push_bind(household_id);
    match revision {
        Some(rev) => {
            qb.push(" AND revision = ").push_bind(rev);
        }
        None => {
            qb.push(" ORDER BY revision DESC LIMIT 1");
        }
    }
    qb.build_query_as::<StoredPolicyRow>()
        .fetch_optional(pool)
        .await
}

fn push_audit_predicates(
    qb: &mut QueryBuilder<Postgres>,
    household_id: Uuid,
    filters: &AuditFilters,
) {
    qb.push(" WHERE household_id = ").push_bind(household_id);
    if let Some(action) = &filters.action {
        qb.push(" AND action = ").push_bind(action.clone());
    }
    if let Some(actor) = &filters.actor {
        qb.push(" AND actor = ").push_bind(actor.clone());
    }
    if let Some(from) = filters.from {
        qb.push(" AND ts >= ").push_bind(from);
    }
    if let Some(to) = filters.to {
        qb.push(" AND ts <= ").push_bind(to);
    }
}

/// Household-scoped audit page with a count that uses the identical tenant and
/// filter predicates, read under one fixed snapshot in `REPEATABLE READ`.
pub async fn audit_page(
    pool: &PgPool,
    household_id: Uuid,
    filters: &AuditFilters,
) -> sqlx::Result<AuditPage> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;

    let mut count = QueryBuilder::new("SELECT COUNT(*)::bigint FROM network_audit");
    push_audit_predicates(&mut count, household_id, filters);
    let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;

    let mut rows = QueryBuilder::new(
        "SELECT id, ts, household_id, actor, client_ip, action, status, detail FROM network_audit",
    );
    push_audit_predicates(&mut rows, household_id, filters);
    rows.push(" ORDER BY ts DESC, id DESC LIMIT ")
        .push_bind(filters.limit)
        .push(" OFFSET ")
        .push_bind(filters.offset);
    let rows = rows
        .build_query_as::<NetworkAudit>()
        .fetch_all(&mut *tx)
        .await?;

    tx.commit().await?;
    let has_more = filters.offset.saturating_add(rows.len() as i64) < total;
    let next_offset = has_more.then(|| filters.offset.saturating_add(rows.len() as i64));
    Ok(AuditPage {
        rows,
        total,
        has_more,
        next_offset,
    })
}

const CONTEXT_FROM: &str = " FROM network_grants g \
    JOIN network_principal_bindings b \
      ON b.household_id = g.household_id AND b.dashboard_user = g.user_id \
    JOIN network_households h ON h.id = b.household_id \
    JOIN network_persons p ON p.id = b.person_id AND p.household_id = b.household_id";

fn push_context_predicates(qb: &mut QueryBuilder<Postgres>, user_id: Uuid) {
    qb.push(" WHERE g.user_id = ")
        .push_bind(user_id)
        // Exact grant name: network_admin / network_events never contribute.
        .push(" AND g.grant_name = 'network_enroll'")
        .push(" AND b.active AND b.revoked_at IS NULL");
}

/// Self-service discovery for the CALLER's bindings only. The join requires
/// both an explicit `network_enroll` grant and an active admin-created binding
/// in the same household; revoking either removes the context immediately.
/// No device, other person, grant list, inventory or secret is selected.
pub async fn enrollment_contexts_page(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<EnrollmentContextPage> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;

    let mut count = QueryBuilder::new("SELECT COUNT(*)::bigint");
    count.push(CONTEXT_FROM);
    push_context_predicates(&mut count, user_id);
    let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;

    let mut rows = QueryBuilder::new(
        "SELECT b.id AS binding_id, b.household_id, h.name AS household_name, \
         b.person_id, p.display_name AS person_display_name, b.generation",
    );
    rows.push(CONTEXT_FROM);
    push_context_predicates(&mut rows, user_id);
    rows.push(" ORDER BY b.household_id, b.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let contexts = rows
        .build_query_as::<EnrollmentContext>()
        .fetch_all(&mut *tx)
        .await?;

    tx.commit().await?;
    let has_more = offset.saturating_add(contexts.len() as i64) < total;
    let next_offset = has_more.then(|| offset.saturating_add(contexts.len() as i64));
    Ok(EnrollmentContextPage {
        count: contexts.len(),
        contexts,
        total,
        has_more,
        next_offset,
    })
}
