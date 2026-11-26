//! Atomic BYOD enrollment transitions and authorization.
//!
//! Every mutator opens ONE transaction and locks the household row first, so a
//! binding revoke, device end, grant consume and session end for the same
//! household cannot interleave. The exact lock order after that prefix is
//! binding -> grant -> device enrollment -> session: the consume path reads
//! and locks the grant before its device enrollment and the target session.
//! No plaintext secret, digest or person/device claim is logged here.
//!
//! Scope is intentionally narrow: this service issues one-time scoped grants
//! and records time-bounded verified sessions. It never produces proxy
//! credentials, never installs trust material and never claims network coverage.

use axum::http::StatusCode;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::authz::{has_grant, NetworkGrant};
use super::enroll_auth::{self, Secret, VERIFICATION_OIDC};
use super::enroll_db::{self, AttemptOutcome, BindingRec, EndReason};
use super::enroll_retention::{AttemptRetention, RecordRetention};

/// Hard cap on concurrent live device enrollments per household, checked under
/// the household lock. Historical enrollments and inventory are retained separately.
pub const MAX_LIVE_ENROLLMENTS_PER_HOUSEHOLD: i64 = 100;

/// An authenticated user may enroll only with BOTH the explicit grant and an
/// active admin-created principal binding in this household. Both checks fail
/// with the same 403 so neither half can be probed.
pub async fn require_enrollment(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
) -> ApiResult<BindingRec> {
    let allowed = has_grant(pool, user_id, household_id, NetworkGrant::Enroll)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    if !allowed {
        return Err(ApiError::forbidden());
    }
    enroll_db::active_binding(pool, household_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or_else(ApiError::forbidden)
}

/// Re-check the *exact* grant inside the transaction that holds the household
/// row lock. `require_enrollment` above only authorized the HTTP request: an
/// admin can revoke `network_enroll` after that check but before this mutator
/// obtains the lock. Without this recheck the stale request would still issue
/// a grant, consume one or register a device. Every self mutator calls this.
async fn require_enroll_grant_on_conn(
    conn: &mut sqlx::PgConnection,
    household_id: Uuid,
    user_id: Uuid,
) -> ApiResult<()> {
    let allowed =
        enroll_db::has_grant_on_conn(conn, household_id, user_id, NetworkGrant::Enroll.as_str())
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

// ─── Admin: explicit principal bindings ──────────────────────────────────────

/// Map an existing dashboard user to an existing person in this household. The
/// dashboard user id is chosen explicitly by the admin and checked against the
/// real `dashboard_users` row; it is never inferred from a person profile,
/// device, IP or self-asserted body claim. Re-mapping bumps the generation and
/// invalidates everything issued under the old principal.
pub async fn map_binding(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    person_id: Uuid,
    user_id: Uuid,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    if !enroll_db::person_in_household_on_conn(&mut tx, household_id, person_id).await? {
        return Err(ApiError::not_found("person not found in this household"));
    }
    if !enroll_db::dashboard_user_exists_on_conn(&mut tx, user_id).await? {
        return Err(ApiError::not_found("dashboard user not found"));
    }
    let existing = enroll_db::binding_by_user_on_conn(&mut tx, household_id, user_id).await?;
    if let Some(ref binding) = existing {
        if binding.active && binding.person_id == person_id {
            // Idempotent mapping: no generation bump, no invalidation.
            tx.commit().await?;
            return Ok(binding.id);
        }
    }
    let id =
        enroll_db::upsert_binding_on_conn(&mut tx, household_id, user_id, person_id, actor).await?;
    if let Some(old) = existing {
        let now = Utc::now();
        // Generation changed: close everything bound to the old principal
        // before the new generation can be used.
        enroll_db::revoke_grants_for_binding_on_conn(&mut tx, household_id, old.id, now).await?;
        enroll_db::end_sessions_for_binding_on_conn(
            &mut tx,
            household_id,
            old.id,
            now,
            EndReason::GenerationChanged,
        )
        .await?;
        enroll_db::end_device_enrollments_for_binding_on_conn(&mut tx, household_id, old.id, now)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

/// Revoke a binding and, in the same transaction, every outstanding grant,
/// verified session and device enrollment it owns. The generation bump makes
/// any row that escaped the explicit updates unusable at consume time.
pub async fn revoke_binding(
    pool: &PgPool,
    household_id: Uuid,
    binding_id: Uuid,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    let Some(binding) = enroll_db::binding_by_id_on_conn(&mut tx, household_id, binding_id).await?
    else {
        return Err(ApiError::not_found("principal binding not found"));
    };
    if !binding.active {
        return Ok(false);
    }
    let now = Utc::now();
    enroll_db::revoke_grants_for_binding_on_conn(&mut tx, household_id, binding_id, now).await?;
    enroll_db::end_sessions_for_binding_on_conn(
        &mut tx,
        household_id,
        binding_id,
        now,
        EndReason::BindingRevoked,
    )
    .await?;
    enroll_db::end_device_enrollments_for_binding_on_conn(&mut tx, household_id, binding_id, now)
        .await?;
    enroll_db::revoke_binding_on_conn(&mut tx, household_id, binding_id, now).await?;
    tx.commit().await?;
    Ok(true)
}

// ─── Device enrollment ───────────────────────────────────────────────────────

/// Admin pre-authorization of an EXISTING household device to a binding. The
/// caller never supplies a canonical key; the device must already exist in the
/// household and must not be live-enrolled by any binding.
pub async fn authorize_device(
    pool: &PgPool,
    household_id: Uuid,
    actor: Uuid,
    binding_id: Uuid,
    device_id: Uuid,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    let Some(binding) = enroll_db::binding_by_id_on_conn(&mut tx, household_id, binding_id).await?
    else {
        return Err(ApiError::not_found("principal binding not found"));
    };
    if !binding.active {
        return Err(ApiError::bad_request("principal binding is not active"));
    }
    if !enroll_db::device_in_household_on_conn(&mut tx, household_id, device_id).await? {
        return Err(ApiError::not_found("device not found in this household"));
    }
    if enroll_db::count_live_enrollments_on_conn(&mut tx, household_id).await?
        >= MAX_LIVE_ENROLLMENTS_PER_HOUSEHOLD
    {
        return Err(ApiError::conflict(
            "live enrollment cap reached for this household",
        ));
    }
    if enroll_db::live_enrollment_for_device_on_conn(&mut tx, household_id, device_id).await? {
        return Err(ApiError::conflict(
            "device already has a live enrollment in this household",
        ));
    }
    let id = enroll_db::insert_device_enrollment_on_conn(
        &mut tx,
        household_id,
        binding_id,
        device_id,
        binding.generation,
        Some(actor),
        "authorized",
    )
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// Self-registration creates a NEW device with a server-generated canonical
/// key. The body cannot name an existing device id, so a caller cannot claim a
/// household device they do not own or hold an authorization for.
pub async fn self_register_device(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    label: &str,
    device_type: &str,
    shared: bool,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    require_enroll_grant_on_conn(&mut tx, household_id, user_id).await?;
    let Some(binding) = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id).await?
    else {
        return Err(ApiError::forbidden());
    };
    if enroll_db::count_live_enrollments_on_conn(&mut tx, household_id).await?
        >= MAX_LIVE_ENROLLMENTS_PER_HOUSEHOLD
    {
        return Err(ApiError::conflict(
            "live enrollment cap reached for this household",
        ));
    }
    let device_id = enroll_db::insert_device_on_conn(
        &mut tx,
        household_id,
        &enroll_auth::new_canonical_key(),
        label,
        device_type,
        shared,
    )
    .await?;
    enroll_db::insert_device_enrollment_on_conn(
        &mut tx,
        household_id,
        binding.id,
        device_id,
        binding.generation,
        None,
        "active",
    )
    .await?;
    tx.commit().await?;
    Ok(device_id)
}

// ─── One-time grants ─────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct GrantOutcome {
    pub grant_id: Uuid,
    pub secret: Secret,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub purpose: &'static str,
    pub expires_at: DateTime<Utc>,
}

/// Issue a server-authenticated, single-purpose, short-lived grant bound to the
/// caller's real AuthUser, the household, the binding generation and one
/// explicitly authorized device. The plaintext secret is returned ONCE from
/// here; only its hash is written.
pub async fn issue_grant(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    device_id: Uuid,
    purpose: &'static str,
    ttl_secs: i64,
) -> ApiResult<GrantOutcome> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    require_enroll_grant_on_conn(&mut tx, household_id, user_id).await?;
    let Some(binding) = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id).await?
    else {
        return Err(ApiError::forbidden());
    };
    let Some(enrollment) =
        enroll_db::device_enrollment_on_conn(&mut tx, household_id, device_id, binding.id).await?
    else {
        return Err(ApiError::not_found(
            "device is not enrolled to this account",
        ));
    };
    if enrollment.generation != binding.generation {
        return Err(ApiError::forbidden());
    }
    let now = Utc::now();
    let expires_at = now + ChronoDuration::seconds(ttl_secs);
    let secret = enroll_auth::new_secret();
    let grant_id = enroll_db::insert_grant_on_conn(
        &mut tx,
        household_id,
        binding.id,
        enrollment.id,
        device_id,
        user_id,
        binding.person_id,
        binding.generation,
        purpose,
        &enroll_auth::hash_secret(&secret),
        expires_at,
    )
    .await?;
    // Write-time bound: retired grants never accumulate without limit.
    let retention = RecordRetention::from_env().clamped();
    enroll_db::prune_grants_for_household_on_conn(
        &mut tx,
        household_id,
        retention.cutoff(now),
        now,
        retention.max_per_household,
    )
    .await?;
    tx.commit().await?;
    Ok(GrantOutcome {
        grant_id,
        secret,
        household_id,
        device_id,
        purpose,
        expires_at,
    })
}

// ─── Grant consumption ───────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SessionOutcome {
    pub session_id: Uuid,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub purpose: &'static str,
    pub verification_method: &'static str,
    pub verified_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

type ConsumeFailure = (ApiError, AttemptOutcome, Option<Uuid>);

fn failed(err: ApiError, code: AttemptOutcome, binding: Option<Uuid>) -> ConsumeFailure {
    (err, code, binding)
}

fn consume_denied(binding: Option<Uuid>) -> ConsumeFailure {
    failed(
        ApiError::status(
            StatusCode::FORBIDDEN,
            "enrollment grant could not be consumed",
        ),
        AttemptOutcome::WrongScope,
        binding,
    )
}

/// All checks happen inside the household lock. A failed check records a
/// bounded outcome code and leaves the grant untouched, so a wrong device,
/// purpose, household or secret cannot burn a valid grant. Only a fully valid
/// consume marks the grant used AND creates the session atomically.
#[allow(clippy::too_many_arguments)] // One locked transaction; all fields are bound scope.
async fn consume_inner(
    conn: &mut PgConnection,
    household_id: Uuid,
    user_id: Uuid,
    grant_id: Uuid,
    provided: &Secret,
    purpose: &'static str,
    device_id: Uuid,
    now: DateTime<Utc>,
) -> Result<SessionOutcome, ConsumeFailure> {
    if let Err(e) = require_enroll_grant_on_conn(conn, household_id, user_id).await {
        return Err((e, AttemptOutcome::WrongScope, None));
    }
    let Some(binding) = enroll_db::active_binding_on_conn(conn, household_id, user_id)
        .await
        .map_err(|e| {
            failed(
                ApiError::Internal(e.into()),
                AttemptOutcome::NotActive,
                None,
            )
        })?
    else {
        return Err(failed(
            ApiError::forbidden(),
            AttemptOutcome::NotActive,
            None,
        ));
    };
    let Some(grant) = enroll_db::grant_on_conn(conn, household_id, grant_id)
        .await
        .map_err(|e| {
            failed(
                ApiError::Internal(e.into()),
                AttemptOutcome::NotFound,
                Some(binding.id),
            )
        })?
    else {
        return Err(failed(
            ApiError::not_found("enrollment grant not found"),
            AttemptOutcome::NotFound,
            Some(binding.id),
        ));
    };

    // Scope checks: no secret comparison until the caller, device and purpose
    // all match the grant. All failures here keep the grant consumable.
    if grant.dashboard_user != user_id || grant.binding_id != binding.id {
        return Err(consume_denied(Some(binding.id)));
    }
    if grant.purpose != purpose {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::WrongPurpose,
            Some(binding.id),
        ));
    }
    if grant.device_id != device_id {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::WrongDevice,
            Some(binding.id),
        ));
    }
    if grant.consumed_at.is_some() || grant.revoked_at.is_some() {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::Revoked,
            Some(binding.id),
        ));
    }
    if grant.generation != binding.generation {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::GenerationMismatch,
            Some(binding.id),
        ));
    }
    if grant.expires_at <= now {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::Expired,
            Some(binding.id),
        ));
    }
    if grant.verification_method != VERIFICATION_OIDC {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::NotActive,
            Some(binding.id),
        ));
    }
    let Some(enrollment) =
        enroll_db::device_enrollment_on_conn(conn, household_id, grant.device_id, binding.id)
            .await
            .map_err(|e| {
                failed(
                    ApiError::Internal(e.into()),
                    AttemptOutcome::NotActive,
                    Some(binding.id),
                )
            })?
    else {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::NotActive,
            Some(binding.id),
        ));
    };
    if enrollment.id != grant.device_enrollment_id || enrollment.generation != binding.generation {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::GenerationMismatch,
            Some(binding.id),
        ));
    }
    if !enroll_auth::verify_secret(provided, &grant.secret_hash) {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::WrongSecret,
            Some(binding.id),
        ));
    }

    // Conservative concurrent-device policy: one live session per device. An
    // already-expired row is closed here so a new verified person can start.
    if let Some(live) =
        enroll_db::live_session_for_device_on_conn(conn, household_id, grant.device_id)
            .await
            .map_err(|e| {
                failed(
                    ApiError::Internal(e.into()),
                    AttemptOutcome::SessionConflict,
                    Some(binding.id),
                )
            })?
    {
        if live.ended_at.is_none() && live.expires_at > now {
            return Err(failed(
                ApiError::conflict("an active session already exists on this device"),
                AttemptOutcome::SessionConflict,
                Some(binding.id),
            ));
        }
        if live.ended_at.is_none() {
            enroll_db::end_session_on_conn(conn, household_id, live.id, now, EndReason::Expired)
                .await
                .map_err(|e| {
                    failed(
                        ApiError::Internal(e.into()),
                        AttemptOutcome::SessionConflict,
                        Some(binding.id),
                    )
                })?;
        }
    }

    let consumed = enroll_db::consume_grant_on_conn(conn, household_id, grant_id, now)
        .await
        .map_err(|e| {
            failed(
                ApiError::Internal(e.into()),
                AttemptOutcome::Revoked,
                Some(binding.id),
            )
        })?;
    if !consumed {
        return Err(failed(
            ApiError::status(
                StatusCode::FORBIDDEN,
                "enrollment grant could not be consumed",
            ),
            AttemptOutcome::Revoked,
            Some(binding.id),
        ));
    }
    let session_id = enroll_db::insert_session_on_conn(
        conn,
        household_id,
        binding.id,
        grant.device_id,
        grant.dashboard_user,
        grant.person_id,
        grant.generation,
        grant.purpose.as_str(),
        now,
        now + ChronoDuration::seconds(enroll_auth::MAX_SESSION_SECS),
    )
    .await
    .map_err(|e| {
        failed(
            ApiError::Internal(e.into()),
            AttemptOutcome::SessionConflict,
            Some(binding.id),
        )
    })?;
    Ok(SessionOutcome {
        session_id,
        household_id,
        device_id: grant.device_id,
        purpose,
        verification_method: VERIFICATION_OIDC,
        verified_at: now,
        expires_at: now + ChronoDuration::seconds(enroll_auth::MAX_SESSION_SECS),
    })
}

