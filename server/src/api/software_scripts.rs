//! Remote script execution and software inventory.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::auth::{self, RequireOperator};
use crate::error::{ApiError, ApiResult};
use crate::{agent_capabilities, db, state::AppState};

use super::helpers::audit_ip;

// ─── Software inventory & remote scripts ─────────────────────────────────────

const MAX_SCRIPT_BODY_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
pub struct RunScriptBody {
    shell: String,
    script: String,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
pub struct BulkScriptBody {
    agent_ids: Vec<Uuid>,
    shell: String,
    script: String,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Deserialize, Default)]
pub struct SoftwareListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn agent_software_list(
    Path(id): Path<Uuid>,
    Query(q): Query<SoftwareListQuery>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let paged = q.limit.is_some() || q.offset.is_some();
    if paged {
        let limit = q.limit.unwrap_or(500);
        let offset = q.offset.unwrap_or(0);
        if !(1..=5000).contains(&limit) {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "limit must be between 1 and 5000",
            ));
        }
        if !(0..=500_000).contains(&offset) {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "offset must be between 0 and 500000",
            ));
        }
        let (rows, total) = db::list_agent_software_paged(&s.db, id, limit, offset).await?;
        let last = db::latest_software_capture_time(&s.db, id)
            .await
            .unwrap_or(None);
        Ok(Json(serde_json::json!({
            "rows": rows,
            "last_captured_at": last,
            "total": total,
            "limit": limit,
            "offset": offset,
        })))
    } else {
        let rows = db::list_agent_software(&s.db, id).await?;
        let last = db::latest_software_capture_time(&s.db, id)
            .await
            .unwrap_or(None);
        Ok(Json(serde_json::json!({
            "rows": rows,
            "last_captured_at": last,
        })))
    }
}

fn idempotency_key_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get("idempotency-key")
        .or_else(|| headers.get("Idempotency-Key"))?;
    let s = raw.to_str().ok()?.trim();
    if s.is_empty() || s.len() > 128 {
        return None;
    }
    Some(s.to_string())
}

const SOFTWARE_COLLECT_IDEMPOTENCY_TTL: Duration = Duration::from_secs(120);

pub async fn agent_software_collect(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_operator() {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Forbidden",
        ));
    }
    let ip = audit_ip(&headers, addr);

    if let Some(key) = idempotency_key_from_headers(&headers) {
        let now = Instant::now();
        let mut map = s.throttles.software_collect_dedup.lock();
        map.retain(|_, t| now.duration_since(*t) < SOFTWARE_COLLECT_IDEMPOTENCY_TTL);
        if map.contains_key(&(id, key.clone())) {
            return Ok(Json(serde_json::json!({
                "ok": true,
                "idempotent_replay": true
            })));
        }
        map.insert((id, key), now);
    }

    let cmd = serde_json::json!({ "type": "CollectSoftware" });
    if let Err(e) = s.send_agent_command_json(id, &cmd) {
        if let Some(key) = idempotency_key_from_headers(&headers) {
            s.throttles.software_collect_dedup.lock().remove(&(id, key));
        }
        return Err(ApiError::Custom(e.response()));
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "software_collect",
        "ok",
        &serde_json::json!({}),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn run_script_and_wait(
    s: Arc<AppState>,
    agent_id: Uuid,
    shell: String,
    script: String,
    timeout: u64,
) -> serde_json::Value {
    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel();
    s.rpc.register_script_waiter(rid, tx);
    let cmd = serde_json::json!({
        "type": "RunScript",
        "request_id": rid.to_string(),
        "shell": shell,
        "script": script,
        "timeout_secs": timeout,
    });
    if let Err(e) = s.send_agent_command_json(agent_id, &cmd) {
        s.rpc.remove_script_waiter(rid);
        return serde_json::json!({
            "agent_id": agent_id,
            "ok": false,
            "error": e.error, "code":e.code,
        });
    }
    let wait = Duration::from_secs((timeout + 15).min(330));
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(mut val)) => {
            if let Some(o) = val.as_object_mut() {
                o.insert(
                    "agent_id".to_string(),
                    serde_json::Value::String(agent_id.to_string()),
                );
            }
            val
        }
        Ok(Err(_)) => serde_json::json!({
            "agent_id": agent_id,
            "ok": false,
            "error": "Internal wait channel closed.",
        }),
        Err(_) => {
            s.rpc.remove_script_waiter(rid);
            serde_json::json!({
                "agent_id": agent_id,
                "ok": false,
                "error": "Timed out waiting for script result.",
                "request_id": rid,
            })
        }
    }
}

