//! Windows remote input: physical cursor placement and toast notifications.

use anyhow::{Context, Result};
use enigo::Enigo;
use tracing::warn;

mod toast;

const MAX_NOTIFY_TITLE_CHARS: usize = 64;
const MAX_NOTIFY_MESSAGE_CHARS: usize = 256;

/// Place the cursor in physical pixels, bypassing per-monitor DPI scaling.
pub(super) fn move_absolute(_enigo: &mut Enigo, x: i32, y: i32) -> Result<()> {
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetPhysicalCursorPos(x, y)
            .context("physical cursor movement failed")?;
    }
    Ok(())
}

/// Show the server's `Notify` message as a toast.
pub(super) fn notify(title: &str, message: &str) {
    let title = title.trim();
    let message = message.trim();
    if title.is_empty() && message.is_empty() {
        return;
    }
    if title.chars().count() > MAX_NOTIFY_TITLE_CHARS
        || message.chars().count() > MAX_NOTIFY_MESSAGE_CHARS
    {
        warn!("Ignoring Notify: title/message too large");
        return;
    }
    let mut t = toast::Toast::new(toast::Toast::POWERSHELL_APP_ID);
    t = t.title(if title.is_empty() { "Vantyr" } else { title });
    if !message.is_empty() {
        t = t.text1(message);
    }
    let _ = t.show();
}
