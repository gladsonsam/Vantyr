//! Remote script execution and software inventory.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{agent_capabilities, auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

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
) -> Response {
    let paged = q.limit.is_some() || q.offset.is_some();
    if paged {
        let limit = q.limit.unwrap_or(500);
        let offset = q.offset.unwrap_or(0);
        if !(1..=5000).contains(&limit) {
            return crate::error::api_json_error(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "limit must be between 1 and 5000",
            );
        }
        if !(0..=500_000).contains(&offset) {
            return crate::error::api_json_error(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "offset must be between 0 and 500000",
            );
        }
        match db::list_agent_software_paged(&s.db, id, limit, offset).await {
            Ok((rows, total)) => {
                let last = db::latest_software_capture_time(&s.db, id)
                    .await
                    .unwrap_or(None);
                Json(serde_json::json!({
                    "rows": rows,
                    "last_captured_at": last,
                    "total": total,
                    "limit": limit,
                    "offset": offset,
                }))
                .into_response()
            }
            Err(e) => err500(e),
        }
    } else {
        match db::list_agent_software(&s.db, id).await {
            Ok(rows) => {
                let last = db::latest_software_capture_time(&s.db, id)
                    .await
                    .unwrap_or(None);
                Json(serde_json::json!({
                    "rows": rows,
                    "last_captured_at": last,
                }))
                .into_response()
            }
            Err(e) => err500(e),
        }
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
) -> Response {
    if !user.is_operator() {
        return crate::error::api_json_error(StatusCode::FORBIDDEN, "forbidden", "Forbidden");
    }
    let ip = audit_ip(&headers, addr);

    if let Some(key) = idempotency_key_from_headers(&headers) {
        let now = Instant::now();
        let mut map = s.software_collect_dedup.lock();
        map.retain(|_, t| now.duration_since(*t) < SOFTWARE_COLLECT_IDEMPOTENCY_TTL);
        if map.contains_key(&(id, key.clone())) {
            return Json(serde_json::json!({
                "ok": true,
                "idempotent_replay": true
            }))
            .into_response();
        }
        map.insert((id, key), now);
    }

    let cmd = serde_json::json!({ "type": "CollectSoftware" });
    if !s.try_send_agent_command_json(id, &cmd) {
        if let Some(key) = idempotency_key_from_headers(&headers) {
            s.software_collect_dedup.lock().remove(&(id, key));
        }
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "Agent is not connected.",
                "code": "agent_offline",
            })),
        )
            .into_response();
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
    Json(serde_json::json!({ "ok": true })).into_response()
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
    s.register_script_waiter(rid, tx);
    let cmd = serde_json::json!({
        "type": "RunScript",
        "request_id": rid.to_string(),
        "shell": shell,
        "script": script,
        "timeout_secs": timeout,
    });
    if !s.try_send_agent_command_json(agent_id, &cmd) {
        s.remove_script_waiter(rid);
        return serde_json::json!({
            "agent_id": agent_id,
            "ok": false,
            "error": "Agent is not connected.",
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
            s.remove_script_waiter(rid);
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RunScriptBody>,
) -> Response {
    let ip = audit_ip(&headers, addr);
    if !user.is_operator() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if !s.allow_remote_script {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Remote script execution is disabled. Set ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server (high risk)."
            })),
        )
            .into_response();
    }
    let shell = body.shell.trim().to_ascii_lowercase();
    match agent_capabilities::shell_error(&s.db, id, &shell).await {
        Ok(Some(error)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check script shell capability");
        }
        Ok(None) => {}
    }
    match agent_capabilities::capability_attemptable(&s.db, id, "script_execution").await {
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "Script execution is not supported by this agent.",
                    "code": "feature_unavailable",
                    "feature": "script_execution",
                })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check script capability");
        }
        Ok(true) => {}
    }
    if !matches!(shell.as_str(), "powershell" | "cmd" | "sh" | "bash") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unsupported shell" })),
        )
            .into_response();
    }
    if body.script.len() > MAX_SCRIPT_BODY_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "script exceeds maximum size" })),
        )
            .into_response();
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
    Json(val).into_response()
}

pub async fn agents_bulk_script(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<BulkScriptBody>,
) -> Response {
    if !user.is_operator() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if !s.allow_remote_script {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Remote script execution is disabled. Set ALLOW_REMOTE_SCRIPT_EXECUTION=true on the server (high risk)."
            })),
        )
            .into_response();
    }
    if body.agent_ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "agent_ids must be non-empty" })),
        )
            .into_response();
    }
    if body.agent_ids.len() > 64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "at most 64 agents per bulk request" })),
        )
            .into_response();
    }
    let shell = body.shell.trim().to_ascii_lowercase();
    if !matches!(shell.as_str(), "powershell" | "cmd" | "sh" | "bash") {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unsupported shell" })),
        )
            .into_response();
    }
    if body.script.len() > MAX_SCRIPT_BODY_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "script exceeds maximum size" })),
        )
            .into_response();
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
    Json(serde_json::json!({ "results": results })).into_response()
}
