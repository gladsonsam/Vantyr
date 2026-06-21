//! Linux screen capture, session-aware.
//!
//! - **X11** → the shared `xcap` capturer (works well under X/XWayland).
//! - **Wayland (wlroots: Hyprland/sway)** → native **`wlr-screencopy`** via the
//!   in-process `libwayshot` backend: one persistent Wayland connection, a raw
//!   RGBA frame per grab fed straight into the JPEG pipeline. No per-frame
//!   process spawn, no PNG round-trip, and no portal flash. If that backend is
//!   unavailable at runtime it falls back to spawning **`grim`** per frame.
//! - **Wayland (GNOME/KDE)** → not supported here (needs the XDG ScreenCast
//!   portal + PipeWire); reported `unsupported` in the capability block.
//!
//! Both Wayland paths follow the *focused* output (re-checked ~1×/second via
//! `hyprctl`) so multi-monitor setups stream the active screen rather than a
//! wide all-outputs composite.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use image::{codecs::jpeg::JpegEncoder, ExtendedColorType, ImageEncoder};
use libwayshot_xcap::{output::OutputInfo, WayshotConnection};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tracing::{info, warn};

pub use crate::capture::CaptureSettings;

use super::session::{self, SessionKind};

/// Spawn the capture loop on a dedicated OS thread; the caller owns the `stop`
/// flag. Signature matches the platform contract / the Windows backend.
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
                     (Hyprland/sway) are supported"
                );
            }
            std::thread::Builder::new()
                .name("screen-capture-wayland".into())
                .spawn(move || wayland_capture_thread(tx, stop, settings))
                .map_err(|e| anyhow::anyhow!("failed to spawn wayland capture thread: {e}"))?;
            Ok(())
        }
        SessionKind::Headless => anyhow::bail!("no graphical session available for screen capture"),
    }
}

/// Wayland capture thread body: prefer native `wlr-screencopy` (libwayshot) and
/// fall back to `grim` on any initialisation or sustained runtime failure.
fn wayland_capture_thread(
    tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    settings: CaptureSettings,
) {
    let want_grim_fallback = run_wayshot_loop(&tx, &stop, settings);
    if want_grim_fallback && !stop.load(Ordering::Relaxed) {
        if !session::command_exists("grim") {
            warn!("Native wlr-screencopy unavailable and `grim` is not installed; screen capture disabled.");
            return;
        }
        info!("Screen capture: falling back to grim.");
        run_grim_loop(&tx, &stop, settings);
    }
}

/// Resolve the focused wlroots output name via `hyprctl`, so multi-monitor setups
/// stream the active screen. Returns `None` off Hyprland or on any error (callers
/// then default to the first output / whole compositor).
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

/// Pick the `OutputInfo` matching `focused` (by connector name, e.g. `eDP-1`);
/// fall back to the first available output.
fn pick_output<'a>(outputs: &'a [OutputInfo], focused: Option<&str>) -> Option<&'a OutputInfo> {
    if let Some(name) = focused {
        if let Some(o) = outputs.iter().find(|o| o.name == name) {
            return Some(o);
        }
    }
    outputs.first()
}

