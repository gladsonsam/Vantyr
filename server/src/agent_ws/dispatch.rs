//! Inbound agent events: validates and persists telemetry, routes RPC replies, and fans
//! events out to dashboard viewers.

use std::sync::Arc;

use crate::state::agent_lifecycle::IngestionLease;
use base64::Engine;
use tracing::{error, warn};
use uuid::Uuid;
use vantyr_protocol::agent_message::{TerminalExit, TerminalOutput};
use vantyr_protocol::AgentMessage;

use super::history_ingest::ingest_history_frame;
use super::policy_push::push_initial_policies;
use super::{MAX_KEYS_TEXT_CHARS, MAX_URL_STR_BYTES, MAX_WINDOW_APP_CHARS, MAX_WINDOW_TITLE_CHARS};
use crate::agents::db as agents_db;
use crate::agents::telemetry::db as telemetry_db;
use crate::agents::telemetry::ingest as telemetry_ingest;
use crate::policy::alert_rules;
use crate::policy::app_block::db as app_block_db;
use crate::scripts::software_inventory::db as software_db;
use crate::state::AppState;
use crate::web_activity;

async fn dispatch_val(
    val: serde_json::Value,
    message: AgentMessage,
    agent_id: uuid::Uuid,
    conn_id: Uuid,
    name: &str,
    state: &Arc<AppState>,
    lease: &IngestionLease,
) {
    let kind = val["type"].as_str().unwrap_or("");
    if matches!(
        message,
        AgentMessage::ModuleStates | AgentMessage::ModuleDisableAck
    ) {
        let previous = state
            .agents
            .modules
            .lock()
            .get(&agent_id)
            .map(|runtime| runtime.report.clone());
        let result = if matches!(message, AgentMessage::ModuleStates) {
            state
                .accept_module_report(agent_id, conn_id, val, lease)
                .await
        } else {
            state
                .accept_module_disable_ack(agent_id, conn_id, val, lease)
                .await
        };
        if let Err(e) = result {
            warn!(%agent_id,error=%e,"Rejected module protocol message");
        } else {
            let current = state
                .agents
                .modules
                .lock()
                .get(&agent_id)
                .map(|runtime| runtime.report.clone());
            let changed = current.as_ref().is_some_and(|report| {
                previous.as_ref().is_none_or(|old| {
                    [
                        crate::agents::modules::Module::AppPolicy,
                        crate::agents::modules::Module::NetworkPolicy,
                    ]
                    .iter()
                    .any(|module| report.get(*module).revision != old.get(*module).revision)
                })
            });
            if changed {
                push_initial_policies(name, agent_id, state).await;
            }
            state.sync_mjpeg_capture(agent_id);
        }
        return;
    }

    if matches!(message, AgentMessage::ClipboardResult) {
        state.complete_clipboard(agent_id, conn_id, val);
        return;
    }

    // One-shot RPC responses (agent -> server -> HTTP). Do not persist to DB; do not broadcast.
    if let AgentMessage::LogTail(reply) | AgentMessage::LogSources(reply) = &message {
        if let Some(rid) = reply.request_id {
            let _ = state.rpc.try_complete_log_waiter(rid, val);
        }
        return;
    }

    // Interactive-terminal output: route to the one owning browser session only
    // (never persisted, never broadcast to other viewers).
    if let AgentMessage::TerminalOutput(TerminalOutput { session_id, .. })
    | AgentMessage::TerminalExit(TerminalExit { session_id }) = &message
    {
        if let Some(sid) = *session_id {
            let _ = state.rpc.route_terminal_output(sid, val.to_string());
        }
        return;
    }

    // Screen-history keyframe: persist JPEG to the blob store + index row. Handled
    // here (early return) so the large base64 payload is never fanned out to viewers.
    if matches!(message, AgentMessage::HistoryFrame) {
        if state
            .agents
            .module_authorized(agent_id, crate::agents::modules::Module::Recall)
        {
            ingest_history_frame(agent_id, conn_id, &val, state, lease).await;
        }
        return;
    }

    let result = match &message {
        AgentMessage::Keys(keys) => {
            let too_long = keys
                .text
                .as_deref()
                .is_some_and(|s| s.chars().count() > MAX_KEYS_TEXT_CHARS);
            if too_long {
                warn!("Dropping 'keys' event from {agent_id}: text too large");
                Ok(())
            } else {
                telemetry_db::events::upsert_keys(
                    &state.db,
                    agent_id,
                    &telemetry_ingest::KeysEvent::parse(&val),
                )
                .await
            }
        }
        AgentMessage::WindowFocus(focus) => {
            let title_ok = focus
                .title
                .as_deref()
                .is_none_or(|s| s.chars().count() <= MAX_WINDOW_TITLE_CHARS);
            let app_ok = focus
                .app
                .as_deref()
                .is_none_or(|s| s.chars().count() <= MAX_WINDOW_APP_CHARS);
            if !title_ok || !app_ok {
                warn!("Dropping 'window_focus' event from {agent_id}: title/app too large");
                Ok(())
            } else {
                telemetry_db::events::insert_window(
                    &state.db,
                    agent_id,
                    &telemetry_ingest::WindowFocusEvent::parse(&val),
                )
                .await
            }
        }
        AgentMessage::Url(visit) => {
            let url_ok = visit
                .url
                .as_deref()
                .is_none_or(|s| s.len() <= MAX_URL_STR_BYTES);
            if url_ok {
                web_activity::ingest::record_url_visit(&state.db, agent_id, &val).await
            } else {
                warn!("Dropping 'url' event from {agent_id}: url too large");
                Ok(())
            }
        }
        AgentMessage::UrlSession => {
            web_activity::ingest::record_url_session(&state.db, agent_id, &val).await
        }
        AgentMessage::Afk | AgentMessage::Active => {
            telemetry_db::events::insert_activity(
                &state.db,
                agent_id,
                &telemetry_ingest::ActivityEvent::parse(&val),
            )
            .await
        }
        AgentMessage::AppIcon(icon) => {
            // Expected: { type:"app_icon", exe_name:"winword.exe", png_base64:"..." }
            let exe_ok = icon
                .exe_name
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= MAX_WINDOW_APP_CHARS);
            let b64 = icon.png_base64.as_deref().unwrap_or("");
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
                            telemetry_db::app_icons::upsert_app_icon(
                                &state.db,
                                agent_id,
                                icon.exe_name.as_deref().unwrap_or(""),
                                &bytes,
                            )
                            .await
                        }
                        Err(_) => Ok(()),
                    }
                }
            }
        }
        AgentMessage::AppBlockKill(kill) => {
            let rule_id = kill.rule_id;
            let rule_name = kill.rule_name.as_deref();
            let exe_name = kill.exe_name.as_deref().unwrap_or("").trim().to_string();
            if exe_name.is_empty() {
                Ok(())
            } else {
                app_block_db::events::log_app_block_event(
                    &state.db, agent_id, rule_id, rule_name, &exe_name,
                )
                .await
            }
        }
        AgentMessage::AgentInfo => agents_db::upsert_agent_info(&state.db, agent_id, &val).await,
        AgentMessage::Metrics => {
            telemetry_db::metrics::insert_agent_metrics(
                &state.db,
                agent_id,
                &telemetry_ingest::MetricsSample::parse(&val),
            )
            .await
        }
        AgentMessage::SoftwareInventory(inventory) => {
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

            fn key_for_row(r: &software_db::AgentSoftwareRow) -> String {
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
            let prev_rows = software_db::list_agent_software(&state.db, agent_id)
                .await
                .unwrap_or_default();

            let items = val["items"].as_array().cloned().unwrap_or_default();
            let new_items: Vec<serde_json::Value> =
                items.into_iter().take(MAX_SOFTWARE_ITEMS).collect();

            let replace_res = software_db::replace_agent_software(&state.db, agent_id, &new_items)
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

                    let captured_at = inventory.captured_at;

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
        AgentMessage::ScriptResult(reply) => {
            if let Some(rid) = reply.request_id {
                let _ = state.rpc.try_complete_script_waiter(rid, val.clone());
            }
            Ok(())
        }
        AgentMessage::DirList | AgentMessage::FileChunk | AgentMessage::FileUploadResult => Ok(()),
        // Answered by the early returns above; listed so a new message type has to
        // pick a route here.
        AgentMessage::Batch(_)
        | AgentMessage::ModuleStates
        | AgentMessage::ModuleDisableAck
        | AgentMessage::ClipboardResult
        | AgentMessage::LogTail(_)
        | AgentMessage::LogSources(_)
        | AgentMessage::TerminalOutput(_)
        | AgentMessage::TerminalExit(_)
        | AgentMessage::HistoryFrame => Ok(()),
        AgentMessage::Unknown => {
            warn!("Unknown event type '{kind}' from {agent_id}");
            Ok(())
        }
    };

    if let Err(e) = result {
        error!("DB error ({kind} / {agent_id}): {e}");
        return;
    }

    if matches!(
        message,
        AgentMessage::WindowFocus(_)
            | AgentMessage::Url(_)
            | AgentMessage::Afk
            | AgentMessage::Active
    ) {
        state.agents.update_live_from_event(agent_id, kind, &val);
    }

    if matches!(message, AgentMessage::Keys(_) | AgentMessage::Url(_)) {
        alert_rules::on_url_or_keys_event(state, agent_id, name, kind, &val).await;
    }

    if matches!(message, AgentMessage::Metrics) {
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

pub(super) async fn dispatch_text(
    text: &str,
    agent_id: uuid::Uuid,
    conn_id: Uuid,
    name: &str,
    state: &Arc<AppState>,
    lease: &IngestionLease,
) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        warn!("Bad JSON from {agent_id}");
        return;
    };

    // Agent-side batching: { type:"batch", events:[{type:"url",...}, ...] }
    let message = AgentMessage::parse(&val);
    if let AgentMessage::Batch(batch) = message {
        for ev in batch.events {
            let message = AgentMessage::parse(&ev);
            // Prevent recursive batches.
            if matches!(message, AgentMessage::Batch(_)) {
                continue;
            }
            dispatch_val(ev, message, agent_id, conn_id, name, state, lease).await;
        }
        return;
    }

    dispatch_val(val, message, agent_id, conn_id, name, state, lease).await;
}
