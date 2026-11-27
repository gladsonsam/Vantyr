//! Atomic proxy credential/session/evidence authority.
//!
//! Every mutator opens ONE transaction and locks the household row first, then
//! re-checks the exact grant inside that transaction. A grant revoked after the
//! HTTP guard cannot still issue a credential. Person, device, generation and
//! household-kind are derived from authoritative rows, never from a label, IP
//! or body claim. Revocation ends owned sessions and invalidates unexpired
//! evidence in the SAME commit.

use axum::http::StatusCode;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::authz::{self, NetworkGrant};
use super::enroll_db;
use super::gateway_db;
use super::gateway_service;
use super::proxy_auth::{self, Secret};
use super::proxy_db::{self, OidcSession};
use super::proxy_dto::{
    CredentialRow, EvidenceBody, EvidenceProof, IssueBody, WorkerCredentialRow,
    WorkerIntrospectBody, WorkerSyncBody,
};
use super::{db, gateway_auth, gateway_dto};

/// Match the worker credential/binding caps. Checked under the household lock.
pub const MAX_LIVE_CREDENTIALS_PER_HOUSEHOLD: i64 = 256;
/// Retired rows are kept for audit before reclamation; replay state on a still
/// live receipt is never evicted to make room.
const RETIRE_RETENTION: ChronoDuration = ChronoDuration::days(30);

/// Worker routes fail closed with a generic error; no claim about which check
/// failed is returned to a caller holding an untrusted bearer.
fn worker_auth_error() -> ApiError {
    ApiError::Status(
        StatusCode::UNAUTHORIZED,
        "invalid proxy introspection credential".to_string(),
    )
}

fn evidence_denied() -> ApiError {
    ApiError::status(
        StatusCode::FORBIDDEN,
        "session evidence is not valid for this scope",
    )
}