pub async fn agent_run_script(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RunScriptBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    if !s.settings.allow_remote_script {
        return Err(ApiError::Forbidden(
            "Remote script execution is disabled. Set ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server (high risk)."
                .into(),
        ));
    }
    let shell = body.shell.trim().to_ascii_lowercase();
    match agent_capabilities::shell_error(&s.db, id, &shell).await {
        Ok(Some(error)) => {
            return Err(ApiError::bad_request(error));
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check script shell capability");
        }
        Ok(None) => {}
    }
    match agent_capabilities::capability_attemptable(&s.db, id, "script_execution").await {
        Ok(false) => {
            return Err(ApiError::Custom(
                (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "Script execution is not supported by this agent.",
                        "code": "feature_unavailable",
                        "feature": "script_execution",
                    })),
                )
                    .into_response(),
            ));
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check script capability");
        }
        Ok(true) => {}
    }
    if !matches!(shell.as_str(), "powershell" | "cmd" | "sh" | "bash") {
        return Err(ApiError::bad_request("unsupported shell"));
    }
    if body.script.len() > MAX_SCRIPT_BODY_BYTES {
        return Err(ApiError::bad_request("script exceeds maximum size"));
    }
    if let Err(e) = s.authorize_agent_command(id, &serde_json::json!({"type":"RunScript"})) {
        return Err(ApiError::Custom(e.response()));
    }
    let timeout = body.timeout_secs.unwrap_or(120).clamp(5, 300);
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "remote_script",
        "dispatched",
        &serde_json::json!({ "shell": shell }),
        ip.as_deref(),
    )
    .await;
    let val = run_script_and_wait(s.clone(), id, shell.clone(), body.script, timeout).await;
    let audit_status = if val.get("ok") == Some(&serde_json::json!(false))
        || val.get("error").is_some() && val.get("exit_code").is_none()
    {
        "error"
    } else {
        "ok"
    };
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "remote_script",
        audit_status,
        &serde_json::json!({
            "shell": shell,
            "exit_code": val.get("exit_code"),
        }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(val))
}

pub async fn agents_bulk_script(
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<BulkScriptBody>,
) -> ApiResult<Json<Value>> {
    if !s.settings.allow_remote_script {
        return Err(ApiError::Forbidden(
            "Remote script execution is disabled. Set ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server (high risk)."
                .into(),
        ));
    }
    if body.agent_ids.is_empty() {
        return Err(ApiError::bad_request("agent_ids must be non-empty"));
    }
    if body.agent_ids.len() > 64 {
        return Err(ApiError::bad_request("at most 64 agents per bulk request"));
    }
    let shell = body.shell.trim().to_ascii_lowercase();
    if !matches!(shell.as_str(), "powershell" | "cmd" | "sh" | "bash") {
        return Err(ApiError::bad_request("unsupported shell"));
    }
    if body.script.len() > MAX_SCRIPT_BODY_BYTES {
        return Err(ApiError::bad_request("script exceeds maximum size"));
    }
    let ip = audit_ip(&headers, addr);
    let timeout = body.timeout_secs.unwrap_or(120).clamp(5, 300);
    let s2 = s.clone();
    let script = body.script;
    let futs: Vec<_> = body
        .agent_ids
        .into_iter()
        .map(|aid| {
            let s3 = s2.clone();
            let sh = shell.clone();
            let sc = script.clone();
            async move {
                match agent_capabilities::shell_error(&s3.db, aid, &sh).await {
                    Ok(Some(error)) => {
                        return serde_json::json!({
                            "agent_id": aid,
                            "ok": false,
                            "error": error,
                        });
                    }
                    Err(e) => {
                        tracing::warn!(agent_id = %aid, error = %e, "failed to check script shell capability");
                    }
                    Ok(None) => {}
                }
                match agent_capabilities::capability_attemptable(&s3.db, aid, "script_execution").await {
                    Ok(false) => {
                        return serde_json::json!({
                            "agent_id": aid,
                            "ok": false,
                            "error": "Script execution is not supported by this agent.",
                        });
                    }
                    Err(e) => {
                        tracing::warn!(agent_id = %aid, error = %e, "failed to check script capability");
                    }
                    Ok(true) => {}
                }
                run_script_and_wait(s3, aid, sh, sc, timeout).await
            }
        })
        .collect();
    let results = futures_util::future::join_all(futs).await;
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "remote_script_bulk",
        "ok",
        &serde_json::json!({ "count": results.len(), "shell": shell }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "results": results })))
}
