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
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use super::helpers::{audit_ip, err500};
use crate::{auth, db, state::AppState, ws_agent};

// ── List ──────────────────────────────────────────────────────────────────────

pub async fn internet_block_rules_list(State(s): State<Arc<AppState>>) -> Response {
    match db::internet_block_rules_list_all(&s.db).await {
        Ok(rules) => Json(serde_json::json!({ "rules": rules })).into_response(),
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateInternetBlockRule>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    let scopes: Vec<(String, Option<Uuid>, Option<Uuid>)> = body
        .scopes
        .iter()
        .map(|s| (s.kind.clone(), s.group_id, s.agent_id))
        .collect();

    match db::internet_block_rule_create(&s.db, &body.name, &scopes, &body.schedules).await {
        Ok(id) => {
            db::insert_audit_log_traced(
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
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
        }
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateInternetBlockRule>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    match db::internet_block_rule_set_enabled(&s.db, rule_id, body.enabled).await {
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Not found" })),
        )
            .into_response(),
        Ok(true) => {
            if let Some(sched) = body.schedules.as_ref() {
                if let Err(e) = db::internet_block_rule_set_schedules(&s.db, rule_id, sched).await {
                    return err500(e);
                }
            }
            db::insert_audit_log_traced(
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
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

// ── Delete ────────────────────────────────────────────────────────────────────

pub async fn internet_block_rules_delete(
    Path(rule_id): Path<i64>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    let has_all = db::internet_block_rule_has_all_scope(&s.db, rule_id)
        .await
        .unwrap_or(false);
    let direct_agents = db::internet_block_rule_direct_agent_ids(&s.db, rule_id)
        .await
        .unwrap_or_default();

    match db::internet_block_rule_delete(&s.db, rule_id).await {
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Not found" })),
        )
            .into_response(),
        Ok(true) => {
            db::insert_audit_log_traced(
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
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

// ── Per-agent GET / PUT (quick toggle) ───────────────────────────────────────

pub async fn agent_internet_blocked_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> Response {
    let blocked = db::get_agent_internet_blocked(&s.db, id)
        .await
        .unwrap_or(false);
    let source = db::get_agent_internet_block_source(&s.db, id)
        .await
        .unwrap_or(None);
    Json(serde_json::json!({ "blocked": blocked, "source": source })).into_response()
}

#[derive(Deserialize)]
pub struct AgentInternetBlockedBody {
    blocked: bool,
}

pub async fn agent_internet_blocked_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentInternetBlockedBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    match db::set_agent_internet_blocked(&s.db, id, body.blocked).await {
        Ok(()) => {
            db::insert_audit_log_traced(
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
            agent_internet_blocked_get(Path(id), State(s)).await
        }
        Err(e) => err500(e),
    }
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
