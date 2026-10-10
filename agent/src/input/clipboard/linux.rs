//! Linux clipboard: `wl-paste`/`wl-copy` on Wayland, `xclip` on X11.

use serde_json::Value;
use tokio::process::Command;

fn backend() -> Option<&'static str> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        (super::executable("wl-paste").is_some() && super::executable("wl-copy").is_some())
            .then_some("wayland")
    } else if std::env::var_os("DISPLAY").is_some() {
        super::executable("xclip").map(|_| "x11")
    } else {
        None
    }
}

pub(super) fn available() -> bool {
    backend().is_some()
}

pub(super) fn command(write: bool) -> anyhow::Result<Command> {
    let (name, args): (&str, &[&str]) = match (backend(), write) {
        (Some("wayland"), false) => ("wl-paste", &["--no-newline", "--type", "text"]),
        // Clipboard owners must survive to serve the selection. wl-copy/xclip
        // fork their selection owner after consuming stdin; no text on argv.
        (Some("wayland"), true) => ("wl-copy", &["--type", "text/plain;charset=utf-8"]),
        (Some("x11"), false) => (
            "xclip",
            &["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
        ),
        (Some("x11"), true) => (
            "xclip",
            &["-selection", "clipboard", "-in", "-target", "UTF8_STRING"],
        ),
        _ => anyhow::bail!("clipboard unavailable"),
    };
    let mut cmd = Command::new(
        super::executable(name).ok_or_else(|| anyhow::anyhow!("clipboard unavailable"))?,
    );
    cmd.args(args);
    Ok(cmd)
}

/// No console sessions to pin on Linux.
pub(super) fn execution_allowed(_value: &Value) -> bool {
    true
}

pub(super) fn reply_session_current(_value: &Value) -> bool {
    true
}

pub(super) fn pin_request(_value: &mut Value) {}

pub(super) fn pin_reply(_reply: &mut Value, _value: &Value) {}
