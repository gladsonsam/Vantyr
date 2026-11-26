//! HTTP handlers for bounded DNS management. Admin routes inherit the `/api`
//! session cookie + CSRF middleware and need an explicit household grant;
//! worker routes are cookie-free, top-level and need a scoped Bearer command.
//!
//! No handler here publishes a policy, assigns a desired policy revision or
//! reports that a gateway applied, enforced or verified anything.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::dns_management_dto::{
    PatchBody, RefreshResult, WorkerReadBody, WorkerReadResponse, WorkerStatusBody,
};
use super::{api, authz, dns_management_service, gateway_api};

async fn require_status_read(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    household_id: Uuid,
) -> ApiResult<()> {
    let admin = authz::has_grant(pool, user_id, household_id, authz::NetworkGrant::Admin).await?;
    let events = authz::has_grant(pool, user_id, household_id, authz::NetworkGrant::Events).await?;
    if admin || events {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

fn reject_json(rejection: JsonRejection) -> ApiError {
    // Preserve the 413 emitted by the body-limit layer; semantic/field
    // rejections are honest 400s rather than an extractor-specific 422.
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::status(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body exceeds the bound",
        )
    } else {
        ApiError::bad_request("invalid or unsupported request fields")
    }
}

// ─── Admin: desired config ──────────────────────────────────────────────────

pub async fn management_get(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    Ok(Json(json!(
        dns_management_service::get_view(&s.db, hid).await?
    )))
}

pub async fn management_patch(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<PatchBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let body = body.map_err(reject_json)?.0;
    let operation_names: Vec<&'static str> = body.operations.iter().map(|op| op.name()).collect();
    let result = dns_management_service::patch(&s.db, user.user_id, hid, body, Utc::now()).await?;
    if result.changed {
        if let Some(desired) = &result.view.desired {
            api::audit_network(
                &s,
                &user,
                audit_ip(&headers, addr).as_deref(),
                hid,
                "network_dns_management_patch",
                json!({
                    "config_version": desired.config_version,
                    "body_sha256": desired.body_sha256,
                    "operations": operation_names,
                }),
            )
            .await;
        }
    }
    Ok(Json(json!(result)))
}

pub async fn refresh(
    Path((hid, source_id)): Path<(Uuid, String)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let result: RefreshResult =
        dns_management_service::request_refresh(&s.db, user.user_id, hid, &source_id, Utc::now())
            .await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_dns_refresh_request",
        json!({
            "source_id": source_id,
            "refresh_seq": result.refresh_seq,
            "config_version": result.config_version,
        }),
    )
    .await;
    Ok(Json(json!(result)))
}

pub async fn status_get(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    require_status_read(&s.db, user.user_id, hid).await?;
    Ok(Json(json!(
        dns_management_service::status_view(&s.db, hid).await?
    )))
}

// ─── Worker: cookie-free scoped routes ──────────────────────────────────────

pub async fn worker_read(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<WorkerReadBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(reject_json)?.0;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let result: WorkerReadResponse =
        dns_management_service::worker_read(&s.db, bearer, body, Utc::now()).await?;
    let ip = audit_ip(&headers, addr);
    gateway_api::audit_worker(
        &s,
        result.household_id,
        ip.as_deref(),
        "network_dns_management_read",
        json!({
            "gateway_id": result.gateway_id,
            "config_version": result.config_version,
        }),
    )
    .await;
    Ok(Json(json!(result)))
}

pub async fn worker_status(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<WorkerStatusBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(reject_json)?.0;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let outcome = dns_management_service::worker_status(&s.db, bearer, body, Utc::now()).await?;
    let ip = audit_ip(&headers, addr);
    gateway_api::audit_worker(
        &s,
        outcome.household_id,
        ip.as_deref(),
        "network_dns_status_report",
        json!({
            "gateway_id": outcome.gateway_id,
            "report_id": outcome.report_id,
        }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "report_id": outcome.report_id })))
}
