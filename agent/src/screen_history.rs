//! Screen history capture ("Recall") — Phase 0/1.
//!
//! This is a SEPARATE pipeline from the demand-driven MJPEG streaming in
//! [`crate::capture`]. That one only runs while a dashboard viewer is watching
//! and keeps only the latest frame in memory. This one runs on a slow cadence
//! (a "keyframe every N seconds while the user is active"), dedupes near-identical
//! frames via an average-hash, extracts on-device OCR text (Windows.Media.Ocr),
//! and hands each surviving frame to the agent loop for persistence on the server.
//!
//! Storage strategy (see docs/11-screen-history-plan.md): capture is *strategic*,
//! not fixed-fps — the agent loop pauses this pipeline while the user is AFK by
//! clearing the `active` flag, and the dedup step drops frames that didn't change.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage,
};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tracing::{debug, error, info, warn};
use xcap::Monitor;

// ─────────────────────────────────────────────────────────────────────────────

/// Tunables for the history-capture loop. Parsed from a server policy push in a
/// later phase; sensible fleet-friendly defaults here.
#[derive(Clone, Copy, Debug)]
pub struct HistorySettings {
    /// Normal cadence (ms) while the user is active but not actively interacting
    /// (e.g. reading, watching). Adaptive capture slows to this when input is quiet.
    pub interval_ms: u64,
    /// Faster cadence (ms) while the user is actively interacting (recent keyboard /
    /// window activity within `hot_idle_ms`). This is the "record more when using" tier.
    pub hot_interval_ms: u64,
    /// How recent the last input must be (ms) to count as "actively interacting".
    pub hot_idle_ms: u64,
    /// JPEG quality for the stored keyframe (1–100). Low by design — these are
    /// thumbnails for review, not pixel-perfect archives.
    pub jpeg_quality: u8,
    /// Longest edge (px) after downscale; `0` disables downscaling.
    pub max_dim: u32,
    /// Skip a frame if its average-hash is within this Hamming distance of the
    /// last *stored* frame (0 = only skip byte-identical scenes).
    pub dedup_hamming: u32,
    /// Force a keyframe at least this often even if the screen looks unchanged,
    /// so the timelapse has coverage and "machine was on" is provable.
    pub keyframe_max_gap_ms: u64,
    /// Which monitor to capture (index into [`crate::capture::list_monitors`]);
    /// `None` = primary.
    pub monitor: Option<usize>,
    /// Run on-device OCR on each stored frame.
    pub ocr: bool,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            interval_ms: 20_000,
            hot_interval_ms: 6_000,
            hot_idle_ms: 20_000,
            jpeg_quality: 45,
            max_dim: 1600,
            dedup_hamming: 4,
            keyframe_max_gap_ms: 5 * 60_000,
            monitor: None,
            ocr: true,
        }
    }
}

/// One captured, deduped, encoded keyframe ready to ship to the server.
#[derive(Debug)]
pub struct HistoryFrame {
    pub captured_at: chrono::DateTime<chrono::Utc>,
    /// 0-based monitor index this frame came from.
    pub monitor: usize,
    pub width: u32,
    pub height: u32,
    /// JPEG-encoded, downscaled keyframe.
    pub jpeg: Vec<u8>,
    /// 64-bit average-hash of the (downscaled) frame — used for dedup and for
    /// cheap "did anything change" queries later.
    pub phash: u64,
    /// On-device OCR text, if OCR ran and produced anything.
    pub ocr_text: Option<String>,
}

// ── Image helpers ─────────────────────────────────────────────────────────────

