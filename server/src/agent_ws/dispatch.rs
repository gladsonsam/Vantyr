//! Inbound agent events: validates and persists telemetry, routes RPC replies, and fans
//! events out to dashboard viewers. One strict parse at the boundary: a rejected
//! frame is dropped here, before any database mutation, RPC completion or broadcast.

use std::sync::Arc;

use crate::state::agent_lifecycle::IngestionLease;
use base64::Engine;
use tracing::{error, warn};
use uuid::Uuid;
use vantyr_protocol::agent_message::{TerminalExit, TerminalOutput};
use vantyr_protocol::telemetry::{SoftwareItem, UrlSessionEvent, UrlVisit};
use vantyr_protocol::AgentMessage;

use super::policy_push::push_initial_policies;
use super::{MAX_AGENT_TEXT_BYTES, MAX_KEYS_TEXT_CHARS, MAX_URL_STR_BYTES, MAX_WINDOW_APP_CHARS, MAX_WINDOW_TITLE_CHARS};
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
        let _ = state.rpc.try_complete_log_waiter(reply.request_id, val);
        return;
    }
    if let AgentMessage::ScriptResult(reply) = &message {
        let _ = state.rpc.try_complete_script_waiter(reply.request_id, val.clone());
        return;
    }

    // Interactive-terminal output: route to the one owning browser session only
    // (never persisted, never broadcast to other viewers).
    if let AgentMessage::TerminalOutput(TerminalOutput { session_id, .. })
    | AgentMessage::TerminalExit(TerminalExit { session_id }) = &message
    {
        let _ = state.rpc.route_terminal_output(*session_id, val.to_string());
        return;
    }

    let result = match &message {
        AgentMessage::Keys(ev) => {
            let too_long = ev.text.chars().count() > MAX_KEYS_TEXT_CHARS;
            if too_long {
                warn!("Dropping 'keys' event from {agent_id}: text too large");
                Ok(())
            } else {
                telemetry_db::events::upsert_keys(&state.db, agent_id, ev).await
            }
        }
        AgentMessage::WindowFocus(ev) => {
            let title_ok = ev.title.chars().count() <= MAX_WINDOW_TITLE_CHARS;
            let app_ok = ev.app.chars().count() <= MAX_WINDOW_APP_CHARS;
            if !title_ok || !app_ok {
                warn!("Dropping 'window_focus' event from {agent_id}: title/app too large");
                Ok(())
            } else {
                telemetry_db::events::insert_window(&state.db, agent_id, ev).await
            }
        }
        AgentMessage::Url(ev) => {
            if ev.url.len() > MAX_URL_STR_BYTES {
                warn!("Dropping 'url' event from {agent_id}: url too large");
                Ok(())
            } else {
                web_activity::ingest::record_url_visit(&state.db, agent_id, ev).await
            }
        }
        AgentMessage::UrlSession(ev) => {
            web_activity::ingest::record_url_session(&state.db, agent_id, ev).await
        }
        AgentMessage::Afk | AgentMessage::Active => {
            match telemetry_ingest::ActivityEvent::parse(&val) {
                Ok(ev) => telemetry_db::events::insert_activity(&state.db, agent_id, &ev).await,
                Err(e) => {
                    warn!(%agent_id, error=%e, "Rejected activity event");
                    Ok(())
                }
            }
        }
        AgentMessage::AppIcon(icon) => {
            // Expected: { type:"app_icon", exe_name:"winword.exe", png_base64:"..." }
            let exe_ok = !icon.exe_name.trim().is_empty()
                && icon.exe_name.len() <= MAX_WINDOW_APP_CHARS;
            if !exe_ok || icon.png_base64.is_empty() {
                Ok(())
            } else if icon.png_base64.len() > 300_000 {
                // Hard cap to avoid DB bloat / abuse (~200KB decoded).
                warn!("Dropping 'app_icon' from {agent_id}: payload too large");
                Ok(())
            } else {
                match base64::engine::general_purpose::STANDARD.decode(&icon.png_base64) {
                    Ok(bytes) => {
                        telemetry_db::app_icons::upsert_app_icon(
                            &state.db,
                            agent_id,
                            &icon.exe_name,
                            &bytes,
                        )
                        .await
                    }
                    Err(_) => Ok(()),
                }
            }
        }
        AgentMessage::AppBlockKill(kill) => {
            let exe_name = kill.exe_name.trim();
            if exe_name.is_empty() {
                Ok(())
            } else {
                app_block_db::events::log_app_block_event(
                    &state.db,
                    agent_id,
                    kill.rule_id,
                    Some(&kill.rule_name),
                    exe_name,
                )
                .await
            }
        }
        AgentMessage::AgentInfo => {
            if let Some(connection) = state
                .agents
                .connections
                .lock()
                .get_mut(&agent_id)
                .filter(|c| c.conn_id == conn_id)
            {
                connection.screen_live_tuning =
                    val["capabilities"]["screen_live_tuning"].as_str() == Some("supported");
            }
            agents_db::upsert_agent_info(&state.db, agent_id, &val).await
        }
        AgentMessage::Metrics(ev) => {
            telemetry_db::metrics::insert_agent_metrics(&state.db, agent_id, ev).await
        }
        AgentMessage::SoftwareInventory(inv) => {
            use std::collections::{HashMap, HashSet};

            const MAX_SOFTWARE_ITEMS: usize = 12_000;
            const MAX_SOFTWARE_CHANGE_EVENTS: usize = 250;

            if inv.items.len() > MAX_SOFTWARE_ITEMS {
                warn!("Dropping 'software_inventory' from {agent_id}: too many items");
                return;
            }
            // One bad entry rejects the whole snapshot before any mutation.
            let mut typed_items = Vec::with_capacity(inv.items.len());
            for it in &inv.items {
                match SoftwareItem::parse(it) {
                    Ok(Some(item)) => typed_items.push(item),
                    Ok(None) => {}
                    Err(e) => {
                        warn!(%agent_id, error=%e, "Rejected software inventory entry");
                        return;
                    }
                }
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

            let replace_res = software_db::replace_agent_software(&state.db, agent_id, &typed_items)
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
                        HashMap::with_capacity(typed_items.len().saturating_mul(2));
                    let mut new_keys: HashSet<String> =
                        HashSet::with_capacity(typed_items.len().saturating_mul(2));
                    for (parsed, it) in typed_items.iter().zip(inv.items.iter()) {
                        if let Some(k) = parsed.key() {
                            new_keys.insert(k.clone());
                            new_by_key.entry(k).or_insert_with(|| it.clone());
                        }
                    }

                    let captured_at = inv.captured_at;

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
        // Answered by the early returns above; listed so a new message type has to
        // pick a route here.
        AgentMessage::Batch(_)
        | AgentMessage::ModuleStates
        | AgentMessage::ModuleDisableAck
        | AgentMessage::ClipboardResult
        | AgentMessage::LogTail(_)
        | AgentMessage::LogSources(_)
        | AgentMessage::ScriptResult(_)
        | AgentMessage::TerminalOutput(_)
        | AgentMessage::TerminalExit(_) => Ok(()),
        AgentMessage::DirList | AgentMessage::FileChunk | AgentMessage::FileUploadResult => Ok(()),
        AgentMessage::Unknown => {
            // Strict parsing never reaches here; kept exhaustive for safety.
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

    if matches!(message, AgentMessage::Metrics(_)) {
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
        warn!("Rejected agent frame (malformed_json) from {agent_id}");
        return;
    };

    let message = match AgentMessage::try_parse(&val) {
        Ok(message) => message,
        Err(e) => {
            // The error is code-only; the raw frame is never logged.
            warn!(%agent_id, error=%e, "Rejected agent frame");
            return;
        }
    };

    // Agent-side batching: { type:"batch", events:[{type:"url",...}, ...] }
    if let AgentMessage::Batch(batch) = message {
        for ev in batch.events {
            let message = match AgentMessage::try_parse(&ev) {
                Ok(message) => message,
                Err(e) => {
                    warn!(%agent_id, error=%e, "Rejected batched agent frame");
                    continue;
                }
            };
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
