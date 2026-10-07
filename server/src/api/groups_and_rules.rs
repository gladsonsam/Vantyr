//! Agent groups and alert rules (admin).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::RequireAdmin;
use crate::{db, state::AppState};

use crate::http::audit_ip;
use crate::platform::audit;

type AlertRuleScopeRow = (String, Option<Uuid>, Option<Uuid>);

// ─── Agent groups & alert rules (admin) ───────────────────────────────────────

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

#[derive(Deserialize)]
pub struct AlertRuleScopeIn {
    kind: String,
    #[serde(default)]
    group_id: Option<Uuid>,
    #[serde(default)]
    agent_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct AlertRuleCreateBody {
    #[serde(default)]
    name: String,
    channel: String,
    pattern: String,
    #[serde(default = "default_match_mode")]
    match_mode: String,
    #[serde(default = "default_true")]
    case_insensitive: bool,
    #[serde(default = "default_cooldown_secs")]
    cooldown_secs: i32,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    take_screenshot: bool,
    // Monitoring channels: resource (metric/comparator/threshold) + agent_offline (duration_secs).
    #[serde(default)]
    metric: Option<String>,
    #[serde(default)]
    comparator: Option<String>,
    #[serde(default)]
    threshold: Option<f32>,
    #[serde(default)]
    duration_secs: Option<i32>,
    scopes: Vec<AlertRuleScopeIn>,
}

#[derive(Deserialize)]
pub struct AlertRuleUpdateBody {
    #[serde(default)]
    name: String,
    channel: String,
    pattern: String,
    #[serde(default = "default_match_mode")]
    match_mode: String,
    #[serde(default = "default_true")]
    case_insensitive: bool,
    #[serde(default = "default_cooldown_secs")]
    cooldown_secs: i32,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    take_screenshot: bool,
    // Monitoring channels: resource (metric/comparator/threshold) + agent_offline (duration_secs).
    #[serde(default)]
    metric: Option<String>,
    #[serde(default)]
    comparator: Option<String>,
    #[serde(default)]
    threshold: Option<f32>,
    #[serde(default)]
    duration_secs: Option<i32>,
    scopes: Vec<AlertRuleScopeIn>,
}

fn default_match_mode() -> String {
    "substring".to_string()
}

const fn default_true() -> bool {
    true
}

const fn default_cooldown_secs() -> i32 {
    300
}

fn normalize_alert_scopes(
    scopes: &[AlertRuleScopeIn],
) -> Result<Vec<AlertRuleScopeRow>, &'static str> {
    if scopes.is_empty() {
        return Err("at least one scope is required");
    }
    let mut out = Vec::with_capacity(scopes.len());
    for s in scopes {
        match s.kind.as_str() {
            "all" if s.group_id.is_none() && s.agent_id.is_none() => {
                out.push(("all".to_string(), None, None));
            }
            "group" if s.group_id.is_some() && s.agent_id.is_none() => {
                out.push(("group".to_string(), s.group_id, None));
            }
            "agent" if s.agent_id.is_some() && s.group_id.is_none() => {
                out.push(("agent".to_string(), None, s.agent_id));
            }
            _ => {
                return Err(
                    "each scope must be { kind: \"all\" } or { kind: \"group\", group_id } or { kind: \"agent\", agent_id }",
                );
            }
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn validate_alert_rule_pattern(
    channel: &str,
    match_mode: &str,
    pattern: &str,
    case_insensitive: bool,
    metric: Option<&str>,
    comparator: Option<&str>,
    threshold: Option<f32>,
    duration_secs: Option<i32>,
) -> Result<(), String> {
    match channel {
        "url" | "keys" | "url_category" => {
            if match_mode != "substring" && match_mode != "regex" {
                return Err("match_mode must be \"substring\" or \"regex\"".to_string());
            }
            if pattern.trim().is_empty() {
                return Err("pattern must be non-empty".to_string());
            }
            if match_mode == "regex" {
                RegexBuilder::new(pattern)
                    .case_insensitive(case_insensitive)
                    .build()
                    .map_err(|e| format!("invalid regex: {e}"))?;
            }
            Ok(())
        }
        "resource" => {
            if !matches!(metric, Some("cpu_pct" | "mem_pct" | "disk_pct")) {
                return Err("metric must be \"cpu_pct\", \"mem_pct\", or \"disk_pct\"".to_string());
            }
            if !matches!(comparator, Some("gt" | "lt")) {
                return Err("comparator must be \"gt\" or \"lt\"".to_string());
            }
            match threshold {
                Some(t) if (0.0..=100.0).contains(&t) => Ok(()),
                _ => Err("threshold must be between 0 and 100".to_string()),
            }
        }
        "agent_offline" => match duration_secs {
            Some(d) if d < 0 => Err("duration_secs must be >= 0".to_string()),
            _ => Ok(()),
        },
        _ => Err(
            "channel must be \"url\", \"keys\", \"url_category\", \"resource\", or \"agent_offline\""
                .to_string(),
        ),
    }
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

pub async fn alert_rules_list_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    let rules = db::alert_rules_list_all(&s.db).await?;
    Ok(Json(serde_json::json!({ "rules": rules })))
}

pub async fn alert_rules_create_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<AlertRuleCreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    validate_alert_rule_pattern(
        body.channel.trim(),
        body.match_mode.trim(),
        body.pattern.trim(),
        body.case_insensitive,
        body.metric.as_deref(),
        body.comparator.as_deref(),
        body.threshold,
        body.duration_secs,
    )
    .map_err(ApiError::bad_request)?;
    let scopes = normalize_alert_scopes(&body.scopes).map_err(ApiError::bad_request)?;
    let params = db::AlertRuleUpsert {
        name: body.name.trim(),
        channel: body.channel.trim(),
        pattern: body.pattern.trim(),
        match_mode: body.match_mode.trim(),
        case_insensitive: body.case_insensitive,
        cooldown_secs: body.cooldown_secs,
        enabled: body.enabled,
        take_screenshot: body.take_screenshot,
        metric: body.metric.as_deref(),
        comparator: body.comparator.as_deref(),
        threshold: body.threshold,
        duration_secs: body.duration_secs,
        scopes: scopes.as_slice(),
    };
    let id = db::alert_rule_create_with_scopes(&s.db, &params).await?;
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "alert_rule_create",
        "ok",
        &serde_json::json!({ "id": id, "name": body.name.trim(), "channel": body.channel.trim() }),
        ip.as_deref(),
    )
    .await;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

pub async fn alert_rules_update_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(rule_id): Path<i64>,
    Json(body): Json<AlertRuleUpdateBody>,
) -> ApiResult<Json<Value>> {
    validate_alert_rule_pattern(
        body.channel.trim(),
        body.match_mode.trim(),
        body.pattern.trim(),
        body.case_insensitive,
        body.metric.as_deref(),
        body.comparator.as_deref(),
        body.threshold,
        body.duration_secs,
    )
    .map_err(ApiError::bad_request)?;
    let scopes = normalize_alert_scopes(&body.scopes).map_err(ApiError::bad_request)?;
    let params = db::AlertRuleUpsert {
        name: body.name.trim(),
        channel: body.channel.trim(),
        pattern: body.pattern.trim(),
        match_mode: body.match_mode.trim(),
        case_insensitive: body.case_insensitive,
        cooldown_secs: body.cooldown_secs,
        enabled: body.enabled,
        take_screenshot: body.take_screenshot,
        metric: body.metric.as_deref(),
        comparator: body.comparator.as_deref(),
        threshold: body.threshold,
        duration_secs: body.duration_secs,
        scopes: scopes.as_slice(),
    };
    if !db::alert_rule_update_with_scopes(&s.db, rule_id, &params).await? {
        return Err(ApiError::not_found("Rule not found"));
    }
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "alert_rule_update",
        "ok",
        &serde_json::json!({ "id": rule_id, "name": body.name.trim(), "enabled": body.enabled }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn alert_rules_delete_h(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: axum::http::HeaderMap,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(rule_id): Path<i64>,
) -> ApiResult<Json<Value>> {
    if !db::alert_rule_delete(&s.db, rule_id).await? {
        return Err(ApiError::not_found("Rule not found"));
    }
    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "alert_rule_delete",
        "ok",
        &serde_json::json!({ "id": rule_id }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
