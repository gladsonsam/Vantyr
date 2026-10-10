//! Interactive-terminal WebSocket: `/ws/terminal?agent_id=<uuid>`.
//!
//! Bridges a browser terminal (xterm.js) to a ConPTY shell on the agent. Output
//! is routed only to the owning browser session (see `RpcWaiters::register_terminal_session`)
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
use vantyr_protocol::commands::{TerminalInput, TerminalSession, TerminalSize};
use vantyr_protocol::ServerCommand;

use crate::http::AuthUser;
use crate::platform::audit;
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
    if !state.settings.allow_remote_script {
        return (
            StatusCode::FORBIDDEN,
            "Remote execution is disabled (ALLOW_REMOTE_SCRIPT_EXECUTION).",
        )
            .into_response();
    }
    let Ok(agent_id) = Uuid::parse_str(params.agent_id.trim()) else {
        return (StatusCode::BAD_REQUEST, "invalid agent_id").into_response();
    };
    match crate::agents::capabilities::capability_attemptable(&state.db, agent_id, "terminal").await
    {
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
    if let Err(e) = state.agents.authorize_agent_command(
        agent_id,
        &ServerCommand::TerminalStart(TerminalSize::default()).to_value(),
    ) {
        return e.response();
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
    state.rpc.register_terminal_session(session_id, tx);

    audit::insert_audit_log_traced(
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
    let start = ServerCommand::TerminalStart(TerminalSize::new(
        session_id,
        u64::from(cols),
        u64::from(rows),
    ));
    if let Err(e) = state.agents.send_command(agent_id, &start) {
        let _ = ws
            .send(Message::Text(
                serde_json::json!({ "type": "terminal_error", "message": e.error,"code":e.code })
                    .to_string(),
            ))
            .await;
        state.rpc.remove_terminal_session(session_id);
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
                        if let Err(e)=handle_browser_msg(&text, &state, agent_id, session_id) {
                            let _=ws.send(Message::Text(serde_json::json!({"type":"terminal_error","message":e.error,"code":e.code}).to_string())).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // Terminate the agent-side shell and clean up.
    let close = ServerCommand::TerminalClose(TerminalSession::new(session_id));
    let _ = state.agents.try_send_command(agent_id, &close);
    state.rpc.remove_terminal_session(session_id);
    audit::insert_audit_log_traced(
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

fn handle_browser_msg(
    text: &str,
    state: &Arc<AppState>,
    agent_id: Uuid,
    session_id: Uuid,
) -> Result<(), crate::agents::modules::CommandDenied> {
    if text.len() > MAX_TERMINAL_INPUT_BYTES {
        return Ok(());
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(());
    };
    match val["type"].as_str() {
        Some("input") => {
            if let Some(data) = val["data"].as_str() {
                let cmd = ServerCommand::TerminalInput(TerminalInput::new(session_id, data));
                state.agents.send_command(agent_id, &cmd)?;
            }
        }
        Some("resize") => {
            let cols = val["cols"].as_u64().unwrap_or(80).clamp(2, 500);
            let rows = val["rows"].as_u64().unwrap_or(24).clamp(1, 200);
            let cmd = ServerCommand::TerminalResize(TerminalSize::new(session_id, cols, rows));
            state.agents.send_command(agent_id, &cmd)?;
        }
        _ => {}
    }
    Ok(())
}
