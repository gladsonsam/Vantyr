//! HTTP handlers for Vantyr Network gateways.
//!
//! Admin routes live under `/api` (session + CSRF) and require an explicit
//! `network_admin` grant on the household from the URL path. The worker route
//! is mounted OUTSIDE `/api` and outside cookie/CSRF middleware: it accepts
//! only a bounded bearer credential and can only submit a heartbeat report.
//! A dashboard cookie can never authenticate a worker, and a worker bearer can
//! never reach an admin route.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::key_extractor::PeerIpKeyExtractor;
use tower_governor::GovernorLayer;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::{
    api, authz, db, gateway_auth, gateway_db, gateway_dto, gateway_retention, gateway_service,
};

fn bounds(page: &PageParams) -> ApiResult<(i64, i64)> {
    validate_page_params(page).map_err(ApiError::bad_request)?;
    Ok((page.limit, page.offset))
}

#[derive(Debug, Deserialize)]
pub struct GatewayListParams {
    kind: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

// ─── Admin: gateway inventory ────────────────────────────────────────────────

pub async fn gateways_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<GatewayListParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let page = PageParams {
        limit: params.limit.unwrap_or(50),
        offset: params.offset.unwrap_or(0),
    };
    let (limit, offset) = bounds(&page)?;
    let kind = match &params.kind {
        Some(k) => Some(gateway_dto::normalize_kind(k).map_err(ApiError::bad_request)?),
        None => None,
    };
    let rows = gateway_db::list_gateways(&s.db, hid, kind.as_deref(), limit, offset).await?;
    Ok(Json(json!({ "gateways": rows })))
}

pub async fn gateway_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<gateway_dto::CreateGatewayBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let kind = gateway_dto::normalize_kind(&body.kind).map_err(ApiError::bad_request)?;
    let label = gateway_dto::normalize_label(&body.label).map_err(ApiError::bad_request)?;
    let id = gateway_service::create_gateway(&s.db, user.user_id, hid, &kind, &label).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_create",
        json!({ "gateway_id": id, "kind": kind }),
    )
    .await;
    Ok(Json(json!({ "id": id })))
}

