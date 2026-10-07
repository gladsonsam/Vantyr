//! Agent authentication, socket registration under the lifecycle gate, the socket read
//! loop, and disconnect cleanup.

use std::sync::Arc;

use axum::extract::ws::Message;
use axum::extract::ws::WebSocket;
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};
use uuid::Uuid;

use super::dispatch::dispatch_text;
use super::history_ingest::ingest_history_frame_binary;
use super::policy_push::push_initial_policies;
use super::{HISTORY_FRAME_MAGIC, MAX_AGENT_BINARY_BYTES, MAX_AGENT_TEXT_BYTES};
use crate::agents::db as agents_db;
use crate::agents::modules::db as modules_db;
use crate::auth::secrets;
use crate::state::{AgentControl, AppState, AGENT_CMD_CHANNEL_CAPACITY};

pub(crate) struct AuthenticatedAgent {
    pub(crate) id: Uuid,
    pub(crate) token_hash: String,
}

pub(super) async fn authenticate_agent(
    state: &Arc<AppState>,
    name: &str,
    provided: &str,
) -> Option<AuthenticatedAgent> {
    if provided.is_empty() {
        return None;
    }
    let (id, token_hash) = match agents_db::get_agent_auth_by_name(&state.db, name).await {
        Ok(Some((id, Some(hash)))) => (id, hash),
        Ok(_) => return None,
        Err(e) => {
            error!(error = %e, "get_agent_auth_by_name failed");
            return None;
        }
    };
    secrets::verify_dashboard_password(&token_hash, provided)
        .then_some(AuthenticatedAgent { id, token_hash })
}

pub(crate) struct RegisteredAgent {
    pub(crate) lifecycle: Arc<tokio::sync::RwLock<()>>,
    pub(crate) session_id: i64,
    pub(crate) conn_id: Uuid,
    pub(crate) shutdown_rx: watch::Receiver<Option<&'static str>>,
    pub(crate) cmd_rx: mpsc::Receiver<AgentControl>,
}

pub(crate) async fn register_authenticated_connection(
    authenticated: &AuthenticatedAgent,
    name: &str,
    state: &Arc<AppState>,
) -> anyhow::Result<Option<RegisteredAgent>> {
    let agent_id = authenticated.id;
    let lifecycle = state.agents.lifecycle.for_agent(agent_id);
    // No credential mutation can interleave between this final check and both
    // in-memory registrations. A delayed upgrade cannot adopt a rotated token.
    let registration = lifecycle.clone().write_owned().await;
    let Some(session_id) =
        agents_db::register_authenticated_agent(&state.db, agent_id, &authenticated.token_hash)
            .await?
    else {
        return Ok(None);
    };
    // Fail closed: an unknown history is treated as a modern, grant-reporting agent.
    let legacy_policy_delivery = !modules_db::has_module_report(&state.db, agent_id)
        .await
        .unwrap_or(true);
    let connected_at = chrono::Utc::now();
    let conn_id = Uuid::new_v4();
    let (shutdown_tx, shutdown_rx) = watch::channel(None);
    let (cmd_tx, cmd_rx) = mpsc::channel::<AgentControl>(AGENT_CMD_CHANNEL_CAPACITY);
    {
        let mut control = state.control.lock();
        let old_conn = state
            .agents
            .connections
            .lock()
            .get(&agent_id)
            .map(|c| c.conn_id);
        if let Some(old_conn) = old_conn {
            state.revoke_agent_control_locked(&mut control, agent_id, old_conn);
            state.clear_capture_connection_locked(agent_id, old_conn);
        }
        let previous = state.agents.connections.lock().insert(
            agent_id,
            crate::state::AgentConn {
                conn_id,
                connected_at,
                session_id,
                shutdown: shutdown_tx,
                legacy_policy_delivery,
            },
        );
        state.agents.modules.lock().remove(&agent_id);
        state.agents.cmds.lock().insert(agent_id, cmd_tx);
        if let Some(previous) = previous {
            previous.shutdown.send_replace(Some(""));
        }
    }
    state.broadcast(
        serde_json::json!({
            "event": "agent_connected", "agent_id": agent_id,
            "name": name, "connected_at": connected_at,
        })
        .to_string(),
    );
    drop(registration);
    Ok(Some(RegisteredAgent {
        lifecycle,
        session_id,
        conn_id,
        shutdown_rx,
        cmd_rx,
    }))
}