/// Native `wlr-screencopy` capture loop (libwayshot). Returns `true` if the caller
/// should fall back to `grim` (init failed, no outputs, or sustained capture
/// errors); `false` if it stopped cleanly or the frame channel closed.
fn run_wayshot_loop(
    tx: &mpsc::Sender<Vec<u8>>,
    stop: &Arc<AtomicBool>,
    settings: CaptureSettings,
) -> bool {
    let mut conn = match WayshotConnection::new() {
        Ok(c) => c,
        Err(e) => {
            warn!("Native wlr-screencopy init failed ({e}); will try grim.");
            return true;
        }
    };
    if conn.get_all_outputs().is_empty() {
        warn!("Native wlr-screencopy found no outputs; will try grim.");
        return true;
    }

    let jpeg_quality = settings.jpeg_quality.clamp(1, 100);
    // In-process capture, so we can afford a much lower floor than grim (~25 fps).
    let interval_ms = settings.interval_ms.max(40);
    // Re-resolve the focused output about once per second.
    let refresh_frames = (1000 / interval_ms).max(1);

    let mut current: Option<OutputInfo> =
        pick_output(conn.get_all_outputs(), focused_output().as_deref()).cloned();
    info!(
        "Screen capture started (wlr-screencopy/libwayshot, output={}, jpeg_q={jpeg_quality}, interval_ms={interval_ms})",
        current.as_ref().map_or("<none>", |o| o.name.as_str()),
    );

    let mut jpeg_data: Vec<u8> = Vec::new();
    let mut frame: u64 = 0;
    let mut consecutive_errors: u32 = 0;

    loop {
        if stop.load(Ordering::Relaxed) {
            info!("Screen capture stopped on demand.");
            return false;
        }

        // Follow the focused monitor without spawning hyprctl every frame.
        if frame % refresh_frames == 0 {
            if let Some(o) = pick_output(conn.get_all_outputs(), focused_output().as_deref()).cloned()
            {
                current = Some(o);
            }
        }
        frame = frame.wrapping_add(1);

        // Clone so the connection isn't borrowed across a possible refresh below.
        let Some(output) = current.clone() else {
            let _ = conn.refresh_outputs();
            current = pick_output(conn.get_all_outputs(), focused_output().as_deref()).cloned();
            if current.is_none() {
                warn!("Native capture: no resolvable output; will try grim.");
                return true;
            }
            continue;
        };

        match conn.screenshot_single_output(&output, false) {
            Ok(img) => {
                consecutive_errors = 0;
                let rgb = img.into_rgb8();
                jpeg_data.clear();
                let encoder = JpegEncoder::new_with_quality(&mut jpeg_data, jpeg_quality);
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
                            return false;
                        }
                    },
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors <= 3 || consecutive_errors % 25 == 0 {
                    warn!("Native capture failed (x{consecutive_errors}): {e}");
                }
                // A monitor may have been (un)plugged; refresh and re-resolve.
                let _ = conn.refresh_outputs();
                current =
                    pick_output(conn.get_all_outputs(), focused_output().as_deref()).cloned();
                if consecutive_errors >= 5 {
                    warn!("Native capture failing repeatedly; will try grim.");
                    return true;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }

        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}

/// Capture one frame as PNG bytes via `grim`. `output` selects a single wlroots
/// output; `None` captures the whole compositor.
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

/// Fallback capture loop: spawn `grim` per frame. Higher per-frame cost than the
/// native path, so it enforces a higher minimum interval (~5 fps).
fn run_grim_loop(tx: &mpsc::Sender<Vec<u8>>, stop: &Arc<AtomicBool>, settings: CaptureSettings) {
    let jpeg_quality = settings.jpeg_quality.clamp(1, 100);
    let interval_ms = settings.interval_ms.max(200);
    let refresh_frames = (1000 / interval_ms).max(1);

    let mut output = focused_output();
    info!(
        "Screen capture started (grim, output={:?}, jpeg_q={jpeg_quality}, interval_ms={interval_ms})",
        output.as_deref().unwrap_or("<all>")
    );

    let mut jpeg_data: Vec<u8> = Vec::new();
    let mut consecutive_errors: u32 = 0;
    let mut frame: u64 = 0;

    loop {
        if stop.load(Ordering::Relaxed) {
            info!("Screen capture stopped on demand.");
            break;
        }

        if frame % refresh_frames == 0 {
            output = focused_output();
        }
        frame = frame.wrapping_add(1);

        match grim_capture_png(output.as_deref()) {
            Ok(png) => {
                consecutive_errors = 0;
                match image::load_from_memory(&png) {
                    Ok(img) => {
                        let rgb = img.into_rgb8();
                        jpeg_data.clear();
                        let encoder = JpegEncoder::new_with_quality(&mut jpeg_data, jpeg_quality);
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
                if consecutive_errors <= 3 || consecutive_errors % 25 == 0 {
                    warn!("grim capture failed (x{consecutive_errors}): {e}");
                }
                if consecutive_errors >= 3 {
                    std::thread::sleep(Duration::from_millis(1000));
                }
            }
        }

        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}
