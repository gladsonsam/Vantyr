//! Agent groups (admin): CRUD, membership, and the groups an agent belongs to.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::agents::groups::db;
use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, RequireAdmin};
use crate::platform::audit;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct AgentGroupCreateBody {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
pub struct AgentGroupUpdateBody {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
pub struct AgentGroupMembersAddBody {
    agent_ids: Vec<Uuid>,
}

pub async fn agent_groups_list_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    let groups = db::agent_groups_list(&s.db).await?;
    Ok(Json(serde_json::json!({ "groups": groups })))
}

pub async fn agent_groups_create_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<AgentGroupCreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }
    let id = db::agent_group_create(&s.db, name, body.description.trim()).await?;
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "agent_group_create",
        "ok",
        &serde_json::json!({ "id": id, "name": name }),
        ip.as_deref(),
    )
    .await;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

pub async fn agent_groups_update_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(group_id): Path<Uuid>,
    Json(body): Json<AgentGroupUpdateBody>,
) -> ApiResult<Json<Value>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }
    if !db::agent_group_rename(&s.db, group_id, name, body.description.trim()).await? {
        return Err(ApiError::not_found("Group not found"));
    }
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "agent_group_update",
        "ok",
        &serde_json::json!({ "id": group_id, "name": name }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn agent_groups_delete_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(group_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if !db::agent_group_delete(&s.db, group_id).await? {
        return Err(ApiError::not_found("Group not found"));
    }
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "agent_group_delete",
        "ok",
        &serde_json::json!({ "id": group_id }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn agent_group_members_list_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Path(group_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let ids = db::agent_group_members(&s.db, group_id).await?;
    Ok(Json(serde_json::json!({ "agent_ids": ids })))
}

pub async fn agent_group_members_add_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Path(group_id): Path<Uuid>,
    Json(body): Json<AgentGroupMembersAddBody>,
) -> ApiResult<Json<Value>> {
    if body.agent_ids.len() > 512 {
        return Err(ApiError::bad_request("at most 512 agent_ids per request"));
    }
    let n = db::agent_group_add_members(&s.db, group_id, &body.agent_ids).await?;
    Ok(Json(serde_json::json!({ "added": n })))
}

pub async fn agent_group_member_remove_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Path((group_id, agent_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Value>> {
    if !db::agent_group_remove_member(&s.db, group_id, agent_id).await? {
        return Err(ApiError::not_found("Membership not found"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// List agent groups that include this agent (admin only; used by dashboard membership UI).
pub async fn agent_agent_groups_for_agent_h(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    let groups = db::agent_groups_for_agent(&s.db, agent_id).await?;
    Ok(Json(serde_json::json!({ "groups": groups })))
}
