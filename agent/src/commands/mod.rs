//! Server-originated control commands from the dashboard (JSON `"type"` field).
//!
//! [`handle_server_command`] parses a frame into a [`ServerCommand`], applies the
//! generation and local module gates, and dispatches to the per-area handlers:
//!
//! - [`protocol`]: the typed commands and the command -> module table.
//! - `terminal`, `files`, `logs`, `scripts`: interactive and request/reply tools.
//! - `capture`: live screen and audio streaming.
//! - `policy`, `update`: server-pushed settings and on-demand updates.
//! - `info`, `power`: system info / software inventory and lock/restart/shutdown.
//! - `input`: remote mouse/keyboard, handed to the session's input controller.
//! - `windows`, `linux`: the per-OS parts of the handlers above (audio, updates,
//!   file-browser roots).
//!
//! The command inventory lives in `agent/docs/server-commands.md`.

mod capture;
mod files;
mod info;
mod input;
mod logs;
mod policy;
mod power;
pub mod protocol;
mod scripts;
mod terminal;
mod update;

// The few handler parts that differ per OS (audio, updates, drive roots).
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

use std::sync::{atomic::AtomicBool, Arc, Mutex};

use crate::input::remote::InputController;
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
    pub(crate) shared_rules: &'a crate::policy::app_block::SharedRules,
    /// Live capture tunables, shared with the screen-history capture thread.
    pub(crate) history_settings: &'a Arc<Mutex<crate::capture::history::HistorySettings>>,
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
    let command = ServerCommand::parse(&val);
    if command
        .module()
        .is_some_and(|m| generation.is_none_or(|g| g.module != m))
    {
        return;
    }
    match command {
        ServerCommand::ClipboardCancel => {
            crate::input::clipboard::cancel(&val);
            return;
        }
        ServerCommand::ClipboardRead | ServerCommand::ClipboardWrite => {
            if let Some(generation) = generation {
                crate::input::clipboard::spawn(val, generation, out_tx);
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
        ServerCommand::TerminalStart(cmd) => terminal::start(cmd, generation, out_tx),
        ServerCommand::TerminalInput(cmd) => terminal::input(cmd),
        ServerCommand::TerminalResize(cmd) => terminal::resize(cmd),
        ServerCommand::TerminalClose(cmd) => terminal::close(cmd),
        ServerCommand::RequestInfo => info::request_info(generation, out_tx),
        ServerCommand::LockHost => power::lock_host(),
        ServerCommand::RestartHost => power::restart_host(),
        ServerCommand::ShutdownHost => power::shutdown_host(),
        // UI/grant authentication belongs to this device. The remote password
        // setter is denied by command_allowed and intentionally has no handler.
        ServerCommand::SetAutoUpdate(cmd) => policy::set_auto_update(cmd, shared_cfg, config_tx),
        ServerCommand::SetNetworkPolicy(cmd) => {
            policy::set_network_policy(cmd, generation, shared_cfg, config_tx)
        }
        ServerCommand::SetInternetBlockRules(cmd) => {
            policy::set_internet_block_rules(cmd, generation, shared_cfg)
        }
        ServerCommand::SetRecallSettings(cmd) => {
            policy::set_recall_settings(cmd, shared_cfg, history_settings)
        }
        ServerCommand::SetAppBlockRules(cmd) => {
            policy::set_app_block_rules(cmd, shared_cfg, shared_rules)
        }
        ServerCommand::UpdateNow => update::update_now(generation, out_tx),
        ServerCommand::StartCapture(_) if crate::host::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker owns live screen
            // capture (it can also reach the lock/sign-in desktop). Ignore here so
            // the same monitor isn't captured twice.
        }
        ServerCommand::StopCapture if crate::host::role::suppresses_capture_and_input() => {}
        ServerCommand::StartCapture(cmd) => {
            capture::start_capture(cmd, generation, frame_tx, capture_stop)
        }
        ServerCommand::StopCapture => capture::stop_capture(capture_stop),
        ServerCommand::StartAudio => capture::start_audio(generation, frame_tx, audio_stop),
        ServerCommand::StopAudio => capture::stop_audio(audio_stop),
        ServerCommand::ListLogSources(cmd) => logs::list_log_sources(cmd, generation, out_tx),
        ServerCommand::ReadLogTail(cmd) => logs::read_log_tail(cmd, generation, out_tx),
        ServerCommand::Mkdir(cmd) => files::mkdir(cmd, generation, out_tx),
        ServerCommand::RenamePath(cmd) => files::rename_path(cmd, generation, out_tx),
        ServerCommand::DeletePath(cmd) => files::delete_path(cmd, generation, out_tx),
        ServerCommand::CopyPath(cmd) => files::copy_path(cmd, generation, out_tx),
        ServerCommand::ListDir(cmd) => files::list_dir(cmd, generation, out_tx),
        ServerCommand::CollectSoftware => info::collect_software(generation, out_tx),
        ServerCommand::RunScript(cmd) => scripts::run_script(cmd, generation, out_tx),
        ServerCommand::ReadFile(cmd) => files::read_file(cmd, generation, out_tx),
        ServerCommand::WriteFileChunk(cmd) => files::write_file_chunk(cmd, generation, out_tx),
        // Remote input (MouseMove/Click/Key*/TypeText/…) falls through here.
        // Unknown types were denied by command_allowed above; `history_frame_ack`
        // is consumed by the agent loop before dispatch.
        _ if crate::host::role::suppresses_capture_and_input() => {
            // Service-managed companion: the SYSTEM capture worker injects input
            // (and can drive the lock/sign-in desktop). Ignore here.
        }
        _ => input::handle(text, controller),
    }
}
