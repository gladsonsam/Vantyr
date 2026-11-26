//! Atomic gateway/credential transitions and the worker heartbeat path.
//!
//! EVERY mutator acquires the same lock order: household -> gateway ->
//! credential. Reading a credential row `FOR UPDATE` last cannot deadlock with
//! rotate/revoke, which hold the same prefix before touching the credential.
//! Issuance re-checks gateway activity inside the locked transaction, so a
//! concurrent revocation cannot race a TOCTOU read.

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::gateway_dto::HeartbeatBody;
use super::gateway_retention::GatewayReportRetention;
use super::{gateway_auth, gateway_db, gateway_dto};

fn worker_auth_error() -> ApiError {
    ApiError::Status(
        StatusCode::UNAUTHORIZED,
        "invalid gateway credential".to_string(),
    )
}

fn scope_not_found() -> ApiError {
    ApiError::not_found("active gateway not found in this household")
}

/// Metadata only: no secret, digest or claimed ids beyond the worker's own scope.
pub struct HeartbeatOutcome {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub report_id: i64,
}

pub async fn create_gateway(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    kind: &str,
    label: &str,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    super::db::lock_household(&mut tx, household_id).await?;
    let id = gateway_db::insert_gateway(&mut tx, household_id, kind, label, actor).await?;
    tx.commit().await?;
    Ok(id)
}

/// Issue a credential for an ACTIVE gateway in this household. The plaintext
/// secret is generated here, hashed, and only the hash reaches the database.
/// Activity is checked after the household and gateway are locked.
pub async fn issue_credential(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    issued_by: Uuid,
    expires_at: DateTime<Utc>,
) -> ApiResult<(Uuid, String)> {
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Err(scope_not_found());
    }
    let Some(kind) =
        gateway_db::active_gateway_kind_on_conn(&mut tx, household_id, gateway_id).await?
    else {
        return Err(scope_not_found());
    };
    let id = gateway_auth::new_token_id();
    let secret = gateway_auth::new_secret();
    let hash = gateway_auth::hash_secret(&secret);
    gateway_db::insert_credential(
        &mut tx,
        id,
        household_id,
        gateway_id,
        &kind,
        &hash,
        expires_at,
        issued_by,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok((id, secret))
}

/// Revoke the old credential and issue its replacement atomically. The old
/// plaintext stops working as soon as the transaction commits.
pub async fn rotate_credential(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
    issued_by: Uuid,
    expires_at: DateTime<Utc>,
) -> ApiResult<(Uuid, String)> {
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Err(scope_not_found());
    }
    let Some(kind) =
        gateway_db::active_gateway_kind_on_conn(&mut tx, household_id, gateway_id).await?
    else {
        return Err(scope_not_found());
    };
    if !gateway_db::revoke_credential_conn(&mut tx, household_id, gateway_id, credential_id).await?
    {
        return Err(ApiError::not_found("credential not found in this gateway"));
    }
    let id = gateway_auth::new_token_id();
    let secret = gateway_auth::new_secret();
    let hash = gateway_auth::hash_secret(&secret);
    gateway_db::insert_credential(
        &mut tx,
        id,
        household_id,
        gateway_id,
        &kind,
        &hash,
        expires_at,
        issued_by,
        Some(credential_id),
    )
    .await?;
    tx.commit().await?;
    Ok((id, secret))
}

pub async fn revoke_credential(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Err(scope_not_found());
    }
    let removed =
        gateway_db::revoke_credential_conn(&mut tx, household_id, gateway_id, credential_id)
            .await?;
    tx.commit().await?;
    Ok(removed)
}

pub async fn revoke_gateway(
    pool: &PgPool,
    household_id: Uuid,
    gateway_id: Uuid,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Ok(false);
    }
    let removed = gateway_db::revoke_gateway_conn(&mut tx, household_id, gateway_id).await?;
    tx.commit().await?;
    Ok(removed)
}

