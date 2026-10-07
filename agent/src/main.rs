//! # Vantyr Agent
//!
//! Connects to a remote WebSocket server and streams real-time telemetry.
//!
//! ## Startup flow
//!
//! `main` hands the command line to [`host::run`], which picks this process's
//! role (CLI command, Windows service, capture worker, or the agent itself).
//!
//! 1. The **main thread** loads the saved configuration, spawns a background
//!    thread that runs a Tokio runtime + the agent WebSocket loop, then either
//!    blocks headless (`--no-ui` / `AGENT_NO_UI`) or runs the Tauri settings
//!    shell on Windows or stays headless on Linux.
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
//! ## Outbound frames (agent -> server)
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
//! ## Inbound frames (server -> agent)
//!
//! | Command          | WS frame type | JSON `"type"` field   |
//! |------------------|---------------|-----------------------|
//! | Start streaming  | `Text` (JSON) | `"start_capture"`     |
//! | Stop streaming   | `Text` (JSON) | `"stop_capture"`      |
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

mod capture;
mod commands;
mod config;
mod connection;
mod host;
mod input;
mod inventory;
mod permissions;
mod platform;
mod policy;
#[cfg(windows)]
mod updater;

fn main() {
    host::run(host::Launch::from_args(std::env::args().collect()));
}

// Helpers

#[inline]
pub(crate) fn unix_timestamp_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
