//! Dashboard API: create 6-digit pairing codes and review pending agent claims.

use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;

use crate::auth;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use std::net::SocketAddr;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateEnrollmentTokenBody {
    /// How many pending claims can use this pairing code (default 1).
    #[serde(default = "default_uses")]
    pub uses: i32,
    /// Hours until expiry; omit = no expiry.
    pub expires_in_hours: Option<i64>,
    pub note: Option<String>,
    /// Explicit replacement of this identity; generic invitations never merge devices.
    pub bound_agent_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ApproveClaimBody {
    pub agent_name: Option<String>,
    pub group_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct RejectClaimBody {
    pub error: Option<String>,
}

const fn default_uses() -> i32 {
    1
}

/// Admin: mDNS mode and agent WSS URL for onboarding copy (mirrors `mdns_broadcast` rules).
pub async fn get_agent_setup_hints(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let hints = crate::mdns_broadcast::build_agent_setup_hints(state.agent_listen_port);
    Ok((StatusCode::OK, Json(hints)))
}

pub async fn create_enrollment_token(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateEnrollmentTokenBody>,
) -> ApiResult<Response> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }

    if let Some(id) = body.bound_agent_id {
        return super::agents_list::replace_agent_installation(
            axum::extract::Path(id),
            State(state),
            Extension(user),
            headers,
            ConnectInfo(addr),
        )
        .await
        .map(IntoResponse::into_response);
    }
    let uses = body.uses.clamp(1, 100_000);
    let expires_at = match body.expires_in_hours {
        Some(h) if h > 0 => Some(Utc::now() + Duration::hours(h)),
        Some(_) => {
            return Err(ApiError::bad_request("expires_in_hours must be positive"));
        }
        None => Some(Utc::now() + Duration::minutes(10)),
    };

    let note_owned: Option<String> = body
        .note
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (id, plaintext) =
        db::create_agent_enrollment_token(&state.db, uses, expires_at, note_owned.as_deref())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "create enrollment token failed");
                ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not create token")
            })?;
    let ip = super::helpers::audit_ip(&headers, addr);
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        None,
        "agent_pairing_code_create",
        "ok",
        &serde_json::json!({ "invite_id": id, "uses": uses, "expires_at": expires_at }),
        ip.as_deref(),
    )
    .await;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({
            "id": id,
            "enrollment_token": plaintext,
            "uses": uses,
            "expires_at": expires_at,
            "note": body.note,
        })),
    )
        .into_response())
}

/// Admin: list enrollment tokens (metadata + remaining uses).
pub async fn list_enrollment_tokens(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let rows = db::list_agent_enrollment_tokens(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list enrollment tokens failed");
            ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not list tokens")
        })?;
    Ok((StatusCode::OK, Json(serde_json::json!({ "tokens": rows }))))
}

/// Admin: revoke an enrollment token (sets `uses_remaining` = 0).
pub async fn revoke_enrollment_token(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token_id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    db::revoke_agent_enrollment_token(&state.db, token_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, token_id = %token_id, "revoke enrollment token failed");
            ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not revoke token")
        })?;
    let ip = super::helpers::audit_ip(&headers, addr);
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        None,
        "agent_pairing_code_revoke",
        "ok",
        &serde_json::json!({ "invite_id": token_id }),
        ip.as_deref(),
    )
    .await;
    Ok((StatusCode::OK, Json(serde_json::json!({ "ok": true }))))
}

/// Admin: revoke all enrollment tokens (sets `uses_remaining` = 0 for all).
pub async fn revoke_all_enrollment_tokens(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let n = db::revoke_all_agent_enrollment_tokens(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "revoke all enrollment tokens failed");
            ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not revoke tokens")
        })?;
    let ip = super::helpers::audit_ip(&headers, addr);
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        None,
        "agent_pairing_code_revoke_all",
        "ok",
        &serde_json::json!({ "revoked": n }),
        ip.as_deref(),
    )
    .await;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "revoked": n })),
    ))
}

pub async fn list_enrollment_claims(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let rows = db::list_agent_enrollment_claims(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list enrollment claims failed");
            ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not list claims")
        })?;
    Ok((StatusCode::OK, Json(serde_json::json!({ "claims": rows }))))
}

pub async fn approve_enrollment_claim(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(claim_id): Path<Uuid>,
    Json(body): Json<ApproveClaimBody>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let approved = state
        .approve_agent_enrollment_claim(
            claim_id,
            user.username.as_str(),
            body.agent_name.as_deref(),
            body.group_id,
        )
        .await
        .map_err(|e| {
            tracing::error!(error = %e, claim_id = %claim_id, "approve enrollment claim failed");
            ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not approve claim")
        })?;
    let (agent_id, _agent_token, agent_name) = match approved {
        Ok(v) => v,
        Err(db::ClaimApproveReject::NotFound) => {
            return Err(ApiError::not_found("claim not found"))
        }
        Err(db::ClaimApproveReject::NotPending) => {
            return Err(ApiError::conflict("claim is not pending"))
        }
        Err(db::ClaimApproveReject::AlreadyEnrolled) => {
            return Err(ApiError::conflict(
                "an enrolled agent already uses that name",
            ))
        }
    };
    let ip = super::helpers::audit_ip(&headers, addr);
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        Some(agent_id),
        "agent_enrollment_claim_approve",
        "ok",
        &serde_json::json!({ "claim_id": claim_id, "agent_name": agent_name }),
        ip.as_deref(),
    )
    .await;
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        Some(agent_id),
        "agent_credential_issue",
        "ok",
        &serde_json::json!({ "claim_id": claim_id }),
        ip.as_deref(),
    )
    .await;
    Ok((
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "agent_id": agent_id })),
    ))
}

pub async fn reject_enrollment_claim(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(claim_id): Path<Uuid>,
    Json(body): Json<RejectClaimBody>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let rejected = db::reject_agent_enrollment_claim(
        &state.db,
        claim_id,
        user.username.as_str(),
        body.error.as_deref(),
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, claim_id = %claim_id, "reject enrollment claim failed");
        ApiError::status(StatusCode::INTERNAL_SERVER_ERROR, "could not reject claim")
    })?;
    if !rejected {
        return Err(ApiError::conflict("claim is not pending"));
    }
    let ip = super::helpers::audit_ip(&headers, addr);
    db::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        None,
        "agent_enrollment_claim_reject",
        "ok",
        &serde_json::json!({ "claim_id": claim_id }),
        ip.as_deref(),
    )
    .await;
    Ok((StatusCode::OK, Json(serde_json::json!({ "ok": true }))))
}

/// Admin: list recent uses of a given enrollment token.
pub async fn list_enrollment_token_uses(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    axum::extract::Path(token_id): axum::extract::Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let rows = db::list_agent_enrollment_token_uses(&state.db, token_id, 200)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, token_id = %token_id, "list enrollment token uses failed");
            ApiError::status(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not list token uses",
            )
        })?;
    Ok((StatusCode::OK, Json(serde_json::json!({ "uses": rows }))))
}
