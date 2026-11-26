//! SQL for the Vantyr Network inventory. Every read and write is scoped by
//! `household_id`; none of these functions decide who may call them (see `authz`).
//!
//! Queries use the runtime `sqlx::query*` API on purpose: this slice adds no
//! `query!` macros, so no offline cache regeneration or dependency changes are
//! needed. Row mapping goes through typed `FromRow` DTOs.

use sqlx::{PgConnection, PgPool, QueryBuilder};
use uuid::Uuid;

use crate::network::authz::NetworkGrant;
use crate::network::dto::{
    AgentEnrollment, Assignment, Connection, Device, Grant, Household, Person,
};

// ─── Households / bootstrap ──────────────────────────────────────────────────

pub async fn count_default_households(conn: &mut PgConnection) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_households WHERE is_default")
        .fetch_one(conn)
        .await
}

pub async fn insert_default_household(
    conn: &mut PgConnection,
    name: &str,
    created_by: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_households (name, is_default, created_by)
        VALUES ($1, true, $2)
        RETURNING id
        ",
    )
    .bind(name)
    .bind(created_by)
    .fetch_one(conn)
    .await
}

pub async fn insert_household(pool: &PgPool, name: &str, created_by: Uuid) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO network_households (name, is_default, created_by) VALUES ($1, false, $2) RETURNING id",
    )
    .bind(name)
    .bind(created_by)
    .fetch_one(pool)
    .await
}

