//! Screen Capture Module – xcap (demand-driven)
//!
//! The capture loop only runs while the server has active MJPEG viewers.
//! When the server wants to start streaming it sends JSON such as
//! `{"type":"start_capture","jpeg_quality":40,"interval_ms":200}` (fields optional; defaults apply).
//! over the control WebSocket; when the last viewer disconnects it sends
//! `{"type":"stop_capture"}`.
//!
//! [`start_capture`] spawns the OS thread and returns an [`Arc<AtomicBool>`]
//! stop flag.  Setting that flag to `true` causes the thread to exit cleanly
//! after its current frame.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use image::{codecs::jpeg::JpegEncoder, ExtendedColorType, ImageEncoder};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tracing::{error, info, warn};
use xcap::Monitor;

// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct CaptureSettings {
    pub jpeg_quality: u8,
    pub interval_ms: u64,
    /// Which monitor to capture (0-based index into [`list_monitors`] order).
    /// `None` captures the primary monitor.
    pub monitor: Option<usize>,
    /// When true (SYSTEM capture worker on Windows), the capture thread attaches
    /// to whichever desktop currently owns input and re-attaches when it changes
    /// (Default ↔ Winlogon), so the lock/sign-in screen is captured too. Ignored
    /// off Windows and left `false` for the ordinary user-session agent, which
    /// keeps the original single-thread behaviour.
    pub follow_input_desktop: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            jpeg_quality: 40,
            interval_ms: 200,
            monitor: None,
            follow_input_desktop: false,
        }
    }
}

impl CaptureSettings {
    /// Parse [`CaptureSettings`] from a control WebSocket `start_capture` JSON payload.
    pub fn from_server_command(val: &serde_json::Value) -> Self {
        let mut jpeg_quality: u8 = val
            .get("jpeg_quality")
            .or_else(|| val.get("jpeg_q"))
            .and_then(serde_json::Value::as_u64)
            .map_or(40, |u| u as u8)
            .clamp(1, 100);

        let interval_ms: u64 = if let Some(v) = val.get("interval_ms") {
            if let Some(ms) = v.as_u64() {
                ms
            } else if let Some(ms) = v.as_f64() {
                ms as u64
            } else {
                200
            }
        } else if let Some(fps) = val.get("fps").and_then(serde_json::Value::as_f64) {
            if fps.is_finite() && fps > 0.0 {
                (1000.0 / fps).round() as u64
            } else {
                200
            }
        } else {
            200
        }
        .clamp(33, 2000);

        if val.get("jpeg_quality").is_none() && val.get("jpeg_q").is_none() {
            jpeg_quality = 40;
        }

        let monitor = val
            .get("monitor")
            .or_else(|| val.get("monitor_index"))
            .and_then(serde_json::Value::as_u64)
            .map(|u| u as usize);

        Self {
            jpeg_quality,
            interval_ms,
            monitor,
            // Server-driven starts never set this; the SYSTEM capture worker
            // enables it explicitly before calling `start_capture`.
            follow_input_desktop: false,
        }
    }
}

/// Enumerate the connected monitors for the dashboard's monitor picker.
///
/// The index in this list is the value [`CaptureSettings::monitor`] expects, so
/// enumeration and capture-selection share one ordering ([`Monitor::all`]).
/// Returns an empty list when monitors can't be enumerated (e.g. no interactive
/// desktop), in which case the dashboard simply hides the picker.
pub fn list_monitors() -> Vec<serde_json::Value> {
    let Ok(monitors) = Monitor::all() else {
        return Vec::new();
    };
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::json!({
                "index": i,
                "name": m.name().unwrap_or_default(),
                "width": m.width().unwrap_or(0),
                "height": m.height().unwrap_or(0),
                "primary": m.is_primary().unwrap_or(false),
            })
        })
        .collect()
}

