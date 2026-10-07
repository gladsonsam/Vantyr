//! Run the agent itself: the Tokio runtime + agent loop on a background thread,
//! and the settings UI (Windows) or a headless wait on the main thread.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use tracing::{info, warn};

use super::{imp, Launch};
use crate::config::{AgentStatus, Config};
use crate::platform::keyboard_monitor::InputEvent;

pub(super) fn run(launch: &Launch) {
    let _log_guard = super::logging::init_logging(launch.log_file());
    info!("Vantyr agent v{}", env!("CARGO_PKG_VERSION"));

    imp::prepare_interactive(launch);

    // Allow forcing the settings UI to show on startup (tray/hotkey is easy to miss).
    let show_ui_on_startup = imp::show_ui_on_startup(launch);
    let no_ui = launch.no_ui();

    // Load persisted configuration.
    let initial_config = crate::config::load_config();
    info!("Config file {:?}", crate::config::config_path());
    imp::log_config_state();

    // Shared with Tauri for locally saved settings and connection updates.
    let shared_cfg: Arc<Mutex<Config>> = Arc::new(Mutex::new(initial_config.clone()));

    // Shared agent status (agent thread writes, GUI thread reads).
    let agent_status: Arc<Mutex<AgentStatus>> = Arc::new(Mutex::new(AgentStatus::Disconnected));

    // Config watch channel (GUI thread writes, agent thread reads).
    let initial_watch = if initial_config.server_url.is_empty() {
        None
    } else {
        Some(initial_config.clone())
    };
    let (config_tx, config_rx) = tokio::sync::watch::channel(initial_watch);

    // Synchronisation: wait for the input monitor to be initialized.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();

    // Background thread: Tokio runtime + agent WebSocket loop.
    let status_bg = agent_status.clone();
    let shared_cfg_bg = shared_cfg.clone();
    let config_tx_bg = config_tx.clone();
    std::thread::Builder::new()
        .name("agent-runtime".into())
        .spawn(move || {
            // Few workers: the agent is mostly one WebSocket session plus short-lived
            // spawned tasks; a large default pool wastes RAM (thread stacks) on many-core PCs.
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
                .unwrap_or_else(|e| {
                    tracing::error!("Failed to build Tokio runtime: {e}");
                    std::process::exit(1);
                });

            rt.block_on(async move {
                // Keyboard capture channels must be created inside the async context
                // because keyboard_monitor::start() spawns a tokio task internally.
                // Bounded queue: prevents unbounded RAM growth while offline (WAN laptops).
                // Best-effort producers use `try_send`, so overload drops bursts instead of blocking input threads.
                const INPUT_EVENT_CHANNEL_CAP: usize = 2048;
                let (key_tx, key_rx) = mpsc::channel::<InputEvent>(INPUT_EVENT_CHANNEL_CAP);
                match crate::platform::keyboard_monitor::start(key_tx) {
                    Ok(()) => {
                        info!("Input monitor initialized.");
                    }
                    Err(e) => {
                        // Non-fatal: keep the agent running (telemetry, AFK, capture) without
                        // keystroke capture rather than aborting the process.
                        warn!("Keyboard capture degraded; continuing without keystroke capture: {e:#}");
                    }
                }
                let _ = ready_tx.send(Ok(()));

                let (frame_tx, frame_rx) =
                    mpsc::channel::<Vec<u8>>(crate::connection::agent_loop::FRAME_CHANNEL_CAP);
                crate::connection::agent_loop::run_agent_loop(
                    config_rx,
                    config_tx_bg,
                    shared_cfg_bg,
                    frame_tx,
                    frame_rx,
                    key_rx,
                    status_bg,
                )
                .await;
            });
        })
        .unwrap_or_else(|e| {
            tracing::error!("Failed to spawn agent thread: {e}");
            std::process::exit(1);
        });

    // Block until the keyboard hook is ready (or failed)
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => warn!("Keyboard capture failed to start: {e:#}"),
        Err(_) => warn!("Agent thread exited before keyboard hook was ready"),
    }

    if no_ui {
        info!("UI disabled (--no-ui / AGENT_NO_UI). Running headless.");
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
    imp::run_ui(
        initial_config,
        config_tx,
        shared_cfg,
        agent_status,
        show_ui_on_startup,
    );
}
