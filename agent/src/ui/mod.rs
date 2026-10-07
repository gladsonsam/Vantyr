//! Tauri-based settings window for the Vantyr agent.
//!
//! ## Architecture
//!
//! Tauri owns the main thread and its webview event loop.  The agent's
//! background Tokio runtime continues to run in a separate OS thread (spawned
//! by `main` before this module is called).
//!
//! Shared state is passed into the Tauri app via `.manage()`:
//! - `SharedConfig`  – `Arc<tokio::sync::watch::Sender<Option<Config>>>`
//! - `SharedStatus`  – `Arc<Mutex<AgentStatus>>`
//! - `StoredConfig`  – `Arc<Mutex<Config>>` (latest saved config, for reads)
//!
//! ## IPC Commands (webview → Rust)
//!
//! | Command              | Returns                  | Description                          |
//! |----------------------|--------------------------|--------------------------------------|
//! | `get_config`         | `Config` JSON            | Read current config                  |
//! | `save_config`        | `()`                     | Persist + hot-reload config          |
//! | `get_status`         | `StatusResponse` JSON    | Current WS connection status         |
//! | `has_ui_password`    | `bool`                   | Whether a UI password is set         |
//! | `verify_ui_password` | `()` or Err              | Check UI password                    |
//! | `hide_window`        | `()`                     | Hide the settings window             |
//! | `exit_agent`         | never                    | Kill the process                     |
//! | `check_manual_update`| `ManualUpdateCheckResponse` | Compare build to `latest.json` (Windows) |
//! | `apply_manual_update`| `ManualApplyUpdateResponse` | Download + service `msiexec` (Windows) |
//! | `list_log_sources`   | `Vec<LogSourceDesc>`     | Known on-disk log files for the Logs tab   |
//! | `read_log_file_tail` | `String`                 | Tail of a log file (see `kind` + `max_kb`) |
//! | `clear_log_file`     | `()`                     | Truncate a log file to zero bytes          |
//! | `open_log_location`  | `()`                     | Open the log file in Explorer (Windows)    |
//!
//! The handlers live in [`commands`], one file per area; the tray icon in [`tray`].

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tracing::{error, info, warn};

use crate::config::{AgentStatus, Config};

mod commands;
mod tray;

// ─── Shared state wrappers ─────────────────────────────────────────────────────

/// Watch sender — agent loop listens on the receiver end.
pub struct SharedConfigTx(pub tokio::sync::watch::Sender<Option<Config>>);

/// Latest locally saved config, shared with the background agent thread.
pub struct StoredConfig(pub Arc<Mutex<Config>>);

/// Agent connection status — written by the agent loop, read by `get_status`.
pub struct SharedStatus(pub Arc<Mutex<AgentStatus>>);

// ─── Public entry point ────────────────────────────────────────────────────────

