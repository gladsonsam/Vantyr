//! Atomic transitions for versioned policy, desired assignment and scoped
//! worker retrieval.
//!
//! Publishing and rollback take the household lock, allocate a strictly
//! increasing revision, INSERT an immutable row and prune only unpinned old
//! rows. Both are SAVED PROPOSALS: no applied/enforced state and no ack path
//! exists here. Worker retrieval uses the same household -> gateway -> cred
//! lock order as heartbeats and never returns a token-bearing payload.

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::gateway_db;
use super::policy_dto::{
    build_policy, canonical_bytes, digest, valid_revision, DesiredPolicy, DesiredPolicyBody,
    PolicyDraft, PolicyReadResponse, PublishResponse, RollbackBody, POLICY_SCHEMA_VERSION,
};
use super::{db, gateway_auth, policy_db, policy_dto};

fn worker_auth_error() -> ApiError {
    ApiError::Status(
        StatusCode::UNAUTHORIZED,
        "invalid gateway credential".to_string(),
    )
}

fn scoped_not_found() -> ApiError {
    ApiError::not_found("gateway not found in this household")
}

/// Save a new policy revision. The household comes from the path; revision and
/// published_at are server-assigned. A supplied, stale `expected_revision` is
/// the only way to signal optimistic concurrency and yields 409.
pub async fn publish(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    draft: PolicyDraft,
    now: DateTime<Utc>,
) -> ApiResult<PublishResponse> {
    // Capture the concurrency token before the draft is consumed. Revision 1
    // here is only a validation probe; the stored revision is allocated under
    // the household lock. The token is never accepted as a revision to store.
    let expected_revision = draft.expected_revision;
    let mut policy = build_policy(draft, household_id, 1, now)?;

    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    let current = policy_db::current_revision_on_conn(&mut tx, household_id).await?;
    if let Some(expected) = expected_revision {
        if expected as i64 != current {
            return Err(ApiError::conflict("expected revision is stale"));
        }
    }
    let revision = current
        .checked_add(1)
        .ok_or_else(|| ApiError::conflict("policy revision counter exhausted"))?;
    policy.revision = revision as u64;
    policy.published_at = now;
    let bytes = canonical_bytes(&policy)?;
    if bytes.len() > policy_dto::MAX_POLICY_BYTES {
        return Err(ApiError::bad_request("canonical policy exceeds 64 KiB"));
    }
    let checksum = digest(&bytes);
    policy_db::insert_policy(
        &mut tx,
        household_id,
        revision,
        POLICY_SCHEMA_VERSION,
        &bytes,
        &checksum,
        "publish",
        None,
        now,
        actor,
    )
    .await?;
    policy_db::prune_history_on_conn(&mut tx, household_id, policy_dto::MAX_POLICY_HISTORY).await?;
    tx.commit().await?;
    Ok(PublishResponse {
        revision: revision as u64,
        body_sha256: checksum,
        status: "saved",
    })
}

/// Restore prior content as a NEW monotonic revision. Nothing is reset; the
/// source revision remains recorded as provenance, while its payload follows
/// the normal bounded-history retention policy.
pub async fn rollback(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    body: RollbackBody,
    now: DateTime<Utc>,
) -> ApiResult<PublishResponse> {
    if !valid_revision(body.source_revision) {
        return Err(ApiError::bad_request(
            "source_revision is outside its bound",
        ));
    }
    if let Some(expected) = body.expected_revision {
        if !valid_revision(expected) {
            return Err(ApiError::bad_request(
                "expected_revision is outside its bound",
            ));
        }
    }
    let source = body.source_revision as i64;

    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    if !policy_db::policy_exists_on_conn(&mut tx, household_id, source).await? {
        return Err(ApiError::not_found(
            "policy revision not found in this household",
        ));
    }
    let current = policy_db::current_revision_on_conn(&mut tx, household_id).await?;
    if let Some(expected) = body.expected_revision {
        if expected as i64 != current {
            return Err(ApiError::conflict("expected revision is stale"));
        }
    }
    let revision = current
        .checked_add(1)
        .ok_or_else(|| ApiError::conflict("policy revision counter exhausted"))?;

    let Some((stored, schema_version, _, _)) =
        policy_db::policy_body_on_conn(&mut tx, household_id, source).await?
    else {
        return Err(ApiError::not_found(
            "policy revision not found in this household",
        ));
    };
    if schema_version != POLICY_SCHEMA_VERSION {
        return Err(ApiError::conflict("unsupported stored policy schema"));
    }
    let mut policy: vantyr_network_policy::Policy =
        serde_json::from_slice(&stored).map_err(|e| ApiError::Internal(e.into()))?;
    if policy.household_id != household_id {
        return Err(ApiError::not_found(
            "policy revision not found in this household",
        ));
    }
    policy.revision = revision as u64;
    policy.published_at = now;
    // Rollback never resurrects unverifiable grants.
    policy.person_rules.clear();
    policy.exceptions.clear();
    let bytes = canonical_bytes(&policy)?;
    if bytes.len() > policy_dto::MAX_POLICY_BYTES {
        return Err(ApiError::bad_request("canonical policy exceeds 64 KiB"));
    }
    let checksum = digest(&bytes);
    policy_db::insert_policy(
        &mut tx,
        household_id,
        revision,
        POLICY_SCHEMA_VERSION,
        &bytes,
        &checksum,
        "rollback",
        Some(source),
        now,
        actor,
    )
    .await?;
    policy_db::prune_history_on_conn(&mut tx, household_id, policy_dto::MAX_POLICY_HISTORY).await?;
    tx.commit().await?;
    Ok(PublishResponse {
        revision: revision as u64,
        body_sha256: checksum,
        status: "saved",
    })
}

