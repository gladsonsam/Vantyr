//! HTTP handlers for versioned policy, desired assignment and worker retrieval.
//!
//! Admin routes live under `/api` behind the real session + CSRF middleware and
//! require an explicit `network_admin` grant on the household in the URL path.
//! Platform operator/admin roles without that grant get 403. The worker read
//! route is mounted at the top level, outside cookies/CSRF, behind a bounded
//! bearer credential with an explicit `read_policy` command.
//!
//! A saved policy or assignment is a PROPOSAL only. No handler here reports
//! `applied`, `enforced` or an acknowledgement; receipt/verification is future.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::gateway_api::audit_worker;
use super::gateway_db;
use super::policy_dto::{DesiredPolicyBody, PolicyDraft, ReadPolicyBody, RollbackBody};
use super::{api, authz, policy_db, policy_service};

// ─── Admin: versioned policy ─────────────────────────────────────────────────

pub async fn policies_publish(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<PolicyDraft>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    // Map a malformed body (including unknown fields such as a caller
    // `revision`/`household_id`) to a typed 400 rather than an extractor 422.
    let draft = body
        .map_err(|_| ApiError::bad_request("invalid or unsupported policy fields"))?
        .0;
    let result = policy_service::publish(&s.db, user.user_id, hid, draft, Utc::now()).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_policy_publish",
        json!({ "revision": result.revision, "body_sha256": result.body_sha256 }),
    )
    .await;
    Ok(Json(json!(result)))
}

pub async fn policies_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    validate_page_params(&page).map_err(ApiError::bad_request)?;
    let rows = policy_db::list_versions(&s.db, hid, page.limit, page.offset).await?;
    Ok(Json(json!({ "policies": rows, "count": rows.len() })))
}

pub async fn policies_rollback(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RollbackBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let result = policy_service::rollback(&s.db, user.user_id, hid, body, Utc::now()).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_policy_rollback",
        json!({
            "revision": result.revision,
            "body_sha256": result.body_sha256,
            "status": result.status
        }),
    )
    .await;
    Ok(Json(json!(result)))
}

// ─── Admin: explicit desired assignment ─────────────────────────────────────

pub async fn desired_get(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !gateway_db::gateway_in_household(&s.db, hid, gid).await? {
        return Err(ApiError::not_found("gateway not found in this household"));
    }
    let desired = policy_db::get_desired(&s.db, hid, gid).await?;
    Ok(Json(json!({ "desired": desired })))
}

pub async fn desired_set(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<DesiredPolicyBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let desired = policy_service::set_desired(&s.db, user.user_id, hid, gid, body).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_gateway_desired_policy_set",
        json!({ "gateway_id": gid, "revision": desired.revision }),
    )
    .await;
    Ok(Json(json!({ "desired": desired })))
}

// ─── Worker: cookie-free scoped retrieval only ──────────────────────────────

pub async fn worker_read(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<ReadPolicyBody>,
) -> ApiResult<Json<Value>> {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let result = policy_service::read_policy(&s.db, bearer, body, Utc::now()).await?;
    let ip = audit_ip(&headers, addr);
    audit_worker(
        &s,
        result.policy.household_id,
        ip.as_deref(),
        "network_gateway_policy_read",
        json!({ "gateway_id": result.gateway_id, "revision": result.revision }),
    )
    .await;
    // No token, secret, digest-of-secret or applied/enforced flag is logged.
    Ok(Json(json!(result)))
}

/// Mounted by `worker_routes()` at the top level, so this handler is outside
/// dashboard cookie/CSRF middleware. Rate limiting and the body cap are applied
/// to the whole worker router before any handler or database work.
pub fn worker_route() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route(
        "/worker/network/policy/read",
        axum::routing::post(worker_read),
    )
}
