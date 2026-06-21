//! Linux session/desktop detection — the RustDesk-style runtime dispatch point.
//!
//! Capture, input, and activity backends branch on [`detect`] so one Linux
//! binary serves Wayland and X11. Cached after first call (a session does not
//! change type at runtime).

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    Wayland,
    X11,
    Headless,
}

/// Detect the graphical session type. Checks Wayland first because XWayland also
/// sets `DISPLAY`, which would otherwise misreport a Wayland session as X11.
pub fn detect() -> SessionKind {
    static CACHED: OnceLock<SessionKind> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let session_type = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if session_type == "wayland" || std::env::var("WAYLAND_DISPLAY").is_ok() {
            SessionKind::Wayland
        } else if session_type == "x11" || std::env::var("DISPLAY").is_ok() {
            SessionKind::X11
        } else {
            SessionKind::Headless
        }
    })
}

/// Whether the compositor is wlroots-based (Hyprland, sway, …). These expose the
/// `wlr-screencopy` protocol that `grim` uses, so they can be captured without
/// the XDG ScreenCast portal + PipeWire.
pub fn is_wlroots() -> bool {
    std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() || std::env::var("SWAYSOCK").is_ok()
}

/// Best-effort check that an executable is on `PATH` (used to report capability
/// status honestly, e.g. whether `grim` is installed for Wayland capture).
pub fn command_exists(name: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {name}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
