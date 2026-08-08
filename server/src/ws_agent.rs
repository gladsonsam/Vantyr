//! WebSocket handler for Windows agents.
//!
//! Agents connect to `ws://<host>/ws/agent?name=<hostname>`.
//! Binary frames are treated as JPEG screenshots and cached in memory.
//! Text frames must be JSON objects with a `"type"` field.
//!
//! Each agent connection also gets a per-agent command channel so that
//! dashboard viewers can send mouse/keyboard control commands back to the
//! agent (via the server) without needing a direct connection.
//!
//! Screen capture is demand-driven: the MJPEG stream handler in `api::agents_capture`
//! sends `start_capture` / `stop_capture` based on viewer count.  The agent
//! always stops capture when its WebSocket session ends, so each new session
//! starts idle until explicitly asked to capture.

use std::sync::Arc;

use axum::extract::ws::WebSocket;
use axum::{
    extract::{ws::Message, Query, State, WebSocketUpgrade},
    http::HeaderMap,
    http::StatusCode,
    response::IntoResponse,
};
use base64::Engine;
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::{
    alert_rules, db,
    state::{AgentControl, AppState, AGENT_CMD_CHANNEL_CAPACITY},
};

// Conservative bounds to mitigate memory/DB-flood DoS.
// These can be tuned later (or moved to env/config).
pub const MAX_AGENT_NAME_CHARS: usize = 128;
/// ~3 MiB raw chunk → ~4.1 MiB base64 + JSON overhead (see agent `REMOTE_FILE_CHUNK_BYTES`).
const MAX_AGENT_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_AGENT_BINARY_BYTES: usize = 8 * 1024 * 1024; // JPEG frames
/// Magic prefix marking a binary frame as a Recall keyframe (header JSON + raw JPEG),
/// alongside `AUD\0` (audio) and bare JPEG (MJPEG) on the same socket.
/// Keep in sync with `HISTORY_FRAME_MAGIC` in `agent/src/agent_loop.rs`.
const HISTORY_FRAME_MAGIC: &[u8; 4] = b"HST\0";

const MAX_KEYS_TEXT_CHARS: usize = 4_000;
const MAX_URL_STR_BYTES: usize = 4_096;
const MAX_WINDOW_TITLE_CHARS: usize = 512;
const MAX_WINDOW_APP_CHARS: usize = 256;

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

    if !agent_ws_authorized(&state, &name, provided.as_str()).await {
        // Do NOT log the secret itself; only log whether it was provided.
        warn!(
            agent_name = %name,
            provided_len = provided.len(),
            "Agent WS auth rejected (401)."
        );
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    ws.on_upgrade(move |socket| run(socket, name, state))
}

async fn agent_ws_authorized(state: &Arc<AppState>, agent_name: &str, provided: &str) -> bool {
    if provided.is_empty() {
        return false;
    }

    let row = match db::get_agent_auth_by_name(&state.db, agent_name).await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "get_agent_auth_by_name failed");
            return false;
        }
    };

    if let Some((_, Some(ref api_hash))) = row {
        let ok = db::verify_dashboard_password(api_hash, provided);
        if !ok {
            warn!(
                agent_name = %agent_name,
                provided_len = provided.len(),
                auth_mode = "per_device_token",
                "Agent WS auth failed: token mismatch."
            );
        }
        return ok;
    }

    warn!(
        agent_name = %agent_name,
        provided_len = provided.len(),
        auth_mode = "per_device_token",
        "Agent WS auth failed: enrolled per-device token is required."
    );
    false
}

