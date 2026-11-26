//! SQL for the Vantyr Network inventory. Every read and write is scoped by
//! `household_id`; authorization lives in `authz`, never in these functions.
//!
//! Runtime `sqlx::query*` APIs are used throughout: no `query!` macros, so no
//! offline cache regeneration. Row mapping goes through typed `FromRow` DTOs.

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
    timezone: &str,
    created_by: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_households (name, timezone, is_default, created_by)
        VALUES ($1, $2, true, $3)
        RETURNING id
        ",
    )
    .bind(name)
    .bind(timezone)
    .bind(created_by)
    .fetch_one(conn)
    .await
}

pub async fn insert_household_on_conn(
    conn: &mut PgConnection,
    name: &str,
    timezone: &str,
    created_by: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO network_households (name, timezone, is_default, created_by) VALUES ($1, $2, false, $3) RETURNING id",
    )
    .bind(name)
    .bind(timezone)
    .bind(created_by)
    .fetch_one(conn)
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
        SELECT h.id, h.name, h.timezone, h.is_default, h.created_at
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

/// Serializes grant changes for one household (including concurrent revokes).
pub async fn lock_household(conn: &mut PgConnection, household_id: Uuid) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM network_households WHERE id = $1 FOR UPDATE")
        .bind(household_id)
        .fetch_one(conn)
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

pub async fn count_admins(conn: &mut PgConnection, household_id: Uuid) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM network_grants WHERE household_id = $1 AND grant_name = 'network_admin'",
    )
    .bind(household_id)
    .fetch_one(conn)
    .await
}

pub async fn grant_is_admin(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_grants WHERE household_id = $1 AND user_id = $2 AND grant_name = 'network_admin')",
    )
    .bind(household_id)
    .bind(user_id)
    .fetch_one(conn)
    .await
}

