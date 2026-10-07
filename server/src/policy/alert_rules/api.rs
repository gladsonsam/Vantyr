//! Alert rules (admin CRUD) and alert-rule event history.

use std::sync::Arc;

use std::net::SocketAddr;

use axum::response::{IntoResponse, Response};
use axum::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    Json,
};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{AuthUser, RequireAdmin};
use crate::policy::alert_rules::db;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;

type AlertRuleScopeRow = (String, Option<Uuid>, Option<Uuid>);

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

pub async fn alert_rule_events_all_h(
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let rows = db::alert_rule_events_list_all(&s.db, p.limit, p.offset).await?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn alert_rule_events_for_rule_h(
    Path(rule_id): Path<i64>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = db::alert_rule_events_list_for_rule(&s.db, rule_id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "rule_id": rule_id, "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: None,
            action: "view_alert_rule_events_by_rule",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn agent_alert_rule_events(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = db::alert_rule_events_list_for_agent(&s.db, id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_alert_rule_events",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn alert_rule_event_screenshot(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Response {
    match db::alert_rule_event_screenshot_get(&s.db, id).await {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "No screenshot").into_response(),
        Err(e) => ApiError::from(e).into_response(),
    }
}