/// Spawn the capture loop on a dedicated OS thread; return its stop flag.
///
/// Frames are JPEG-encoded (quality configurable) and sent on `tx` on `settings.interval_ms`.
/// Setting `stop` to `true` causes the thread to exit after the current frame.
///
/// When `tx` is closed (channel dropped) the thread also exits automatically.
pub fn start_capture(
    tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    settings: CaptureSettings,
) -> anyhow::Result<()> {
    let jpeg_quality = settings.jpeg_quality.clamp(1, 100);
    let interval_ms = settings.interval_ms.max(1);
    std::thread::Builder::new()
        .name("screen-capture".into())
        .spawn(move || {
            if !settings.follow_input_desktop {
                // Ordinary path (standalone / user-session agent): one capture pass,
                // no desktop attaching. Identical behaviour to before.
                capture_pass(&tx, &stop, &settings, jpeg_quality, interval_ms, None);
                return;
            }

            // SYSTEM capture worker: follow the input desktop. Attaching must happen
            // on a thread that has not yet created any windows (`SetThreadDesktop`
            // rejects a thread that owns UI objects), and xcap builds per-desktop
            // GPU/DXGI state — so each desktop generation runs a *fresh* capture pass
            // that exits when the input desktop switches (lock/unlock/UAC), after
            // which we re-attach and start a new pass.
            #[cfg(target_os = "windows")]
            loop {
                if stop.load(Ordering::Relaxed) {
                    info!("Screen capture stopped on demand.");
                    break;
                }
                match crate::secure_desktop::attach_current_thread_to_input_desktop() {
                    Ok(attachment) => {
                        info!("Capture attached to input desktop '{}'.", attachment.name());
                        capture_pass(
                            &tx,
                            &stop,
                            &settings,
                            jpeg_quality,
                            interval_ms,
                            Some(attachment.name()),
                        );
                        // Drop the attachment (closes the desktop handle) before the
                        // next OpenInputDesktop/SetThreadDesktop attaches the new one.
                        drop(attachment);
                        // Settle briefly so a pass that returns instantly (e.g. no
                        // monitor mid-transition) can't busy-spin the re-attach loop.
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    Err(e) => {
                        // No reachable input desktop right now (transient during
                        // session transitions). Back off and retry.
                        warn!("Capture: cannot attach to input desktop yet: {e:#}");
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }

            #[cfg(not(target_os = "windows"))]
            capture_pass(&tx, &stop, &settings, jpeg_quality, interval_ms, None);
        })
        .map_err(|e| anyhow::anyhow!("Failed to spawn capture thread: {e}"))?;

    Ok(())
}

/// Capture/encode/send frames until `stop` is set, the frame channel closes, or
/// (when `watch_desktop` is `Some`) the input desktop changes away from that name.
///
/// Returning on a desktop change lets the caller re-attach a fresh thread to the
/// new desktop. On other paths this simply runs until told to stop.
fn capture_pass(
    tx: &mpsc::Sender<Vec<u8>>,
    stop: &Arc<AtomicBool>,
    settings: &CaptureSettings,
    jpeg_quality: u8,
    interval_ms: u64,
    watch_desktop: Option<&str>,
) {
    let monitors = Monitor::all().unwrap_or_default();
    // Resolve which monitor to capture: an explicit (valid) selection,
    // else the primary monitor, else the first available one.
    let idx = settings
        .monitor
        .filter(|&i| i < monitors.len())
        .or_else(|| monitors.iter().position(|m| m.is_primary().unwrap_or(false)))
        .or(if monitors.is_empty() { None } else { Some(0) });
    let Some(idx) = idx else {
        // With no monitor we can't capture this generation. When following the
        // input desktop this is transient (e.g. mid-switch); return so the caller
        // re-attaches rather than spinning here.
        if watch_desktop.is_none() {
            error!("Screen capture: no monitor found.");
        }
        return;
    };
    let Some(monitor) = monitors.into_iter().nth(idx) else {
        error!("Screen capture: monitor index {idx} unavailable.");
        return;
    };

    info!(
        "Screen capture pass: {}×{} (jpeg_q={jpeg_quality}, interval_ms={interval_ms})",
        monitor.width().unwrap_or(0),
        monitor.height().unwrap_or(0),
    );

    // Reuse one buffer per frame to avoid allocator churn on the capture thread.
    let mut jpeg_data: Vec<u8> = Vec::new();
    // Poll the input-desktop name at most a few times a second, not every frame.
    #[cfg(target_os = "windows")]
    let mut desktop_check = std::time::Instant::now();
    #[cfg(not(target_os = "windows"))]
    let _ = watch_desktop;

    loop {
        // Check stop flag first so we exit promptly.
        if stop.load(Ordering::Relaxed) {
            info!("Screen capture stopped on demand.");
            break;
        }

        // Detect a desktop switch (Default ↔ Winlogon) so the caller re-attaches.
        #[cfg(target_os = "windows")]
        if let Some(expected) = watch_desktop {
            if desktop_check.elapsed() >= Duration::from_millis(400) {
                desktop_check = std::time::Instant::now();
                if let Some(current) = crate::secure_desktop::input_desktop_name() {
                    if current != expected {
                        info!(
                            "Input desktop changed '{expected}' → '{current}'; re-attaching capture."
                        );
                        break;
                    }
                }
            }
        }

        match monitor.capture_image() {
            Ok(rgba_img) => {
                let rgb = image::DynamicImage::ImageRgba8(rgba_img).into_rgb8();

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
                        Err(TrySendError::Full(v)) => {
                            // Consumer busy – drop stale frame; keep capacity for next encode.
                            jpeg_data = v;
                        }
                        Err(TrySendError::Closed(_)) => {
                            info!("Frame channel closed; stopping capture.");
                            break;
                        }
                    },
                }
            }
            Err(e) => warn!("Screen capture error (skipping): {e}"),
        }

        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}
