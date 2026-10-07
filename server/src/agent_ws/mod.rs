//! The agent WebSocket (`/ws/agent`): authentication and connection lifecycle
//! (`connection`), inbound event dispatch (`dispatch`), Recall keyframe ingest
//! (`history_ingest`), and server-to-agent policy pushes (`policy_push`).
//!
//! Agents connect to `ws://<host>/ws/agent?name=<hostname>`.
//! Binary frames are treated as JPEG screenshots and cached in memory.
//! Text frames must be JSON objects with a `"type"` field.
//!
//! Each agent connection also gets a per-agent command channel so that
//! dashboard viewers can send mouse/keyboard control commands back to the
//! agent (via the server) without needing a direct connection.
//!
//! Screen capture is demand-driven: the MJPEG stream handler in `control::live_media`
//! sends `start_capture` / `stop_capture` based on viewer count.  The agent
//! always stops capture when its WebSocket session ends, so each new session
//! starts idle until explicitly asked to capture.

use std::sync::Arc;

use axum::{
    extract::{Query, State, WebSocketUpgrade},
    http::HeaderMap,
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use tracing::warn;

use crate::state::AppState;

pub mod connection;
mod dispatch;
mod history_ingest;
pub mod policy_push;

use connection::{authenticate_agent, run};

// Conservative bounds to mitigate memory/DB-flood DoS.
// These can be tuned later (or moved to env/config).
pub const MAX_AGENT_NAME_CHARS: usize = 128;
/// ~3 MiB raw chunk → ~4.1 MiB base64 + JSON overhead (see agent `REMOTE_FILE_CHUNK_BYTES`).
pub(super) const MAX_AGENT_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_AGENT_BINARY_BYTES: usize = 8 * 1024 * 1024; // JPEG frames
/// Magic prefix marking a binary frame as a Recall keyframe (header JSON + raw JPEG),
/// alongside `AUD\0` (audio) and bare JPEG (MJPEG) on the same socket.
/// Keep in sync with `HISTORY_FRAME_MAGIC` in `agent/src/agent_loop.rs`.
pub(super) const HISTORY_FRAME_MAGIC: &[u8; 4] = b"HST\0";
pub(super) const MAX_KEYS_TEXT_CHARS: usize = 4_000;
pub(super) const MAX_URL_STR_BYTES: usize = 4_096;
pub(super) const MAX_WINDOW_TITLE_CHARS: usize = 512;
pub(super) const MAX_WINDOW_APP_CHARS: usize = 256;

#[derive(Deserialize)]
pub struct AgentQuery {
    name: Option<String>,
}

pub async fn handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AgentQuery>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let name = params
        .name
        .unwrap_or_else(|| "unknown".into())
        .trim()
        .chars()
        .take(MAX_AGENT_NAME_CHARS)
        .collect::<String>();

    let Some(authenticated) = authenticate_agent(&state, &name, &provided).await else {
        warn!(agent_name = %name, "Agent WS auth rejected (401).");
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    ws.on_upgrade(move |socket| run(socket, name, authenticated, state))
}

/// Unauthenticated agent socket; agents authenticate with a per-device bearer token.
pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route("/ws/agent", axum::routing::get(handler))
}