pub async fn delete_grant_on_conn(
    conn: &mut PgConnection,
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
    .execute(conn)
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

// Retained for the older test fixtures; production person creation now runs
// through mutation_db::insert_person_on_conn inside the household lock.
#[allow(dead_code)]
pub async fn insert_person(
    pool: &PgPool,
    household_id: Uuid,
    display_name: &str,
    note: Option<&str>,
    is_default_profile: bool,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_persons (household_id, display_name, note, is_default_profile)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(display_name)
    .bind(note)
    .bind(is_default_profile)
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
        SELECT id, household_id, display_name, is_default_profile, note, created_at
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

// ─── Devices (household-owned; never a global key oracle) ───────────────────

pub async fn insert_device(
    pool: &PgPool,
    household_id: Uuid,
    canonical_key: &str,
    label: &str,
    device_type: &str,
    shared: bool,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_devices (household_id, canonical_key, label, device_type, shared)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(canonical_key)
    .bind(label)
    .bind(device_type)
    .bind(shared)
    .fetch_one(pool)
    .await
}

/// All devices in the household are visible, including unassigned ones: no
/// fabricated person or assignment is needed to see a newly added device.
pub async fn list_devices(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Device>> {
    sqlx::query_as::<_, Device>(
        r"
        SELECT id, household_id, canonical_key, label, device_type, shared, created_at, updated_at
        FROM network_devices
        WHERE household_id = $1
        ORDER BY label, id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn device_in_household(
    pool: &PgPool,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_devices WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_one(pool)
    .await
}

pub async fn update_device(
    pool: &PgPool,
    household_id: Uuid,
    device_id: Uuid,
    label: Option<&str>,
    device_type: Option<&str>,
    shared: Option<bool>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_devices SET ");
    let mut fields = qb.separated(", ");
    if let Some(l) = label {
        fields.push("label = ").push_bind_unseparated(l);
    }
    if let Some(t) = device_type {
        fields.push("device_type = ").push_bind_unseparated(t);
    }
    if let Some(s) = shared {
        fields.push("shared = ").push_bind_unseparated(s);
    }
    fields.push("updated_at = NOW()");
    qb.push(" WHERE household_id = ")
        .push_bind(household_id)
        .push(" AND id = ")
        .push_bind(device_id);
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

#[allow(clippy::too_many_arguments)]
pub async fn insert_assignment(
    pool: &PgPool,
    household_id: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    agent_id: Option<Uuid>,
    role: &str,
    active: bool,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_assignments (household_id, person_id, device_id, agent_id, role, active, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(device_id)
    .bind(agent_id)
    .bind(role)
    .bind(active)
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
        SELECT id, household_id, person_id, device_id, agent_id, active, role, note, created_at, updated_at
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

#[allow(clippy::too_many_arguments)]
pub async fn update_assignment(
    pool: &PgPool,
    household_id: Uuid,
    assignment_id: Uuid,
    agent_id: Option<Option<Uuid>>,
    role: Option<&str>,
    active: Option<bool>,
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
        fields.push("role = ").push_bind_unseparated(r);
    }
    if let Some(a) = active {
        fields.push("active = ").push_bind_unseparated(a);
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

#[allow(clippy::too_many_arguments)]
pub async fn insert_connection(
    pool: &PgPool,
    household_id: Uuid,
    device_id: Uuid,
    assignment_id: Option<Uuid>,
    enrolled_agent_id: Option<Uuid>,
    kind: &str,
    provenance: &str,
    capabilities: &serde_json::Value,
    status: &str,
    observed_at: Option<chrono::DateTime<chrono::Utc>>,
    last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
    revoked_at: Option<chrono::DateTime<chrono::Utc>>,
    note: Option<&str>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_connections
            (household_id, device_id, assignment_id, enrolled_agent_id, kind, provenance,
             capabilities, status, observed_at, last_seen_at, revoked_at, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(assignment_id)
    .bind(enrolled_agent_id)
    .bind(kind)
    .bind(provenance)
    .bind(capabilities)
    .bind(status)
    .bind(observed_at)
    .bind(last_seen_at)
    .bind(revoked_at)
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
        SELECT id, household_id, device_id, assignment_id, enrolled_agent_id, kind, provenance,
               capabilities, status, observed_at, last_seen_at, revoked_at, note, created_at, updated_at
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
    assignment_id: Option<Option<Uuid>>,
    enrolled_agent_id: Option<Option<Uuid>>,
    provenance: Option<&str>,
    capabilities: Option<&serde_json::Value>,
    status: Option<&str>,
    observed_at: Option<Option<chrono::DateTime<chrono::Utc>>>,
    last_seen_at: Option<Option<chrono::DateTime<chrono::Utc>>>,
    revoked_at: Option<Option<chrono::DateTime<chrono::Utc>>>,
    note: Option<Option<&str>>,
) -> sqlx::Result<bool> {
    let mut qb = QueryBuilder::new("UPDATE network_connections SET ");
    let mut fields = qb.separated(", ");
    match assignment_id {
        Some(Some(a)) => {
            fields.push("assignment_id = ").push_bind_unseparated(a);
        }
        Some(None) => {
            fields.push("assignment_id = NULL");
        }
        None => {}
    }
    match enrolled_agent_id {
        Some(Some(a)) => {
            fields.push("enrolled_agent_id = ").push_bind_unseparated(a);
        }
        Some(None) => {
            fields.push("enrolled_agent_id = NULL");
        }
        None => {}
    }
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
    match last_seen_at {
        Some(Some(ts)) => {
            fields.push("last_seen_at = ").push_bind_unseparated(ts);
        }
        Some(None) => {
            fields.push("last_seen_at = NULL");
        }
        None => {}
    }
    match revoked_at {
        Some(Some(ts)) => {
            fields.push("revoked_at = ").push_bind_unseparated(ts);
        }
        Some(None) => {
            fields.push("revoked_at = NULL");
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

// ─── Household-scoped audit ──────────────────────────────────────────────────

pub async fn insert_network_audit(
    pool: &PgPool,
    household_id: Uuid,
    actor: &str,
    client_ip: Option<&str>,
    action: &str,
    detail: &serde_json::Value,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_audit (household_id, actor, client_ip, action, status, detail)
        VALUES ($1, $2, $3, $4, 'ok', $5)
        ",
    )
    .bind(household_id)
    .bind(actor)
    .bind(client_ip)
    .bind(action)
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}