/// 64-bit average-hash (aHash): downscale to 8×8, grayscale, threshold at mean.
/// Cheap, allocation-light, and good enough to tell "screen changed" from noise.
fn average_hash(img: &RgbaImage) -> u64 {
    let small = image::imageops::resize(img, 8, 8, FilterType::Triangle);
    let mut lumas = [0u16; 64];
    let mut sum: u32 = 0;
    for (i, px) in small.pixels().enumerate() {
        let [r, g, b, _] = px.0;
        // Integer Rec.601 luma.
        let l = (r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000;
        lumas[i] = l as u16;
        sum += l;
    }
    let mean = (sum / 64) as u16;
    let mut hash = 0u64;
    for (i, &l) in lumas.iter().enumerate() {
        if l >= mean {
            hash |= 1u64 << i;
        }
    }
    hash
}

#[inline]
fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Downscale so the longest edge is at most `max_dim`, preserving aspect ratio.
fn downscale(img: RgbaImage, max_dim: u32) -> RgbaImage {
    if max_dim == 0 {
        return img;
    }
    let (w, h) = (img.width(), img.height());
    let longest = w.max(h);
    if longest <= max_dim {
        return img;
    }
    let scale = max_dim as f32 / longest as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(&img, nw, nh, FilterType::Triangle)
}

fn encode_jpeg(img: &RgbaImage, quality: u8) -> anyhow::Result<Vec<u8>> {
    let rgb = image::DynamicImage::ImageRgba8(img.clone()).into_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

// ── On-device OCR ─────────────────────────────────────────────────────────────

/// Extract text from a frame using the OS OCR engine. Windows uses the native
/// `Windows.Media.Ocr` engine (no model download, runs offline). Other platforms
/// return `None` for now (Phase 2 can wire Tesseract on Linux).
#[cfg(windows)]
fn ocr_rgba(img: &RgbaImage) -> anyhow::Result<String> {
    use windows::{
        Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::DataWriter,
    };

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Ok(String::new());
    }

    // Windows OCR wants BGRA8; `image` gives us RGBA8. Swizzle in place.
    let mut bgra: Vec<u8> = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for px in img.pixels() {
        let [r, g, b, a] = px.0;
        bgra.push(b);
        bgra.push(g);
        bgra.push(r);
        bgra.push(a);
    }

    let writer = DataWriter::new()?;
    writer.WriteBytes(&bgra)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32)?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let op = engine.RecognizeAsync(&bitmap)?;
    // Block on the WinRT async op via status polling. OCR completes off a thread
    // pool in tens of ms, so a short poll loop avoids depending on the async
    // `.get()` helper (which `windows` 0.62 keeps in the separate `windows-future`
    // crate, not re-exported here) and needs no message pump on this thread.
    // `AsyncStatus` is a stable WinRT ABI enum: Started=0, Completed=1,
    // Canceled=2, Error=3 — read as raw i32 so we don't have to name the type.
    loop {
        let status = op.Status()?.0;
        if status == 1 {
            break; // Completed
        }
        if status != 0 {
            return Err(anyhow::anyhow!(
                "OCR async operation did not complete (status {status})"
            ));
        }
        std::thread::sleep(Duration::from_millis(2)); // Started — keep waiting
    }
    let result = op.GetResults()?;
    Ok(result.Text()?.to_string())
}

#[cfg(not(windows))]
fn ocr_rgba(_img: &RgbaImage) -> anyhow::Result<String> {
    Ok(String::new())
}

// ── Capture loop ──────────────────────────────────────────────────────────────