async fn require_admin_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
) -> ApiResult<()> {
    let allowed =
        authz::has_grant_on_conn(conn, user_id, household_id, NetworkGrant::Admin).await?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

async fn require_enroll_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
) -> ApiResult<()> {
    let allowed =
        authz::has_grant_on_conn(conn, user_id, household_id, NetworkGrant::Enroll).await?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

pub struct IssueOutcome {
    pub credential: CredentialRow,
    pub secret: Secret,
    pub expires_at: DateTime<Utc>,
}

/// Issue a person-scoped, device-bound proxy credential. The person and device
/// must exist in the same household, and an active OIDC-backed verified session
/// must prove the current person on that device. `network_admin` alone cannot
/// act as an implicit self-login.
pub async fn issue_credential(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    body: IssueBody,
    now: DateTime<Utc>,
) -> ApiResult<IssueOutcome> {
    let label = proxy_auth::normalize_label(&body.label)
        .map_err(|()| ApiError::bad_request("invalid label"))?;
    let secs = body
        .expires_in_hours
        .checked_mul(3600)
        .ok_or_else(|| ApiError::bad_request("expires_in_hours is out of range"))?;
    let ttl_secs = proxy_auth::normalize_credential_secs(secs)
        .map_err(|()| ApiError::bad_request("expires_in_hours must be between 1 and 720"))?;
    let scopes = proxy_auth::normalize_scopes(body.scopes.as_deref())
        .map_err(|()| ApiError::bad_request("scopes must be proxy_connect and/or proxy_http"))?;

    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_on_conn(&mut tx, household_id, actor).await?;
    if !enroll_db::person_in_household_on_conn(&mut tx, household_id, body.person_id).await? {
        return Err(ApiError::not_found("person not found in this household"));
    }

    // Optional device: derive from the person's active OIDC-backed session when
    // omitted. A caller cannot bind a credential to a device they did not prove.
    let device_id = match body.device_id {
        Some(device_id) => {
            if !enroll_db::device_in_household_on_conn(&mut tx, household_id, device_id).await? {
                return Err(ApiError::not_found("device not found in this household"));
            }
            device_id
        }
        None => proxy_db::latest_oidc_session_for_person_on_conn(
            &mut tx,
            household_id,
            body.person_id,
            now,
        )
        .await?
        .map(|(device_id, _)| device_id)
        .ok_or_else(|| {
            ApiError::conflict("no active OIDC sign-in exists to bind this credential to a device")
        })?,
    };

    let device_scope = proxy_db::device_scope_on_conn(&mut tx, household_id, device_id)
        .await?
        .ok_or_else(|| ApiError::not_found("device not found in this household"))?;
    if device_scope.shared {
        // A shared device can never attribute a verified person; the worker
        // enforces the same rule. Fail closed rather than issue a misleading row.
        return Err(ApiError::conflict(
            "a shared device cannot carry a person-scoped proxy credential",
        ));
    }
    let household_kind = "personal";

    let session: OidcSession =
        proxy_db::live_oidc_session_on_conn(&mut tx, household_id, body.person_id, device_id, now)
            .await?
            .ok_or_else(|| {
                ApiError::conflict("the person has no active OIDC-backed sign-in on this device")
            })?;

    if proxy_db::count_live_credentials_on_conn(&mut tx, household_id, now).await?
        >= MAX_LIVE_CREDENTIALS_PER_HOUSEHOLD
    {
        return Err(ApiError::conflict(
            "live proxy credential cap reached for this household",
        ));
    }

    let id = proxy_auth::new_id();
    let secret = proxy_auth::new_secret();
    let hash = proxy_auth::hash_secret(&secret);
    let expires_at = now + ChronoDuration::seconds(ttl_secs);
    proxy_db::insert_credential_on_conn(
        &mut tx,
        id,
        household_id,
        body.person_id,
        device_id,
        &label,
        &scopes,
        &hash,
        session.generation,
        household_kind,
        actor,
        expires_at,
    )
    .await?;
    proxy_db::prune_retired_on_conn(&mut tx, household_id, now - RETIRE_RETENTION).await?;
    let person_label = proxy_db::person_label_on_conn(&mut tx, household_id, body.person_id)
        .await?
        .unwrap_or_default();
    tx.commit().await?;

    Ok(IssueOutcome {
        credential: CredentialRow {
            id,
            label,
            person_id: body.person_id,
            person_label,
            device_id,
            created_at: now,
            expires_at,
            last_used_at: None,
            revoked: false,
            revoked_at: None,
            scopes,
        },
        secret,
        expires_at,
    })
}

/// Revoke one credential and, in the SAME transaction, end every live session
/// it owns and invalidate every unexpired evidence receipt.
pub async fn revoke_one(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    credential_id: Uuid,
    now: DateTime<Utc>,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_on_conn(&mut tx, household_id, actor).await?;
    if !proxy_db::revoke_credential_on_conn(&mut tx, household_id, credential_id, now).await? {
        return Ok(false);
    }
    proxy_db::end_sessions_for_credential_on_conn(&mut tx, household_id, credential_id, now)
        .await?;
    proxy_db::revoke_evidence_for_credential_on_conn(&mut tx, household_id, credential_id, now)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// Revoke every credential for this exact person id in the household, by id
/// only — never by label, device, IP or an asserted claim. Atomic with session
/// ends and evidence invalidation.
pub async fn revoke_all_for_person(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    person_id: Uuid,
    now: DateTime<Utc>,
) -> ApiResult<u64> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_on_conn(&mut tx, household_id, actor).await?;
    if !enroll_db::person_in_household_on_conn(&mut tx, household_id, person_id).await? {
        return Err(ApiError::not_found("person not found in this household"));
    }
    let revoked =
        proxy_db::revoke_all_for_person_on_conn(&mut tx, household_id, person_id, now).await?;
    proxy_db::end_sessions_for_person_on_conn(&mut tx, household_id, person_id, now).await?;
    proxy_db::revoke_evidence_for_person_on_conn(&mut tx, household_id, person_id, now).await?;
    tx.commit().await?;
    Ok(revoked)
}

pub async fn end_session(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    session_id: Uuid,
    now: DateTime<Utc>,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_on_conn(&mut tx, household_id, actor).await?;
    if !proxy_db::session_in_scope_on_conn(&mut tx, household_id, session_id).await? {
        return Ok(false);
    }
    if !proxy_db::end_session_on_conn(&mut tx, household_id, session_id, now).await? {
        return Ok(false);
    }
    proxy_db::revoke_evidence_for_session_on_conn(&mut tx, household_id, session_id, now).await?;
    tx.commit().await?;
    Ok(true)
}

/// The exact worker-wire evidence shape (field order defines the digest).
#[derive(Debug, Serialize)]
struct WireEvidence {
    schema: u32,
    session_id: Uuid,
    household_id: Uuid,
    device_id: Uuid,
    verified_person: Option<Uuid>,
    binding_generation: i64,
    household_kind: String,
    audience: String,
    command: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    nonce: String,
}

pub struct EvidenceOutcome {
    pub bytes: Vec<u8>,
    pub expires_at: DateTime<Utc>,
}

/// Issue one single-use evidence receipt from an OIDC-backed session. The
/// caller must hold the explicit `network_enroll` grant and an active binding
/// whose person matches the credential. No person id is accepted from the body.
pub async fn issue_evidence(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    body: EvidenceBody,
    now: DateTime<Utc>,
) -> ApiResult<EvidenceOutcome> {
    let command = match body.command.as_str() {
        proxy_auth::COMMAND_PROXY_CONNECT => proxy_auth::COMMAND_PROXY_CONNECT,
        proxy_auth::COMMAND_PROXY_HTTP => proxy_auth::COMMAND_PROXY_HTTP,
        _ => {
            return Err(ApiError::bad_request(
                "command is not in the proxy allowlist",
            ))
        }
    };

    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_enroll_on_conn(&mut tx, household_id, user_id).await?;
    let binding = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id)
        .await?
        .ok_or_else(ApiError::forbidden)?;
    let credential =
        proxy_db::credential_for_evidence_on_conn(&mut tx, household_id, body.credential_id)
            .await?
            .ok_or_else(|| ApiError::not_found("proxy credential not found in this household"))?;
    if credential.revoked_at.is_some() || credential.expires_at <= now {
        return Err(ApiError::conflict("proxy credential is not active"));
    }
    if credential.person_id != binding.person_id {
        return Err(ApiError::forbidden());
    }
    if !credential.scopes.iter().any(|c| c == command) {
        return Err(ApiError::bad_request(
            "command is not allowed by this credential",
        ));
    }
    let session = proxy_db::live_oidc_session_on_conn(
        &mut tx,
        household_id,
        credential.person_id,
        credential.device_id,
        now,
    )
    .await?
    .ok_or_else(|| {
        ApiError::conflict("no active OIDC-backed sign-in for this person and device")
    })?;

    let expires_at = [
        credential.expires_at,
        session.expires_at,
        now + ChronoDuration::seconds(proxy_auth::MAX_EVIDENCE_SECS),
    ]
    .into_iter()
    .min()
    .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("empty expiry set")))?;
    if expires_at <= now + ChronoDuration::seconds(proxy_auth::MIN_EVIDENCE_SECS) {
        return Err(ApiError::conflict("no active sign-in window remains"));
    }

    let session_id = proxy_auth::new_id();
    let nonce = proxy_auth::new_nonce();
    let evidence = WireEvidence {
        schema: 1,
        session_id,
        household_id,
        device_id: credential.device_id,
        verified_person: Some(credential.person_id),
        binding_generation: credential.binding_generation,
        household_kind: credential.household_kind.clone(),
        audience: proxy_auth::EVIDENCE_AUDIENCE.to_string(),
        command: command.to_string(),
        issued_at: now,
        expires_at,
        nonce: nonce.clone(),
    };
    let bytes = serde_json::to_vec(&evidence)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("evidence serialization failed: {e}")))?;
    if bytes.len() > proxy_auth::MAX_EVIDENCE_BYTES {
        return Err(ApiError::bad_request("evidence exceeds the bounded size"));
    }
    let digest = proxy_auth::hash_bytes(&bytes);
    proxy_db::insert_evidence_on_conn(
        &mut tx,
        session_id,
        household_id,
        body.credential_id,
        credential.device_id,
        Some(credential.person_id),
        credential.binding_generation,
        &credential.household_kind,
        command,
        &digest,
        &nonce,
        now,
        expires_at,
    )
    .await?;
    proxy_db::insert_session_on_conn(
        &mut tx,
        session_id,
        household_id,
        body.credential_id,
        credential.device_id,
        credential.person_id,
        credential.binding_generation,
        &credential.household_kind,
        expires_at,
    )
    .await?;
    proxy_db::prune_retired_on_conn(&mut tx, household_id, now - RETIRE_RETENTION).await?;
    tx.commit().await?;
    Ok(EvidenceOutcome { bytes, expires_at })
}

