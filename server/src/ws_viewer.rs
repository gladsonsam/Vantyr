//! WebSocket handler for dashboard viewers.
//!
//! Dashboards connect to `ws://<host>/ws/view`.
//!
//! ## Viewer → server messages
//!
//! ```json
//! { "type": "control", "agent_id": "<uuid>", "cmd": { "type": "MouseMove", "x": 100, "y": 200 } }
//! { "type": "control", "agent_id": "<uuid>", "cmd": { "type": "MouseClick", "x": 100, "y": 200, "button": "Left" } }
//! ```
//!
//! The server looks up the agent by UUID and forwards the `cmd` JSON to it
//! via the per-agent command channel registered in `AppState::agent_cmds`.
//!
//! ## Server → viewer messages
//!
//! On connect: `{ "event": "init", "agents": [...] }`
//! Then real-time: every telemetry event broadcast by `ws_agent`.

use std::sync::Arc;

use axum::extract::ws::WebSocket;
use axum::{
    extract::Extension,
    extract::{ws::Message, State, WebSocketUpgrade},
    response::IntoResponse,
};
use tokio::sync::broadcast::error::RecvError;
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::state::{AgentControl, AppState, Broadcast};

// Conservative bounds for viewer -> server control messages.
// This prevents large JSON objects from turning into expensive parses or
// unbounded command payload forwarding.
const MAX_VIEWER_TEXT_BYTES: usize = 64 * 1024;
/// File uploads send base64 chunks — align with agent `REMOTE_FILE_CHUNK_BYTES` + JSON (~8 MiB).
const MAX_VIEWER_WRITEFILE_MSG_BYTES: usize = 8 * 1024 * 1024;
const MAX_TYPE_TEXT_CHARS: usize = 2_000;
const MAX_NOTIFY_TITLE_CHARS: usize = 64;
const MAX_NOTIFY_MESSAGE_CHARS: usize = 256;
const MAX_FS_PATH_CHARS: usize = 2048;
const MAX_FS_NAME_CHARS: usize = 256;

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| run(socket, state, user))
}

