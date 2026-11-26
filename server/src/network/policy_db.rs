//! SQL for versioned policy rows, explicit desired assignment and worker read.
//!
//! Every statement is bound to the household from the URL path or from the
//! authenticated credential's own scope. No statement writes applied/enforced
//! state and none touches agent tokens, modules, grants or Recall. Mutating
//! callers take the household lock first and keep the same h -> g -> c order
//! used by the gateway slice.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::policy_dto::{DesiredPolicy, PolicyVersionMeta};

/// Highest revision in this household (0 when it has no policy yet). Called
/// inside the household-locked transaction so allocation is monotonic.
pub async fn current_revision_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(revision) FROM network_policies WHERE household_id = $1",
    )
    .bind(household_id)
    .fetch_one(conn)
    .await
    .map(|v| v.unwrap_or(0))
}

pub async fn policy_exists_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    revision: i64,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_policies WHERE household_id = $1 AND revision = $2)",
    )
    .bind(household_id)
    .bind(revision)
    .fetch_one(conn)
    .await
}

/// Exact stored bytes plus their metadata. The worker response is built from
/// these bytes; nothing is re-signed or re-timestamped on read.
pub async fn policy_body_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    revision: i64,
) -> sqlx::Result<Option<(Vec<u8>, i32, DateTime<Utc>, String)>> {
    let row: Option<(Vec<u8>, i32, DateTime<Utc>, String)> = sqlx::query_as(
        r"
        SELECT body, schema_version, published_at, body_sha256
        FROM network_policies
        WHERE household_id = $1 AND revision = $2
        ",
    )
    .bind(household_id)
    .bind(revision)
    .fetch_optional(conn)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_policy(
    conn: &mut PgConnection,
    household_id: Uuid,
    revision: i64,
    schema_version: i32,
    body: &[u8],
    body_sha256: &str,
    source_kind: &str,
    rolled_back_from_revision: Option<i64>,
    published_at: DateTime<Utc>,
    published_by: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_policies
            (household_id, revision, schema_version, body, body_sha256,
             source_kind, rolled_back_from_revision, published_at, published_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ",
    )
    .bind(household_id)
    .bind(revision)
    .bind(schema_version)
    .bind(body)
    .bind(body_sha256)
    .bind(source_kind)
    .bind(rolled_back_from_revision)
    .bind(published_at)
    .bind(published_by)
    .execute(conn)
    .await?;
    Ok(())
}

/// Bound history: keep the newest `max_history` revisions plus every pinned
/// row (desired assignment, current head, or rollback source). Runs inside the
/// same locked transaction as the insert, so a concurrent publish cannot prune
/// a row that another assignment just pinned.
pub async fn prune_history_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    max_history: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        DELETE FROM network_policies p
        WHERE p.household_id = $1
          AND p.revision NOT IN (
              SELECT revision FROM network_policies
              WHERE household_id = $1 ORDER BY revision DESC LIMIT $2
          )
          AND p.revision NOT IN (
              SELECT revision FROM network_gateway_desired_policy WHERE household_id = $1
          )
          AND p.revision NOT IN (
              SELECT DISTINCT rolled_back_from_revision FROM network_policies
              WHERE household_id = $1 AND rolled_back_from_revision IS NOT NULL
          )
          AND p.revision <> (
              SELECT MAX(revision) FROM network_policies WHERE household_id = $1
          )
        ",
    )
    .bind(household_id)
    .bind(max_history)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn list_versions(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<PolicyVersionMeta>> {
    sqlx::query_as::<_, PolicyVersionMeta>(
        r"
        SELECT household_id, revision, schema_version, source_kind,
               rolled_back_from_revision, published_at, published_by,
               body_sha256, octet_length(body)::bigint AS body_bytes
        FROM network_policies
        WHERE household_id = $1
        ORDER BY revision DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Explicit desired assignment ────────────────────────────────────────────

pub async fn get_desired_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<DesiredPolicy>> {
    sqlx::query_as::<_, DesiredPolicy>(
        r"
        SELECT household_id, gateway_id, kind, revision, assigned_by, assigned_at
        FROM network_gateway_desired_policy
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await
}

pub async fn get_desired(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<DesiredPolicy>> {
    let mut conn = pool.acquire().await?;
    get_desired_on_conn(&mut conn, household_id, gateway_id).await
}

pub async fn upsert_desired(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    kind: &str,
    revision: i64,
    assigned_by: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_gateway_desired_policy
            (household_id, gateway_id, kind, revision, assigned_by, assigned_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (household_id, gateway_id) DO UPDATE
        SET kind = EXCLUDED.kind,
            revision = EXCLUDED.revision,
            assigned_by = EXCLUDED.assigned_by,
            assigned_at = NOW()
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(kind)
    .bind(revision)
    .bind(assigned_by)
    .execute(conn)
    .await?;
    Ok(())
}
