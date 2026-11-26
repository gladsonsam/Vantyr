//! SQL for authenticated BYOD enrollment. Every statement is household-scoped.
//!
//! Runtime `sqlx::query*` APIs are used throughout, so no offline cache
//! regeneration is needed. This module contains no domain decisions: callers
//! pass already validated values and already computed hashes/deadlines. All
//! mutators run inside a transaction that first locks the household row, which
//! serializes every grant/session/binding race for that household.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::enroll_dto::{
    BindingRow, DeviceAuthorizationRow, OwnDeviceRow, OwnGrantRow, OwnSessionRow,
};
use super::enroll_retention::AttemptRetention;

// ─── Row shapes ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BindingRec {
    pub id: Uuid,
    pub person_id: Uuid,
    pub generation: i64,
    pub active: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceEnrollmentRec {
    pub id: Uuid,
    pub generation: i64,
    pub status: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GrantRec {
    pub binding_id: Uuid,
    pub device_enrollment_id: Uuid,
    pub device_id: Uuid,
    pub dashboard_user: Uuid,
    pub person_id: Uuid,
    pub generation: i64,
    pub purpose: String,
    pub verification_method: String,
    pub secret_hash: String,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRec {
    pub id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

// ─── Locked reads ────────────────────────────────────────────────────────────

/// The first lock in every enrollment mutation. Serializes all grant consume,
/// binding revoke, device end and session end operations for one household.
pub async fn lock_household(conn: &mut PgConnection, household_id: Uuid) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM network_households WHERE id = $1 FOR UPDATE")
        .bind(household_id)
        .fetch_one(conn)
        .await
}

/// Exact grant check inside the same transaction as the household lock. The
/// API-level check can be stale by the time a mutator obtains the lock; every
/// self mutator rechecks here so a concurrent `network_enroll` revoke wins.
pub async fn has_grant_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
    grant_name: &str,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_grants
            WHERE household_id = $1 AND user_id = $2 AND grant_name = $3
        )
        ",
    )
    .bind(household_id)
    .bind(user_id)
    .bind(grant_name)
    .fetch_one(conn)
    .await
}

pub async fn person_in_household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_persons WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(person_id)
    .fetch_one(conn)
    .await
}

pub async fn dashboard_user_exists_on_conn(
    conn: &mut PgConnection,
    user_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM dashboard_users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(conn)
        .await
}

pub async fn device_in_household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_devices WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_one(conn)
    .await
}

pub async fn active_binding(
    pool: &PgPool,
    household_id: Uuid,
    user: Uuid,
) -> sqlx::Result<Option<BindingRec>> {
    sqlx::query_as::<_, BindingRec>(
        r"
        SELECT id, person_id, generation, active
        FROM network_principal_bindings
        WHERE household_id = $1 AND dashboard_user = $2 AND active
        ",
    )
    .bind(household_id)
    .bind(user)
    .fetch_optional(pool)
    .await
}

pub async fn active_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user: Uuid,
) -> sqlx::Result<Option<BindingRec>> {
    sqlx::query_as::<_, BindingRec>(
        r"
        SELECT id, person_id, generation, active
        FROM network_principal_bindings
        WHERE household_id = $1 AND dashboard_user = $2 AND active
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(user)
    .fetch_optional(conn)
    .await
}

pub async fn binding_by_user_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<Option<BindingRec>> {
    sqlx::query_as::<_, BindingRec>(
        r"
        SELECT id, person_id, generation, active
        FROM network_principal_bindings
        WHERE household_id = $1 AND dashboard_user = $2
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(user_id)
    .fetch_optional(conn)
    .await
}

pub async fn binding_by_id_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
) -> sqlx::Result<Option<BindingRec>> {
    sqlx::query_as::<_, BindingRec>(
        r"
        SELECT id, person_id, generation, active
        FROM network_principal_bindings
        WHERE household_id = $1 AND id = $2
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .fetch_optional(conn)
    .await
}

pub async fn device_enrollment_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
    binding_id: Uuid,
) -> sqlx::Result<Option<DeviceEnrollmentRec>> {
    sqlx::query_as::<_, DeviceEnrollmentRec>(
        r"
        SELECT id, generation, status
        FROM network_device_enrollments
        WHERE household_id = $1 AND device_id = $2 AND binding_id = $3
          AND status IN ('authorized', 'active')
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(binding_id)
    .fetch_optional(conn)
    .await
}

/// Hard bound on live enrollments in one household. Checked under the household
/// lock before self-registration or admin pre-authorization inserts a row.
pub async fn count_live_enrollments_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r"
        SELECT COUNT(*) FROM network_device_enrollments
        WHERE household_id = $1 AND status IN ('authorized', 'active')
        ",
    )
    .bind(household_id)
    .fetch_one(conn)
    .await
}