/// Save (propose) a desired revision for an active gateway in the same
/// household and of the gateway's own stored kind. No applied/enforced state
/// is written and no acknowledgement endpoint is exposed in this slice.
pub async fn set_desired(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    gateway_id: Uuid,
    body: DesiredPolicyBody,
) -> ApiResult<DesiredPolicy> {
    if !valid_revision(body.revision) {
        return Err(ApiError::bad_request("revision is outside its bound"));
    }
    let mut tx = pool.begin().await?;
    // Global h -> g lock order, then the policy row is read in the same tx.
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Err(scoped_not_found());
    }
    let Some(kind) =
        gateway_db::active_gateway_kind_on_conn(&mut tx, household_id, gateway_id).await?
    else {
        return Err(scoped_not_found());
    };
    let revision = body.revision as i64;
    if !policy_db::policy_exists_on_conn(&mut tx, household_id, revision).await? {
        return Err(ApiError::not_found(
            "policy revision not found in this household",
        ));
    }
    policy_db::upsert_desired(&mut tx, household_id, gateway_id, &kind, revision, actor).await?;
    let desired = policy_db::get_desired_on_conn(&mut tx, household_id, gateway_id)
        .await?
        .ok_or_else(scoped_not_found)?;
    tx.commit().await?;
    Ok(desired)
}

/// Scoped worker retrieval. The bearer credential must be active, unrevoked,
/// in the exact household/gateway/kind it claims, carry the explicit
/// `read_policy` command and hold no cookie or dashboard session.
pub async fn read_policy(
    pool: &PgPool,
    bearer: Option<&str>,
    body: super::policy_dto::ReadPolicyBody,
    now: DateTime<Utc>,
) -> ApiResult<PolicyReadResponse> {
    let (credential_id, secret) =
        gateway_auth::parse_bearer(bearer).ok_or_else(worker_auth_error)?;
    if body.audience != gateway_auth::AUDIENCE || body.command != gateway_auth::COMMAND_READ_POLICY
    {
        return Err(worker_auth_error());
    }
    let kind = super::gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())?;

    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, body.household_id, body.gateway_id).await? {
        return Err(worker_auth_error());
    }
    let Some(cred) = gateway_db::auth_credential_scoped(
        &mut tx,
        credential_id,
        body.household_id,
        body.gateway_id,
        &kind,
    )
    .await?
    else {
        return Err(worker_auth_error());
    };
    if !gateway_auth::verify_secret(secret, &cred.secret_hash) {
        return Err(worker_auth_error());
    }
    if cred.revoked_at.is_some()
        || cred.gateway_revoked_at.is_some()
        || !cred.gateway_enabled
        || cred.expires_at <= now
        || cred.audience != gateway_auth::AUDIENCE
        || !cred
            .allowed_commands
            .iter()
            .any(|c| c == gateway_auth::COMMAND_READ_POLICY)
    {
        return Err(worker_auth_error());
    }
    gateway_db::mark_credential_used(&mut tx, cred.id).await?;

    let Some(desired) =
        policy_db::get_desired_on_conn(&mut tx, cred.household_id, cred.gateway_id).await?
    else {
        return Err(ApiError::not_found(
            "no policy assigned to this gateway in this household",
        ));
    };
    if desired.kind != kind {
        return Err(worker_auth_error());
    }
    let Some((stored, schema_version, _db_published_at, body_sha256)) =
        policy_db::policy_body_on_conn(&mut tx, cred.household_id, desired.revision).await?
    else {
        return Err(ApiError::not_found(
            "no policy assigned to this gateway in this household",
        ));
    };
    if schema_version != POLICY_SCHEMA_VERSION {
        return Err(ApiError::not_found("unsupported stored policy schema"));
    }
    let policy: vantyr_network_policy::Policy =
        serde_json::from_slice(&stored).map_err(|e| ApiError::Internal(e.into()))?;
    if policy.household_id != cred.household_id || policy.revision != desired.revision as u64 {
        return Err(ApiError::not_found(
            "no policy assigned to this gateway in this household",
        ));
    }
    tx.commit().await?;
    Ok(PolicyReadResponse {
        gateway_id: cred.gateway_id,
        revision: policy.revision,
        original_published_at: policy.published_at,
        schema_version,
        policy,
        body_sha256,
    })
}
