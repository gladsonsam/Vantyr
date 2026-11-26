//! SQL for Vantyr Network gateways, credentials and reports.
//!
//! Every statement is bound to `household_id` (and gateway/kind where relevant).
//! The credential lookup that authenticates a worker uses a row lock so a
//! concurrent revoke cannot race a heartbeat. No statement here touches agent
//! tokens, modules, grants, Recall or control tables.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgConnection, PgPool};
use uuid::Uuid;

use super::gateway_dto::{Gateway, GatewayCredential, GatewayReport};

/// Internal authentication row. Carries the hash but is never serialized.
#[derive(Debug, FromRow)]
pub struct AuthCredential {
    pub id: Uuid,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub audience: String,
    pub allowed_commands: Vec<String>,
    pub secret_hash: String,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub gateway_enabled: bool,
    pub gateway_revoked_at: Option<DateTime<Utc>>,
}

// ─── Gateways ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_gateway(
    conn: &mut PgConnection,
    household_id: Uuid,
    kind: &str,
    label: &str,
    created_by: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_gateways (household_id, kind, label, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(kind)
    .bind(label)
    .bind(created_by)
    .fetch_one(conn)
    .await
}

pub async fn list_gateways(
    pool: &PgPool,
    household_id: Uuid,
    kind: Option<&str>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Gateway>> {
    sqlx::query_as::<_, Gateway>(
        r"
        SELECT id, household_id, kind, label, enabled, capabilities, last_seen_at,
               revoked_at, created_at, updated_at
        FROM network_gateways
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

pub async fn gateway_in_household(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_gateways WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_one(pool)
    .await
}

/// Returns the kind of an active gateway in this household. The kind is read
/// from storage, never taken from the caller; issuance/rotation bind to it and
/// the composite FK enforces the same scope in the database.
pub async fn active_gateway_kind(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r"
        SELECT kind FROM network_gateways
        WHERE household_id = $1 AND id = $2 AND enabled AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(pool)
    .await
}

/// Same check as `active_gateway_kind`, inside a transaction after locking.
pub async fn active_gateway_kind_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r"
        SELECT kind FROM network_gateways
        WHERE household_id = $1 AND id = $2 AND enabled AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await
}

pub async fn lock_gateway(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM network_gateways WHERE household_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_one(conn)
    .await
}

/// Revokes the gateway and all of its credentials in one statement sequence.
/// Returns false when the gateway was not in this household.
pub async fn revoke_gateway_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_gateways
        SET revoked_at = NOW(), enabled = false, updated_at = NOW()
        WHERE household_id = $1 AND id = $2 AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .execute(&mut *conn)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query(
        r"
        UPDATE network_gateway_credentials
        SET revoked_at = NOW()
        WHERE household_id = $1 AND gateway_id = $2 AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .execute(&mut *conn)
    .await?;
    Ok(true)
}

pub async fn touch_gateway_from_report(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    capabilities: &serde_json::Value,
    observed_at: DateTime<Utc>,
) -> sqlx::Result<()> {
    // Only reported observations are written. `enabled`, `revoked_at` and any
    // enforcement/verification state are deliberately untouched.
    sqlx::query(
        r"
        UPDATE network_gateways
        SET capabilities = $3, last_seen_at = $4, updated_at = NOW()
        WHERE household_id = $1 AND id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(capabilities)
    .bind(observed_at)
    .execute(conn)
    .await?;
    Ok(())
}

// ─── Credentials ─────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_credential(
    conn: &mut PgConnection,
    id: Uuid,
    household_id: Uuid,
    gateway_id: Uuid,
    kind: &str,
    secret_hash: &str,
    expires_at: DateTime<Utc>,
    issued_by: Uuid,
    rotated_from: Option<Uuid>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_gateway_credentials
            (id, household_id, gateway_id, kind, audience, allowed_commands,
             secret_hash, expires_at, issued_by, rotated_from)
        VALUES ($1, $2, $3, $4, $5, ARRAY['heartbeat']::text[], $6, $7, $8, $9)
        ",
    )
    .bind(id)
    .bind(household_id)
    .bind(gateway_id)
    .bind(kind)
    .bind(super::gateway_auth::AUDIENCE)
    .bind(secret_hash)
    .bind(expires_at)
    .bind(issued_by)
    .bind(rotated_from)
    .execute(conn)
    .await?;
    Ok(())
}

/// Metadata only: `secret_hash` is intentionally not in the SELECT list.
pub async fn list_credentials(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<GatewayCredential>> {
    sqlx::query_as::<_, GatewayCredential>(
        r"
        SELECT id, household_id, gateway_id, kind, audience, allowed_commands,
               expires_at, revoked_at, last_used_at, issued_at, rotated_from
        FROM network_gateway_credentials
        WHERE household_id = $1 AND gateway_id = $2
        ORDER BY issued_at DESC, id DESC
        LIMIT $3 OFFSET $4
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn credential_in_scope(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_gateway_credentials
            WHERE household_id = $1 AND gateway_id = $2 AND id = $3
        )
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(credential_id)
    .fetch_one(pool)
    .await
}

pub async fn revoke_credential_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_gateway_credentials
        SET revoked_at = NOW()
        WHERE household_id = $1 AND gateway_id = $2 AND id = $3 AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(credential_id)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// The worker authentication lookup. `for_update` serializes with revoke/rotate.
pub async fn auth_credential(
    conn: &mut PgConnection,
    credential_id: Uuid,
    for_update: bool,
) -> sqlx::Result<Option<AuthCredential>> {
    let sql = if for_update {
        r"
        SELECT c.id, c.household_id, c.gateway_id, c.kind, c.audience,
               c.allowed_commands, c.secret_hash, c.expires_at, c.revoked_at,
               g.enabled AS gateway_enabled, g.revoked_at AS gateway_revoked_at
        FROM network_gateway_credentials c
        JOIN network_gateways g
          ON g.id = c.gateway_id AND g.household_id = c.household_id AND g.kind = c.kind
        WHERE c.id = $1 FOR UPDATE OF c
        "
    } else {
        r"
        SELECT c.id, c.household_id, c.gateway_id, c.kind, c.audience,
               c.allowed_commands, c.secret_hash, c.expires_at, c.revoked_at,
               g.enabled AS gateway_enabled, g.revoked_at AS gateway_revoked_at
        FROM network_gateway_credentials c
        JOIN network_gateways g
          ON g.id = c.gateway_id AND g.household_id = c.household_id AND g.kind = c.kind
        WHERE c.id = $1
        "
    };
    sqlx::query_as::<_, AuthCredential>(sql)
        .bind(credential_id)
        .fetch_optional(conn)
        .await
}

pub async fn mark_credential_used(
    conn: &mut PgConnection,
    credential_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE network_gateway_credentials SET last_used_at = NOW() WHERE id = $1")
        .bind(credential_id)
        .execute(conn)
        .await?;
    Ok(())
}

// ─── Reports ─────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_report(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
    observed_at: DateTime<Utc>,
    capabilities: &serde_json::Value,
    desired_revision: Option<&str>,
    applied_revision: Option<&str>,
    failure: Option<&str>,
) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r"
        INSERT INTO network_gateway_reports
            (household_id, gateway_id, credential_id, observed_at, capabilities,
             desired_revision, applied_revision, failure)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(credential_id)
    .bind(observed_at)
    .bind(capabilities)
    .bind(desired_revision)
    .bind(applied_revision)
    .bind(failure)
    .fetch_one(conn)
    .await
}

/// Read-only reporting for a household admin; no hash or secret is selectable.
pub async fn list_reports(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<GatewayReport>> {
    sqlx::query_as::<_, GatewayReport>(
        r"
        SELECT id, household_id, gateway_id, credential_id, reported_at, observed_at,
               capabilities, desired_revision, applied_revision, failure, verified, enforced
        FROM network_gateway_reports
        WHERE household_id = $1 AND gateway_id = $2
        ORDER BY reported_at DESC, id DESC
        LIMIT $3 OFFSET $4
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}