pub async fn consume_grant(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    grant_id: Uuid,
    provided: Secret,
    purpose: &'static str,
    device_id: Uuid,
) -> ApiResult<SessionOutcome> {
    let now = Utc::now();
    let cfg = AttemptRetention::from_env().clamped();
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    match consume_inner(
        &mut tx,
        household_id,
        user_id,
        grant_id,
        &provided,
        purpose,
        device_id,
        now,
    )
    .await
    {
        Ok(outcome) => {
            let retention = RecordRetention::from_env().clamped();
            enroll_db::prune_sessions_for_household_on_conn(
                &mut tx,
                household_id,
                retention.cutoff(now),
                now,
                retention.max_per_household,
            )
            .await?;
            tx.commit().await?;
            Ok(outcome)
        }
        Err((err, code, binding)) => {
            enroll_db::record_attempt_on_conn(
                &mut tx,
                household_id,
                binding,
                Some(grant_id),
                now,
                &cfg,
                code,
            )
            .await?;
            tx.commit().await?;
            Err(err)
        }
    }
}

// ─── Self-service revocation / logout ────────────────────────────────────────

/// End ONE verified session. Only a session owned by this exact binding/user
/// in this household can be ended. Its outstanding (unconsumed) grants are
/// revoked for the SAME device and binding only: a grant already consumed or
/// bound to another device/binding is left alone. Report the count of revoked
/// grants so callers can see the effect without exposing any secret.
pub async fn end_session(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    session_id: Uuid,
) -> ApiResult<(bool, u64)> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    require_enroll_grant_on_conn(&mut tx, household_id, user_id).await?;
    let Some(binding) = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id).await?
    else {
        return Err(ApiError::forbidden());
    };
    let Some(device_id) =
        enroll_db::session_device_on_conn(&mut tx, household_id, binding.id, user_id, session_id)
            .await?
    else {
        return Err(ApiError::not_found("verified session not found"));
    };
    let now = Utc::now();
    let removed = enroll_db::end_own_session_on_conn(
        &mut tx,
        household_id,
        binding.id,
        user_id,
        session_id,
        now,
        EndReason::SelfEnd,
    )
    .await?;
    let revoked = enroll_db::revoke_grants_for_device_and_binding_on_conn(
        &mut tx,
        household_id,
        device_id,
        binding.id,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok((removed, revoked))
}