/// Current wall-clock in epoch milliseconds (matches the agent loop's activity stamp).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn the history-capture loop on a dedicated OS thread.
///
/// Capture is **adaptive**: it ticks on a short quantum and decides when to grab a
/// frame based on how actively the machine is being used —
/// * **AFK** (`active` is `false`): capture nothing (unattended, unchanging screen).
/// * **Active + recent input** (`last_input_ms` within `hot_idle_ms`): fast cadence
///   (`hot_interval_ms`) — "record more when using".
/// * **Active + quiet**: normal cadence (`interval_ms`).
///
/// Every surviving frame is downscaled, average-hashed (near-duplicates dropped unless
/// `keyframe_max_gap_ms` forces a heartbeat), OCR'd, JPEG-encoded, and `try_send`s a
/// [`HistoryFrame`] on `tx`. Because dedup drops unchanged frames, the resulting frame
/// *density* tracks real interactivity — the dashboard uses it as an activity signal.
///
/// Setting `stop` to `true`, or dropping the receiver, ends the loop cleanly.
pub fn start_history_capture(
    tx: mpsc::Sender<HistoryFrame>,
    stop: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    last_input_ms: Arc<AtomicU64>,
    settings: HistorySettings,
) -> anyhow::Result<()> {
    // Short quantum so cadence changes (and stop) take effect quickly; the desired
    // interval is re-evaluated every tick from the current activity level.
    let quantum_ms: u64 = 1_000;
    let quantum = Duration::from_millis(quantum_ms);
    let quality = settings.jpeg_quality.clamp(1, 100);

    std::thread::Builder::new()
        .name("screen-history".into())
        .spawn(move || {
            let monitors = Monitor::all().unwrap_or_default();
            let idx = settings
                .monitor
                .filter(|&i| i < monitors.len())
                .or_else(|| monitors.iter().position(|m| m.is_primary().unwrap_or(false)))
                .or(if monitors.is_empty() { None } else { Some(0) });
            let Some(idx) = idx else {
                error!("Screen history: no monitor found; capture disabled.");
                return;
            };
            let Some(monitor) = monitors.into_iter().nth(idx) else {
                error!("Screen history: monitor index {idx} unavailable.");
                return;
            };

            info!(
                "Screen history capture started on monitor {idx} (interval={}ms, q={quality}, max_dim={}, ocr={})",
                settings.interval_ms, settings.max_dim, settings.ocr
            );

            let mut last_hash: Option<u64> = None;
            // ms since a frame was last *stored*, to enforce keyframe_max_gap_ms.
            let mut since_stored_ms: u64 = settings.keyframe_max_gap_ms; // force first frame
            // ms accumulated toward the current (adaptive) desired interval.
            let mut waited_ms: u64 = 0;

            loop {
                if stop.load(Ordering::Relaxed) {
                    info!("Screen history capture stopped.");
                    break;
                }
                std::thread::sleep(quantum);
                since_stored_ms = since_stored_ms.saturating_add(quantum_ms);
                waited_ms = waited_ms.saturating_add(quantum_ms);

                if !active.load(Ordering::Relaxed) {
                    // AFK — capture nothing; reset the accumulator so returning from
                    // idle doesn't immediately fire a frame before real interaction.
                    waited_ms = 0;
                    continue;
                }

                // Adaptive cadence: fast while actively interacting, normal when quiet.
                let idle_ms = now_ms().saturating_sub(last_input_ms.load(Ordering::Relaxed));
                let desired_ms = if idle_ms <= settings.hot_idle_ms {
                    settings.hot_interval_ms
                } else {
                    settings.interval_ms
                };
                let force_keyframe = since_stored_ms >= settings.keyframe_max_gap_ms;
                if waited_ms < desired_ms.max(quantum_ms) && !force_keyframe {
                    continue;
                }
                waited_ms = 0;

                let rgba = match monitor.capture_image() {
                    Ok(img) => img,
                    Err(e) => {
                        warn!("Screen history capture error (skipping): {e}");
                        continue;
                    }
                };

                let small = downscale(rgba, settings.max_dim);
                let hash = average_hash(&small);

                if !force_keyframe {
                    if let Some(prev) = last_hash {
                        if hamming(prev, hash) <= settings.dedup_hamming {
                            debug!("Screen history: unchanged frame dropped (dedup).");
                            continue;
                        }
                    }
                }

                let ocr_text = if settings.ocr {
                    match ocr_rgba(&small) {
                        Ok(t) if !t.trim().is_empty() => Some(t),
                        Ok(_) => None,
                        Err(e) => {
                            debug!("Screen history OCR failed (continuing without text): {e}");
                            None
                        }
                    }
                } else {
                    None
                };

                let jpeg = match encode_jpeg(&small, quality) {
                    Ok(j) => j,
                    Err(e) => {
                        warn!("Screen history JPEG encode failed (skipping): {e}");
                        continue;
                    }
                };

                let frame = HistoryFrame {
                    captured_at: chrono::Utc::now(),
                    monitor: idx,
                    width: small.width(),
                    height: small.height(),
                    jpeg,
                    phash: hash,
                    ocr_text,
                };

                // Non-blocking send: while the agent is disconnected nobody drains
                // the channel, so drop rather than wedge the capture thread. Only
                // advance dedup/keyframe state when a frame is actually accepted.
                match tx.try_send(frame) {
                    Ok(()) => {
                        last_hash = Some(hash);
                        since_stored_ms = 0;
                    }
                    Err(TrySendError::Full(_)) => {
                        debug!("Screen history: consumer busy; keyframe dropped.");
                    }
                    Err(TrySendError::Closed(_)) => {
                        info!("Screen history: receiver dropped; stopping capture.");
                        break;
                    }
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("Failed to spawn screen-history thread: {e}"))?;

    Ok(())
}
