//! # Sentinel Agent (Windows)
//!
//! Connects to a remote WebSocket server and streams real-time telemetry.
//!
//! ## Startup flow
//!
//! 1. The **main thread** loads the saved configuration, spawns a background
//!    thread that runs a Tokio runtime + the agent WebSocket loop, then either
//!    blocks headless (`--no-ui` / `AGENT_NO_UI`) or runs the Tauri settings
//!    shell on Windows.
//!
//! 2. The **background thread** installs the keyboard hook, then runs the
//!    reconnect loop.  Any time the user changes the server URL or agent name
//!    through the settings window, the new `Config` is sent over a
//!    `tokio::sync::watch` channel and the loop reconnects immediately.
//!
//! ## Settings window
//!
//! Press **Ctrl+Shift+F12** to open the settings webview; while visible it
//! appears on the taskbar. Close destroys the webview (recreated on next open);
//! only "Exit Agent" terminates the process.
//!
//! ## Outbound frames (agent â†’ server)
//!
//! | Event                        | WS frame type  | JSON `"type"` field |
//! |------------------------------|----------------|---------------------|
//! | Buffered keystrokes          | `Text` (JSON)  | `"keys"`            |
//! | AFK transition               | `Text` (JSON)  | `"afk"`             |
//! | Return from AFK              | `Text` (JSON)  | `"active"`          |
//! | Foreground window changed    | `Text` (JSON)  | `"window_focus"`    |
//! | Active browser URL changed   | `Text` (JSON)  | `"url"`             |
//! | Installed software snapshot  | `Text` (JSON)  | `"software_inventory"` |
//!
//! ## Inbound frames (server â†’ agent)
//!
//! | Command          | WS frame type | JSON `"type"` field   |
//! |------------------|---------------|-----------------------|
//! | Start streaming  | `Text` (JSON) | `"start_capture"`     |
//! | Stop streaming   | `Text` (JSON) | `"stop_capture"`      |
//! | Local UI password| `Text` (JSON) | `"set_local_ui_password_hash"` |
//! | Mouse move       | `Text` (JSON) | `"MouseMove"`         |
//! | Mouse click      | `Text` (JSON) | `"MouseClick"`        |
//! | Request info     | `Text` (JSON) | `"RequestInfo"`       |
//! | Lock host        | `Text` (JSON) | `"LockHost"`          |
//! | Restart host     | `Text` (JSON) | `"RestartHost"`       |
//! | Shutdown host    | `Text` (JSON) | `"ShutdownHost"`      |
//! | Collect software | `Text` (JSON) | `"CollectSoftware"`   |
//! | Run script       | `Text` (JSON) | `"RunScript"`         |
//! | Network policy   | `Text` (JSON) | `"set_network_policy"` |

// In release builds: suppress the console window so the agent runs silently.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_loop;
mod app_block;
mod app_display;
mod capture;
mod config;
#[cfg(target_os = "windows")]
mod enrollment;
mod input;
mod ipc;
mod keyboard_capture;
mod log_sources;
mod mdns_discover;
mod network_policy;
mod network_scheduler;
mod remote_script;
mod schedule;
mod server_command;
#[cfg(target_os = "windows")]
mod service;
mod software_inventory;
mod system_info;
mod toast;
mod ui;
#[cfg(target_os = "windows")]
mod updater_client;
#[cfg(target_os = "windows")]
mod updater_manifest;
mod url_scraper;
mod win_icons;
mod window_tracker;
mod ws_client;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use keyboard_capture::InputEvent;
use tokio::sync::mpsc;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Registry};

use config::{AgentStatus, Config};