pub async fn list_admin_households(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Household>> {
    sqlx::query_as::<_, Household>(
        r"
        SELECT h.id, h.name, h.is_default, h.created_at
        FROM network_households h
        JOIN network_grants g ON g.household_id = h.id
        WHERE g.user_id = $1 AND g.grant_name = 'network_admin'
        ORDER BY h.created_at, h.id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Grants ──────────────────────────────────────────────────────────────────

pub async fn dashboard_user_exists(pool: &PgPool, user_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM dashboard_users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(pool)
        .await
}

pub async fn insert_grant_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
    grant: NetworkGrant,
    granted_by: Uuid,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_grants (household_id, user_id, grant_name, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (household_id, user_id, grant_name) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(user_id)
    .bind(grant.as_str())
    .bind(granted_by)
    .execute(conn)
    .await?;
    Ok(())
}

/// Returns `false` when the grant already existed (idempotent grant).
pub async fn insert_grant(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    grant: NetworkGrant,
    granted_by: Uuid,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        INSERT INTO network_grants (household_id, user_id, grant_name, granted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (household_id, user_id, grant_name) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(user_id)
    .bind(grant.as_str())
    .bind(granted_by)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn delete_grant(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    grant: NetworkGrant,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "DELETE FROM network_grants WHERE household_id = $1 AND user_id = $2 AND grant_name = $3",
    )
    .bind(household_id)
    .bind(user_id)
    .bind(grant.as_str())
    .execute(pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn list_grants(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Grant>> {
    sqlx::query_as::<_, Grant>(
        r"
        SELECT household_id, user_id, grant_name, granted_at
        FROM network_grants
        WHERE household_id = $1
        ORDER BY grant_name, user_id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Persons ─────────────────────────────────────────────────────────────────

pub async fn insert_person(
    pool: &PgPool,
    household_id: Uuid,
    display_name: &str,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_persons (household_id, display_name, note)
        VALUES ($1, $2, $3)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(display_name)
    .bind(note)
    .fetch_one(pool)
    .await
}

pub async fn list_persons(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Person>> {
    sqlx::query_as::<_, Person>(
        r"
        SELECT id, household_id, display_name, note, created_at
        FROM network_persons
        WHERE household_id = $1
        ORDER BY created_at, id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn person_in_household(
    pool: &PgPool,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_persons WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(person_id)
    .fetch_one(pool)
    .await
}

/// `false` means no such person in this household. A `Some(None)` note clears it.
pub async fn update_person(
    pool: &PgPool,
    household_id: Uuid,
    person_id: Uuid,
    display_name: Option<&str>,
    note: Option<Option<&str>>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_persons SET ");
    let mut fields = qb.separated(", ");
    if let Some(name) = display_name {
        fields.push("display_name = ").push_bind_unseparated(name);
    }
    match note {
        Some(Some(n)) => {
            fields.push("note = ").push_bind_unseparated(n);
        }
        Some(None) => {
            fields.push("note = NULL");
        }
        None => {}
    }
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(person_id);
    Ok(qb.build().execute(pool).await?.rows_affected() == 1)
}

// ─── Devices (global inventory, shared across households) ───────────────────

pub async fn insert_device(
    pool: &PgPool,
    canonical_key: &str,
    label: &str,
    device_type: &str,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_devices (canonical_key, label, device_type)
        VALUES ($1, $2, $3)
        RETURNING id
        ",
    )
    .bind(canonical_key)
    .bind(label)
    .bind(device_type)
    .fetch_one(pool)
    .await
}

/// A shared device is visible only through an assignment in this household.
pub async fn list_devices(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Device>> {
    sqlx::query_as::<_, Device>(
        r"
        SELECT DISTINCT d.id, d.canonical_key, d.label, d.device_type, d.created_at, d.updated_at
        FROM network_devices d
        JOIN network_assignments a ON a.device_id = d.id
        WHERE a.household_id = $1
        ORDER BY d.label, d.id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn device_exists(pool: &PgPool, device_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM network_devices WHERE id = $1)")
        .bind(device_id)
        .fetch_one(pool)
        .await
}

/// A shared device may only be edited through a household that assigns it.
pub async fn update_device_in_household(
    pool: &PgPool,
    household_id: Uuid,
    device_id: Uuid,
    label: Option<&str>,
    device_type: Option<&str>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_devices d SET ");
    let mut fields = qb.separated(", ");
    if let Some(l) = label {
        fields.push("label = ").push_bind_unseparated(l);
    }
    if let Some(t) = device_type {
        fields.push("device_type = ").push_bind_unseparated(t);
    }
    fields.push("updated_at = NOW()");
    qb.push(" WHERE d.id = ")
        .push_bind(device_id)
        .push(" AND EXISTS (SELECT 1 FROM network_assignments a WHERE a.device_id = d.id AND a.household_id = ")
        .push_bind(household_id)
        .push(")");
    Ok(qb.build().execute(pool).await?.rows_affected() == 1)
}

// ─── Explicit agent enrollment ──────────────────────────────────────────────

pub async fn agent_exists(pool: &PgPool, agent_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM agents WHERE id = $1)")
        .bind(agent_id)
        .fetch_one(pool)
        .await
}

pub async fn agent_enrolled_in_household(
    pool: &PgPool,
    household_id: Uuid,
    agent_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_household_agents WHERE household_id = $1 AND agent_id = $2)",
    )
    .bind(household_id)
    .bind(agent_id)
    .fetch_one(pool)
    .await
}

pub async fn insert_enrollment(
    pool: &PgPool,
    household_id: Uuid,
    agent_id: Uuid,
    enrolled_by: Uuid,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        INSERT INTO network_household_agents (household_id, agent_id, enrolled_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (agent_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(agent_id)
    .bind(enrolled_by)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn list_enrollments(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<AgentEnrollment>> {
    sqlx::query_as::<_, AgentEnrollment>(
        r"
        SELECT household_id, agent_id, enrolled_at
        FROM network_household_agents
        WHERE household_id = $1
        ORDER BY enrolled_at, agent_id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Assignments ─────────────────────────────────────────────────────────────

pub async fn insert_assignment(
    pool: &PgPool,
    household_id: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    agent_id: Option<Uuid>,
    role: &str,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_assignments (household_id, person_id, device_id, agent_id, role, note)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(device_id)
    .bind(agent_id)
    .bind(role)
    .bind(note)
    .fetch_one(pool)
    .await
}

pub async fn list_assignments(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Assignment>> {
    sqlx::query_as::<_, Assignment>(
        r"
        SELECT id, household_id, person_id, device_id, agent_id, role, note, created_at, updated_at
        FROM network_assignments
        WHERE household_id = $1
        ORDER BY created_at, id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn assignment_in_household(
    pool: &PgPool,
    household_id: Uuid,
    assignment_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_assignments WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(assignment_id)
    .fetch_one(pool)
    .await
}

pub async fn update_assignment(
    pool: &PgPool,
    household_id: Uuid,
    assignment_id: Uuid,
    agent_id: Option<Option<Uuid>>,
    role: Option<&str>,
    note: Option<Option<&str>>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_assignments SET ");
    let mut fields = qb.separated(", ");
    match agent_id {
        Some(Some(a)) => {
            fields.push("agent_id = ").push_bind_unseparated(a);
        }
        Some(None) => {
            fields.push("agent_id = NULL");
        }
        None => {}
    }
    if let Some(r) = role {
        fields.push("role = ").push_bind(r);
    }
    match note {
        Some(Some(n)) => {
            fields.push("note = ").push_bind_unseparated(n);
        }
        Some(None) => {
            fields.push("note = NULL");
        }
        None => {}
    }
    fields.push("updated_at = NOW()");
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(assignment_id);
    Ok(qb.build().execute(pool).await?.rows_affected() == 1)
}

// ─── Connections ─────────────────────────────────────────────────────────────

// Explicit scalar arguments keep the column mapping reviewable at the call site.
#[allow(clippy::too_many_arguments)]
pub async fn insert_connection(
    pool: &PgPool,
    household_id: Uuid,
    assignment_id: Uuid,
    kind: &str,
    provenance: &str,
    capabilities: &serde_json::Value,
    status: &str,
    observed_at: Option<chrono::DateTime<chrono::Utc>>,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_connections
            (household_id, assignment_id, kind, provenance, capabilities, status, observed_at, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(assignment_id)
    .bind(kind)
    .bind(provenance)
    .bind(capabilities)
    .bind(status)
    .bind(observed_at)
    .bind(note)
    .fetch_one(pool)
    .await
}

pub async fn list_connections(
    pool: &PgPool,
    household_id: Uuid,
    kind: Option<&str>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Connection>> {
    sqlx::query_as::<_, Connection>(
        r"
        SELECT id, household_id, assignment_id, kind, provenance, capabilities,
               status, observed_at, note, created_at, updated_at
        FROM network_connections
        WHERE household_id = $1 AND ($2::text IS NULL OR kind = $2)
        ORDER BY created_at, id
        LIMIT $3 OFFSET $4
        ",
    )
    .bind(household_id)
    .bind(kind)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn update_connection(
    pool: &PgPool,
    household_id: Uuid,
    connection_id: Uuid,
    provenance: Option<&str>,
    capabilities: Option<&serde_json::Value>,
    status: Option<&str>,
    observed_at: Option<Option<chrono::DateTime<chrono::Utc>>>,
    note: Option<Option<&str>>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_connections SET ");
    let mut fields = qb.separated(", ");
    if let Some(p) = provenance {
        fields.push("provenance = ").push_bind_unseparated(p);
    }
    if let Some(c) = capabilities {
        fields.push("capabilities = ").push_bind_unseparated(c);
    }
    if let Some(s) = status {
        fields.push("status = ").push_bind_unseparated(s);
    }
    match observed_at {
        Some(Some(ts)) => {
            fields.push("observed_at = ").push_bind_unseparated(ts);
        }
        Some(None) => {
            fields.push("observed_at = NULL");
        }
        None => {}
    }
    match note {
        Some(Some(n)) => {
            fields.push("note = ").push_bind_unseparated(n);
        }
        Some(None) => {
            fields.push("note = NULL");
        }
        None => {}
    }
    fields.push("updated_at = NOW()");
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(connection_id);
    Ok(qb.build().execute(pool).await?.rows_affected() == 1)
}
