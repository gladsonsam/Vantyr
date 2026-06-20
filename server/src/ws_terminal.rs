//! Interactive-terminal WebSocket: `/ws/terminal?agent_id=<uuid>`.
//!
//! Bridges a browser terminal (xterm.js) to a ConPTY shell on the agent. Output
//! is routed only to the owning browser session (see `AppState::terminal_sessions`)
//! — never persisted, never broadcast to other viewers. Gated: operator role +
//! `ALLOW_REMOTE_SCRIPT_EXECUTION`, with a per-session audit entry.
//!
//! Browser → server: `{ "type": "input", "data": "..." }` / `{ "type": "resize", "cols", "rows" }`.
//! Server → browser: the agent's `terminal_output` (base64 `data_b64`) / `terminal_exit` frames.

use std::sync::Arc;

use axum::{
    extract::{ws::Message, ws::WebSocket, Extension, Query, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::state::AppState;

const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
pub struct TerminalParams {
    agent_id: String,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<TerminalParams>,
) -> Response {
    if !user.is_operator() {
        return (StatusCode::FORBIDDEN, "Operator role required").into_response();
    }
    if !state.allow_remote_script {
        return (
            StatusCode::FORBIDDEN,
            "Remote execution is disabled (ALLOW_REMOTE_SCRIPT_EXECUTION).",
        )
            .into_response();
    }
    let Ok(agent_id) = Uuid::parse_str(params.agent_id.trim()) else {
        return (StatusCode::BAD_REQUEST, "invalid agent_id").into_response();
    };
    match crate::agent_capabilities::capability_attemptable(&state.db, agent_id, "terminal").await {
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                "Interactive terminal is not supported by this agent.",
            )
                .into_response();
        }
        Err(e) => {
            tracing::warn!(%agent_id, error = %e, "failed to check terminal capability");
        }
        Ok(true) => {}
    }
    let cols = params.cols.unwrap_or(80).clamp(2, 500);
    let rows = params.rows.unwrap_or(24).clamp(1, 200);
    let username = user.username.clone();
    ws.on_upgrade(move |socket| run(socket, state, agent_id, cols, rows, username))
        .into_response()
}

async fn run(
    mut ws: WebSocket,
    state: Arc<AppState>,
    agent_id: Uuid,
    cols: u16,
    rows: u16,
    username: String,
) {
    let session_id = Uuid::new_v4();
    let (tx, mut rx) = mpsc::channel::<String>(512);
    state.register_terminal_session(session_id, tx);

    crate::db::insert_audit_log_traced(
        &state.db,
        &username,
        Some(agent_id),
        "terminal_session",
        "started",
        &serde_json::json!({ "session_id": session_id }),
        None,
    )
    .await;

    // Ask the agent to spawn a shell bound to this session.
    let start = serde_json::json!({
        "type": "TerminalStart", "session_id": session_id, "cols": cols, "rows": rows
    });
    if !state.try_send_agent_command_json(agent_id, &start) {
        let _ = ws
            .send(Message::Text(
                serde_json::json!({ "type": "terminal_error", "message": "Agent offline" })
                    .to_string(),
            ))
            .await;
        state.remove_terminal_session(session_id);
        return;
    }

    loop {
        tokio::select! {
            // Agent output routed to this session → browser.
            out = rx.recv() => {
                match out {
                    Some(frame) => {
                        if ws.send(Message::Text(frame)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            // Browser input/resize → agent.
            msg = ws.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_browser_msg(&text, &state, agent_id, session_id);
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // Terminate the agent-side shell and clean up.
    let close = serde_json::json!({ "type": "TerminalClose", "session_id": session_id });
    let _ = state.try_send_agent_command_json(agent_id, &close);
    state.remove_terminal_session(session_id);
    crate::db::insert_audit_log_traced(
        &state.db,
        &username,
        Some(agent_id),
        "terminal_session",
        "ended",
        &serde_json::json!({ "session_id": session_id }),
        None,
    )
    .await;
    info!("Terminal session ended.");
}

fn handle_browser_msg(text: &str, state: &Arc<AppState>, agent_id: Uuid, session_id: Uuid) {
    if text.len() > MAX_TERMINAL_INPUT_BYTES {
        return;
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    match val["type"].as_str() {
        Some("input") => {
            if let Some(data) = val["data"].as_str() {
                let cmd = serde_json::json!({
                    "type": "TerminalInput", "session_id": session_id, "data": data
                });
                let _ = state.try_send_agent_command_json(agent_id, &cmd);
            }
        }
        Some("resize") => {
            let cols = val["cols"].as_u64().unwrap_or(80).clamp(2, 500);
            let rows = val["rows"].as_u64().unwrap_or(24).clamp(1, 200);
            let cmd = serde_json::json!({
                "type": "TerminalResize", "session_id": session_id, "cols": cols, "rows": rows
            });
            let _ = state.try_send_agent_command_json(agent_id, &cmd);
        }
        _ => {}
    }
}
