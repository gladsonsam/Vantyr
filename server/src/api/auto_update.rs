//! Central agent auto-update policy.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::RequireAdmin;
use crate::error::ApiResult;
use crate::{db, state::AppState, ws_agent};

use super::helpers::audit_ip;
// ─── Agent auto-update policy (Tauri updater) ─────────────────────────────────

pub async fn agent_auto_update_global_get(
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let enabled = db::get_agent_auto_update_global(&s.db).await?;
    Ok(Json(serde_json::json!({ "enabled": enabled })))
}

#[derive(Deserialize)]
pub struct AgentAutoUpdateBody {
    enabled: bool,
}

pub async fn agent_auto_update_global_put(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentAutoUpdateBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    db::set_agent_auto_update_global(&s.db, body.enabled).await?;
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "set_agent_auto_update_global",
        "ok",
        &serde_json::json!({ "enabled": body.enabled }),
        ip.as_deref(),
    )
    .await;
    ws_agent::push_auto_update_policy_to_all_connected(&s).await;
    agent_auto_update_global_get(State(s.clone())).await
}

pub async fn agent_auto_update_agent_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let global = db::get_agent_auto_update_global(&s.db).await?;
    let ov = db::get_agent_auto_update_override(&s.db, id).await?;
    Ok(Json(serde_json::json!({
        "global": { "enabled": global },
        "override": match ov {
            None => serde_json::Value::Null,
            Some(v) => serde_json::json!({ "enabled": v }),
        }
    })))
}

pub async fn agent_auto_update_agent_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentAutoUpdateBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    db::set_agent_auto_update_override(&s.db, id, body.enabled).await?;
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "set_agent_auto_update_override",
        "ok",
        &serde_json::json!({ "enabled": body.enabled }),
        ip.as_deref(),
    )
    .await;
    ws_agent::push_auto_update_policy_to_agent(&s, id).await;
    agent_auto_update_agent_get(Path(id), State(s.clone())).await
}

pub async fn agent_auto_update_agent_delete(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    db::clear_agent_auto_update_override(&s.db, id).await?;
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "clear_agent_auto_update_override",
        "ok",
        &serde_json::json!({}),
        ip.as_deref(),
    )
    .await;
    ws_agent::push_auto_update_policy_to_agent(&s, id).await;
    agent_auto_update_agent_get(Path(id), State(s.clone())).await
}
