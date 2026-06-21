//! Linux active-window tracking.
//!
//! Today only Hyprland is supported (via `hyprctl -j activewindow`). Other
//! Wayland compositors report no window until a backend is added — the
//! capability block in `system_info` reflects this honestly.

use serde_json::Value;

pub use crate::platform::types::WindowEvent;

#[derive(Default)]
pub struct WindowTracker {
    last_key: String,
}

impl WindowTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `Some(WindowEvent)` only when the focused window changed since the
    /// last call; `None` otherwise.
    pub fn poll(&mut self) -> Option<WindowEvent> {
        let ev = current_window()?;
        let key = format!("{}\n{}\n{}", ev.hwnd, ev.title, ev.app_path);
        if key == self.last_key {
            return None;
        }
        self.last_key = key;
        Some(ev)
    }
}

/// Current focused window without de-duplication (used for keystroke attribution
/// at flush time). Hyprland only for now.
pub fn current_window() -> Option<WindowEvent> {
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_err() {
        return None;
    }
    let output = std::process::Command::new("hyprctl")
        .args(["-j", "activewindow"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let class = value
        .get("class")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0);
    let app_path = if pid > 0 {
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let app = if !app_path.is_empty() {
        app_path
            .rsplit('/')
            .next()
            .unwrap_or(class.as_str())
            .to_string()
    } else {
        class.clone()
    };
    Some(WindowEvent {
        title,
        app_display: if class.is_empty() { app.clone() } else { class },
        app,
        app_path,
        hwnd: pid as usize,
    })
}

pub fn app_icon_png_for_path(_path: &str, _size: u32) -> anyhow::Result<Vec<u8>> {
    anyhow::bail!("app icon extraction is not implemented on Linux")
}