/// Network logout (NOT dashboard logout). Ends every verified session owned by
/// this authenticated user in this household AND revokes every outstanding
/// enrollment grant for that exact binding/household in the same transaction.
/// The dashboard OIDC session-cookie is untouched: the user can sign in again
/// and request a fresh grant, but no pre-logout grant can be consumed. The
/// shared `require_auth` middleware separately enforces dashboard logout.
pub async fn end_all_sessions(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
) -> ApiResult<(u64, u64)> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    require_enroll_grant_on_conn(&mut tx, household_id, user_id).await?;
    let Some(binding) = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id).await?
    else {
        return Err(ApiError::forbidden());
    };
    let now = Utc::now();
    let n = enroll_db::end_own_sessions_on_conn(
        &mut tx,
        household_id,
        binding.id,
        user_id,
        now,
        EndReason::SelfAll,
    )
    .await?;
    let revoked =
        enroll_db::revoke_grants_for_binding_on_conn(&mut tx, household_id, binding.id, now)
            .await?;
    tx.commit().await?;
    Ok((n, revoked))
}

/// End this account's device enrollment. Grants and verified sessions for the
/// device are invalidated in the same transaction; a still-live device from a
/// different binding cannot be ended through this route.
pub async fn end_device_enrollment(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    device_id: Uuid,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    enroll_db::lock_household(&mut tx, household_id).await?;
    require_enroll_grant_on_conn(&mut tx, household_id, user_id).await?;
    let Some(binding) = enroll_db::active_binding_on_conn(&mut tx, household_id, user_id).await?
    else {
        return Err(ApiError::forbidden());
    };
    let Some(enrollment) =
        enroll_db::device_enrollment_on_conn(&mut tx, household_id, device_id, binding.id).await?
    else {
        return Err(ApiError::not_found(
            "device is not enrolled to this account",
        ));
    };
    let now = Utc::now();
    enroll_db::revoke_grants_for_device_on_conn(&mut tx, household_id, device_id, now).await?;
    enroll_db::end_sessions_for_device_on_conn(
        &mut tx,
        household_id,
        device_id,
        now,
        EndReason::DeviceEnded,
    )
    .await?;
    enroll_db::end_enrollment_on_conn(&mut tx, household_id, device_id, binding.id, now).await?;
    tx.commit().await?;
    Ok(enrollment.status == "active" || enrollment.status == "authorized")
}