async fn run(mut ws: WebSocket, state: Arc<AppState>, user: AuthUser) {
    // ── Send initial agent list (includes offline agents + last session times) ──
    let agents = crate::db::list_agents(&state.db).await.unwrap_or_default();

    let online: std::collections::HashMap<uuid::Uuid, chrono::DateTime<chrono::Utc>> = {
        let map = state.agents.lock();
        map.iter().map(|(id, a)| (*id, a.connected_at)).collect()
    };

    let agent_ids: Vec<Uuid> = agents
        .iter()
        .filter_map(|a| a["id"].as_str().and_then(|s| s.parse().ok()))
        .collect();
    let versions = match crate::db::agent_versions_batch(&state.db, &agent_ids).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "agent_versions_batch failed for viewer init");
            std::collections::HashMap::new()
        }
    };
    let session_times = match crate::db::agent_last_session_times_batch(&state.db, &agent_ids).await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "agent_last_session_times_batch failed for viewer init");
            std::collections::HashMap::new()
        }
    };

    let mut out: Vec<serde_json::Value> = Vec::with_capacity(agents.len());
    for a in agents {
        let id = match a["id"].as_str().and_then(|s| s.parse::<Uuid>().ok()) {
            Some(id) => id,
            None => continue,
        };
        let (last_connected_at, last_disconnected_at) =
            session_times.get(&id).copied().unwrap_or((None, None));
        let connected_at = online.get(&id).copied();
        out.push(serde_json::json!({
            "id": id,
            "name": a["name"],
            "first_seen": a["first_seen"],
            "last_seen": a["last_seen"],
            "icon": a["icon"],
            "agent_version": versions.get(&id).cloned(),
            "online": connected_at.is_some(),
            "connected_at": connected_at,
            "last_connected_at": last_connected_at,
            "last_disconnected_at": last_disconnected_at
        }));
    }

    let init = serde_json::json!({ "event": "init", "agents": out }).to_string();
    if ws.send(Message::Text(init)).await.is_err() {
        return;
    }

    // ── Subscribe to live events ──────────────────────────────────────────────
    let mut rx = state.tx.subscribe();

    loop {
        tokio::select! {
            // Broadcast from an agent handler → forward to this viewer.
            msg = rx.recv() => {
                match msg {
                    Ok(Broadcast::Text(text)) => {
                        if ws.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                    Err(RecvError::Lagged(n)) => {
                        warn!("Viewer lagged, dropped {n} messages");
                    }
                }
            }

            // Message from the viewer.
            frame = ws.recv() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        handle_viewer_message(&text, &state, &user);
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    info!("Viewer disconnected.");
}

// ─── Viewer → agent control forwarding ───────────────────────────────────────

fn handle_viewer_message(text: &str, state: &Arc<AppState>, user: &AuthUser) {
    if text.len() > MAX_VIEWER_WRITEFILE_MSG_BYTES {
        warn!(
            "Dropping viewer message: payload too large ({} bytes)",
            text.len()
        );
        return;
    }

    // RBAC: only operators/admins can send agent control commands via WebSocket.
    if !user.is_operator() {
        return;
    }

    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };

    if val["type"].as_str() != Some("control") {
        return;
    }

    // Validate command "shape" before forwarding to the agent.
    let cmd_type = val["cmd"]["type"].as_str().unwrap_or("");
    if text.len() > MAX_VIEWER_TEXT_BYTES && cmd_type != "WriteFileChunk" {
        warn!(
            "Dropping viewer message: payload too large ({} bytes)",
            text.len()
        );
        return;
    }

    let Some(agent_id_str) = val["agent_id"].as_str() else {
        return;
    };
    let Ok(agent_id) = agent_id_str.parse::<Uuid>() else {
        return;
    };
    let cmd_ok = match cmd_type {
        "MouseMove" => {
            let x_ok = val["cmd"]["x"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            let y_ok = val["cmd"]["y"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            x_ok && y_ok
        }
        "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp" => {
            let x_ok = val["cmd"]["x"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            let y_ok = val["cmd"]["y"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            let button_ok = val["cmd"]["button"]
                .as_str()
                .is_none_or(|b| matches!(b, "left" | "right" | "middle"));
            x_ok && y_ok && button_ok
        }
        "MouseScroll" => {
            let dx_ok = val["cmd"]["delta_x"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            let dy_ok = val["cmd"]["delta_y"]
                .as_i64()
                .is_some_and(|v| i32::try_from(v).is_ok());
            dx_ok && dy_ok
        }
        "TypeText" => val["cmd"]["text"]
            .as_str()
            .is_some_and(|s| s.chars().count() <= MAX_TYPE_TEXT_CHARS),
        "KeyPress" | "KeyDown" | "KeyUp" => val["cmd"]["key"].as_str().is_some_and(|k| {
            matches!(
                k,
                "enter"
                    | "backspace"
                    | "tab"
                    | "escape"
                    | "delete"
                    | "insert"
                    | "space"
                    | "home"
                    | "end"
                    | "pageup"
                    | "pagedown"
                    | "arrowup"
                    | "arrowdown"
                    | "arrowleft"
                    | "arrowright"
                    | "f1"
                    | "f2"
                    | "f3"
                    | "f4"
                    | "f5"
                    | "f6"
                    | "f7"
                    | "f8"
                    | "f9"
                    | "f10"
                    | "f11"
                    | "f12"
                    | "control"
                    | "alt"
                    | "shift"
                    | "meta"
                    | "capslock"
            )
        }),
        // Single Unicode character key press — used for modifier+key combos.
        "KeyChar" => val["cmd"]["char"]
            .as_str()
            .is_some_and(|s| s.chars().count() == 1),
        "Notify" => {
            let title_ok = val["cmd"]["title"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= MAX_NOTIFY_TITLE_CHARS);
            let msg_ok = val["cmd"]["message"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= MAX_NOTIFY_MESSAGE_CHARS);
            title_ok && msg_ok
        }
        // `ListDir` supports an omitted/empty path, which the agent treats as
        // "start at a sensible default" (typically the user's Documents folder).
        "ListDir" => true,
        "ReadFile" => val["cmd"]["path"].as_str().is_some(),
        "Mkdir" => {
            let path_ok = val["cmd"]["path"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let name_ok = val["cmd"]["name"]
                .as_str()
                .is_some_and(|n| !n.trim().is_empty() && n.chars().count() <= MAX_FS_NAME_CHARS);
            path_ok && name_ok
        }
        "RenamePath" => {
            let src_ok = val["cmd"]["src"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let dst_ok = val["cmd"]["dst"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            src_ok && dst_ok
        }
        "CopyPath" => {
            let src_ok = val["cmd"]["src"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            let dst_ok = val["cmd"]["dst"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS);
            src_ok && dst_ok
        }
        "DeletePath" => val["cmd"]["path"]
            .as_str()
            .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= MAX_FS_PATH_CHARS),
        "WriteFileChunk" => {
            let path_ok = val["cmd"]["path"]
                .as_str()
                .is_some_and(|p| !p.trim().is_empty() && p.chars().count() <= 2048);
            let total = val["cmd"]["total_chunks"].as_u64().unwrap_or(0);
            let idx = val["cmd"]["chunk_index"].as_u64().unwrap_or(0);
            let chunks_ok = total >= 1 && idx < total;
            let dv = &val["cmd"]["data"];
            let data_ok = dv.as_str().is_some() || dv.is_null();
            path_ok && chunks_ok && data_ok
        }
        "RequestInfo" | "RestartHost" | "ShutdownHost" | "LockHost" | "CollectSoftware" => true,
        _ => false,
    };

    if !cmd_ok {
        let cmd_type = if cmd_type.is_empty() {
            "unknown"
        } else {
            cmd_type
        };
        let detail = serde_json::json!({
            "cmd_type": cmd_type,
            "reason": "invalid cmd type/shape",
        });
        let pool = state.db.clone();
        let actor = user.username.clone();
        tokio::spawn(async move {
            crate::db::insert_audit_log_dedup_traced(
                &pool,
                crate::db::AuditLogDedup {
                    actor: actor.as_str(),
                    agent_id: Some(agent_id),
                    action: "control_command",
                    status: "rejected",
                    detail: &detail,
                    dedup_window_secs: 2,
                    client_ip: None,
                },
            )
            .await;
        });
        warn!("Dropping viewer control command: invalid cmd type/shape");
        return;
    }

    // Serialise just the `cmd` sub-object and forward it to the agent.
    let cmd = serde_json::to_string(&val["cmd"]).unwrap_or_default();
    if cmd.is_empty() || cmd == "null" {
        return;
    }

    // WebSocket-first mode: forward commands to the connected agent over its
    // per-agent command channel.
    let sent = state
        .agent_cmds
        .lock()
        .get(&agent_id)
        .map(|tx| tx.try_send(AgentControl::Text(cmd)).is_ok());

    let status = if sent == Some(true) { "ok" } else { "error" };
    let detail = serde_json::json!({
        "cmd_type": cmd_type,
        "agent_online": sent.is_some(),
    });
    let pool = state.db.clone();
    let actor = user.username.clone();
    let dedup_window_secs: i64 = match cmd_type {
        "MouseMove" | "MouseScroll" => 5,
        _ => 2,
    };
    tokio::spawn(async move {
        crate::db::insert_audit_log_dedup_traced(
            &pool,
            crate::db::AuditLogDedup {
                actor: actor.as_str(),
                agent_id: Some(agent_id),
                action: "control_command",
                status,
                detail: &detail,
                dedup_window_secs,
                client_ip: None,
            },
        )
        .await;
    });

    if sent == Some(false) {
        warn!("Agent {agent_id} command channel full or closed");
    }
}