pub async fn gateway_revoke(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !gateway_service::revoke_gateway(&s.db, hid, gid).await? {
        return Err(ApiError::not_found("gateway not found in this household"));
    }
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_revoke",
        json!({ "gateway_id": gid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ─── Admin: gateway credentials (metadata only after issuance) ──────────────

pub async fn credentials_list(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !gateway_db::gateway_in_household(&s.db, hid, gid).await? {
        return Err(ApiError::not_found("gateway not found in this household"));
    }
    let (limit, offset) = bounds(&page)?;
    let rows = gateway_db::list_credentials(&s.db, hid, gid, limit, offset).await?;
    Ok(Json(json!({ "credentials": rows })))
}

pub async fn credential_issue(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<gateway_dto::IssueCredentialBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let expires_at = gateway_dto::credential_expiry(body.expires_in_hours, Utc::now())
        .map_err(|()| ApiError::bad_request("expires_in_hours must be between 1 and 720"))?;
    let commands = gateway_auth::normalize_commands(body.commands.as_deref())
        .map_err(|()| ApiError::bad_request("commands must be heartbeat and/or read_policy"))?;
    let (id, secret) =
        gateway_service::issue_credential(&s.db, hid, gid, user.user_id, expires_at, &commands)
            .await?;
    // The plaintext is returned exactly once. Audit detail carries only the
    // identifier and allowlist, never the secret or its digest.
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_credential_issue",
        json!({ "gateway_id": gid, "credential_id": id, "commands": commands }),
    )
    .await;
    Ok(Json(json!({
        "credential_id": id,
        "token": gateway_auth::format_bearer(id, &secret),
        "expires_at": expires_at
    })))
}

pub async fn credential_rotate(
    Path((hid, gid, cid)): Path<(Uuid, Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<gateway_dto::IssueCredentialBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let expires_at = gateway_dto::credential_expiry(body.expires_in_hours, Utc::now())
        .map_err(|()| ApiError::bad_request("expires_in_hours must be between 1 and 720"))?;
    let commands = gateway_auth::normalize_commands(body.commands.as_deref())
        .map_err(|()| ApiError::bad_request("commands must be heartbeat and/or read_policy"))?;
    let (id, secret) =
        gateway_service::rotate_credential(&s.db, hid, gid, cid, user.user_id, expires_at, &commands)
            .await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_credential_rotate",
        json!({ "gateway_id": gid, "credential_id": id, "rotated_from": cid, "commands": commands }),
    )
    .await;
    Ok(Json(json!({
        "credential_id": id,
        "token": gateway_auth::format_bearer(id, &secret),
        "expires_at": expires_at
    })))
}

pub async fn credential_revoke(
    Path((hid, gid, cid)): Path<(Uuid, Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !gateway_db::credential_in_scope(&s.db, hid, gid, cid).await? {
        return Err(ApiError::not_found("credential not found in this gateway"));
    }
    if !gateway_service::revoke_credential(&s.db, hid, gid, cid).await? {
        return Err(ApiError::not_found("credential not found in this gateway"));
    }
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_credential_revoke",
        json!({ "gateway_id": gid, "credential_id": cid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn reports_list(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !gateway_db::gateway_in_household(&s.db, hid, gid).await? {
        return Err(ApiError::not_found("gateway not found in this household"));
    }
    let (limit, offset) = bounds(&page)?;
    let retention = gateway_retention::GatewayReportRetention::from_env().clamped();
    let rows =
        gateway_db::list_reports(&s.db, hid, gid, retention.cutoff(Utc::now()), limit, offset)
            .await?;
    Ok(Json(json!({ "reports": rows })))
}

// ─── Worker: heartbeat only ──────────────────────────────────────────────────

pub(super) async fn audit_worker(
    state: &AppState,
    hid: Uuid,
    ip: Option<&str>,
    action: &str,
    detail: Value,
) {
    if let Err(e) = db::insert_network_audit(
        &state.db,
        hid,
        "network-gateway-worker",
        ip,
        action,
        &detail,
    )
    .await
    {
        tracing::warn!(error = %e, action, "gateway audit insert failed");
    }
    // Global audit is readable by every session: only a generic marker, never
    // a token, a user, a gateway id or the worker's claimed payload.
    crate::platform::audit::insert_audit_log_traced(
        &state.db,
        "network_gateway",
        None,
        "network_action",
        "ok",
        &json!({}),
        ip,
    )
    .await;
}

pub async fn worker_heartbeat(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<gateway_dto::HeartbeatBody>,
) -> ApiResult<Json<Value>> {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let now = Utc::now();
    let outcome = gateway_service::heartbeat(
        &s.db,
        bearer,
        body,
        now,
        gateway_retention::GatewayReportRetention::from_env(),
    )
    .await?;
    let ip = audit_ip(&headers, addr);
    audit_worker(
        &s,
        outcome.household_id,
        ip.as_deref(),
        "network_gateway_heartbeat",
        json!({ "gateway_id": outcome.gateway_id, "report_id": outcome.report_id }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "report_id": outcome.report_id })))
}

/// The worker router is mounted at the top level (NOT under `/api`), so it is
/// outside the dashboard cookie/CSRF middleware. Rate limiting and a small body
/// cap are applied before any handler or database work.
pub fn worker_routes() -> axum::Router<Arc<AppState>> {
    let config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(5)
            .burst_size(20)
            .key_extractor(PeerIpKeyExtractor)
            .finish()
            .expect("static gateway worker rate limit config"),
    );
    axum::Router::new()
        .route("/worker/network/gateway/heartbeat", post(worker_heartbeat))
        .merge(super::policy_api::worker_route())
        .layer(axum::extract::DefaultBodyLimit::max(4096))
        .layer(GovernorLayer::new(config))
}
