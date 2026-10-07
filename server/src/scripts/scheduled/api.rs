//! Admin API for scheduled scripts.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use super::db;
use super::{ScheduledScriptSchedule, ScheduledScriptScope};
use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireAdmin;
use crate::platform::audit;
use crate::state::AppState;

const MAX_SCRIPT_BODY_BYTES: usize = 256 * 1024;
const MIN_TIMEOUT_SECS: i32 = 5;
const MAX_TIMEOUT_SECS: i32 = 300;

/// Shared gate for the remote-script kill-switch (ALLOW_REMOTE_SCRIPT_EXECUTION).
/// Message mirrors `scripts::remote_api` so clients get a consistent error contract.
fn remote_script_disabled() -> ApiError {
    ApiError::Forbidden(
        "Remote script execution is disabled. Set ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server (high risk)."
            .into(),
    )
}

fn validate_name(name: &str) -> Result<String, &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required");
    }
    if trimmed.len() > 120 {
        return Err("name must be 120 characters or fewer");
    }
    Ok(trimmed.to_string())
}

fn validate_shell(shell: &str) -> Result<String, &'static str> {
    let normalized = shell.trim().to_lowercase();
    if normalized == "powershell" || normalized == "cmd" {
        Ok(normalized)
    } else {
        Err("shell must be \"powershell\" or \"cmd\"")
    }
}

fn validate_script(script: &str) -> Result<(), &'static str> {
    if script.is_empty() {
        return Err("script is required");
    }
    if script.len() > MAX_SCRIPT_BODY_BYTES {
        return Err("script exceeds maximum size");
    }
    Ok(())
}

fn validate_timeout(timeout_secs: i32) -> Result<i32, &'static str> {
    if !(MIN_TIMEOUT_SECS..=MAX_TIMEOUT_SECS).contains(&timeout_secs) {
        return Err("timeout_secs must be between 5 and 300");
    }
    Ok(timeout_secs)
}

fn validate_scope(scope: &ScheduledScriptScope) -> Result<(), &'static str> {
    match scope.kind.as_str() {
        "all" if scope.group_id.is_none() && scope.agent_id.is_none() => Ok(()),
        "group" if scope.group_id.is_some() && scope.agent_id.is_none() => Ok(()),
        "agent" if scope.agent_id.is_some() && scope.group_id.is_none() => Ok(()),
        _ => Err("invalid scope"),
    }
}

fn validate_schedule(schedule: &ScheduledScriptSchedule) -> Result<(), &'static str> {
    match schedule.frequency.as_str() {
        "hourly" => {
            if !(0..=59).contains(&schedule.fire_minute) {
                return Err("hourly fire_minute must be between 0 and 59");
            }
            if schedule.day_of_week.is_some() {
                return Err("hourly schedules must not set day_of_week");
            }
            Ok(())
        }
        "daily" => {
            if !(0..=1439).contains(&schedule.fire_minute) {
                return Err("daily fire_minute must be between 0 and 1439");
            }
            if schedule.day_of_week.is_some() {
                return Err("daily schedules must not set day_of_week");
            }
            Ok(())
        }
        "weekly" => {
            if !(0..=1439).contains(&schedule.fire_minute) {
                return Err("weekly fire_minute must be between 0 and 1439");
            }
            match schedule.day_of_week {
                Some(day) if (0..=6).contains(&day) => Ok(()),
                _ => Err("weekly schedules require day_of_week between 0 and 6"),
            }
        }
        _ => Err("frequency must be \"hourly\", \"daily\", or \"weekly\""),
    }
}

fn validate_scopes(scopes: &[ScheduledScriptScope]) -> Result<(), &'static str> {
    if scopes.is_empty() {
        return Err("at least one scope is required");
    }
    if scopes.len() > 256 {
        return Err("too many scopes");
    }
    for scope in scopes {
        validate_scope(scope)?;
    }
    Ok(())
}

fn validate_schedules(schedules: &[ScheduledScriptSchedule]) -> Result<(), &'static str> {
    if schedules.is_empty() {
        return Err("at least one schedule is required");
    }
    if schedules.len() > 256 {
        return Err("too many schedules");
    }
    for schedule in schedules {
        validate_schedule(schedule)?;
    }
    Ok(())
}

pub async fn list_scripts(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    let rules = db::list_scripts(&s.db).await?;
    Ok(Json(serde_json::json!({ "scripts": rules })))
}

#[derive(Deserialize)]
pub struct CreateScheduledScriptBody {
    pub name: String,
    pub shell: String,
    pub script: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i32,
    pub scopes: Vec<ScheduledScriptScope>,
    pub schedules: Vec<ScheduledScriptSchedule>,
}

const fn default_timeout() -> i32 {
    120
}