async fn run(mut ws: WebSocket, name: String, state: Arc<AppState>) {
    // Register / touch the agent row in Postgres.
    let agent_id = match db::upsert_agent(&state.db, &name).await {
        Ok(id) => id,
        Err(e) => {
            error!("upsert_agent({name}): {e}");
            return;
        }
    };

    // Record connection session (history).
    let session_id = match db::start_agent_session(&state.db, agent_id).await {
        Ok(id) => id,
        Err(e) => {
            error!("start_agent_session({agent_id}): {e}");
            return;
        }
    };

    info!("Agent connected: {name} ({agent_id})");
    let connected_at = chrono::Utc::now();
    let conn_id = Uuid::new_v4();

    // Add to in-memory agent map.
    {
        let mut map = state.agents.lock();
        map.insert(
            agent_id,
            crate::state::AgentConn {
                conn_id,
                connected_at,
            },
        );
    }

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<AgentControl>(AGENT_CMD_CHANNEL_CAPACITY);
    state.agent_cmds.lock().insert(agent_id, cmd_tx.clone());

    state.broadcast(
        serde_json::json!({
            "event":    "agent_connected",
            "agent_id": agent_id,
            "name":     name,
            "connected_at": connected_at,
        })
        .to_string(),
    );

    // Push local settings-window password hash (SHA-256 hex) so the agent matches server policy.
    if let Ok(hash) = db::effective_agent_ui_password_hash(&state.db, agent_id).await {
        let sync = serde_json::json!({
            "type": "set_local_ui_password_hash",
            "hash": hash,
        })
        .to_string();
        if let Err(e) = ws.send(Message::Text(sync)).await {
            warn!("Failed to push local UI password to {name}: {e}");
            // Continue — agent can still work; user may reconnect.
        }
    }

    // Push auto-update policy so agents can be centrally managed.
    if let Ok(enabled) = db::effective_agent_auto_update_enabled(&state.db, agent_id).await {
        let sync = serde_json::json!({
            "type": "set_auto_update",
            "enabled": enabled,
        })
        .to_string();
        if let Err(e) = ws.send(Message::Text(sync)).await {
            warn!("Failed to push auto-update policy to {name}: {e}");
        }
    }

    // Push network policy so internet block is re-applied after a reboot.
    if let Ok(blocked) = db::get_agent_internet_blocked(&state.db, agent_id).await {
        let sync = serde_json::json!({
            "type": "set_network_policy",
            "blocked": blocked,
        })
        .to_string();
        if let Err(e) = ws.send(Message::Text(sync)).await {
            warn!("Failed to push network policy to {name}: {e}");
        }
    }

    // Push scheduled internet-block rules so curfews apply offline.
    if let Ok(rules) = db::internet_block_rules_effective_for_agent(&state.db, agent_id).await {
        let sync = serde_json::json!({
            "type": "set_internet_block_rules",
            "rules": rules,
        })
        .to_string();
        if let Err(e) = ws.send(Message::Text(sync)).await {
            warn!("Failed to push internet block rules to {name}: {e}");
        }
    }

    // Push app block rules so enforcement resumes after a reboot.
    if let Ok(rules) = db::app_block_rules_effective_for_agent(&state.db, agent_id).await {
        let sync = serde_json::json!({
            "type": "set_app_block_rules",
            "rules": rules,
        })
        .to_string();
        if let Err(e) = ws.send(Message::Text(sync)).await {
            warn!("Failed to push app block rules to {name}: {e}");
        }
    }

    // Push Recall capture settings before the first keyframe of this session, so a
    // cadence change or a kill switch set while this agent was offline applies now.
    if let Ok(settings) = db::effective_recall_settings(&state.db, agent_id).await {
        if !settings.is_null() {
            let sync = serde_json::json!({
                "type": "set_recall_settings",
                "settings": settings,
            })
            .to_string();
            if let Err(e) = ws.send(Message::Text(sync)).await {
                warn!("Failed to push Recall capture settings to {name}: {e}");
            }
        }
    }

    loop {
        tokio::select! {
            msg = ws.recv() => {
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
                            state.route_audio_frame(agent_id, frame);
                        } else if frame.len() >= 4 && &frame[..4] == HISTORY_FRAME_MAGIC {
                            // Recall keyframe — persist to the blob store + index.
                            // Handled here (not fanned out) so the payload never
                            // reaches dashboard viewers.
                            ingest_history_frame_binary(agent_id, &frame, &state).await;
                        } else {
                            // JPEG screenshot frame — cache for MJPEG viewers.
                            state.store_frame(agent_id, frame);
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
                        dispatch_text(text.as_str(), agent_id, &name, &state).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // Control command (MouseMove / MouseClick JSON) from a viewer.
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(AgentControl::Text(cmd_str)) => {
                        if ws.send(Message::Text(cmd_str)).await.is_err() {
                            break; // Agent disconnected.
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

    // ── Cleanup ───────────────────────────────────────────────────────────────
    let disconnected_at = chrono::Utc::now();
    // Only clean up if this is still the current connection for this agent.
    // Otherwise, a newer WS session is active and we must not mark it offline.
    let is_current = {
        let map = state.agents.lock();
        map.get(&agent_id).map(|c| c.conn_id) == Some(conn_id)
    };
    if is_current {
        state.clear_agent_live(agent_id);
        state.agents.lock().remove(&agent_id);
        state.agent_cmds.lock().remove(&agent_id);
        // Clear stale frame so MJPEG stream goes blank rather than serving the
        // last screenshot of a disconnected agent.
        state.frames.lock().remove(&agent_id);
    } else {
        info!("Skipping stale disconnect cleanup for {name} ({agent_id})");
    }
    let _ = db::touch_agent(&state.db, agent_id).await;
    let _ = db::end_agent_session(&state.db, session_id).await;

    if is_current {
        state.broadcast(
            serde_json::json!({
                "event":    "agent_disconnected",
                "agent_id": agent_id,
                "disconnected_at": disconnected_at,
            })
            .to_string(),
        );

        info!("Agent disconnected: {name} ({agent_id})");
    }
}

/// Push updated local UI password hash to a connected agent (after dashboard edit).
pub async fn push_local_ui_password_hash_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    let Ok(hash) = db::effective_agent_ui_password_hash(&state.db, agent_id).await else {
        return;
    };
    let payload = serde_json::json!({
        "type": "set_local_ui_password_hash",
        "hash": hash,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

pub async fn push_auto_update_policy_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    let Ok(enabled) = db::effective_agent_auto_update_enabled(&state.db, agent_id).await else {
        return;
    };
    let payload = serde_json::json!({
        "type": "set_auto_update",
        "enabled": enabled,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

pub async fn push_auto_update_policy_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.lock().keys().copied().collect();
    for id in ids {
        push_auto_update_policy_to_agent(state, id).await;
    }
}

pub async fn push_network_policy_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agent_capabilities::capability_attemptable(&state.db, agent_id, "network_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(blocked) = db::get_agent_internet_blocked(&state.db, agent_id).await else {
        return;
    };
    let payload = serde_json::json!({
        "type": "set_network_policy",
        "blocked": blocked,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

pub async fn push_internet_block_rules_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agent_capabilities::capability_attemptable(&state.db, agent_id, "network_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(rules) = db::internet_block_rules_effective_for_agent(&state.db, agent_id).await else {
        return;
    };
    let payload = serde_json::json!({
        "type": "set_internet_block_rules",
        "rules": rules,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

pub async fn push_app_block_rules_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    if !crate::agent_capabilities::capability_attemptable(&state.db, agent_id, "app_blocking")
        .await
        .unwrap_or(true)
    {
        return;
    }
    let Ok(rules) = db::app_block_rules_effective_for_agent(&state.db, agent_id).await else {
        return;
    };
    let payload = serde_json::json!({
        "type": "set_app_block_rules",
        "rules": rules,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

/// Push effective Recall capture settings to one agent.
///
/// Settings are per-agent (global row + optional override), so unlike a fleet-wide
/// policy this must be resolved and sent individually. Agents cache the result, so
/// this is what makes a change take effect now rather than at the next reconnect.
pub async fn push_recall_settings_to_agent(state: &Arc<AppState>, agent_id: uuid::Uuid) {
    let Ok(settings) = db::effective_recall_settings(&state.db, agent_id).await else {
        return;
    };
    if settings.is_null() {
        return; // No global row yet; leave the agent on its built-in defaults.
    }
    let payload = serde_json::json!({
        "type": "set_recall_settings",
        "settings": settings,
    })
    .to_string();
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(payload));
    }
}

/// Push capture settings to every connected agent (after a global settings change).
pub async fn push_recall_settings_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.lock().keys().copied().collect();
    for id in ids {
        push_recall_settings_to_agent(state, id).await;
    }
}

pub async fn push_app_block_rules_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.lock().keys().copied().collect();
    for id in ids {
        push_app_block_rules_to_agent(state, id).await;
    }
}

pub async fn push_internet_block_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.lock().keys().copied().collect();
    for id in ids {
        push_network_policy_to_agent(state, id).await;
        push_internet_block_rules_to_agent(state, id).await;
    }
}

/// After changing the global default, notify every connected agent.
pub async fn push_local_ui_password_to_all_connected(state: &Arc<AppState>) {
    let ids: Vec<uuid::Uuid> = state.agents.lock().keys().copied().collect();
    for id in ids {
        push_local_ui_password_hash_to_agent(state, id).await;
    }
}

async fn dispatch_val(
    val: serde_json::Value,
    agent_id: uuid::Uuid,
    name: &str,
    state: &Arc<AppState>,
) {
    let kind = val["type"].as_str().unwrap_or("");

    // One-shot RPC responses (agent -> server -> HTTP). Do not persist to DB; do not broadcast.
    if kind == "log_tail" || kind == "log_sources" {
        if let Some(rid) = val["request_id"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
        {
            let _ = state.try_complete_log_waiter(rid, val);
        }
        return;
    }

    // Interactive-terminal output: route to the one owning browser session only
    // (never persisted, never broadcast to other viewers).
    if kind == "terminal_output" || kind == "terminal_exit" {
        if let Some(sid) = val["session_id"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
        {
            let _ = state.route_terminal_output(sid, val.to_string());
        }
        return;
    }

    // Screen-history keyframe: persist JPEG to the blob store + index row. Handled
    // here (early return) so the large base64 payload is never fanned out to viewers.
    if kind == "history_frame" {
        ingest_history_frame(agent_id, &val, state).await;
        return;
    }

    let result = match kind {
        "keys" => {
            let too_long = val["text"]
                .as_str()
                .is_some_and(|s| s.chars().count() > MAX_KEYS_TEXT_CHARS);
            if too_long {
                warn!("Dropping 'keys' event from {agent_id}: text too large");
                Ok(())
            } else {
                db::upsert_keys(&state.db, agent_id, &val).await
            }
        }
        "window_focus" => {
            let title_ok = val["title"]
                .as_str()
                .is_none_or(|s| s.chars().count() <= MAX_WINDOW_TITLE_CHARS);
            let app_ok = val["app"]
                .as_str()
                .is_none_or(|s| s.chars().count() <= MAX_WINDOW_APP_CHARS);
            if !title_ok || !app_ok {
                warn!("Dropping 'window_focus' event from {agent_id}: title/app too large");
                Ok(())
            } else {
                db::insert_window(&state.db, agent_id, &val).await
            }
        }
        "url" => {
            let url_ok = val["url"]
                .as_str()
                .is_none_or(|s| s.len() <= MAX_URL_STR_BYTES);
            if url_ok {
                db::insert_url(&state.db, agent_id, &val).await
            } else {
                warn!("Dropping 'url' event from {agent_id}: url too large");
                Ok(())
            }
        }
        "url_session" => db::insert_url_session(&state.db, agent_id, &val).await,
        "afk" | "active" => db::insert_activity(&state.db, agent_id, &val).await,
        "app_icon" => {
            // Expected: { type:"app_icon", exe_name:"winword.exe", png_base64:"..." }
            let exe_ok = val["exe_name"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= MAX_WINDOW_APP_CHARS);
            let b64 = val["png_base64"].as_str().unwrap_or("");
            if !exe_ok || b64.is_empty() {
                Ok(())
            } else {
                // Hard cap to avoid DB bloat / abuse (~200KB decoded).
                if b64.len() > 300_000 {
                    warn!("Dropping 'app_icon' from {agent_id}: payload too large");
                    Ok(())
                } else {
                    match base64::engine::general_purpose::STANDARD.decode(b64) {
                        Ok(bytes) => {
                            db::upsert_app_icon(
                                &state.db,
                                agent_id,
                                val["exe_name"].as_str().unwrap_or(""),
                                &bytes,
                            )
                            .await
                        }
                        Err(_) => Ok(()),
                    }
                }
            }
        }
        "app_block_kill" => {
            let rule_id = val["rule_id"].as_i64();
            let rule_name = val["rule_name"].as_str();
            let exe_name = val["exe_name"].as_str().unwrap_or("").trim().to_string();
            if exe_name.is_empty() {
                Ok(())
            } else {
                db::log_app_block_event(&state.db, agent_id, rule_id, rule_name, &exe_name).await
            }
        }
        "agent_info" => db::upsert_agent_info(&state.db, agent_id, &val).await,
        "metrics" => db::insert_agent_metrics(&state.db, agent_id, &val).await,
        "software_inventory" => {
            use std::collections::{HashMap, HashSet};

            const MAX_SOFTWARE_ITEMS: usize = 12_000;
            const MAX_SOFTWARE_CHANGE_EVENTS: usize = 250;

            fn key_for_item(v: &serde_json::Value) -> Option<String> {
                let name = v["name"].as_str()?.trim();
                if name.is_empty() {
                    return None;
                }
                // Make a stable-ish identity; keep it conservative to avoid flip-flopping.
                let version = v["version"].as_str().unwrap_or("").trim();
                let publisher = v["publisher"].as_str().unwrap_or("").trim();
                Some(format!(
                    "{}\n{}\n{}",
                    name.to_ascii_lowercase(),
                    version.to_ascii_lowercase(),
                    publisher.to_ascii_lowercase()
                ))
            }

            fn key_for_row(r: &db::AgentSoftwareRow) -> String {
                let version = r.version.as_deref().unwrap_or("").trim();
                let publisher = r.publisher.as_deref().unwrap_or("").trim();
                format!(
                    "{}\n{}\n{}",
                    r.name.trim().to_ascii_lowercase(),
                    version.to_ascii_lowercase(),
                    publisher.to_ascii_lowercase()
                )
            }

            // Grab previous snapshot before replacing, so we can emit a diff.
            let prev_rows = db::list_agent_software(&state.db, agent_id)
                .await
                .unwrap_or_default();

            let items = val["items"].as_array().cloned().unwrap_or_default();
            let new_items: Vec<serde_json::Value> =
                items.into_iter().take(MAX_SOFTWARE_ITEMS).collect();

            let replace_res = db::replace_agent_software(&state.db, agent_id, &new_items)
                .await
                .map(|_| ());
            if let Err(e) = replace_res {
                Err(e)
            } else {
                // Avoid blasting a flood on first ever snapshot.
                if !prev_rows.is_empty() {
                    let mut prev_keys: HashSet<String> =
                        HashSet::with_capacity(prev_rows.len().saturating_mul(2));
                    for r in &prev_rows {
                        prev_keys.insert(key_for_row(r));
                    }

                    let mut new_by_key: HashMap<String, serde_json::Value> =
                        HashMap::with_capacity(new_items.len().saturating_mul(2));
                    let mut new_keys: HashSet<String> =
                        HashSet::with_capacity(new_items.len().saturating_mul(2));
                    for it in &new_items {
                        if let Some(k) = key_for_item(it) {
                            new_keys.insert(k.clone());
                            // Keep the first encountered payload for this key.
                            new_by_key.entry(k).or_insert_with(|| it.clone());
                        }
                    }

                    let captured_at = val["captured_at"].as_i64();

                    let mut installed: Vec<serde_json::Value> = Vec::new();
                    for k in new_keys.difference(&prev_keys) {
                        if let Some(it) = new_by_key.get(k) {
                            installed.push(serde_json::json!({
                                "type": "software_installed",
                                "key": k,
                                "captured_at": captured_at,
                                "item": it,
                            }));
                        }
                        if installed.len() >= MAX_SOFTWARE_CHANGE_EVENTS {
                            break;
                        }
                    }

                    let mut removed: Vec<serde_json::Value> = Vec::new();
                    if installed.len() < MAX_SOFTWARE_CHANGE_EVENTS {
                        for k in prev_keys.difference(&new_keys) {
                            removed.push(serde_json::json!({
                                "type": "software_removed",
                                "key": k,
                                "captured_at": captured_at,
                            }));
                            if installed.len() + removed.len() >= MAX_SOFTWARE_CHANGE_EVENTS {
                                break;
                            }
                        }
                    }

                    // Emit a summary first if there are any changes.
                    if !installed.is_empty() || !removed.is_empty() {
                        state.broadcast(
                        serde_json::json!({
                            "event": "software_change_summary",
                            "agent_id": agent_id,
                            "agent_name": name,
                            "data": {
                                "captured_at": captured_at,
                                "installed_count": installed.len(),
                                "removed_count": removed.len(),
                                "capped": (installed.len() + removed.len()) >= MAX_SOFTWARE_CHANGE_EVENTS,
                            }
                        })
                        .to_string(),
                    );
                    }

                    // Then emit per-item change events (same viewer fanout format as other telemetry).
                    for ev in installed.into_iter().chain(removed) {
                        let ev_type = ev["type"].as_str().unwrap_or("software_change");
                        state.broadcast(
                            serde_json::json!({
                                "event": ev_type,
                                "agent_id": agent_id,
                                "agent_name": name,
                                "data": ev,
                            })
                            .to_string(),
                        );
                    }
                }

                Ok(())
            }
        }
        "script_result" => {
            if let Some(rid) = val["request_id"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            {
                let _ = state.try_complete_script_waiter(rid, val.clone());
            }
            Ok(())
        }
        "dir_list" | "file_chunk" | "file_upload_result" => Ok(()),
        other => {
            warn!("Unknown event type '{other}' from {agent_id}");
            Ok(())
        }
    };

    if let Err(e) = result {
        error!("DB error ({kind} / {agent_id}): {e}");
        return;
    }

    if matches!(kind, "window_focus" | "url" | "afk" | "active") {
        state.update_agent_live_from_event(agent_id, kind, &val);
    }

    if kind == "keys" || kind == "url" {
        alert_rules::on_url_or_keys_event(state, agent_id, name, kind, &val).await;
    }

    if kind == "metrics" {
        alert_rules::on_metrics_event(state, agent_id, name, &val).await;
    }

    // Fan-out to all connected dashboard viewers.
    state.broadcast(
        serde_json::json!({
            "event":      kind,
            "agent_id":   agent_id,
            "agent_name": name,
            "data":       val,
        })
        .to_string(),
    );
}

/// Max decoded bytes for a single screen-history JPEG keyframe. Downscaled frames
/// are ~15–60 KB; this is a generous DoS bound well under `MAX_AGENT_TEXT_BYTES`.
const MAX_HISTORY_JPEG_BYTES: usize = 2 * 1024 * 1024;
const MAX_OCR_TEXT_CHARS: usize = 20_000;

/// Tell the agent a spooled keyframe is durably stored (or permanently unacceptable),
/// so it can delete it from its on-disk spool.
///
/// `rejected` frames are ones no retry will fix — oversized, bad base64, unwritable
/// blob. The agent drops those too: retrying forever would wedge its queue behind a
/// frame that can never land. Transient failures (DB down) are deliberately *not*
/// acked, so the agent re-sends them on its next session.
fn ack_history_frame(
    agent_id: Uuid,
    val: &serde_json::Value,
    state: &Arc<AppState>,
    rejected: Option<&str>,
) {
    let Some(uid) = val["uid"].as_str().filter(|s| !s.is_empty()) else {
        return; // Pre-spool agent; nothing to ack.
    };
    let mut ack = serde_json::json!({ "type": "history_frame_ack", "uid": uid });
    if let Some(reason) = rejected {
        ack["rejected"] = serde_json::Value::Bool(true);
        ack["reason"] = serde_json::Value::String(reason.to_string());
    }
    state.try_send_agent_command_json(agent_id, &ack);
}

/// Persist a legacy JSON `history_frame` (base64 JPEG).
///
/// Superseded by the binary `HST\0` frame, which avoids base64's ~33% inflation on a
/// socket shared with live telemetry. Kept so an agent that hasn't been updated yet
/// keeps recording rather than silently losing its history.
async fn ingest_history_frame(agent_id: Uuid, val: &serde_json::Value, state: &Arc<AppState>) {
    let b64 = val["jpeg_b64"].as_str().unwrap_or("");
    if b64.is_empty() {
        warn!("Dropping history_frame from {agent_id}: empty jpeg_b64");
        ack_history_frame(agent_id, val, state, Some("empty jpeg"));
        return;
    }
    let jpeg = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(bytes) if bytes.len() <= MAX_HISTORY_JPEG_BYTES => bytes,
        Ok(bytes) => {
            warn!(
                "Dropping history_frame from {agent_id}: jpeg too large ({} bytes)",
                bytes.len()
            );
            ack_history_frame(agent_id, val, state, Some("jpeg too large"));
            return;
        }
        Err(e) => {
            warn!("Dropping history_frame from {agent_id}: bad base64 ({e})");
            ack_history_frame(agent_id, val, state, Some("bad base64"));
            return;
        }
    };

    store_history_frame(agent_id, val, jpeg, state).await;
}

/// Decode a binary `HST\0` keyframe and persist it.
///
/// Layout: `HST\0` + u32 LE header length + header JSON + raw JPEG bytes. This is the
/// path modern agents use; the JSON/base64 `history_frame` event above is kept so an
/// agent that hasn't been updated yet still works.
async fn ingest_history_frame_binary(agent_id: Uuid, frame: &[u8], state: &Arc<AppState>) {
    let (val, jpeg) = match parse_history_frame_binary(frame) {
        Ok(v) => v,
        Err(e) => {
            warn!("Dropping binary history frame from {agent_id}: {e}");
            return;
        }
    };
    if jpeg.is_empty() {
        warn!("Dropping binary history frame from {agent_id}: empty jpeg");
        ack_history_frame(agent_id, &val, state, Some("empty jpeg"));
        return;
    }
    if jpeg.len() > MAX_HISTORY_JPEG_BYTES {
        warn!(
            "Dropping binary history frame from {agent_id}: jpeg too large ({} bytes)",
            jpeg.len()
        );
        ack_history_frame(agent_id, &val, state, Some("jpeg too large"));
        return;
    }
    store_history_frame(agent_id, &val, jpeg, state).await;
}

/// Split a binary `HST\0` keyframe into its header JSON and JPEG bytes.
///
/// Pure so the wire format can be tested directly: a mismatch between this and the
/// agent's encoder would silently drop every keyframe on the floor.
fn parse_history_frame_binary(
    frame: &[u8],
) -> Result<(serde_json::Value, Vec<u8>), &'static str> {
    const PREFIX: usize = 8; // magic + u32 header length
    if frame.len() < PREFIX {
        return Err("truncated header");
    }
    if &frame[..4] != HISTORY_FRAME_MAGIC {
        return Err("bad magic");
    }
    let hlen = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]) as usize;
    let hend = PREFIX
        .checked_add(hlen)
        .filter(|e| *e <= frame.len())
        .ok_or("bad header length")?;
    let val: serde_json::Value =
        serde_json::from_slice(&frame[PREFIX..hend]).map_err(|_| "bad header JSON")?;
    Ok((val, frame[hend..].to_vec()))
}

/// Write the JPEG to the blob store and insert its index row, then ack.
///
/// Shared by both wire formats so the durability semantics — at-least-once with
/// `client_uid` dedup, ack only on success, no ack on transient failure — live in one
/// place regardless of how the bytes arrived.
async fn store_history_frame(
    agent_id: Uuid,
    val: &serde_json::Value,
    jpeg: Vec<u8>,
    state: &Arc<AppState>,
) {
    // captured_at is RFC3339 UTC; fall back to now if malformed rather than dropping.
    let captured_at = val["captured_at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(chrono::Utc::now);

    let monitor = val["monitor"].as_i64().unwrap_or(0) as i32;
    let w = val["w"].as_i64().unwrap_or(0) as i32;
    let h = val["h"].as_i64().unwrap_or(0) as i32;

    // u64 aHash sent as a decimal string (JS precision). Reinterpret bits as i64.
    let phash = val["phash"]
        .as_str()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0) as i64;

    // Agent-generated spool id; absent for pre-spool agents (then ingest is
    // fire-and-forget, exactly as before).
    let client_uid = val["uid"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s.trim()).ok());

    // Per-word OCR geometry, when the agent produced any. Stored as-is; the shape is
    // validated by the frontend rather than re-parsed here.
    let ocr_words = val
        .get("ocr_words")
        .filter(|v| v.is_array())
        .filter(|v| !v.as_array().is_some_and(std::vec::Vec::is_empty));

    let ocr_text = val["ocr_text"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_OCR_TEXT_CHARS).collect::<String>());

    // Blob layout: <agent>/<YYYYMMDD>/<uuid>.jpg. Relative path stored in the row;
    // the on-disk path is joined against SCREEN_HISTORY_DIR at read time.
    let day = captured_at.format("%Y%m%d").to_string();
    let file = format!("{}.jpg", Uuid::new_v4());
    let rel = format!("{agent_id}/{day}/{file}");
    let dir = state.screen_history_dir.join(agent_id.to_string()).join(&day);
    let path = dir.join(&file);

    // Filesystem writes are blocking; keep them off the async reactor.
    let write_res = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, &jpeg)
    })
    .await;
    match write_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            // Disk full / permissions: retrying the same frame won't help, and the
            // agent's spool is bounded, so let it move on rather than jam.
            error!("history_frame blob write failed for {agent_id}: {e}");
            ack_history_frame(agent_id, val, state, Some("blob write failed"));
            return;
        }
        Err(e) => {
            error!("history_frame blob write task panicked for {agent_id}: {e}");
            ack_history_frame(agent_id, val, state, Some("blob write panicked"));
            return;
        }
    }

    match db::insert_screen_frame(
        &state.db,
        agent_id,
        captured_at,
        monitor,
        w,
        h,
        phash,
        &rel,
        ocr_text.as_deref(),
        ocr_words,
        client_uid,
    )
    .await
    {
        Ok(Some(_)) => ack_history_frame(agent_id, val, state, None),
        Ok(None) => {
            // Already stored — the agent re-sent after a lost ack. The blob we just
            // wrote is a duplicate of the one the original row points at, so drop it
            // rather than leave it orphaned until the day-dir sweep.
            let dup = state.screen_history_dir.join(&rel);
            let _ = tokio::fs::remove_file(dup).await;
            ack_history_frame(agent_id, val, state, None);
        }
        Err(e) => {
            // Transient (DB down / lock contention): do NOT ack, so the agent keeps
            // the frame spooled and re-sends it later.
            error!("insert_screen_frame failed for {agent_id}: {e}");
            // Orphaned blob: cheap to leave; retention's day-dir sweep reclaims it.
        }
    }
}

async fn dispatch_text(text: &str, agent_id: uuid::Uuid, name: &str, state: &Arc<AppState>) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        warn!("Bad JSON from {agent_id}");
        return;
    };

    // Agent-side batching: { type:"batch", events:[{type:"url",...}, ...] }
    if val["type"].as_str().unwrap_or("") == "batch" {
        let events = val["events"].as_array().cloned().unwrap_or_default();
        for ev in events {
            // Prevent recursive batches.
            if ev["type"].as_str().unwrap_or("") == "batch" {
                continue;
            }
            dispatch_val(ev, agent_id, name, state).await;
        }
        return;
    }

    dispatch_val(val, agent_id, name, state).await;
}

