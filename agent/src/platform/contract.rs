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
//! NOTE: `async fn` entry points (e.g. `script_execution::run`) cannot be written as `fn` pointers (opaque return
//! type), so they are not pinned here; they are already exercised by real,
//! non-cfg-gated call sites in `agent_loop`/`commands`, which enforces them
//! on both targets.

#![allow(dead_code)]

use tokio::sync::mpsc::Sender;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use super::types::{ActiveUrl, InputEvent, WindowEvent};
use super::{
    activity_tracker, keyboard_monitor, script_execution, system_control, terminal, url_provider,
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

    // ── system_control ──────────────────────────────────────────────────────
    let _: fn() -> anyhow::Result<()> = system_control::lock_host;
    let _: fn() -> anyhow::Result<()> = system_control::restart_host;
    let _: fn() -> anyhow::Result<()> = system_control::shutdown_host;

    // ── terminal ────────────────────────────────────────────────────────────
    let _: fn(Uuid, u16, u16, Sender<Message>, crate::permissions::Generation) = terminal::start;
    let _: fn(Uuid, &str) = terminal::input;
    let _: fn(Uuid, u16, u16) = terminal::resize;
    let _: fn(Uuid) = terminal::close;

    // ── script_execution ────────────────────────────────────────────────────
    // `run` is `async fn` (opaque return), so only its outcome type is pinned
    // here; the call site in `commands` enforces the signature.
    let _: Option<script_execution::RunOutcome> = None;
}