/// Any live enrollment for a device, regardless of binding: an admin cannot
/// pre-authorize a device that is already enrolled to somebody else, and a
/// user cannot self-register a UUID that a different binding already holds.
pub async fn live_enrollment_for_device_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_device_enrollments
            WHERE household_id = $1 AND device_id = $2 AND status IN ('authorized', 'active')
        )
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_one(conn)
    .await
}

pub async fn grant_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    grant_id: Uuid,
) -> sqlx::Result<Option<GrantRec>> {
    sqlx::query_as::<_, GrantRec>(
        r"
        SELECT binding_id, device_enrollment_id, device_id, dashboard_user, person_id,
               generation, purpose, verification_method, secret_hash, expires_at,
               consumed_at, revoked_at
        FROM network_enrollment_grants
        WHERE household_id = $1 AND id = $2
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(grant_id)
    .fetch_optional(conn)
    .await
}

pub async fn live_session_for_device_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<Option<SessionRec>> {
    sqlx::query_as::<_, SessionRec>(
        r"
        SELECT id, expires_at, ended_at
        FROM network_verified_sessions
        WHERE household_id = $1 AND device_id = $2 AND ended_at IS NULL
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_optional(conn)
    .await
}

// ─── Admin binding management ────────────────────────────────────────────────

pub async fn upsert_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
    person_id: Uuid,
    actor: Uuid,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_principal_bindings
            (household_id, dashboard_user, person_id, created_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (household_id, dashboard_user) DO UPDATE
            SET person_id = EXCLUDED.person_id,
                generation = network_principal_bindings.generation + 1,
                active = true,
                revoked_at = NULL,
                updated_at = NOW(),
                created_by = EXCLUDED.created_by
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(user_id)
    .bind(person_id)
    .bind(actor)
    .fetch_one(conn)
    .await
}

pub async fn revoke_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_principal_bindings
        SET active = false, generation = generation + 1, revoked_at = $3, updated_at = NOW()
        WHERE household_id = $1 AND id = $2 AND active
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn list_bindings(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<BindingRow>> {
    sqlx::query_as::<_, BindingRow>(
        r"
        SELECT id, dashboard_user, person_id, generation, active, created_at, revoked_at
        FROM network_principal_bindings
        WHERE household_id = $1
        ORDER BY created_at DESC, id
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Device enrollment ───────────────────────────────────────────────────────

pub async fn insert_device_on_conn(
    conn: &mut PgConnection,
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
    .fetch_one(conn)
    .await
}

pub async fn insert_device_enrollment_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    device_id: Uuid,
    generation: i64,
    authorized_by: Option<Uuid>,
    status: &str,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_device_enrollments
            (household_id, binding_id, device_id, generation, authorized_by, status)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(device_id)
    .bind(generation)
    .bind(authorized_by)
    .bind(status)
    .fetch_one(conn)
    .await
}

pub async fn end_enrollment_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_device_enrollments
        SET status = 'ended', ended_at = $4
        WHERE household_id = $1 AND device_id = $2 AND binding_id = $3
          AND status IN ('authorized', 'active')
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(binding_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn list_own_devices(
    pool: &PgPool,
    household_id: Uuid,
    binding_id: Uuid,
) -> sqlx::Result<Vec<OwnDeviceRow>> {
    sqlx::query_as::<_, OwnDeviceRow>(
        r"
        SELECT d.id, d.label, d.device_type, d.shared, e.id AS enrollment_id,
               e.status AS enrollment_status
        FROM network_device_enrollments e
        JOIN network_devices d ON d.id = e.device_id AND d.household_id = e.household_id
        WHERE e.household_id = $1 AND e.binding_id = $2
          AND e.status IN ('authorized', 'active')
        ORDER BY d.label, d.id
        LIMIT 100
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .fetch_all(pool)
    .await
}

/// Bounded, paginated admin read. The caller receives the page window and a
/// `truncated` flag so an omitted remainder is never presented as the full set.
pub async fn list_device_enrollments(
    pool: &PgPool,
    household_id: Uuid,
    binding_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<DeviceAuthorizationRow>> {
    sqlx::query_as::<_, DeviceAuthorizationRow>(
        r"
        SELECT id, binding_id, device_id, generation, status, authorized_by, created_at
        FROM network_device_enrollments
        WHERE household_id = $1 AND binding_id = $2
        ORDER BY created_at DESC, id
        LIMIT $3 OFFSET $4
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

// ─── Grants and sessions ─────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_grant_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    device_enrollment_id: Uuid,
    device_id: Uuid,
    user_id: Uuid,
    person_id: Uuid,
    generation: i64,
    purpose: &str,
    secret_hash: &str,
    expires_at: DateTime<Utc>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_enrollment_grants
            (household_id, binding_id, device_enrollment_id, device_id, dashboard_user,
             person_id, generation, purpose, verification_method, secret_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'oidc_session', $9, $10)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(device_enrollment_id)
    .bind(device_id)
    .bind(user_id)
    .bind(person_id)
    .bind(generation)
    .bind(purpose)
    .bind(secret_hash)
    .bind(expires_at)
    .fetch_one(conn)
    .await
}

pub async fn consume_grant_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    grant_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_enrollment_grants SET consumed_at = $3
        WHERE household_id = $1 AND id = $2 AND consumed_at IS NULL AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(grant_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn list_own_grants(
    pool: &PgPool,
    household_id: Uuid,
    binding_id: Uuid,
) -> sqlx::Result<Vec<OwnGrantRow>> {
    sqlx::query_as::<_, OwnGrantRow>(
        r"
        SELECT id, device_id, purpose, expires_at, consumed_at, revoked_at, created_at
        FROM network_enrollment_grants
        WHERE household_id = $1 AND binding_id = $2
        ORDER BY created_at DESC, id
        LIMIT 100
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .fetch_all(pool)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    device_id: Uuid,
    user_id: Uuid,
    person_id: Uuid,
    generation: i64,
    purpose: &str,
    verified_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> sqlx::Result<Uuid> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        INSERT INTO network_verified_sessions
            (household_id, binding_id, device_id, dashboard_user, person_id, generation,
             purpose, verification_method, verified_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'oidc_session', $8, $9)
        RETURNING id
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(device_id)
    .bind(user_id)
    .bind(person_id)
    .bind(generation)
    .bind(purpose)
    .bind(verified_at)
    .bind(expires_at)
    .fetch_one(conn)
    .await
}

pub async fn list_own_sessions(
    pool: &PgPool,
    household_id: Uuid,
    binding_id: Uuid,
) -> sqlx::Result<Vec<OwnSessionRow>> {
    sqlx::query_as::<_, OwnSessionRow>(
        r"
        SELECT id, device_id, purpose, verification_method, verified_at, expires_at, ended_at
        FROM network_verified_sessions
        WHERE household_id = $1 AND binding_id = $2
        ORDER BY verified_at DESC, id
        LIMIT 100
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .fetch_all(pool)
    .await
}

#[derive(Clone, Copy)]
pub enum EndReason {
    SelfEnd,
    SelfAll,
    BindingRevoked,
    DeviceEnded,
    GenerationChanged,
    Expired,
}

impl EndReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::SelfEnd => "self",
            Self::SelfAll => "self_all",
            Self::BindingRevoked => "binding_revoked",
            Self::DeviceEnded => "device_ended",
            Self::GenerationChanged => "generation_changed",
            Self::Expired => "expired",
        }
    }
}

pub async fn end_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    session_id: Uuid,
    now: DateTime<Utc>,
    reason: EndReason,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_verified_sessions SET ended_at = $3, end_reason = $4
        WHERE household_id = $1 AND id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(session_id)
    .bind(now)
    .bind(reason.as_str())
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Resolve the device of a session before ending it, so single-session logout
/// can revoke only outstanding grants for that exact device and binding.
pub async fn session_device_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        r"
        SELECT device_id FROM network_verified_sessions
        WHERE household_id = $1 AND binding_id = $2 AND dashboard_user = $3
          AND id = $4 AND ended_at IS NULL
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(user_id)
    .bind(session_id)
    .fetch_optional(conn)
    .await
}

/// Ends only a session owned by the calling binding/user. The household is
/// locked by the caller, so a concurrent revoke cannot race this decision.
pub async fn end_own_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
    now: DateTime<Utc>,
    reason: EndReason,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        UPDATE network_verified_sessions SET ended_at = $5, end_reason = $6
        WHERE household_id = $1 AND binding_id = $2 AND dashboard_user = $3
          AND id = $4 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(user_id)
    .bind(session_id)
    .bind(now)
    .bind(reason.as_str())
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn end_own_sessions_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    user_id: Uuid,
    now: DateTime<Utc>,
    reason: EndReason,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_verified_sessions SET ended_at = $4, end_reason = $5
        WHERE household_id = $1 AND binding_id = $2 AND dashboard_user = $3 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(user_id)
    .bind(now)
    .bind(reason.as_str())
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn end_sessions_for_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
    reason: EndReason,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_verified_sessions SET ended_at = $3, end_reason = $4
        WHERE household_id = $1 AND binding_id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(now)
    .bind(reason.as_str())
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn end_sessions_for_device_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
    now: DateTime<Utc>,
    reason: EndReason,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_verified_sessions SET ended_at = $3, end_reason = $4
        WHERE household_id = $1 AND device_id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(now)
    .bind(reason.as_str())
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn end_device_enrollments_for_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_device_enrollments SET status = 'ended', ended_at = $3
        WHERE household_id = $1 AND binding_id = $2 AND status IN ('authorized', 'active')
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn revoke_grants_for_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_enrollment_grants SET revoked_at = $3
        WHERE household_id = $1 AND binding_id = $2
          AND revoked_at IS NULL AND consumed_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

/// Device + binding scoped grant revocation for single-session logout. A grant
/// for a different device or a different binding is deliberately untouched.
pub async fn revoke_grants_for_device_and_binding_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
    binding_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_enrollment_grants SET revoked_at = $4
        WHERE household_id = $1 AND device_id = $2 AND binding_id = $3
          AND revoked_at IS NULL AND consumed_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(binding_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn revoke_grants_for_device_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        UPDATE network_enrollment_grants SET revoked_at = $3
        WHERE household_id = $1 AND device_id = $2
          AND revoked_at IS NULL AND consumed_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(device_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

// ─── Bounded grant / session record history ──────────────────────────────────

/// Retire old inactive grants for one household. Live, unconsumed grants are
/// never removed; this runs inside the household lock on each issuance.
pub async fn prune_grants_for_household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    cutoff: DateTime<Utc>,
    now: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    sqlx::query(
        r"
        DELETE FROM network_enrollment_grants
        WHERE household_id = $1 AND created_at < $2
          AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < $3)
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let res = sqlx::query(
        r"
        DELETE FROM network_enrollment_grants WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
                FROM network_enrollment_grants
                WHERE household_id = $1
                  AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < $2)
            ) ranked WHERE rn > $3
        )
        ",
    )
    .bind(household_id)
    .bind(now)
    .bind(max_per_household)
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

/// Retire old ended/expired sessions for one household. The active-session
/// unique index and the `ended_at IS NULL` filter keep live sessions intact.
pub async fn prune_sessions_for_household_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    cutoff: DateTime<Utc>,
    now: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    sqlx::query(
        r"
        DELETE FROM network_verified_sessions
        WHERE household_id = $1 AND verified_at < $2
          AND (ended_at IS NOT NULL OR expires_at < $3)
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let res = sqlx::query(
        r"
        DELETE FROM network_verified_sessions WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (ORDER BY verified_at DESC, id DESC) AS rn
                FROM network_verified_sessions
                WHERE household_id = $1
                  AND (ended_at IS NOT NULL OR expires_at < $2)
            ) ranked WHERE rn > $3
        )
        ",
    )
    .bind(household_id)
    .bind(now)
    .bind(max_per_household)
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

/// Periodic sweep across every household, with the same hard bounds.
#[allow(dead_code)]
pub async fn prune_all_records(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    now: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let age_grants = sqlx::query(
        r"
        DELETE FROM network_enrollment_grants
        WHERE created_at < $1
          AND (consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < $2)
        ",
    )
    .bind(cutoff)
    .bind(now)
    .execute(pool)
    .await?
    .rows_affected();
    let age_sessions = sqlx::query(
        r"
        DELETE FROM network_verified_sessions
        WHERE verified_at < $1 AND (ended_at IS NOT NULL OR expires_at < $2)
        ",
    )
    .bind(cutoff)
    .bind(now)
    .execute(pool)
    .await?
    .rows_affected();
    let count_grants = sqlx::query(
        r"
        DELETE FROM network_enrollment_grants WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY household_id ORDER BY created_at DESC, id DESC
                ) AS rn
                FROM network_enrollment_grants
                WHERE consumed_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < $1
            ) ranked WHERE rn > $2
        )
        ",
    )
    .bind(now)
    .bind(max_per_household)
    .execute(pool)
    .await?
    .rows_affected();
    let count_sessions = sqlx::query(
        r"
        DELETE FROM network_verified_sessions WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY household_id ORDER BY verified_at DESC, id DESC
                ) AS rn
                FROM network_verified_sessions
                WHERE ended_at IS NOT NULL OR expires_at < $1
            ) ranked WHERE rn > $2
        )
        ",
    )
    .bind(now)
    .bind(max_per_household)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(age_grants + age_sessions + count_grants + count_sessions)
}