pub(super) async fn run(
    mut ws: WebSocket,
    name: String,
    authenticated: AuthenticatedAgent,
    state: Arc<AppState>,
) {
    let agent_id = authenticated.id;
    let RegisteredAgent {
        lifecycle,
        session_id,
        conn_id,
        mut shutdown_rx,
        mut cmd_rx,
    } = match register_authenticated_connection(&authenticated, &name, &state).await {
        Ok(Some(connection)) => connection,
        Ok(None) => {
            close_invalidated_socket(&mut ws, "agent_credentials_revoked", agent_id).await;
            return;
        }
        Err(e) => {
            error!(error = %e, %agent_id, "final agent credential check failed");
            return;
        }
    };

    'session: {
        // Shutdown also interrupts initial settings queries and slow socket sends.
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break 'session,
            _ = push_initial_policies(&name, agent_id, &state) => {}
        }

        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => break,
                msg = ws.recv() => {
                    let lease = Arc::new(lifecycle.clone().read_owned().await);
                    if state.agents.connections.lock().get(&agent_id).map(|connection| connection.conn_id) != Some(conn_id) {
                        break;
                    }
                    match msg {
                        Some(Ok(Message::Binary(bytes))) => {
                            if bytes.len() > MAX_AGENT_BINARY_BYTES {
                                warn!(
                                    "Dropping agent {agent_id}: frame too large ({} bytes)",
                                    bytes.len()
                                );
                                break;
                            }

                            let frame = bytes::Bytes::from(bytes);

                            if frame.len() >= 4 && &frame[..4] == b"AUD\0" {
                                // Audio PCM frame — fan-out to live audio viewers.
                                if state.agents.module_authorized(agent_id,crate::agents::modules::Module::LiveAudio) { state.media.route_audio_frame(agent_id, frame); }
                            } else if frame.len() >= 4 && &frame[..4] == HISTORY_FRAME_MAGIC {
                                // Recall keyframe — persist to the blob store + index.
                                // Handled here (not fanned out) so the payload never
                                // reaches dashboard viewers.
                                if state.agents.module_authorized(agent_id,crate::agents::modules::Module::Recall) {ingest_history_frame_binary(agent_id, conn_id, &frame, &state, &lease).await;}
                            } else {
                                // JPEG screenshot frame — cache for MJPEG viewers.
                                if state.agents.module_authorized(agent_id,crate::agents::modules::Module::LiveScreen) {state.media.store_frame(agent_id, frame);}
                            }
                        }
                        Some(Ok(Message::Text(text))) => {
                            if text.len() > MAX_AGENT_TEXT_BYTES {
                                warn!(
                                    "Dropping agent {agent_id}: text frame too large ({} bytes)",
                                    text.len()
                                );
                                break;
                            }
                            dispatch_text(text.as_str(), agent_id, conn_id, &name, &state, &lease).await;
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => {}
                    }
                }

                // Control command (MouseMove / MouseClick JSON) from a viewer.
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(AgentControl::Text(cmd_str)) => {
                            let Ok(command) = serde_json::from_str(&cmd_str) else {continue;};
                            let _delivery_gate=lifecycle.clone().read_owned().await;
                            if !state.command_deliverable(agent_id,conn_id,&command) {continue;}
                            tokio::select! {
                                biased;
                                _ = shutdown_rx.changed() => break,
                                result = tokio::time::timeout(std::time::Duration::from_secs(5),ws.send(Message::Text(cmd_str))) => {
                                    if !matches!(result,Ok(Ok(()))) { break; }
                                }
                            }
                        }
                        Some(AgentControl::InputCleanup { conn_id: cleanup_conn, command }) => {
                            let _delivery_gate = lifecycle.clone().read_owned().await;
                            if !state.control_cleanup_deliverable(agent_id, conn_id, cleanup_conn, &command) { continue; }
                            tokio::select! {
                                biased;
                                _ = shutdown_rx.changed() => break,
                                result = tokio::time::timeout(std::time::Duration::from_secs(5), ws.send(Message::Text(command.to_string()))) => {
                                    if !matches!(result, Ok(Ok(()))) { break; }
                                }
                            }
                        }
                        Some(AgentControl::Close) => {
                            let _ = ws.send(Message::Close(None)).await;
                            break;
                        }
                        None => break, // All senders dropped.
                    }
                }
            }
        }
    }
    let reason = *shutdown_rx.borrow();
    if let Some(reason) = reason {
        close_invalidated_socket(&mut ws, reason, agent_id).await;
    }

    cleanup_connection(agent_id, conn_id, session_id, &state).await;
}

pub(crate) async fn cleanup_connection(
    agent_id: Uuid,
    conn_id: Uuid,
    session_id: i64,
    state: &Arc<AppState>,
) {
    // Cleanup and reconnect registration use the same gate so a stale socket
    // cannot remove a newer command sender or publish a late offline event.
    let gate = state.agents.lifecycle.for_agent(agent_id);
    let _cleanup = gate.write().await;
    // ── Cleanup ───────────────────────────────────────────────────────────────
    let disconnected_at = chrono::Utc::now();
    // Only clean up if this is still the current connection for this agent.
    // Otherwise, a newer WS session is active and we must not mark it offline.
    let is_current = {
        let mut control = state.control.lock();
        state.revoke_agent_control_locked(&mut control, agent_id, conn_id);
        state.clear_capture_connection_locked(agent_id, conn_id);
        let is_current = {
            let map = state.agents.connections.lock();
            map.get(&agent_id).map(|c| c.conn_id) == Some(conn_id)
        };
        if is_current {
            state.agents.clear_live(agent_id);
            state.agents.connections.lock().remove(&agent_id);
            state.agents.cmds.lock().remove(&agent_id);
            state.agents.modules.lock().remove(&agent_id);
            // Clear stale frame so MJPEG stream goes blank rather than serving the
            // last screenshot of a disconnected agent.
            state.media.frames.lock().remove(&agent_id);
        } else {
            info!(%agent_id, "Skipping stale disconnect cleanup");
        }
        is_current
    };
    if is_current {
        let _ = agents_db::touch_agent(&state.db, agent_id).await;
    }
    let _ = agents_db::end_agent_session(&state.db, session_id).await;

    if is_current {
        state.broadcast(
            serde_json::json!({
                "event":    "agent_disconnected",
                "agent_id": agent_id,
                "disconnected_at": disconnected_at,
            })
            .to_string(),
        );

        info!(%agent_id, "Agent disconnected");
    }
}

async fn close_invalidated_socket(ws: &mut WebSocket, reason: &str, agent_id: Uuid) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        if !reason.is_empty() {
            let payload = serde_json::json!({
                "type": reason, "agent_id": agent_id,
                "message": "This installation is no longer authorized. Re-enroll to reconnect.",
            });
            let _ = ws.send(Message::Text(payload.to_string())).await;
        }
        let _ = ws.send(Message::Close(None)).await;
    })
    .await;
}
