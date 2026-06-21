//! Linux screen capture, session-aware.
//!
//! - **X11** → the shared `xcap` capturer (works well under X/XWayland).
//! - **Wayland (wlroots: Hyprland/sway)** → `grim`, which speaks the
//!   `wlr-screencopy` protocol. We grab a PNG per frame, decode it, and feed the
//!   existing shared JPEG pipeline. This needs the `grim` package installed.
//! - **Wayland (GNOME/KDE)** → not yet implemented (needs the XDG ScreenCast
//!   portal + PipeWire); reported `unsupported` in the capability block.
//!
//! `grim` is spawned once per frame, so the per-frame cost is higher than the
//! continuous PipeWire path — the loop therefore enforces a higher minimum
//! interval. A native wlr-screencopy / PipeWire backend is a future perf upgrade.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use image::{codecs::jpeg::JpegEncoder, ExtendedColorType, ImageEncoder};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tracing::{info, warn};

pub use crate::capture::CaptureSettings;

use super::session::{self, SessionKind};

/// Spawn the capture loop on a dedicated OS thread; return its stop flag is set
/// by the caller. Signature matches the platform contract / the Windows backend.
pub fn start_capture(
    tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    settings: CaptureSettings,
) -> anyhow::Result<()> {
    match session::detect() {
        // xcap handles X11 (and XWayland) cleanly — reuse the shared capturer.
        SessionKind::X11 => crate::capture::start_capture(tx, stop, settings),
        SessionKind::Wayland => {
            if !session::is_wlroots() {
                anyhow::bail!(
                    "Wayland screen capture on this compositor needs the XDG ScreenCast \
                     portal + PipeWire (not implemented yet); only wlroots compositors \
                     (Hyprland/sway) via grim are supported"
                );
            }
            if !session::command_exists("grim") {
                anyhow::bail!("Wayland screen capture requires `grim` to be installed");
            }
            start_grim_capture(tx, stop, settings)
        }
        SessionKind::Headless => anyhow::bail!("no graphical session available for screen capture"),
    }
}

/// Resolve the focused wlroots output name via `hyprctl`, so multi-monitor setups
/// stream the active screen rather than a wide all-outputs composite. Falls back
/// to None (whole compositor) when not on Hyprland or on any error.
fn focused_output() -> Option<String> {
    let out = std::process::Command::new("hyprctl")
        .args(["-j", "monitors"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let monitors: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    monitors
        .as_array()?
        .iter()
        .find(|m| m.get("focused").and_then(serde_json::Value::as_bool) == Some(true))
        .and_then(|m| m.get("name").and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

/// Capture one frame as PNG bytes via `grim`. `output` selects a single wlroots
/// output; None captures the whole compositor.
fn grim_capture_png(output: Option<&str>) -> anyhow::Result<Vec<u8>> {
    let mut cmd = std::process::Command::new("grim");
    if let Some(name) = output {
        cmd.args(["-o", name]);
    }
    // `-t png` is always available; `-` writes to stdout.
    cmd.args(["-t", "png", "-"]);
    let out = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run grim (is it installed?): {e}"))?;
    if !out.status.success() {
        anyhow::bail!(
            "grim exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    if out.stdout.is_empty() {
        anyhow::bail!("grim produced no image data");
    }
    Ok(out.stdout)
}

fn start_grim_capture(
    tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    settings: CaptureSettings,
) -> anyhow::Result<()> {
    let jpeg_quality = settings.jpeg_quality.clamp(1, 100);
    // grim spawns a process + full grab + PNG encode each frame, so clamp to a
    // saner floor than xcap's 1ms (≈ max 5 fps) to bound CPU.
    let interval_ms = settings.interval_ms.max(200);

    std::thread::Builder::new()
        .name("screen-capture-grim".into())
        .spawn(move || {
            let output = focused_output();
            info!(
                "Screen capture started (grim, output={:?}, jpeg_q={jpeg_quality}, interval_ms={interval_ms})",
                output.as_deref().unwrap_or("<all>")
            );

            let mut jpeg_data: Vec<u8> = Vec::new();
            let mut consecutive_errors: u32 = 0;

            loop {
                if stop.load(Ordering::Relaxed) {
                    info!("Screen capture stopped on demand.");
                    break;
                }

                match grim_capture_png(output.as_deref()) {
                    Ok(png) => {
                        consecutive_errors = 0;
                        match image::load_from_memory(&png) {
                            Ok(img) => {
                                let rgb = img.into_rgb8();
                                jpeg_data.clear();
                                let encoder =
                                    JpegEncoder::new_with_quality(&mut jpeg_data, jpeg_quality);
                                match encoder.write_image(
                                    rgb.as_raw(),
                                    rgb.width(),
                                    rgb.height(),
                                    ExtendedColorType::Rgb8,
                                ) {
                                    Err(e) => warn!("JPEG encode error (skipping): {e}"),
                                    Ok(()) => match tx.try_send(std::mem::take(&mut jpeg_data)) {
                                        Ok(()) => {}
                                        Err(TrySendError::Full(v)) => jpeg_data = v,
                                        Err(TrySendError::Closed(_)) => {
                                            info!("Frame channel closed; stopping capture.");
                                            break;
                                        }
                                    },
                                }
                            }
                            Err(e) => warn!("Failed to decode grim PNG (skipping): {e}"),
                        }
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        // Don't spam the log every frame if grim is broken/denied.
                        if consecutive_errors <= 3 || consecutive_errors % 25 == 0 {
                            warn!("grim capture failed (x{consecutive_errors}): {e}");
                        }
                        // Back off after repeated failures so we don't busy-spawn.
                        if consecutive_errors >= 3 {
                            std::thread::sleep(Duration::from_millis(1000));
                        }
                    }
                }

                std::thread::sleep(Duration::from_millis(interval_ms));
            }
        })
        .map_err(|e| anyhow::anyhow!("failed to spawn grim capture thread: {e}"))?;

    Ok(())
}
