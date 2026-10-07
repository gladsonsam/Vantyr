use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireAdmin;
use crate::platform::audit;
use crate::state::AppState;

const MAX_SCRIPT_BODY_BYTES: usize = 256 * 1024;
const MIN_TIMEOUT_SECS: i32 = 5;
const MAX_TIMEOUT_SECS: i32 = 300;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ScheduledScriptScope {
    pub kind: String,
    pub group_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ScheduledScriptSchedule {
    pub frequency: String,
    pub day_of_week: Option<i32>,
    pub fire_minute: i32,
}

#[derive(Serialize)]
pub struct ScheduledScriptRow {
    pub id: i64,
    pub name: String,
    pub shell: String,
    pub script: String,
    pub timeout_secs: i32,
    pub enabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub scopes: Vec<ScheduledScriptScope>,
    pub schedules: Vec<ScheduledScriptSchedule>,
}

/// Shared gate for the remote-script kill-switch (ALLOW_REMOTE_SCRIPT_EXECUTION).
/// Message mirrors `software_scripts.rs` so clients get a consistent error contract.
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
    let records = sqlx::query(
        r"
        SELECT 
            s.id, s.name, s.shell, s.script, s.timeout_secs, s.enabled, s.created_at, s.updated_at,
            COALESCE(json_agg(json_build_object('kind', sc.kind, 'group_id', sc.group_id, 'agent_id', sc.agent_id)) FILTER (WHERE sc.kind IS NOT NULL), '[]'::json) as scopes,
            COALESCE((
                SELECT json_agg(json_build_object('frequency', sch.frequency, 'day_of_week', sch.day_of_week, 'fire_minute', sch.fire_minute))
                FROM scheduled_script_schedules sch WHERE sch.script_id = s.id
            ), '[]'::json) as schedules
        FROM scheduled_scripts s
        LEFT JOIN scheduled_script_scopes sc ON sc.script_id = s.id
        GROUP BY s.id
        ORDER BY s.id DESC
        "
    )
    .fetch_all(&s.db)
    .await?;

    let mut rules = Vec::new();
    for r in records {
        let scopes_val: serde_json::Value = r.try_get("scopes").unwrap_or_default();
        let scopes: Vec<ScheduledScriptScope> =
            serde_json::from_value(scopes_val).unwrap_or_default();

        let schedules_val: serde_json::Value = r.try_get("schedules").unwrap_or_default();
        let schedules: Vec<ScheduledScriptSchedule> =
            serde_json::from_value(schedules_val).unwrap_or_default();

        rules.push(ScheduledScriptRow {
            id: r.try_get("id").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            shell: r.try_get("shell").unwrap_or_default(),
            script: r.try_get("script").unwrap_or_default(),
            timeout_secs: r.try_get("timeout_secs").unwrap_or_default(),
            enabled: r.try_get("enabled").unwrap_or_default(),
            created_at: r.try_get("created_at").unwrap_or_default(),
            updated_at: r.try_get("updated_at").unwrap_or_default(),
            scopes,
            schedules,
        });
    }

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

    let mut tx = s.db.begin().await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO scheduled_scripts (name, shell, script, timeout_secs) VALUES ($1, $2, $3, $4) RETURNING id"
    )
    .bind(&name)
    .bind(&shell)
    .bind(&body.script)
    .bind(timeout_secs)
    .fetch_one(&mut *tx)
    .await?;

    for scope in &body.scopes {
        sqlx::query(
            "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)"
        )
        .bind(id)
        .bind(&scope.kind)
        .bind(scope.group_id)
        .bind(scope.agent_id)
        .execute(&mut *tx)
        .await?;
    }

    for sch in &body.schedules {
        sqlx::query(
            "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)"
        )
        .bind(id)
        .bind(&sch.frequency)
        .bind(sch.day_of_week)
        .bind(sch.fire_minute)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

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

    let mut tx = s.db.begin().await?;

    if let Some(enabled) = body.enabled {
        sqlx::query("UPDATE scheduled_scripts SET enabled = $1, updated_at = NOW() WHERE id = $2")
            .bind(enabled)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(name) = name {
        sqlx::query("UPDATE scheduled_scripts SET name = $1, updated_at = NOW() WHERE id = $2")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(shell) = shell {
        sqlx::query("UPDATE scheduled_scripts SET shell = $1, updated_at = NOW() WHERE id = $2")
            .bind(shell)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(script) = body.script {
        sqlx::query("UPDATE scheduled_scripts SET script = $1, updated_at = NOW() WHERE id = $2")
            .bind(script)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(timeout_secs) = timeout_secs {
        sqlx::query(
            "UPDATE scheduled_scripts SET timeout_secs = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(timeout_secs)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(scopes) = body.scopes {
        sqlx::query("DELETE FROM scheduled_script_scopes WHERE script_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for scope in &scopes {
            sqlx::query(
                "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)"
            )
            .bind(id).bind(&scope.kind).bind(scope.group_id).bind(scope.agent_id)
            .execute(&mut *tx).await?;
        }
    }

    if let Some(schedules) = body.schedules {
        sqlx::query("DELETE FROM scheduled_script_schedules WHERE script_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for sch in &schedules {
            sqlx::query(
                "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)"
            )
            .bind(id).bind(&sch.frequency).bind(sch.day_of_week).bind(sch.fire_minute)
            .execute(&mut *tx).await?;
        }
    }

    tx.commit().await?;

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
    let script: Option<(String, String, String, i32)> = sqlx::query_as(
        "SELECT name, shell, script, timeout_secs FROM scheduled_scripts WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await?;

    let Some((_name, shell, script_body, timeout_secs)) = script else {
        return Err(ApiError::not_found("Script not found"));
    };

    // 2. Fetch scopes
    let scopes: Vec<ScheduledScriptScope> = sqlx::query_as(
        "SELECT kind, group_id, agent_id FROM scheduled_script_scopes WHERE script_id = $1",
    )
    .bind(id)
    .fetch_all(&s.db)
    .await?;

    let target_agents = resolve_agents(&s.db, &scopes).await?;

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
        let _ = sqlx::query(
            "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time, is_manual) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING"
        )
        .bind(id)
        .bind(agent_id)
        .bind(status)
        .bind(fire_time)
        .execute(&s.db)
        .await;

        if is_online {
            let s_clone = s.clone();
            let shell_clone = shell.clone();
            let body_clone = script_body.clone();
            let agent_id_val = *agent_id;
            tokio::spawn(async move {
                let result = crate::scripts::remote_api::run_script_and_wait(
                    s_clone.clone(),
                    agent_id_val,
                    shell_clone,
                    body_clone,
                    timeout_secs as u64,
                )
                .await;

                let mut output = String::new();
                if let Some(stdout) = result.get("stdout").and_then(|v| v.as_str()) {
                    if !stdout.is_empty() {
                        output.push_str("--- STDOUT ---\n");
                        output.push_str(stdout);
                        output.push('\n');
                    }
                }
                if let Some(stderr) = result.get("stderr").and_then(|v| v.as_str()) {
                    if !stderr.is_empty() {
                        output.push_str("--- STDERR ---\n");
                        output.push_str(stderr);
                        output.push('\n');
                    }
                }
                if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
                    if !err.is_empty() {
                        output.push_str("--- ERROR ---\n");
                        output.push_str(err);
                        output.push('\n');
                    }
                }

                let final_status = if (result.get("ok") == Some(&serde_json::json!(false)))
                    || (result.get("error").is_some() && result.get("exit_code").is_none())
                {
                    "error"
                } else if result.get("exit_code") == Some(&serde_json::json!(0)) {
                    "success"
                } else {
                    "failed"
                };

                let _ = sqlx::query(
                    "UPDATE scheduled_script_executions SET status = $1, output = $2 WHERE script_id = $3 AND agent_id = $4 AND expected_fire_time = $5"
                )
                .bind(final_status)
                .bind(output)
                .bind(id)
                .bind(agent_id_val)
                .bind(fire_time)
                .execute(&s_clone.db)
                .await;
            });
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

pub async fn resolve_agents(
    db: &sqlx::PgPool,
    scopes: &[ScheduledScriptScope],
) -> anyhow::Result<std::collections::HashSet<Uuid>> {
    let mut all = std::collections::HashSet::new();

    let has_all = scopes.iter().any(|s| s.kind == "all");
    if has_all {
        let rows: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM agents")
            .fetch_all(db)
            .await?;
        for id in rows {
            all.insert(id);
        }
        return Ok(all);
    }

    for scope in scopes {
        if scope.kind == "agent" {
            if let Some(aid) = scope.agent_id {
                all.insert(aid);
            }
        } else if scope.kind == "group" {
            if let Some(gid) = scope.group_id {
                let rows: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT agent_id FROM agent_group_members WHERE group_id = $1",
                )
                .bind(gid)
                .fetch_all(db)
                .await?;
                for aid in rows {
                    all.insert(aid);
                }
            }
        }
    }

    Ok(all)
}

pub async fn delete_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
) -> ApiResult<Json<Value>> {
    let r = sqlx::query("DELETE FROM scheduled_scripts WHERE id = $1")
        .bind(id)
        .execute(&s.db)
        .await?;
    if r.rows_affected() == 0 {
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
    let rows = sqlx::query(
        r"
        SELECT 
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            s.name as rule_name, a.name as agent_name
        FROM scheduled_script_executions e
        JOIN scheduled_scripts s ON s.id = e.script_id
        JOIN agents a ON a.id = e.agent_id
        ORDER BY e.expected_fire_time DESC
        LIMIT $1
        ",
    )
    .bind(limit)
    .fetch_all(&s.db)
    .await?;
    let mut results = Vec::new();
    for r in rows {
        results.push(serde_json::json!({
            "script_id": r.try_get::<i64, _>("script_id").unwrap_or(0),
            "agent_id": r.try_get::<Uuid, _>("agent_id").unwrap_or_default(),
            "agent_name": r.try_get::<String, _>("agent_name").unwrap_or_default(),
            "rule_name": r.try_get::<String, _>("rule_name").unwrap_or_default(),
            "status": r.try_get::<String, _>("status").unwrap_or_default(),
            "expected_fire_time": r.try_get::<chrono::DateTime<chrono::Utc>, _>("expected_fire_time").unwrap_or_default(),
            "output": r.try_get::<Option<String>, _>("output").unwrap_or_default(),
            "is_manual": r.try_get::<bool, _>("is_manual").unwrap_or(false),
        }));
    }
    Ok(Json(serde_json::json!({ "rows": results })))
}

pub async fn events_for_script(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let rows = sqlx::query(
        r"
        SELECT 
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            a.name as agent_name
        FROM scheduled_script_executions e
        JOIN agents a ON a.id = e.agent_id
        WHERE e.script_id = $1
        ORDER BY e.expected_fire_time DESC
        LIMIT $2
        ",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&s.db)
    .await?;
    let mut results = Vec::new();
    for r in rows {
        results.push(serde_json::json!({
            "script_id": r.try_get::<i64, _>("script_id").unwrap_or(0),
            "agent_id": r.try_get::<Uuid, _>("agent_id").unwrap_or_default(),
            "agent_name": r.try_get::<String, _>("agent_name").unwrap_or_default(),
            "status": r.try_get::<String, _>("status").unwrap_or_default(),
            "expected_fire_time": r.try_get::<chrono::DateTime<chrono::Utc>, _>("expected_fire_time").unwrap_or_default(),
            "output": r.try_get::<Option<String>, _>("output").unwrap_or_default(),
        }));
    }
    Ok(Json(serde_json::json!({ "rows": results })))
}
