//! Settings window chrome.

use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

/// Match the native window chrome (the Windows title bar with the
/// minimize/maximize/close buttons) to the theme the UI renders in. The window
/// is created with the dark theme from `tauri.conf.json` so there is no flash
/// before the UI loads; this keeps the two in step afterwards.
#[tauri::command]
pub fn set_window_theme(app: AppHandle, dark: bool) {
    let theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    if let Some(win) = app.get_webview_window("main") {
        if let Err(e) = win.set_theme(Some(theme)) {
            warn!("Failed to set window theme: {e}");
        }
    }
}
#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("lock_ui", ());
        // Fully destroy the webview to release WebView2 memory.
        // We'll recreate it on demand via Ctrl+Shift+F12 (or first-run).
        let _ = win.destroy();
    }
}
