//! Dashboard API: create 6-digit pairing codes and review pending agent claims.

use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{Duration, Utc};
use serde::Deserialize;

use crate::auth;
use crate::db;
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
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let hints = crate::mdns_broadcast::build_agent_setup_hints(state.agent_listen_port);
    (StatusCode::OK, Json(hints)).into_response()
}

pub async fn create_enrollment_token(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateEnrollmentTokenBody>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }

    let uses = body.uses.clamp(1, 100_000);
    let expires_at = match body.expires_in_hours {
        Some(h) if h > 0 => Some(Utc::now() + Duration::hours(h)),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "expires_in_hours must be positive" })),
            )
                .into_response();
        }
        None => Some(Utc::now() + Duration::minutes(10)),
    };

    let note_owned: Option<String> = body
        .note
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    match db::create_agent_enrollment_token(&state.db, uses, expires_at, note_owned.as_deref())
        .await
    {
        Ok((id, plaintext)) => {
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
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "id": id,
                    "enrollment_token": plaintext,
                    "uses": uses,
                    "expires_at": expires_at,
                    "note": body.note,
                })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "create enrollment token failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not create token" })),
            )
                .into_response()
        }
    }
}

/// Admin: list enrollment tokens (metadata + remaining uses).
pub async fn list_enrollment_tokens(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::list_agent_enrollment_tokens(&state.db).await {
        Ok(rows) => (StatusCode::OK, Json(serde_json::json!({ "tokens": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list enrollment tokens failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not list tokens" })),
            )
                .into_response()
        }
    }
}

/// Admin: revoke an enrollment token (sets `uses_remaining` = 0).
pub async fn revoke_enrollment_token(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(token_id): Path<Uuid>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::revoke_agent_enrollment_token(&state.db, token_id).await {
        Ok(()) => {
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
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, token_id = %token_id, "revoke enrollment token failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not revoke token" })),
            )
                .into_response()
        }
    }
}

/// Admin: revoke all enrollment tokens (sets `uses_remaining` = 0 for all).
pub async fn revoke_all_enrollment_tokens(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::revoke_all_agent_enrollment_tokens(&state.db).await {
        Ok(n) => {
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
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "revoked": n })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "revoke all enrollment tokens failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not revoke tokens" })),
            )
                .into_response()
        }
    }
}

pub async fn list_enrollment_claims(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::list_agent_enrollment_claims(&state.db).await {
        Ok(rows) => (StatusCode::OK, Json(serde_json::json!({ "claims": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list enrollment claims failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not list claims" })),
            )
                .into_response()
        }
    }
}

pub async fn approve_enrollment_claim(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(claim_id): Path<Uuid>,
    Json(body): Json<ApproveClaimBody>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::approve_agent_enrollment_claim(
        &state.db,
        claim_id,
        user.username.as_str(),
        body.agent_name.as_deref(),
        body.group_id,
    )
    .await
    {
        Ok(Ok((agent_id, agent_token, agent_name))) => {
            state.pending_enrollment_tokens.lock().insert(
                claim_id,
                crate::state::PendingEnrollmentToken {
                    agent_id,
                    agent_name: agent_name.clone(),
                    agent_token,
                },
            );
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
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "agent_id": agent_id })),
            )
                .into_response()
        }
        Ok(Err(db::ClaimApproveReject::NotFound)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "claim not found" })),
        )
            .into_response(),
        Ok(Err(db::ClaimApproveReject::NotPending)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "claim is not pending" })),
        )
            .into_response(),
        Ok(Err(db::ClaimApproveReject::AlreadyEnrolled)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "an enrolled agent already uses that name" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, claim_id = %claim_id, "approve enrollment claim failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not approve claim" })),
            )
                .into_response()
        }
    }
}

pub async fn reject_enrollment_claim(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(claim_id): Path<Uuid>,
    Json(body): Json<RejectClaimBody>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::reject_agent_enrollment_claim(
        &state.db,
        claim_id,
        user.username.as_str(),
        body.error.as_deref(),
    )
    .await
    {
        Ok(true) => {
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
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "claim is not pending" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, claim_id = %claim_id, "reject enrollment claim failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not reject claim" })),
            )
                .into_response()
        }
    }
}

/// Admin: list recent uses of a given enrollment token.
pub async fn list_enrollment_token_uses(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    axum::extract::Path(token_id): axum::extract::Path<Uuid>,
) -> impl IntoResponse {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    match db::list_agent_enrollment_token_uses(&state.db, token_id, 200).await {
        Ok(rows) => (StatusCode::OK, Json(serde_json::json!({ "uses": rows }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, token_id = %token_id, "list enrollment token uses failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not list token uses" })),
            )
                .into_response()
        }
    }
}
