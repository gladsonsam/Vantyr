//! Server-originated control commands from the dashboard (JSON `"type`" field).

mod capture;
mod files;
mod info;
mod logs;
mod policy;
mod power;
mod scripts;
mod terminal;
mod update;

use std::sync::{atomic::AtomicBool, Arc, Mutex};

use crate::platform::input_control::InputController;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::config::Config;

pub struct ServerCommandArgs<'a> {
    pub(crate) text: &'a str,
    pub(crate) frame_tx: &'a mpsc::Sender<Vec<u8>>,
    pub(crate) capture_stop: &'a mut Option<Arc<AtomicBool>>,
    /// Stop flag for the audio capture background thread (Windows only).
    pub(crate) audio_stop: &'a mut Option<Arc<AtomicBool>>,
    pub(crate) controller: Option<&'a mut InputController>,
    pub(crate) shared_cfg: &'a Arc<Mutex<Config>>,
    pub(crate) config_tx: &'a tokio::sync::watch::Sender<Option<Config>>,
    pub(crate) out_tx: mpsc::Sender<Message>,
    pub(crate) shared_rules: &'a crate::app_block::SharedRules,
    /// Live capture tunables, shared with the screen-history capture thread.
    pub(crate) history_settings: &'a Arc<Mutex<crate::screen_history::HistorySettings>>,
}

pub fn handle_server_command(args: ServerCommandArgs<'_>) {
    let ServerCommandArgs {
        text,
        frame_tx,
        capture_stop,
        audio_stop,
        controller,
        shared_cfg,
        config_tx,
        out_tx,
        shared_rules,
        history_settings,
    } = args;

    let val: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    // WebSocket admission stamps legacy commands once, before queues/IPC.
    // Missing or malformed bindings must never be recaptured at execution.
    let generation = serde_json::from_value::<crate::permissions::Generation>(
        val["__module_generation"].clone(),
    )
    .ok();
    if crate::permissions::command_module(val["type"].as_str().unwrap_or(""))
        .is_some_and(|m| generation.is_none_or(|g| g.module != m))
    {
        return;
    }
    if val["type"] == "ClipboardCancel" {
        crate::clipboard::cancel(&val);
        return;
    }
    if matches!(
        val["type"].as_str(),
        Some("ClipboardRead" | "ClipboardWrite")
    ) {
        if let Some(generation) = generation {
            crate::clipboard::spawn(val, generation, out_tx);
        }
        return;
    }
    if val["type"] == "disable_module" {
        crate::permissions::spawn_for_command(None, async move {
            let ack = crate::permissions::disable_and_wait(&val).await.to_string();
            let _ = out_tx.send(Message::Text(ack)).await;
        });
        return;
    }
    if !crate::permissions::command_allowed(&val) {
        warn!("Command denied by local module permission");
        return;
    }
    match val["type"].as_str().unwrap_or("") {
        // The server sends this just before dropping a deleted / revoked agent.
        // The service-owned WebSocket parks in Error on it; the companion just
        // logs so the user-session log explains why telemetry stopped.
        "agent_deleted" | "agent_credentials_revoked" => {
            warn!(
                "This agent was removed on the server ({}). Re-enroll from Settings to reconnect; not retrying.",
                val["type"].as_str().unwrap_or("removed"),
            );
        }
        // ── Interactive terminal (ConPTY); gated server-side ────────────────
        "TerminalStart" => terminal::start(&val, generation, out_tx),
        "TerminalInput" => terminal::input(&val),
        "TerminalResize" => terminal::resize(&val),
        "TerminalClose" => terminal::close(&val),
        "RequestInfo" => info::request_info(generation, out_tx),
        "LockHost" => power::lock_host(),
        "RestartHost" => power::restart_host(),
        "ShutdownHost" => power::shutdown_host(),
        // UI/grant authentication belongs to this device. The remote password
        // setter is denied by command_allowed and intentionally has no handler.
        "set_auto_update" => policy::set_auto_update(&val, shared_cfg, config_tx),
        "set_network_policy" => policy::set_network_policy(&val, generation, shared_cfg, config_tx),
        "set_internet_block_rules" => {
            policy::set_internet_block_rules(&val, generation, shared_cfg)
        }
        "set_recall_settings" => policy::set_recall_settings(&val, shared_cfg, history_settings),
        "set_app_block_rules" => policy::set_app_block_rules(&val, shared_cfg, shared_rules),
        "update_now" => update::update_now(generation, out_tx),
        "start_capture" if crate::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker owns live screen
            // capture (it can also reach the lock/sign-in desktop). Ignore here so
            // the same monitor isn't captured twice.
        }
        "stop_capture" if crate::role::suppresses_capture_and_input() => {}
        "start_capture" => capture::start_capture(&val, generation, frame_tx, capture_stop),
        "stop_capture" => capture::stop_capture(capture_stop),
        "start_audio" => capture::start_audio(generation, frame_tx, audio_stop),
        "stop_audio" => capture::stop_audio(audio_stop),
        "ListLogSources" => logs::list_log_sources(&val, generation, out_tx),
        "ReadLogTail" => logs::read_log_tail(&val, generation, out_tx),
        "Mkdir" => files::mkdir(&val, generation, out_tx),
        "RenamePath" => files::rename_path(&val, generation, out_tx),
        "DeletePath" => files::delete_path(&val, generation, out_tx),
        "CopyPath" => files::copy_path(&val, generation, out_tx),
        "ListDir" => files::list_dir(&val, generation, out_tx),
        "CollectSoftware" => info::collect_software(generation, out_tx),
        "RunScript" => scripts::run_script(&val, generation, out_tx),
        "ReadFile" => files::read_file(&val, generation, out_tx),
        "WriteFileChunk" => files::write_file_chunk(&val, generation, out_tx),
        // Remote input (MouseMove/Click/Key*/TypeText/…) falls through here.
        _ if crate::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker injects input
            // (and can drive the lock/sign-in desktop). Ignore here.
        }
        _ => match controller {
            Some(ctrl) if crate::permissions::allowed(crate::permissions::Module::RemoteInput) => {
                if let Err(e) = ctrl.handle_command(text) {
                    warn!("Control command error: {e:#}");
                }
            }
            _ => {
                warn!(
                    "Ignoring remote input command: input injection unavailable on this session."
                );
            }
        },
    }
}