async fn authorize_proxy_worker_on_conn(
    conn: &mut PgConnection,
    bearer: Option<&str>,
    body: &WorkerSyncBody,
    now: DateTime<Utc>,
) -> ApiResult<()> {
    if body.audience != gateway_auth::AUDIENCE
        || body.command != gateway_auth::COMMAND_INTROSPECT_PROXY
    {
        return Err(worker_auth_error());
    }
    if gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())? != proxy_auth::KIND
    {
        return Err(worker_auth_error());
    }
    // The shared helper re-checks audience, command, kind, household, gateway,
    // expiry, revocation and constant-time possession of the secret.
    let _ = gateway_service::authorize_worker_on_conn(
        conn,
        bearer,
        body.household_id,
        body.gateway_id,
        "proxy",
        gateway_auth::COMMAND_INTROSPECT_PROXY,
        now,
    )
    .await?;
    Ok(())
}

pub struct WorkerSyncOutcome {
    pub credentials: Vec<WorkerCredentialRow>,
    pub assignments: Vec<super::proxy_dto::WorkerAssignmentRow>,
}

pub async fn worker_sync(
    pool: &PgPool,
    bearer: Option<&str>,
    body: WorkerSyncBody,
    now: DateTime<Utc>,
) -> ApiResult<WorkerSyncOutcome> {
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, body.household_id, body.gateway_id).await? {
        return Err(worker_auth_error());
    }
    authorize_proxy_worker_on_conn(&mut tx, bearer, &body, now).await?;
    let credentials = proxy_db::worker_credentials_on_conn(&mut tx, body.household_id).await?;
    let assignments = proxy_db::worker_assignments_on_conn(&mut tx, body.household_id).await?;
    tx.commit().await?;
    Ok(WorkerSyncOutcome {
        credentials,
        assignments,
    })
}

pub async fn worker_introspect(
    pool: &PgPool,
    bearer: Option<&str>,
    body: WorkerIntrospectBody,
    now: DateTime<Utc>,
) -> ApiResult<EvidenceProof> {
    if body.evidence.is_empty() || body.evidence.len() > proxy_auth::MAX_EVIDENCE_BYTES {
        return Err(evidence_denied());
    }
    let sync_body = WorkerSyncBody {
        audience: body.audience,
        household_id: body.household_id,
        gateway_id: body.gateway_id,
        kind: body.kind,
        command: body.command,
    };
    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(
        &mut tx,
        sync_body.household_id,
        sync_body.gateway_id,
    )
    .await?
    {
        return Err(worker_auth_error());
    }
    authorize_proxy_worker_on_conn(&mut tx, bearer, &sync_body, now).await?;
    let digest = proxy_auth::hash_bytes(body.evidence.as_bytes());
    let proof = proxy_db::consume_evidence_on_conn(&mut tx, sync_body.household_id, &digest, now)
        .await?
        .ok_or_else(evidence_denied)?;
    proxy_db::touch_credential_on_conn(&mut tx, sync_body.household_id, proof.credential_id, now)
        .await?;
    tx.commit().await?;
    Ok(proof)
}