#[cfg(target_os = "windows")]
struct HeldHandle(#[allow(dead_code)] windows::Win32::Foundation::HANDLE);

// HANDLE is just a numeric/opaque OS handle. Holding it for process lifetime is safe.
#[cfg(target_os = "windows")]
unsafe impl Send for HeldHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for HeldHandle {}

#[cfg(target_os = "windows")]
static USER_AGENT_MUTEX: std::sync::OnceLock<HeldHandle> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn program_data_log_path(filename: &str) -> std::path::PathBuf {
    // Prefer a stable, shared location for service logs.
    // %ProgramData% is writable for LocalSystem and readable by admins.
    let base = std::env::var_os("ProgramData").map_or_else(
        || std::path::PathBuf::from(r"C:\ProgramData"),
        std::path::PathBuf::from,
    );
    base.join("Sentinel").join(filename)
}

fn init_logging(
    preferred_log_file: Option<std::path::PathBuf>,
) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    // In Windows release builds we run with `windows_subsystem = "windows"`,
    // so there is often no console attached. Write logs to a file by default
    // so failures are visible.
    //
    // Override path by setting `AGENT_LOG_FILE` to an absolute path.
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let mut log_file_path = std::env::var("AGENT_LOG_FILE")
        .ok()
        .map(std::path::PathBuf::from)
        .or(preferred_log_file);

    if log_file_path.is_none() {
        let mut p = config::config_path();
        p.pop(); // .../sentinel
        p.push("agent.log");
        log_file_path = Some(p);
    }

    if let Some(path) = log_file_path {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let (writer, guard) = tracing_appender::non_blocking(file);
            let file_layer = fmt::layer()
                .with_target(false)
                .with_thread_ids(false)
                .compact()
                .with_writer(writer);
            Registry::default().with(env_filter).with(file_layer).init();
            Some(guard)
        } else {
            let stderr_layer = fmt::layer()
                .with_target(false)
                .with_thread_ids(false)
                .compact();
            Registry::default()
                .with(env_filter)
                .with(stderr_layer)
                .init();
            None
        }
    } else {
        let stderr_layer = fmt::layer()
            .with_target(false)
            .with_thread_ids(false)
            .compact();
        Registry::default()
            .with(env_filter)
            .with(stderr_layer)
            .init();
        None
    }
}

// Entry point (agent runtime on a background thread; main thread: UI or idle)

fn main() {
    let args: Vec<String> = std::env::args().collect();

    #[cfg(target_os = "windows")]
    handle_import_machine_config_arg(&args);

    #[cfg(target_os = "windows")]
    if handle_service_mode_arg(&args) {
        return;
    }

    let _log_guard = init_logging(parse_log_file_arg(&args));
    info!("Sentinel agent v{}", env!("CARGO_PKG_VERSION"));

    #[cfg(target_os = "windows")]
    enforce_single_instance();

    // Allow forcing the settings UI to show on startup (tray/hotkey is easy to miss).
    let show_ui_on_startup = args.iter().any(|a| a == "--show-ui")
        || std::env::var("AGENT_SHOW_UI")
            .map(|v| {
                matches!(
                    v.trim(),
                    "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
                )
            })
            .unwrap_or(false)
        || crate::config::take_reopen_settings_ui_after_restart();

    // Allow disabling the UI entirely (headless mode). Useful when running the
    // agent as a scheduled task / service where a window surface cannot be created.
    let no_ui = args.iter().any(|a| a == "--no-ui")
        || std::env::var("AGENT_NO_UI")
            .map(|v| {
                matches!(
                    v.trim(),
                    "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
                )
            })
            .unwrap_or(false);

    // â”€â”€ Load persisted configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let initial_config = config::load_config();
    info!("Config file {:?}", config::config_path());
    #[cfg(target_os = "windows")]
    info!(
        "Machine-wide config on disk (readable): {}",
        config::machine_connection_policy_active()
    );

    // Shared with Tauri so server-pushed UI password updates apply everywhere.
    let shared_cfg: Arc<Mutex<Config>> = Arc::new(Mutex::new(initial_config.clone()));

    // â”€â”€ Shared agent status (agent thread writes, GUI thread reads) â”€â”€â”€â”€â”€â”€â”€
    let agent_status: Arc<Mutex<AgentStatus>> = Arc::new(Mutex::new(AgentStatus::Disconnected));

    // â”€â”€ Config watch channel (GUI thread writes, agent thread reads) â”€â”€â”€â”€â”€â”€
    let initial_watch = if initial_config.server_url.is_empty() {
        None
    } else {
        Some(initial_config.clone())
    };
    let (config_tx, config_rx) = tokio::sync::watch::channel(initial_watch);

    // â”€â”€ Synchronisation: wait for the keyboard hook to be installed â”€â”€â”€â”€â”€â”€â”€
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<anyhow::Result<()>>();

    // â”€â”€ Background thread: Tokio runtime + agent WebSocket loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                // because keyboard_capture::start() spawns a tokio task internally.
                // Bounded queue: prevents unbounded RAM growth while offline (WAN laptops).
                // Best-effort producers use `try_send`, so overload drops bursts instead of blocking input threads.
                const INPUT_EVENT_CHANNEL_CAP: usize = 2048;
                let (key_tx, key_rx) = mpsc::channel::<InputEvent>(INPUT_EVENT_CHANNEL_CAP);
                match keyboard_capture::start(key_tx) {
                    Ok(()) => {
                        info!("Keyboard hook installed.");
                        let _ = ready_tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(anyhow::anyhow!("{e:#}")));
                        return; // Cannot continue without keyboard capture
                    }
                }

                let (frame_tx, frame_rx) =
                    mpsc::channel::<Vec<u8>>(crate::agent_loop::FRAME_CHANNEL_CAP);
                crate::agent_loop::run_agent_loop(
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
    } else {
        // â”€â”€ Tauri settings window (main thread; Tauri owns the event loop) â”€â”€
        ui::run_tauri(
            initial_config,
            config_tx,
            shared_cfg,
            agent_status,
            show_ui_on_startup,
        );
    }
}