pub async fn create_script(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateScheduledScriptBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = validate_name(&body.name).map_err(ApiError::bad_request)?;
    let shell = validate_shell(&body.shell).map_err(ApiError::bad_request)?;
    validate_script(&body.script).map_err(ApiError::bad_request)?;
    let timeout_secs = validate_timeout(body.timeout_secs).map_err(ApiError::bad_request)?;
    validate_scopes(&body.scopes).map_err(ApiError::bad_request)?;
    validate_schedules(&body.schedules).map_err(ApiError::bad_request)?;

    let id = db::create_script(
        &s.db,
        &name,
        &shell,
        &body.script,
        timeout_secs,
        &body.scopes,
        &body.schedules,
    )
    .await?;

    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "scheduled_script_create",
        "ok",
        &serde_json::json!({ "id": id, "name": name }),
        ip.as_deref(),
    )
    .await;

    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

#[derive(Deserialize)]
pub struct UpdateScheduledScriptBody {
    pub enabled: Option<bool>,
    pub name: Option<String>,
    pub shell: Option<String>,
    pub script: Option<String>,
    pub timeout_secs: Option<i32>,
    pub scopes: Option<Vec<ScheduledScriptScope>>,
    pub schedules: Option<Vec<ScheduledScriptSchedule>>,
}

pub async fn update_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateScheduledScriptBody>,
) -> ApiResult<Json<Value>> {
    let name = match body.name.as_deref() {
        Some(v) => Some(validate_name(v).map_err(ApiError::bad_request)?),
        None => None,
    };
    let shell = match body.shell.as_deref() {
        Some(v) => Some(validate_shell(v).map_err(ApiError::bad_request)?),
        None => None,
    };
    if let Some(script) = body.script.as_deref() {
        validate_script(script).map_err(ApiError::bad_request)?;
    }
    let timeout_secs = match body.timeout_secs {
        Some(v) => Some(validate_timeout(v).map_err(ApiError::bad_request)?),
        None => None,
    };
    if let Some(ref scopes) = body.scopes {
        validate_scopes(scopes).map_err(ApiError::bad_request)?;
    }
    if let Some(ref schedules) = body.schedules {
        validate_schedules(schedules).map_err(ApiError::bad_request)?;
    }

    db::update_script(
        &s.db,
        id,
        db::ScriptUpdate {
            enabled: body.enabled,
            name,
            shell,
            script: body.script,
            timeout_secs,
            scopes: body.scopes,
            schedules: body.schedules,
        },
    )
    .await?;

    let ip = audit_ip(&headers, addr);
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "scheduled_script_update",
        "ok",
        &serde_json::json!({ "id": id }),
        ip.as_deref(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn trigger_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    // Honor the same kill-switch as the ad-hoc run path; a manual "run now"
    // must not bypass ALLOW_REMOTE_SCRIPT_EXECUTION=false.
    if !s.settings.allow_remote_script {
        return Err(remote_script_disabled());
    }

    // 1. Fetch script details
    let script = db::script_body(&s.db, id).await?;

    let Some((_name, shell, script_body, timeout_secs)) = script else {
        return Err(ApiError::not_found("Script not found"));
    };

    // 2. Fetch scopes
    let scopes = db::script_scopes(&s.db, id).await?;

    let target_agents = db::resolve_agents(&s.db, &scopes).await?;

    if target_agents.is_empty() {
        return Err(ApiError::bad_request("No agents in scope"));
    }

    let connected_agents = s
        .agents
        .connections
        .lock()
        .keys()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let now_utc = chrono::Utc::now();
    // For manual triggers, we use the actual current time as expected_fire_time but maybe append "(manual)" or similar?
    // Actually, let's just use the current time truncated to seconds for consistency.
    let fire_time = now_utc;

    for agent_id in &target_agents {
        let is_online = connected_agents.contains(agent_id);
        let status = if is_online {
            "fired"
        } else {
            "skipped_offline"
        };

        // Record execution (manual trigger)
        let _ = db::insert_manual_execution(&s.db, id, *agent_id, status, fire_time).await;

        if is_online {
            super::spawn_run_and_record(
                s.clone(),
                id,
                *agent_id,
                shell.clone(),
                script_body.clone(),
                timeout_secs,
                fire_time,
                true,
            );
        }
    }

    let agent_count = target_agents.len();
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "scheduled_script_trigger",
        "ok",
        &serde_json::json!({
            "script_id": id,
            "agent_count": agent_count,
            "agents_online": target_agents.iter().filter(|a| connected_agents.contains(a)).count(),
        }),
        None,
    )
    .await;

    Ok(Json(
        serde_json::json!({ "ok": true, "agent_count": agent_count }),
    ))
}

pub async fn delete_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    if db::delete_script(&s.db, id).await? == 0 {
        return Err(ApiError::not_found("Script not found"));
    }
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "scheduled_script_delete",
        "ok",
        &serde_json::json!({ "id": id }),
        None,
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    pub limit: Option<i64>,
}

pub async fn events_all(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let results = db::list_executions(&s.db, limit).await?;
    Ok(Json(serde_json::json!({ "rows": results })))
}

pub async fn events_for_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let results = db::list_executions_for_script(&s.db, id, limit).await?;
    Ok(Json(serde_json::json!({ "rows": results })))
}
