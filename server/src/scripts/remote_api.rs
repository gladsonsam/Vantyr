//! Ad-hoc and bulk remote script execution.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::RequireOperator;
use crate::{agents::capabilities, state::AppState};

use crate::http::audit_ip;
use crate::platform::audit;
use crate::scripts::dispatch;

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
    match capabilities::shell_error(&s.db, id, &shell).await {
        Ok(Some(error)) => {
            return Err(ApiError::bad_request(error));
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check script shell capability");
        }
        Ok(None) => {}
    }
    match capabilities::capability_attemptable(&s.db, id, "script_execution").await {
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
    if let Err(e) = s.agents.authorize_agent_command(
        id,
        &vantyr_protocol::ServerCommand::RunScript(Default::default()).to_value(),
    ) {
        return Err(ApiError::Custom(e.response()));
    }
    let timeout = body.timeout_secs.unwrap_or(120).clamp(5, 300);
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "remote_script",
        "dispatched",
        &serde_json::json!({ "shell": shell }),
        ip.as_deref(),
    )
    .await;
    let val =
        dispatch::run_script_and_wait(s.clone(), id, shell.clone(), body.script, timeout).await;
    let audit_status = if val.get("ok") == Some(&serde_json::json!(false))
        || val.get("error").is_some() && val.get("exit_code").is_none()
    {
        "error"
    } else {
        "ok"
    };
    audit::insert_audit_log_traced(
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
                match capabilities::shell_error(&s3.db, aid, &sh).await {
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
                match capabilities::capability_attemptable(&s3.db, aid, "script_execution").await {
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
                dispatch::run_script_and_wait(s3, aid, sh, sc, timeout).await
            }
        })
        .collect();
    let results = futures_util::future::join_all(futs).await;
    audit::insert_audit_log_traced(
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
