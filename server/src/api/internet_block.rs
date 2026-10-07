//! Internet blocking rules — rule-based management (all / group / agent scope).
//!
//! GET  /api/internet-block-rules           → all rules (admin)
//! POST /api/internet-block-rules           ← {name, scopes}  (admin)
//! PUT  /api/internet-block-rules/:id       ← {enabled}  (admin)
//! DEL  /api/internet-block-rules/:id       (admin)
//!
//! GET  /api/agents/:id/internet-blocked    → {blocked, source}
//! PUT  /api/agents/:id/internet-blocked    ← {blocked}  — creates/removes agent-scoped rule

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireAdmin;
use crate::platform::audit;
use crate::{db, state::AppState, ws_agent};

// ── List ──────────────────────────────────────────────────────────────────────

pub async fn internet_block_rules_list(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let rules = db::internet_block_rules_list_all(&s.db).await?;
    Ok(Json(serde_json::json!({ "rules": rules })))
}

// ── Create ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct InternetBlockScope {
    pub kind: String,
    pub group_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct CreateInternetBlockRule {
    #[serde(default)]
    pub name: String,
    pub scopes: Vec<InternetBlockScope>,
    #[serde(default)]
    pub schedules: Vec<db::RuleScheduleJson>,
}

pub async fn internet_block_rules_create(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateInternetBlockRule>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let ip = audit_ip(&headers, addr);
    let scopes: Vec<(String, Option<Uuid>, Option<Uuid>)> = body
        .scopes
        .iter()
        .map(|s| (s.kind.clone(), s.group_id, s.agent_id))
        .collect();

    let id = db::internet_block_rule_create(&s.db, &body.name, &scopes, &body.schedules).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "internet_block_rule_create",
        "ok",
        &serde_json::json!({ "id": id }),
        ip.as_deref(),
    )
    .await;
    push_to_affected(&s, &scopes).await;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

// ── Update (toggle enabled) ───────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateInternetBlockRule {
    pub enabled: bool,
    #[serde(default)]
    pub schedules: Option<Vec<db::RuleScheduleJson>>,
}

pub async fn internet_block_rules_update(
    Path(rule_id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateInternetBlockRule>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    if !db::internet_block_rule_set_enabled(&s.db, rule_id, body.enabled).await? {
        return Err(ApiError::not_found("Not found"));
    }
    if let Some(sched) = body.schedules.as_ref() {
        db::internet_block_rule_set_schedules(&s.db, rule_id, sched).await?;
    }
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "internet_block_rule_update",
        "ok",
        &serde_json::json!({ "id": rule_id, "enabled": body.enabled }),
        ip.as_deref(),
    )
    .await;
    ws_agent::push_internet_block_to_all_connected(&s).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Delete ────────────────────────────────────────────────────────────────────

pub async fn internet_block_rules_delete(
    Path(rule_id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let has_all = db::internet_block_rule_has_all_scope(&s.db, rule_id)
        .await
        .unwrap_or(false);
    let direct_agents = db::internet_block_rule_direct_agent_ids(&s.db, rule_id)
        .await
        .unwrap_or_default();

    if !db::internet_block_rule_delete(&s.db, rule_id).await? {
        return Err(ApiError::not_found("Not found"));
    }
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "internet_block_rule_delete",
        "ok",
        &serde_json::json!({ "id": rule_id }),
        ip.as_deref(),
    )
    .await;
    if has_all {
        ws_agent::push_internet_block_to_all_connected(&s).await;
    } else {
        for agent_id in direct_agents {
            ws_agent::push_network_policy_to_agent(&s, agent_id).await;
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Per-agent GET / PUT (quick toggle) ───────────────────────────────────────

pub async fn agent_internet_blocked_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> Json<Value> {
    let blocked = db::get_agent_internet_blocked(&s.db, id)
        .await
        .unwrap_or(false);
    let source = db::get_agent_internet_block_source(&s.db, id)
        .await
        .unwrap_or(None);
    Json(serde_json::json!({ "blocked": blocked, "source": source }))
}

#[derive(Deserialize)]
pub struct AgentInternetBlockedBody {
    blocked: bool,
}

pub async fn agent_internet_blocked_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentInternetBlockedBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    db::set_agent_internet_blocked(&s.db, id, body.blocked).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "set_agent_internet_blocked",
        "ok",
        &serde_json::json!({ "blocked": body.blocked }),
        ip.as_deref(),
    )
    .await;
    ws_agent::push_network_policy_to_agent(&s, id).await;
    Ok(agent_internet_blocked_get(Path(id), State(s)).await)
}

// ── Internal ──────────────────────────────────────────────────────────────────

async fn push_to_affected(s: &Arc<AppState>, scopes: &[(String, Option<Uuid>, Option<Uuid>)]) {
    if scopes.iter().any(|(k, _, _)| k == "all" || k == "group") {
        ws_agent::push_internet_block_to_all_connected(s).await;
    } else {
        for (_, _, agent_id) in scopes {
            if let Some(id) = agent_id {
                ws_agent::push_network_policy_to_agent(s, *id).await;
            }
        }
    }
}