#[cfg(target_os = "windows")]
fn handle_import_machine_config_arg(args: &[String]) {
    if let Some(json_path) = parse_import_machine_config_arg(args) {
        eprintln!(
            "Importing machine-wide config from {} â€¦",
            json_path.display()
        );
        match crate::config::import_machine_config_from_json_file(&json_path) {
            Ok(()) => {
                eprintln!(
                    "Wrote machine-wide config to {} (DPAPI machine scope).",
                    crate::config::machine_config_path().display()
                );
            }
            Err(e) => {
                eprintln!("Import failed: {e:#}");
                std::process::exit(1);
            }
        }
        std::process::exit(0);
    }
}

#[cfg(target_os = "windows")]
fn handle_service_mode_arg(args: &[String]) -> bool {
    if args.iter().any(|a| a == "--service") {
        let log_guard = init_logging(Some(program_data_log_path("service.log")));
        if let Some(g) = log_guard {
            service::set_service_log_guard(g);
        }
        info!("Sentinel agent v{}", env!("CARGO_PKG_VERSION"));
        info!("Starting in Windows service mode.");
        if let Err(e) = service::run_windows_service() {
            error!("Windows service failed: {e}");
        }
        return true;
    }
    false
}

#[cfg(target_os = "windows")]
fn enforce_single_instance() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows::Win32::System::Threading::CreateMutexW;

    let name = crate::service::to_wide_z("Global\\SentinelAgentMain");
    let h: HANDLE = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.unwrap_or_default();
    if h.is_invalid() {
        warn!("CreateMutexW failed; continuing without single-instance guard.");
    } else {
        let err = unsafe { GetLastError() };
        if err == ERROR_ALREADY_EXISTS {
            let _ = unsafe { CloseHandle(h) };
            info!("Another Sentinel agent instance is already running; exiting.");
            std::process::exit(0);
        }
        // Keep mutex held for process lifetime.
        let _ = USER_AGENT_MUTEX.set(HeldHandle(h));
    }
}

/// `sentinel-agent --import-machine-config C:\path\agent.json` (run elevated). Writes
/// `%ProgramData%\Sentinel\config.dat` with DPAPI machine scope.
#[cfg(target_os = "windows")]
fn parse_import_machine_config_arg(args: &[String]) -> Option<std::path::PathBuf> {
    if let Some(i) = args.iter().position(|a| a == "--import-machine-config") {
        if let Some(p) = args.get(i + 1) {
            let p = p.trim_matches('"').trim();
            if !p.is_empty() {
                return Some(std::path::PathBuf::from(p));
            }
        }
        return None;
    }
    if let Some(a) = args
        .iter()
        .find(|a| a.starts_with("--import-machine-config="))
    {
        let p = a
            .trim_start_matches("--import-machine-config=")
            .trim_matches('"')
            .trim();
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    None
}

fn parse_log_file_arg(args: &[String]) -> Option<std::path::PathBuf> {
    // Optional CLI override (used by the Windows launcher service so we can always find logs).
    if let Some(i) = args.iter().position(|a| a == "--log-file") {
        if let Some(p) = args.get(i + 1) {
            let p = p.trim_matches('"').trim();
            if !p.is_empty() {
                return Some(std::path::PathBuf::from(p));
            }
        }
        return None;
    }
    if let Some(a) = args.iter().find(|a| a.starts_with("--log-file=")) {
        let p = a.trim_start_matches("--log-file=").trim_matches('"').trim();
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

#[inline]
pub(crate) fn unix_timestamp_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
