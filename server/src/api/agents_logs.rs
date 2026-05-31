//! Per-agent runtime log viewing (pulled live from the connected agent; not stored server-side).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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

use crate::{auth, db, state::AppState};

use super::helpers::audit_ip;

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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let _ = (user, headers, addr); // authenticated by middleware; any role may view logs

    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    s.register_log_waiter(rid, tx);

    let cmd = serde_json::json!({
        "type": "ListLogSources",
        "request_id": rid.to_string(),
    });
    if !s.try_send_agent_command_json(agent_id, &cmd) {
        s.remove_log_waiter(rid);
        return crate::error::api_json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_offline",
            "Agent is not connected.",
        );
    }

    match tokio::time::timeout(LOG_RPC_TIMEOUT, rx).await {
        Ok(Ok(val)) => Json(val).into_response(),
        Ok(Err(_)) => crate::error::api_json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Internal wait channel closed.",
        ),
        Err(_) => {
            s.remove_log_waiter(rid);
            crate::error::api_json_error(
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "Timed out waiting for agent log sources.",
            )
        }
    }
}

pub async fn agent_log_tail(
    Path(agent_id): Path<Uuid>,
    Query(q): Query<TailQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let ip = audit_ip(&headers, addr);

    let kind = q.kind.unwrap_or_else(|| "local_agent".into());
    let kind = kind.trim().to_string();
    if kind.is_empty() || kind.len() > 64 {
        return crate::error::api_json_error(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "kind must be a non-empty string",
        );
    }
    let max_kb = q.max_kb.unwrap_or(DEFAULT_TAIL_MAX_KB).min(MAX_TAIL_MAX_KB);

    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    s.register_log_waiter(rid, tx);

    let cmd = serde_json::json!({
        "type": "ReadLogTail",
        "request_id": rid.to_string(),
        "kind": kind,
        "max_kb": max_kb,
    });
    if !s.try_send_agent_command_json(agent_id, &cmd) {
        s.remove_log_waiter(rid);
        db::insert_audit_log_traced(
            &s.db,
            user.username.as_str(),
            Some(agent_id),
            "view_agent_logs",
            "error",
            &serde_json::json!({ "error": "agent_offline" }),
            ip.as_deref(),
        )
        .await;
        return crate::error::api_json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_offline",
            "Agent is not connected.",
        );
    }

    let out = match tokio::time::timeout(LOG_RPC_TIMEOUT, rx).await {
        Ok(Ok(val)) => {
            db::insert_audit_log_dedup_traced(
                &s.db,
                db::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: Some(agent_id),
                    action: "view_agent_logs",
                    status: "ok",
                    detail: &serde_json::json!({ "kind": cmd["kind"], "max_kb": max_kb }),
                    dedup_window_secs: 2,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Json(val).into_response()
        }
        Ok(Err(_)) => crate::error::api_json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Internal wait channel closed.",
        ),
        Err(_) => {
            s.remove_log_waiter(rid);
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                Some(agent_id),
                "view_agent_logs",
                "error",
                &serde_json::json!({ "error": "timeout" }),
                ip.as_deref(),
            )
            .await;
            crate::error::api_json_error(
                StatusCode::GATEWAY_TIMEOUT,
                "timeout",
                "Timed out waiting for agent log tail.",
            )
        }
    };

    out
}
