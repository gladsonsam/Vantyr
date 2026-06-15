//! App blocking rules — create, list, toggle, delete.
//!
//! GET  /api/app-block-rules?agent_id=X  → rules effective for that agent
//! GET  /api/app-block-rules             → all rules (admin)
//! POST /api/app-block-rules             ← {name, `exe_pattern`, `match_mode`, scopes}  (admin)
//! PUT  /api/app-block-rules/:id         ← {enabled: bool}  (admin)
//! DEL  /api/app-block-rules/:id         (admin)
//!
//! GET  /api/agents/:id/known-exes       → distinct exe names seen from this agent

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use uuid::Uuid;

use super::helpers::{audit_ip, err500};
use crate::{auth, db, state::AppState, ws_agent};

// ── Protected exe list ────────────────────────────────────────────────────────
//
// These processes are critical to Windows stability. Blocking them would render
// the machine unusable or unrecoverable remotely.

const PROTECTED_EXES: &[&str] = &[
    "explorer.exe",
    "winlogon.exe",
    "lsass.exe",
    "csrss.exe",
    "svchost.exe",
    "services.exe",
    "wininit.exe",
    "smss.exe",
    "dwm.exe",
    "taskmgr.exe",
    "conhost.exe",
    "spoolsv.exe",
    "audiodg.exe",
    "ntoskrnl.exe",
    "system",
    "registry",
    "vantyr-agent.exe",
    "vantyr-agent",
];

/// Returns `Some(name)` if the pattern would match a protected exe, else `None`.
fn check_protected(exe_pattern: &str, match_mode: &str) -> Option<String> {
    let pat = exe_pattern.trim().to_lowercase();
    for &protected in PROTECTED_EXES {
        let hit = if match_mode == "exact" {
            pat == protected
        } else {
            // "contains" — reject if the pattern is a substring of a protected name
            protected.contains(pat.as_str())
        };
        if hit {
            return Some(protected.to_string());
        }
    }
    None
}

// ── List ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AppBlockListQuery {
    pub agent_id: Option<Uuid>,
}

pub async fn app_block_rules_list(
    Query(params): Query<AppBlockListQuery>,
    State(s): State<Arc<AppState>>,
) -> Response {
    if let Some(agent_id) = params.agent_id {
        match db::app_block_rules_applicable_for_agent(&s.db, agent_id).await {
            Ok(rules) => Json(serde_json::json!({ "rules": rules })).into_response(),
            Err(e) => err500(e),
        }
    } else {
        match db::app_block_rules_list_all(&s.db).await {
            Ok(rules) => Json(serde_json::json!({ "rules": rules })).into_response(),
            Err(e) => err500(e),
        }
    }
}

// ── Create ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AppBlockRuleScope {
    pub kind: String,
    pub group_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct CreateAppBlockRuleBody {
    #[serde(default)]
    pub name: String,
    pub exe_pattern: String,
    #[serde(default = "default_match_mode")]
    pub match_mode: String,
    pub scopes: Vec<AppBlockRuleScope>,
    #[serde(default)]
    pub schedules: Vec<db::RuleScheduleJson>,
}

fn default_match_mode() -> String {
    "contains".into()
}

pub async fn app_block_rules_create(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateAppBlockRuleBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if body.exe_pattern.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "exe_pattern is required" })),
        )
            .into_response();
    }
    let match_mode = if body.match_mode == "exact" {
        "exact"
    } else {
        "contains"
    };
    if let Some(hit) = check_protected(body.exe_pattern.trim(), match_mode) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": format!("'{}' is a protected system process and cannot be blocked.", hit)
            })),
        )
            .into_response();
    }

    let scopes: Vec<(String, Option<Uuid>, Option<Uuid>)> = body
        .scopes
        .iter()
        .map(|s| (s.kind.clone(), s.group_id, s.agent_id))
        .collect();

    let ip = audit_ip(&headers, addr);
    match db::app_block_rule_create(
        &s.db,
        &body.name,
        body.exe_pattern.trim(),
        match_mode,
        &scopes,
        &body.schedules,
    )
    .await
    {
        Ok(id) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "app_block_rule_create",
                "ok",
                &serde_json::json!({ "id": id, "exe_pattern": body.exe_pattern }),
                ip.as_deref(),
            )
            .await;
            // Push updated rules to affected agents.
            push_to_affected(&s, id, &scopes).await;
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
        }
        Err(e) => err500(e),
    }
}

// ── Update (toggle enabled) ───────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct UpdateAppBlockRuleBody {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub exe_pattern: Option<String>,
    #[serde(default)]
    pub match_mode: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<AppBlockRuleScope>>,
    #[serde(default)]
    pub schedules: Option<Vec<db::RuleScheduleJson>>,
}

pub async fn app_block_rules_update(
    Path(rule_id): Path<i64>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateAppBlockRuleBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    let match_mode =
        body.match_mode
            .as_deref()
            .map(|m| if m == "exact" { "exact" } else { "contains" });
    if let Some(ref pat) = body.exe_pattern {
        if let Some(hit) = check_protected(pat.trim(), match_mode.unwrap_or("contains")) {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "error": format!("'{}' is a protected system process and cannot be blocked.", hit)
                })),
            )
            .into_response();
        }
    }

    let scopes: Option<Vec<db::ScopeRow>> = body.scopes.as_ref().map(|sc| {
        sc.iter()
            .map(|s| (s.kind.clone(), s.group_id, s.agent_id))
            .collect()
    });

    match db::app_block_rule_update(
        &s.db,
        rule_id,
        db::AppBlockRuleUpdateOpts {
            name: body.name.as_deref(),
            exe_pattern: body
                .exe_pattern
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
            match_mode,
            enabled: body.enabled,
            scopes: scopes.as_deref(),
            schedules: body.schedules.as_deref(),
        },
    )
    .await
    {
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
                "app_block_rule_update",
                "ok",
                &serde_json::json!({ "id": rule_id }),
                ip.as_deref(),
            )
            .await;
            ws_agent::push_app_block_rules_to_all_connected(&s).await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