/// Build and run the Tauri event loop.  **Blocks the calling thread forever**
/// (or until the user clicks "Exit Agent").
pub fn run_tauri(
    initial_config: Config,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_cfg: Arc<Mutex<Config>>,
    agent_status: Arc<Mutex<AgentStatus>>,
    show_on_startup: bool,
) {
    let app = tauri::Builder::default()
        // Ensure only one instance of the agent settings app runs.
        // If a second instance is launched, we focus/show the existing window
        // and the new instance exits automatically via the plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // ── Plugins ─────────────────────────────────────────────────────────
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // ── Shared state ────────────────────────────────────────────────────
        .manage(SharedConfigTx(config_tx))
        .manage(StoredConfig(shared_cfg))
        .manage(SharedStatus(agent_status))
        // ── Commands ────────────────────────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::get_module_permissions,
            commands::config::set_module_permission,
            commands::config::save_config,
            commands::config::get_status,
            commands::config::get_app_version,
            commands::auth::has_ui_password,
            commands::auth::verify_ui_password,
            commands::window::hide_window,
            commands::window::set_window_theme,
            commands::auth::exit_agent,
            commands::update::check_manual_update,
            commands::update::apply_manual_update,
            commands::enrollment::discover_vantyr_mdns_servers,
            commands::enrollment::adopt_with_enrollment_code,
            commands::logs::list_log_sources,
            commands::logs::read_log_file_tail,
            commands::logs::clear_log_file,
            commands::logs::open_log_location,
        ])
        // ── Setup ────────────────────────────────────────────────────────────
        .setup(move |app| {
            tray::setup(app.handle());

            // When `auto_update_enabled` is true (default off): check shortly after app startup,
            // then every 6 hours, via `update_via_service` + MSI.
            const AUTO_UPDATE_STARTUP_DELAY_SECS: u64 = 45;
            const AUTO_UPDATE_INTERVAL_SECS: u64 = 60 * 60 * 6;

            use crate::service_client::{update_via_service, UpdateViaServiceOutcome};
            let stored_cfg = app.state::<StoredConfig>().0.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(
                    AUTO_UPDATE_STARTUP_DELAY_SECS,
                ))
                .await;
                loop {
                    let enabled = stored_cfg
                        .lock()
                        .map(|c| c.auto_update_enabled)
                        .unwrap_or(false);
                    if enabled {
                        match update_via_service().await {
                            Ok(UpdateViaServiceOutcome::InstallStarted) => {
                                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                                crate::service_client::exit_for_update();
                            }
                            Ok(UpdateViaServiceOutcome::UpToDate) => {}
                            Err(e) => warn!("Auto-update (Windows): {e:#}"),
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(AUTO_UPDATE_INTERVAL_SECS))
                        .await;
                }
            });

            let Some(win) = app.get_webview_window("main") else {
                // Surface as a setup error instead of panicking on the UI thread (panic = "abort"
                // would take down the whole agent process).
                return Err("main window missing".into());
            };

            // Show on first run or explicit flag
            let is_first_run = initial_config.server_url.is_empty();
            if is_first_run || show_on_startup {
                let _ = win.show();
                let _ = win.set_focus();
            } else {
                // Not needed right now: destroy the webview so WebView2 doesn't sit
                // around consuming memory in the background.
                let _ = win.destroy();
            }

            // Register Ctrl+Shift+F12 global shortcut
            let app_handle = app.handle().clone();
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12);

            app.global_shortcut()
                .on_shortcut(shortcut, move |_app_handle, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        // Creating a window in an event handler can deadlock on Windows (WebView2).
                        // Spawn a thread (Tauri docs recommendation).
                        let handle = app_handle.clone();
                        std::thread::spawn(move || {
                            if let Some(w) = handle.get_webview_window("main") {
                                let visible = w.is_visible().unwrap_or(false);
                                if visible {
                                    let _ = w.emit("lock_ui", ());
                                    let _ = w.destroy();
                                } else {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                                return;
                            }

                            // Recreate from config template (keeps size/min size/decorations consistent).
                            let cfg = handle
                                .config()
                                .app
                                .windows
                                .iter()
                                .find(|w| w.label == "main")
                                .or_else(|| handle.config().app.windows.first())
                                .cloned();

                            let Some(conf) = cfg else { return };
                            let _ = tauri::WebviewWindowBuilder::from_config(&handle, &conf)
                                .and_then(tauri::WebviewWindowBuilder::build);

                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        });
                    }
                })
                .unwrap_or_else(|e| {
                    error!("Failed to register global shortcut Ctrl+Shift+F12: {e}");
                });

            info!("Tauri settings window initialised (show_on_startup={show_on_startup}).");
            Ok(())
        })
        // ── Window close → hide instead of quit ──────────────────────────────
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("lock_ui", ());
                // Destroy to reclaim WebView2 memory; recreate on demand.
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    let _ = w.destroy();
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            error!("Tauri runtime error: {e}");
            // Keep process alive so the agent background thread continues.
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
            }
        });

    // Critical: if we destroy the only window, Tauri may try to exit.
    // Prevent exit so the background agent keeps running; `exit_agent()` handles real shutdown.
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
        }
    });
}
