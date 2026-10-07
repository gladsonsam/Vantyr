//! Per-agent runtime log viewing (pulled live from the connected agent; not stored server-side).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;
use vantyr_protocol::commands::{ListLogSources, ReadLogTail};
use vantyr_protocol::ServerCommand;

use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;

const DEFAULT_TAIL_MAX_KB: u32 = 512;
const MAX_TAIL_MAX_KB: u32 = 2048;
const LOG_RPC_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize, Default)]
pub struct TailQuery {
    kind: Option<String>,
    max_kb: Option<u32>,
}

pub async fn agent_log_sources(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_operator() {
        return Err(ApiError::Empty(StatusCode::FORBIDDEN));
    }
    let _ = (headers, addr);

    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    s.rpc.register_log_waiter(rid, tx);

    let cmd = ServerCommand::ListLogSources(ListLogSources::new(&rid.to_string()));
    if let Err(e) = s.agents.send_command(agent_id, &cmd) {
        s.rpc.remove_log_waiter(rid);
        return Err(ApiError::custom(e.response()));
    }

    match tokio::time::timeout(LOG_RPC_TIMEOUT, rx).await {
        Ok(Ok(val)) => Ok(Json(val)),
        Ok(Err(_)) => Err(ApiError::coded(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Internal wait channel closed.",
        )),
        Err(_) => {
            s.rpc.remove_log_waiter(rid);
            Err(ApiError::coded(
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "Timed out waiting for agent log sources.",
            ))
        }
    }
}

pub async fn agent_log_tail(
    Path(agent_id): Path<Uuid>,
    Query(q): Query<TailQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_operator() {
        return Err(ApiError::Empty(StatusCode::FORBIDDEN));
    }
    let ip = audit_ip(&headers, addr);

    let kind = q.kind.unwrap_or_else(|| "local_agent".into());
    let kind = kind.trim().to_string();
    if kind.is_empty() || kind.len() > 64 {
        return Err(ApiError::coded(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "kind must be a non-empty string",
        ));
    }
    let max_kb = q.max_kb.unwrap_or(DEFAULT_TAIL_MAX_KB).min(MAX_TAIL_MAX_KB);

    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    s.rpc.register_log_waiter(rid, tx);

    let cmd =
        ServerCommand::ReadLogTail(ReadLogTail::new(&rid.to_string(), &kind, u64::from(max_kb)));
    if let Err(e) = s.agents.send_command(agent_id, &cmd) {
        s.rpc.remove_log_waiter(rid);
        audit::insert_audit_log_traced(
            &s.db,
            user.username.as_str(),
            Some(agent_id),
            "view_agent_logs",
            "error",
            &serde_json::json!({ "error": "agent_offline" }),
            ip.as_deref(),
        )
        .await;
        return Err(ApiError::custom(e.response()));
    }

    let out = match tokio::time::timeout(LOG_RPC_TIMEOUT, rx).await {
        Ok(Ok(val)) => {
            audit::insert_audit_log_dedup_traced(
                &s.db,
                audit::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: Some(agent_id),
                    action: "view_agent_logs",
                    status: "ok",
                    detail: &serde_json::json!({ "kind": kind, "max_kb": max_kb }),
                    dedup_window_secs: 2,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Ok(Json(val))
        }
        Ok(Err(_)) => Err(ApiError::coded(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Internal wait channel closed.",
        )),
        Err(_) => {
            s.rpc.remove_log_waiter(rid);
            audit::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                Some(agent_id),
                "view_agent_logs",
                "error",
                &serde_json::json!({ "error": "timeout" }),
                ip.as_deref(),
            )
            .await;
            Err(ApiError::coded(
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "Timed out waiting for agent log tail.",
            ))
        }
    };

    out
}
