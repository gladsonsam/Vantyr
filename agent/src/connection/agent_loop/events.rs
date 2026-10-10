//! The session's outbound events: the hello frames, window-focus and app-icon events,
//! and flushing the queued telemetry (batched) to the writer.

use std::collections::HashSet;

use anyhow::Result;
use base64::Engine;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::outbound::{self, telemetry};
use crate::permissions::{Generation, Module};

/// The error when the writer task behind `out_tx` has gone.
pub(super) const CLOSED_OUTBOUND: &str =
    "Outbound channel closed; writer task exited unexpectedly.";

/// Send the queued telemetry events, batched when there is more than one.
/// Events whose module grant has gone are dropped first.
pub(super) async fn flush_events(
    out_tx: &mpsc::Sender<Message>,
    pending: &mut Vec<serde_json::Value>,
) -> Result<()> {
    pending.retain(|v| {
        crate::permissions::outbound_allowed(v)
            && match v["type"].as_str().unwrap_or("") {
                "keys" => crate::permissions::allowed(Module::KeyboardText),
                "afk" | "active" => crate::permissions::allowed(Module::IdleActivity),
                "window_focus" | "app_icon" => crate::permissions::allowed(Module::WindowActivity),
                "url" | "url_session" => crate::permissions::allowed(Module::BrowserUrls),
                _ => true,
            }
    });
    if pending.is_empty() {
        return Ok(());
    }
    if pending.len() == 1 {
        if let Some(one) = pending.pop() {
            let s = one.to_string();
            if out_tx.send(Message::Text(s)).await.is_err() {
                anyhow::bail!(CLOSED_OUTBOUND);
            }
        }
        return Ok(());
    }
    // Prefer batching; fall back to individual sends if the batch is too large.
    let batch = outbound::to_text(&telemetry::Batch { events: pending });
    if batch.len() <= 250_000 {
        pending.clear();
        if out_tx.send(Message::Text(batch)).await.is_err() {
            anyhow::bail!(CLOSED_OUTBOUND);
        }
        return Ok(());
    }
    // Too large: send individually in order.
    let mut items = std::mem::take(pending);
    for v in items.drain(..) {
        let s = v.to_string();
        if out_tx.send(Message::Text(s)).await.is_err() {
            anyhow::bail!(CLOSED_OUTBOUND);
        }
    }
    Ok(())
}

/// Announce the session: current module grants and system info. Returns the
/// grant report sent, so later changes can be detected.
pub(super) async fn send_session_hello(out_tx: &mpsc::Sender<Message>) -> serde_json::Value {
    let permission_report = crate::permissions::load().unwrap_or_default().wire();
    let _ = out_tx
        .send(Message::Text(permission_report.to_string()))
        .await;
    // Send system info once per session.
    if let Some(info) = crate::inventory::system_info::collect_agent_info_async().await {
        let _ = out_tx.send(Message::Text(info.to_string())).await;
    }
    permission_report
}

/// Queue a `window_focus` event, plus the app's icon the first time this
/// session sees its executable.
pub(super) fn push_window_focus(
    event: crate::platform::types::WindowEvent,
    generation: Option<Generation>,
    active_user: &Option<String>,
    sent_app_icons: &mut HashSet<String>,
    pending_events: &mut Vec<serde_json::Value>,
) {
    // Opportunistically upload an app icon once per exe name per session.
    // This keeps the dashboard snappy without requiring extra round trips.
    let exe_key = event.app.trim().to_lowercase();
    if !exe_key.is_empty()
        && !sent_app_icons.contains(&exe_key)
        && !event.app_path.trim().is_empty()
    {
        // `ExtractIconExW` often fails for our own EXE even with a valid installer icon.
        // Fall back to the bundled `icons/icon.ico` so Activity shows a tile on the server.
        let png = crate::platform::activity_tracker::app_icon_png_for_path(&event.app_path, 64);
        if let Ok(png) = png {
            pending_events.push(outbound::stamped(
                &telemetry::AppIcon {
                    exe_name: &exe_key,
                    png_base64: &base64::engine::general_purpose::STANDARD.encode(png),
                    ts: crate::unix_timestamp_secs(),
                },
                generation,
            ));
        }
        // Avoid retrying constantly for executables that can't produce icons.
        sent_app_icons.insert(exe_key);
    }
    pending_events.push(outbound::stamped(
        &telemetry::WindowFocus {
            title: &event.title,
            app: &event.app,
            app_display: &event.app_display,
            app_path: &event.app_path,
            hwnd: event.hwnd,
            ts: crate::unix_timestamp_secs(),
            user: active_user.as_deref(),
        },
        generation,
    ));
}