#[cfg(test)]
mod history_frame_wire_tests {
    use super::*;

    /// Build a frame exactly the way `agent/src/agent_loop.rs::pump_history_spool`
    /// does. If the two encoders drift apart, these tests fail rather than the fleet
    /// silently losing its screen history.
    fn encode(header: &serde_json::Value, jpeg: &[u8]) -> Vec<u8> {
        let hb = serde_json::to_vec(header).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(HISTORY_FRAME_MAGIC);
        out.extend_from_slice(&(hb.len() as u32).to_le_bytes());
        out.extend_from_slice(&hb);
        out.extend_from_slice(jpeg);
        out
    }

    fn sample_header() -> serde_json::Value {
        serde_json::json!({
            "uid": "3f1a9c62-0000-4000-8000-000000000001",
            "captured_at": "2026-08-08T01:23:45+00:00",
            "monitor": 1,
            "w": 1600,
            "h": 900,
            "phash": u64::MAX.to_string(),
            "ocr_text": "hello world",
        })
    }

    #[test]
    fn round_trips_header_and_jpeg() {
        let jpeg: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        let frame = encode(&sample_header(), &jpeg);
        let (val, out) = parse_history_frame_binary(&frame).unwrap();

        assert_eq!(out, jpeg, "JPEG bytes must survive framing exactly");
        assert_eq!(val["monitor"].as_i64(), Some(1));
        assert_eq!(val["w"].as_i64(), Some(1600));
        assert_eq!(val["ocr_text"].as_str(), Some("hello world"));
        // The u64 aHash must survive as a string — a JSON number would lose bits.
        assert_eq!(val["phash"].as_str(), Some(u64::MAX.to_string().as_str()));
    }

