//! Public agent enrollment claim endpoints.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use uuid::Uuid;

use crate::db::{self, ClaimCreateReject};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct CreateClaimBody {
    #[serde(default)]
    pub pairing_code: Option<String>,
    pub requested_name: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub agent_version: Option<String>,
    pub install_id: String,
    pub discovered_server: Option<String>,
}

/// Legacy direct enrollment is deliberately removed. Pairing codes now create pending claims.
pub async fn agent_enroll_handler() -> impl IntoResponse {
    (
        StatusCode::GONE,
        Json(serde_json::json!({
            "error": "direct enrollment has been removed; create /api/agent/enrollment/claims and wait for admin approval"
        })),
    )
}

pub async fn create_enrollment_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateClaimBody>,
) -> impl IntoResponse {
    let ip = crate::auth::client_ip_for_audit(&headers, Some(addr));
    if body.requested_name.trim().is_empty() || body.install_id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "requested_name and install_id required" })),
        )
            .into_response();
    }

    match db::create_agent_enrollment_claim(
        &state.db,
        db::AgentEnrollmentClaimInput {
            pairing_code: body.pairing_code.as_deref(),
            requested_name: &body.requested_name,
            hostname: body.hostname.as_deref(),
            os: body.os.as_deref(),
            agent_version: body.agent_version.as_deref(),
            install_id: &body.install_id,
            discovered_server: body.discovered_server.as_deref(),
            client_ip: ip.as_deref(),
        },
    )
    .await
    {
        Ok(Ok(outcome)) => {
            let claim = outcome.claim;
            db::insert_audit_log_traced(
                &state.db,
                "agent",
                None,
                "agent_enrollment_claim_create",
                "ok",
                &serde_json::json!({
                    "claim_id": claim.id,
                    "requested_name": claim.requested_name,
                    "hostname": claim.hostname,
                    "agent_version": claim.agent_version,
                }),
                ip.as_deref(),
            )
            .await;
            if outcome.auto_approve {
                match db::approve_agent_enrollment_claim(
                    &state.db,
                    claim.id,
                    "pairing_code",
                    None,
                    None,
                )
                .await
                {
                    Ok(Ok((agent_id, agent_token, agent_name))) => {
                        state.pending_enrollment_tokens.lock().insert(
                            claim.id,
                            crate::state::PendingEnrollmentToken {
                                agent_id,
                                agent_name: agent_name.clone(),
                                agent_token,
                            },
                        );
                        db::insert_audit_log_traced(
                            &state.db,
                            "agent",
                            Some(agent_id),
                            "agent_enrollment_claim_auto_approve",
                            "ok",
                            &serde_json::json!({ "claim_id": claim.id, "agent_name": agent_name }),
                            ip.as_deref(),
                        )
                        .await;
                        return (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "claim_id": claim.id,
                                "status": "approved",
                                "poll_after_secs": 1
                            })),
                        )
                            .into_response();
                    }
                    Ok(Err(db::ClaimApproveReject::AlreadyEnrolled)) => {
                        return (
                            StatusCode::CONFLICT,
                            Json(serde_json::json!({ "error": "an enrolled agent already uses that name" })),
                        )
                            .into_response();
                    }
                    Ok(Err(reject)) => {
                        tracing::error!(?reject, claim_id = %claim.id, "auto approve enrollment claim rejected");
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({ "error": "could not auto-approve enrollment claim" })),
                        )
                            .into_response();
                    }
                    Err(e) => {
                        tracing::error!(error = %e, claim_id = %claim.id, "auto approve enrollment claim failed");
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({ "error": "could not auto-approve enrollment claim" })),
                        )
                            .into_response();
                    }
                }
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "claim_id": claim.id,
                    "status": claim.status,
                    "poll_after_secs": 2
                })),
            )
                .into_response()
        }
        Ok(Err(ClaimCreateReject::InvalidOrExpiredCode)) => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid or expired pairing code" })),
        )
            .into_response(),
        Ok(Err(ClaimCreateReject::AlreadyEnrolled)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "an enrolled agent already uses that name" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "create enrollment claim failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not create enrollment claim" })),
            )
                .into_response()
        }
    }
}

pub async fn poll_enrollment_claim(
    State(state): State<Arc<AppState>>,
    Path(claim_id): Path<Uuid>,
) -> impl IntoResponse {
    let claim = match db::get_agent_enrollment_claim(&state.db, claim_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "claim not found" })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, claim_id = %claim_id, "poll enrollment claim failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not load claim" })),
            )
                .into_response();
        }
    };

    match claim.status.as_str() {
        "pending" => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "pending", "poll_after_secs": 2 })),
        )
            .into_response(),
        "approved" => {
            if let Some(issued) = state.pending_enrollment_tokens.lock().remove(&claim_id) {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "status": "approved",
                        "agent_id": issued.agent_id,
                        "agent_name": issued.agent_name,
                        "agent_token": issued.agent_token
                    })),
                )
                    .into_response()
            } else {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "status": "approved",
                        "agent_id": claim.agent_id,
                        "agent_name": claim.requested_name,
                        "error": "credential was already retrieved; start a new pairing if this device did not save it"
                    })),
                )
                    .into_response()
            }
        }
        "rejected" | "expired" => (
            StatusCode::OK,
            Json(serde_json::json!({
                "status": claim.status,
                "error": claim.error.unwrap_or_else(|| "Rejected by admin".to_string())
            })),
        )
            .into_response(),
        _ => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": claim.status, "poll_after_secs": 5 })),
        )
            .into_response(),
    }
}
