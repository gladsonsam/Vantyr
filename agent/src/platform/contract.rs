//! Compiler-enforced platform contract.
//!
//! The platform facade ([`super`]) re-exports each capability from whichever
//! backend (`windows` / `linux`) is selected for the current target. A glob
//! re-export alone does **not** guarantee both backends expose the same set of
//! functions with the same signatures — a backend could silently omit a function
//! (only noticed if a call site happens to reference it on that OS) or drift a
//! type.
//!
//! This module closes that gap. [`_assert_platform_contract`] is never executed;
//! it exists so the compiler type-checks every capability entry point against the
//! exact signature the agent relies on. Because it resolves through the public
//! facade (`super::activity_tracker::…`), it checks **the active backend on the
//! current target**: Windows is verified locally / in the `agent (windows)` CI
//! job, Linux in the `agent (linux)` job. A backend that omits or diverges an
//! entry point fails to build here.
//!
//! When you add a new capability to the seam, add its signature here too — that
//! is what forces every backend to implement it.
//!
//! NOTE: `async fn` entry points (e.g. `software_inventory::send_inventory`,
//! `script_execution::run`) cannot be written as `fn` pointers (opaque return
//! type), so they are not pinned here; they are already exercised by real,
//! non-cfg-gated call sites in `agent_loop`/`server_command`, which enforces them
//! on both targets.

#![allow(dead_code)]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use sysinfo::System;
use tokio::sync::mpsc::Sender;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use super::types::{ActiveUrl, InputEvent, WindowEvent};
use super::{
    activity_tracker, config_store, desktop_capture, input_control, keyboard_monitor,
    network_policy, software_inventory, system_control, system_info, terminal, url_provider,
};

/// Never called. The bindings below are the platform seam's contract: each one
/// fails to compile if the active backend's entry point is missing or has a
/// different signature.
fn _assert_platform_contract() {
    // ── activity_tracker ────────────────────────────────────────────────────
    let _: fn() -> activity_tracker::WindowTracker = activity_tracker::WindowTracker::new;
    let _: fn(&mut activity_tracker::WindowTracker) -> Option<WindowEvent> =
        activity_tracker::WindowTracker::poll;
    let _: fn(&str, u32) -> anyhow::Result<Vec<u8>> = activity_tracker::app_icon_png_for_path;

    // ── keyboard_monitor ────────────────────────────────────────────────────
    let _: fn(Sender<InputEvent>) -> anyhow::Result<()> = keyboard_monitor::start;

    // ── url_provider ────────────────────────────────────────────────────────
    let _: fn() -> Option<ActiveUrl> = url_provider::active_url;

    // ── desktop_capture ─────────────────────────────────────────────────────
    let _: fn(
        Sender<Vec<u8>>,
        Arc<AtomicBool>,
        desktop_capture::CaptureSettings,
    ) -> anyhow::Result<()> = desktop_capture::start_capture;

    // ── input_control ───────────────────────────────────────────────────────
    let _: fn() -> anyhow::Result<input_control::InputController> =
        input_control::InputController::new;
    let _: fn(&mut input_control::InputController, &str) -> anyhow::Result<()> =
        input_control::InputController::handle_command;

    // ── network_policy ──────────────────────────────────────────────────────
    let _: fn(&str, u16) -> anyhow::Result<()> = network_policy::apply_block;
    let _: fn() -> anyhow::Result<()> = network_policy::remove_block;
    let _: fn(&str) -> Option<(String, u16)> = network_policy::parse_server_host_port;

    // ── system_control ──────────────────────────────────────────────────────
    let _: fn() -> anyhow::Result<()> = system_control::lock_host;
    let _: fn() -> anyhow::Result<()> = system_control::restart_host;
    let _: fn() -> anyhow::Result<()> = system_control::shutdown_host;

    // ── system_info ─────────────────────────────────────────────────────────
    let _: fn() -> serde_json::Value = system_info::collect_agent_info;
    let _: fn(&mut System) -> serde_json::Value = system_info::collect_resource_metrics;
    let _: fn() -> Option<String> = system_info::active_username;
    let _: fn() -> Option<String> = system_info::env_username_fallback;

    // ── software_inventory ──────────────────────────────────────────────────
    let _: fn(&str, &str) -> std::cmp::Ordering =
        software_inventory::cmp_str_ascii_case_insensitive;

    // ── terminal ────────────────────────────────────────────────────────────
    let _: fn(Uuid, u16, u16, Sender<Message>) = terminal::start;
    let _: fn(Uuid, &str) = terminal::input;
    let _: fn(Uuid, u16, u16) = terminal::resize;
    let _: fn(Uuid) = terminal::close;

    // ── config_store ────────────────────────────────────────────────────────
    let _: fn() -> std::path::PathBuf = config_store::config_path;
    let _: fn() -> config_store::Config = config_store::load_config;
    let _: fn() -> bool = config_store::take_reopen_settings_ui_after_restart;
}