    #[test]
    fn binary_framing_is_smaller_than_base64_json() {
        // The whole point of the format: no ~33% inflation on a shared socket.
        let jpeg: Vec<u8> = (0..=255u8).cycle().take(40_000).collect();
        let binary = encode(&sample_header(), &jpeg).len();
        let legacy = serde_json::json!({
            "type": "history_frame",
            "uid": sample_header()["uid"],
            "captured_at": sample_header()["captured_at"],
            "monitor": 1, "w": 1600, "h": 900,
            "phash": u64::MAX.to_string(),
            "jpeg_b64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
            "ocr_text": "hello world",
        })
        .to_string()
        .len();
        assert!(
            binary < legacy,
            "binary framing ({binary}B) should beat base64 JSON ({legacy}B)"
        );
        // Base64 is 4/3 of the payload, so the saving should be roughly a quarter.
        assert!(legacy - binary > jpeg.len() / 4);
    }

    #[test]
    fn empty_jpeg_parses_but_yields_no_bytes() {
        // Parsing succeeds; the caller is what rejects and acks it.
        let frame = encode(&sample_header(), &[]);
        let (_, out) = parse_history_frame_binary(&frame).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_wrong_magic() {
        let mut frame = encode(&sample_header(), &[1, 2, 3]);
        frame[..4].copy_from_slice(b"AUD\0");
        assert_eq!(parse_history_frame_binary(&frame), Err("bad magic"));
    }

    #[test]
    fn rejects_truncated_and_overlong_headers() {
        assert_eq!(
            parse_history_frame_binary(b"HST\0"),
            Err("truncated header")
        );
        // Header length pointing past the end of the buffer must not panic.
        let mut frame = encode(&sample_header(), &[1, 2, 3]);
        frame[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_history_frame_binary(&frame), Err("bad header length"));
    }

    #[test]
    fn rejects_malformed_header_json() {
        let mut out = Vec::new();
        out.extend_from_slice(HISTORY_FRAME_MAGIC);
        out.extend_from_slice(&5u32.to_le_bytes());
        out.extend_from_slice(b"{not!");
        out.extend_from_slice(&[0xFF, 0xD8]);
        assert_eq!(parse_history_frame_binary(&out), Err("bad header JSON"));
    }

    #[test]
    fn a_jpeg_starting_with_other_magics_is_not_confused() {
        // Guard the dispatch convention: a Recall frame is identified by its own
        // prefix, and arbitrary JPEG payload bytes inside it can't re-trigger it.
        let jpeg = b"HST\0AUD\0 arbitrary payload".to_vec();
        let frame = encode(&sample_header(), &jpeg);
        let (_, out) = parse_history_frame_binary(&frame).unwrap();
        assert_eq!(out, jpeg);
    }
}