/// The ONLY gateway credential use in this slice: a bounded heartbeat report.
/// All bound checks happen before any write; nothing here writes agent tokens,
/// module grants or control state, and no self-reported flag can set
/// verification/enforcement (the schema forbids it).
pub async fn heartbeat(
    pool: &PgPool,
    bearer: Option<&str>,
    body: HeartbeatBody,
    now: DateTime<Utc>,
    retention: GatewayReportRetention,
) -> ApiResult<HeartbeatOutcome> {
    // Bounds checked before any database work.
    let (credential_id, secret) =
        gateway_auth::parse_bearer(bearer).ok_or_else(worker_auth_error)?;
    if body.audience != gateway_auth::AUDIENCE || body.command != gateway_auth::COMMAND_HEARTBEAT {
        return Err(worker_auth_error());
    }
    let claimed_kind = gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())?;
    let capabilities = gateway_auth::normalize_capabilities(body.capabilities.as_deref())
        .map_err(|()| ApiError::bad_request("capabilities are not in the worker allowlist"))?;
    let observed_at = body.observed_at.unwrap_or(now);
    if !gateway_auth::observed_at_in_window(observed_at, now) {
        return Err(ApiError::bad_request(
            "observed_at is outside the heartbeat window",
        ));
    }
    let desired = gateway_auth::bounded_text(
        body.desired_revision.as_deref(),
        gateway_auth::MAX_REVISION_LEN,
    )
    .map_err(|()| ApiError::bad_request("desired_revision is unbounded"))?;
    let applied = gateway_auth::bounded_text(
        body.applied_revision.as_deref(),
        gateway_auth::MAX_REVISION_LEN,
    )
    .map_err(|()| ApiError::bad_request("applied_revision is unbounded"))?;
    let failure =
        gateway_auth::bounded_text(body.failure.as_deref(), gateway_auth::MAX_FAILURE_LEN)
            .map_err(|()| ApiError::bad_request("failure is unbounded"))?;
    let cfg = retention.clamped();

    let mut tx = pool.begin().await?;
    // Global h -> g -> c order: validate claimed scope, then lock it.
    if !gateway_db::lock_household_and_gateway(&mut tx, body.household_id, body.gateway_id).await? {
        return Err(worker_auth_error());
    }
    let Some(cred) = gateway_db::auth_credential_scoped(
        &mut tx,
        credential_id,
        body.household_id,
        body.gateway_id,
        &claimed_kind,
    )
    .await?
    else {
        return Err(worker_auth_error());
    };
    // Constant-time proof of possession of the one-time secret.
    if !gateway_auth::verify_secret(secret, &cred.secret_hash) {
        return Err(worker_auth_error());
    }
    // Revocation and expiry are re-checked from the locked row on every request.
    if cred.revoked_at.is_some()
        || cred.gateway_revoked_at.is_some()
        || !cred.gateway_enabled
        || cred.expires_at <= now
    {
        return Err(worker_auth_error());
    }
    if cred.audience != gateway_auth::AUDIENCE
        || !cred
            .allowed_commands
            .iter()
            .any(|c| c == gateway_auth::COMMAND_HEARTBEAT)
    {
        return Err(worker_auth_error());
    }

    let caps = serde_json::Value::Array(
        capabilities
            .into_iter()
            .map(serde_json::Value::String)
            .collect(),
    );
    let report_id = gateway_db::insert_report(
        &mut tx,
        cred.household_id,
        cred.gateway_id,
        cred.id,
        observed_at,
        &caps,
        desired.as_deref(),
        applied.as_deref(),
        failure.as_deref(),
    )
    .await?;
    // Ingest-time hard cap and age limit, under the gateway lock: concurrent
    // heartbeats for this gateway cannot grow the table past `max_per_gateway`.
    gateway_db::prune_reports_for_gateway(
        &mut tx,
        cred.household_id,
        cred.gateway_id,
        cfg.cutoff(now),
        cfg.max_per_gateway,
    )
    .await?;
    gateway_db::touch_gateway_from_report(
        &mut tx,
        cred.household_id,
        cred.gateway_id,
        &caps,
        observed_at,
    )
    .await?;
    gateway_db::mark_credential_used(&mut tx, cred.id).await?;
    tx.commit().await?;
    Ok(HeartbeatOutcome {
        household_id: cred.household_id,
        gateway_id: cred.gateway_id,
        report_id,
    })
}
