//! Server-originated control commands from the dashboard (JSON `"type`" field).

mod capture;
mod files;
mod info;
mod input;
mod logs;
mod policy;
mod power;
mod protocol;
mod scripts;
mod terminal;
mod update;

use std::sync::{atomic::AtomicBool, Arc, Mutex};

use crate::platform::input_control::InputController;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::config::Config;

pub use protocol::ServerCommand;

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
    let command = ServerCommand::parse(&val);
    match command {
        ServerCommand::ClipboardCancel => {
            crate::clipboard::cancel(&val);
            return;
        }
        ServerCommand::ClipboardRead | ServerCommand::ClipboardWrite => {
            if let Some(generation) = generation {
                crate::clipboard::spawn(val, generation, out_tx);
            }
            return;
        }
        ServerCommand::DisableModule => {
            crate::permissions::spawn_for_command(None, async move {
                let ack = crate::permissions::disable_and_wait(&val).await.to_string();
                let _ = out_tx.send(Message::Text(ack)).await;
            });
            return;
        }
        _ => {}
    }
    if !crate::permissions::command_allowed(&val) {
        warn!("Command denied by local module permission");
        return;
    }
    match command {
        // The server sends this just before dropping a deleted / revoked agent.
        // The service-owned WebSocket parks in Error on it; the companion just
        // logs so the user-session log explains why telemetry stopped.
        ServerCommand::AgentDeleted | ServerCommand::AgentCredentialsRevoked => {
            warn!(
                "This agent was removed on the server ({}). Re-enroll from Settings to reconnect; not retrying.",
                val["type"].as_str().unwrap_or("removed"),
            );
        }
        // Handled above, before the local module fence.
        ServerCommand::ClipboardCancel
        | ServerCommand::ClipboardRead
        | ServerCommand::ClipboardWrite
        | ServerCommand::DisableModule => {}
        // ── Interactive terminal (ConPTY); gated server-side ────────────────
        ServerCommand::TerminalStart => terminal::start(&val, generation, out_tx),
        ServerCommand::TerminalInput => terminal::input(&val),
        ServerCommand::TerminalResize => terminal::resize(&val),
        ServerCommand::TerminalClose => terminal::close(&val),
        ServerCommand::RequestInfo => info::request_info(generation, out_tx),
        ServerCommand::LockHost => power::lock_host(),
        ServerCommand::RestartHost => power::restart_host(),
        ServerCommand::ShutdownHost => power::shutdown_host(),
        // UI/grant authentication belongs to this device. The remote password
        // setter is denied by command_allowed and intentionally has no handler.
        ServerCommand::SetAutoUpdate => policy::set_auto_update(&val, shared_cfg, config_tx),
        ServerCommand::SetNetworkPolicy => {
            policy::set_network_policy(&val, generation, shared_cfg, config_tx)
        }
        ServerCommand::SetInternetBlockRules => {
            policy::set_internet_block_rules(&val, generation, shared_cfg)
        }
        ServerCommand::SetRecallSettings => {
            policy::set_recall_settings(&val, shared_cfg, history_settings)
        }
        ServerCommand::SetAppBlockRules => {
            policy::set_app_block_rules(&val, shared_cfg, shared_rules)
        }
        ServerCommand::UpdateNow => update::update_now(generation, out_tx),
        ServerCommand::StartCapture if crate::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker owns live screen
            // capture (it can also reach the lock/sign-in desktop). Ignore here so
            // the same monitor isn't captured twice.
        }
        ServerCommand::StopCapture if crate::role::suppresses_capture_and_input() => {}
        ServerCommand::StartCapture => {
            capture::start_capture(&val, generation, frame_tx, capture_stop)
        }
        ServerCommand::StopCapture => capture::stop_capture(capture_stop),
        ServerCommand::StartAudio => capture::start_audio(generation, frame_tx, audio_stop),
        ServerCommand::StopAudio => capture::stop_audio(audio_stop),
        ServerCommand::ListLogSources => logs::list_log_sources(&val, generation, out_tx),
        ServerCommand::ReadLogTail => logs::read_log_tail(&val, generation, out_tx),
        ServerCommand::Mkdir => files::mkdir(&val, generation, out_tx),
        ServerCommand::RenamePath => files::rename_path(&val, generation, out_tx),
        ServerCommand::DeletePath => files::delete_path(&val, generation, out_tx),
        ServerCommand::CopyPath => files::copy_path(&val, generation, out_tx),
        ServerCommand::ListDir => files::list_dir(&val, generation, out_tx),
        ServerCommand::CollectSoftware => info::collect_software(generation, out_tx),
        ServerCommand::RunScript => scripts::run_script(&val, generation, out_tx),
        ServerCommand::ReadFile => files::read_file(&val, generation, out_tx),
        ServerCommand::WriteFileChunk => files::write_file_chunk(&val, generation, out_tx),
        // Remote input (MouseMove/Click/Key*/TypeText/…) and unknown types fall
        // through here. `history_frame_ack` never reaches this point (the agent
        // loop consumes it first) and would land here too, as before.
        _ if crate::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker injects input
            // (and can drive the lock/sign-in desktop). Ignore here.
        }
        _ => input::handle(text, controller),
    }
}
