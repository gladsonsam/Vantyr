//! Audit log query API.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::{db, state::AppState};

use crate::http::audit_ip;

use crate::http::pagination::{validate_audit_params, AuditParams};
pub async fn audit_log(
    Query(p): Query<AuditParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_audit_params(&p).map_err(ApiError::bad_request)?;

    let ip = audit_ip(&headers, addr);
    let rows = db::query_audit_log(
        &s.db,
        p.agent_id,
        p.action.as_deref(),
        p.status.as_deref(),
        p.limit,
        p.offset,
    )
    .await?;
    let detail = serde_json::json!({
        "action_filter": p.action,
        "status_filter": p.status,
        "limit": p.limit,
        "offset": p.offset
    });
    db::insert_audit_log_dedup_traced(
        &s.db,
        db::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: p.agent_id,
            action: "view_audit_log",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}