// ── Delete ────────────────────────────────────────────────────────────────────

pub async fn app_block_rules_delete(
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

    // Capture scope info before deleting so we know who to notify.
    let has_all = db::app_block_rule_has_all_scope(&s.db, rule_id)
        .await
        .unwrap_or(false);
    let direct_agents = db::app_block_rule_direct_agent_ids(&s.db, rule_id)
        .await
        .unwrap_or_default();

    match db::app_block_rule_delete(&s.db, rule_id).await {
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
                "app_block_rule_delete",
                "ok",
                &serde_json::json!({ "id": rule_id }),
                ip.as_deref(),
            )
            .await;
            if has_all {
                ws_agent::push_app_block_rules_to_all_connected(&s).await;
            } else {
                for agent_id in direct_agents {
                    ws_agent::push_app_block_rules_to_agent(&s, agent_id).await;
                }
            }
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

// ── Protected exe list endpoint ───────────────────────────────────────────────

pub async fn protected_exes_list() -> Response {
    Json(serde_json::json!({ "protected": PROTECTED_EXES })).into_response()
}

// ── Known exes ────────────────────────────────────────────────────────────────

pub async fn agent_known_exes(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> Response {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT app FROM window_events WHERE agent_id = $1 AND app IS NOT NULL AND app <> '' ORDER BY app LIMIT 300",
    )
    .bind(agent_id)
    .fetch_all(&s.db)
    .await;

    match rows {
        Ok(exes) => Json(serde_json::json!({ "exes": exes })).into_response(),
        Err(e) => err500(anyhow::anyhow!(e)),
    }
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

const fn default_limit() -> i64 {
    500
}

pub async fn agent_app_block_events(
    Path(agent_id): Path<Uuid>,
    Query(params): Query<EventsQuery>,
    State(s): State<Arc<AppState>>,
) -> Response {
    match db::app_block_events_for_agent(&s.db, agent_id, params.limit, params.offset).await {
        Ok(rows) => Json(serde_json::json!({ "rows": rows })).into_response(),
        Err(e) => err500(e),
    }
}

pub async fn rule_app_block_events(
    Path(rule_id): Path<i64>,
    Query(params): Query<EventsQuery>,
    State(s): State<Arc<AppState>>,
) -> Response {
    match db::app_block_events_for_rule(&s.db, rule_id, params.limit, params.offset).await {
        Ok(rows) => Json(serde_json::json!({ "rows": rows })).into_response(),
        Err(e) => err500(e),
    }
}

pub async fn all_app_block_events(
    Query(params): Query<EventsQuery>,
    State(s): State<Arc<AppState>>,
) -> Response {
    match db::app_block_events_all(&s.db, params.limit, params.offset).await {
        Ok(rows) => Json(serde_json::json!({ "rows": rows })).into_response(),
        Err(e) => err500(e),
    }
}

// ── Effective rules per agent ─────────────────────────────────────────────────

pub async fn agent_effective_rules(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> Response {
    let alert = db::alert_rules_effective_for_agent(&s.db, agent_id, "url")
        .await
        .unwrap_or_default();
    let alert_keys = db::alert_rules_effective_for_agent(&s.db, agent_id, "keys")
        .await
        .unwrap_or_default();
    let app_block = db::app_block_rules_effective_for_agent(&s.db, agent_id)
        .await
        .unwrap_or_default();
    let internet_blocked = db::get_agent_internet_blocked(&s.db, agent_id)
        .await
        .unwrap_or(false);
    let internet_block_source = db::get_agent_internet_block_source(&s.db, agent_id)
        .await
        .unwrap_or(None);

    let mut all_alerts = alert;
    for r in alert_keys {
        if !all_alerts.iter().any(|x| x.id == r.id) {
            all_alerts.push(r);
        }
    }

    Json(serde_json::json!({
        "alert_rules": all_alerts,
        "app_block_rules": app_block,
        "internet_blocked": internet_blocked,
        "internet_block_source": internet_block_source,
    }))
    .into_response()
}

// ── Internal helper ───────────────────────────────────────────────────────────

/// Push updated rules to agents affected by the given scopes.
async fn push_to_affected(
    s: &Arc<AppState>,
    _rule_id: i64,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
) {
    let has_all = scopes.iter().any(|(k, _, _)| k == "all");
    if has_all {
        ws_agent::push_app_block_rules_to_all_connected(s).await;
        return;
    }
    for (kind, _group_id, agent_id) in scopes {
        if kind == "agent" {
            if let Some(id) = agent_id {
                ws_agent::push_app_block_rules_to_agent(s, *id).await;
            }
        } else if kind == "group" {
            // For group scope, push to all connected agents (safe over-push).
            ws_agent::push_app_block_rules_to_all_connected(s).await;
            return;
        }
    }
}
