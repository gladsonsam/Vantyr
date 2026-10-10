//! Linux remote input: `enigo` absolute moves (X11/XTest). Wayland input needs
//! the RemoteDesktop portal + libei or `/dev/uinput` and is a later increment.

use anyhow::{Context, Result};
use enigo::{Coordinate, Enigo, Mouse};
use tracing::warn;

pub(super) fn move_absolute(enigo: &mut Enigo, x: i32, y: i32) -> Result<()> {
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .context("cursor movement failed")?;
    Ok(())
}

/// No desktop notification backend on Linux yet.
pub(super) fn notify(title: &str, message: &str) {
    let _ = (title, message);
    warn!("Notify command is not implemented on this platform");
}