// ─── Bounded attempt history ─────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub enum AttemptOutcome {
    WrongScope,
    WrongDevice,
    WrongPurpose,
    WrongSecret,
    Expired,
    Revoked,
    GenerationMismatch,
    NotActive,
    SessionConflict,
    NotFound,
}

impl AttemptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongScope => "wrong_scope",
            Self::WrongDevice => "wrong_device",
            Self::WrongPurpose => "wrong_purpose",
            Self::WrongSecret => "wrong_secret",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
            Self::GenerationMismatch => "generation_mismatch",
            Self::NotActive => "not_active",
            Self::SessionConflict => "session_conflict",
            Self::NotFound => "not_found",
        }
    }
}

/// Age + count pruning under the household lock, followed by one insert. The
/// table can never grow past `(retention.max_per_household)` rows per household
/// or retain rows older than the cutoff. Outcome codes only; no free text.
#[allow(clippy::too_many_arguments)]
pub async fn record_attempt_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    binding_id: Option<Uuid>,
    grant_id: Option<Uuid>,
    now: DateTime<Utc>,
    cfg: &AttemptRetention,
    outcome: AttemptOutcome,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_enrollment_attempts
            (household_id, binding_id, grant_id, occurred_at, outcome)
        VALUES ($1, $2, $3, $4, $5)
        ",
    )
    .bind(household_id)
    .bind(binding_id)
    .bind(grant_id)
    .bind(now)
    .bind(outcome.as_str())
    .execute(&mut *conn)
    .await?;
    // Prune AFTER the insert so the retained count includes the new row.
    sqlx::query(
        "DELETE FROM network_enrollment_attempts WHERE household_id = $1 AND occurred_at < $2",
    )
    .bind(household_id)
    .bind(cfg.cutoff(now))
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        r"
        DELETE FROM network_enrollment_attempts WHERE id IN (
            SELECT id FROM network_enrollment_attempts
            WHERE household_id = $1 ORDER BY occurred_at DESC, id DESC OFFSET $2
        )
        ",
    )
    .bind(household_id)
    .bind(cfg.max_per_household)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Periodic sweep companion to `prune_gateway_reports`, bounded by the same
/// config shape. Prunes by age and by per-household count.
#[allow(dead_code)] // Companion sweep for the periodic retention task.
pub async fn prune_all_attempts(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let age = sqlx::query("DELETE FROM network_enrollment_attempts WHERE occurred_at < $1")
        .bind(cutoff)
        .execute(pool)
        .await?
        .rows_affected();
    let count = sqlx::query(
        r"
        DELETE FROM network_enrollment_attempts WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY household_id ORDER BY occurred_at DESC, id DESC
                ) AS rn
                FROM network_enrollment_attempts
            ) ranked WHERE rn > $1
        )
        ",
    )
    .bind(max_per_household)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(age + count)
}
