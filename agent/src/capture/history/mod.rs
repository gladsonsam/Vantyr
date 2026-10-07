//! Screen history capture ("Recall") — Phase 0/1.
//!
//! This is a SEPARATE pipeline from the demand-driven MJPEG streaming in
//! [`crate::capture::screen`]. That one only runs while a dashboard viewer is watching
//! and keeps only the latest frame in memory. This one runs on a slow cadence
//! (a "keyframe every N seconds while the user is active"), dedupes near-identical
//! frames via an average-hash, extracts on-device OCR text (Windows.Media.Ocr),
//! and hands each surviving frame to the agent loop for persistence on the server.
//!
//! Storage strategy (see docs/11-screen-history-plan.md): capture is *strategic*,
//! not fixed-fps — the agent loop pauses this pipeline while the user is AFK by
//! clearing the `active` flag, and the dedup step drops frames that didn't change.

mod image_ops;
pub mod spool;

// On-device OCR is the only OS-specific step: Windows.Media.Ocr on Windows,
// nothing yet on Linux.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux::ocr_rgba;
#[cfg(windows)]
use self::windows::ocr_rgba;

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tracing::{debug, error, info, warn};
use xcap::Monitor;

use crate::capture::recall_context::ContextExt;
use image_ops::{average_hash, downscale, encode_jpeg, hamming};

// ─────────────────────────────────────────────────────────────────────────────

/// Tunables for the history-capture loop.
///
/// Pushed by the server (`set_recall_settings`) and cached in agent config, so a
/// cadence change or the kill switch survives restarts and applies while offline.
/// The values here are the fallback for an agent that has never received a push.
///
/// `#[serde(default)]` on the struct means a push omitting a field leaves it at the
/// default rather than failing to parse the whole message.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct HistorySettings {
    /// Operator kill switch. When false the capture loop keeps running but records
    /// nothing, so re-enabling takes effect immediately without a restart.
    pub enabled: bool,
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
    /// Which monitor to capture (index into [`crate::capture::screen::list_monitors`]).
    /// `None` = **every** monitor, each deduped independently — a second screen is
    /// usually where the reference material, chat, or docs live, and recording only
    /// the primary leaves the timeline showing half of what the person was doing.
    pub monitor: Option<usize>,
    /// Run on-device OCR on each stored frame.
    pub ocr: bool,
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
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
    pub generation: Option<crate::permissions::Generation>,
    pub captured_at: chrono::DateTime<chrono::Utc>,
    pub capture_duration_ms: Option<u32>,
    pub context: Option<crate::capture::recall_context::Context>,
    pub context_generations: crate::capture::recall_context::Generations,
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
    /// Per-word bounding boxes for that text, normalized to 0..1 of this frame.
    /// Empty when OCR is off or found nothing.
    pub ocr_words: Vec<OcrWord>,
}

/// Timestamp/duration surround only the screenshot call, not context/OCR/encoding.
fn capture_timed<T, E>(
    capture: impl FnOnce() -> Result<T, E>,
) -> Result<(T, chrono::DateTime<chrono::Utc>, Option<u32>), E> {
    let captured_at = chrono::Utc::now();
    let start = std::time::Instant::now();
    let image = capture()?;
    let duration = start.elapsed().as_millis();
    Ok((
        image,
        captured_at,
        (duration <= 1000).then_some(duration as u32),
    ))
}

// ── On-device OCR ─────────────────────────────────────────────────────────────

/// One OCR'd word and where it sits on the frame.
///
/// Coordinates are normalized to 0..1 of the stored frame, so the dashboard can
/// position them over the replayed image at any rendered size without knowing the
/// capture resolution.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OcrWord {
    /// The word text.
    pub t: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Text plus per-word geometry from one frame.
#[derive(Debug, Clone, Default)]
pub struct OcrOutput {
    pub text: String,
    pub words: Vec<OcrWord>,
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
    settings: Arc<Mutex<HistorySettings>>,
) -> anyhow::Result<()> {
    // Short quantum so cadence changes (and stop) take effect quickly; the desired
    // interval is re-evaluated every tick from the current activity level.
    let quantum_ms: u64 = 1_000;
    let quantum = Duration::from_millis(quantum_ms);
    // Snapshot for the one-time monitor selection + startup log. Everything inside
    // the loop re-reads, so a server push changes behaviour without a restart.
    let initial = *settings.lock().unwrap_or_else(|e| e.into_inner());

    std::thread::Builder::new()
        .name("screen-history".into())
        .spawn(move || {
            let all = Monitor::all().unwrap_or_default();
            if all.is_empty() {
                error!("Screen history: no monitor found; capture disabled.");
                return;
            }
            // Either the one configured monitor, or all of them.
            let targets: Vec<(usize, Monitor)> = match initial.monitor {
                Some(i) if i < all.len() => {
                    all.into_iter().enumerate().filter(|(j, _)| *j == i).collect()
                }
                Some(i) => {
                    warn!("Screen history: monitor index {i} unavailable; capturing all.");
                    all.into_iter().enumerate().collect()
                }
                None => all.into_iter().enumerate().collect(),
            };
            if targets.is_empty() {
                error!("Screen history: no capturable monitor; capture disabled.");
                return;
            }

            info!(
                "Screen history capture started on {} monitor(s) (interval={}ms, q={}, max_dim={}, ocr={})",
                targets.len(), initial.interval_ms, initial.jpeg_quality, initial.max_dim, initial.ocr
            );

            // Dedup state is per-monitor: a still second screen must not suppress
            // keyframes from the primary one the person is actually working on.
            let mut last_hash: Vec<Option<u64>> = vec![None; targets.len()];
            let mut last_context = vec![None; targets.len()];
            let mut last_context_generation = vec![None; targets.len()];
            // ms since a frame was last *stored*, to enforce keyframe_max_gap_ms.
            let mut since_stored_ms: u64 = initial.keyframe_max_gap_ms; // force first frame
            // ms accumulated toward the current (adaptive) desired interval.
            let mut waited_ms: u64 = 0;

            let mut generation = crate::permissions::Generation::capture(crate::permissions::Module::Recall);
            loop {
                if generation.is_some_and(|g| !g.valid()) { generation = None; last_hash.fill(None); last_context.fill(None); waited_ms = 0; }
                if generation.is_none() { generation = crate::permissions::Generation::capture(crate::permissions::Module::Recall); }
                if stop.load(Ordering::Relaxed) {
                    info!("Screen history capture stopped.");
                    break;
                }
                std::thread::sleep(quantum);
                since_stored_ms = since_stored_ms.saturating_add(quantum_ms);
                waited_ms = waited_ms.saturating_add(quantum_ms);

                // Re-read settings each tick so a server push (cadence, quality, or
                // the kill switch) applies without restarting the agent.
                let cfg = *settings.lock().unwrap_or_else(|e| e.into_inner());

                if !cfg.enabled || generation.is_none() {
                    // Operator kill switch. Keep the loop alive so re-enabling is
                    // immediate, but record nothing.
                    waited_ms = 0;
                    continue;
                }

                if !active.load(Ordering::Relaxed) {
                    // AFK — capture nothing; reset the accumulator so returning from
                    // idle doesn't immediately fire a frame before real interaction.
                    waited_ms = 0;
                    continue;
                }

                let _lease = generation.map(crate::permissions::WorkerLease::new);
                // Adaptive cadence: fast while actively interacting, normal when quiet.
                let idle_ms = now_ms().saturating_sub(last_input_ms.load(Ordering::Relaxed));
                let desired_ms = if idle_ms <= cfg.hot_idle_ms {
                    cfg.hot_interval_ms
                } else {
                    cfg.interval_ms
                };
                let force_keyframe = since_stored_ms >= cfg.keyframe_max_gap_ms;
                if waited_ms < desired_ms.max(quantum_ms) && !force_keyframe {
                    continue;
                }
                waited_ms = 0;

                // Any monitor storing a frame this tick resets the keyframe-gap
                // heartbeat: the point of that heartbeat is "prove the machine was
                // on", which one screen answers for all of them.
                let mut stored_any = false;
                let mut closed = false;

                for (slot, (idx, monitor)) in targets.iter().enumerate() {
                    let context_generations = crate::capture::recall_context::Generations::capture();
                    if last_context_generation[slot] != context_generations.window_generation {
                        last_context[slot] = None;
                        last_context_generation[slot] = context_generations.window_generation;
                    }
                    let bracket_start = std::time::Instant::now();
                    let before = crate::capture::recall_context::snapshot(context_generations.window_generation);
                    if !generation.is_some_and(|g| g.valid_fresh()) { continue; }
                    let (rgba, captured_at, capture_duration_ms) = match capture_timed(|| monitor.capture_image()) {
                        Ok(capture) => capture,
                        Err(e) => {
                            warn!("Screen history capture error on monitor {idx} (skipping): {e}");
                            continue;
                        }
                    };

                    let after = crate::capture::recall_context::snapshot(context_generations.window_generation);
                    let mut context = crate::capture::recall_context::Context::around(before, after, bracket_start.elapsed(), context_generations);
                    context.sanitize(context_generations);
                    let signature = context.signature();
                    let context_changed = signature.as_ref().is_some_and(|s| last_context[slot].as_ref() != Some(s));
                    let small = downscale(rgba, cfg.max_dim);
                    let hash = average_hash(&small);

                    if !force_keyframe {
                        if let Some(prev) = last_hash[slot] {
                            if hamming(prev, hash) <= cfg.dedup_hamming && !context_changed {
                                debug!("Screen history: unchanged frame dropped (monitor {idx}).");
                                continue;
                            }
                        }
                    }

                    let (ocr_text, ocr_words) = if cfg.ocr {
                        match ocr_rgba(&small) {
                            Ok(o) if !o.text.trim().is_empty() => (Some(o.text), o.words),
                            Ok(_) => (None, Vec::new()),
                            Err(e) => {
                                debug!("Screen history OCR failed (continuing without text): {e}");
                                (None, Vec::new())
                            }
                        }
                    } else {
                        (None, Vec::new())
                    };

                    let jpeg = match encode_jpeg(&small, cfg.jpeg_quality.clamp(1, 100)) {
                        Ok(j) => j,
                        Err(e) => {
                            warn!("Screen history JPEG encode failed (skipping): {e}");
                            continue;
                        }
                    };

                    if !generation.is_some_and(|g| g.valid_fresh()) { continue; }
                    context.sanitize(context_generations);
                    let frame = HistoryFrame {
                        generation,
                        captured_at,
                        capture_duration_ms,
                        context: Some(context),
                        context_generations,
                        monitor: *idx,
                        width: small.width(),
                        height: small.height(),
                        jpeg,
                        phash: hash,
                        ocr_text,
                        ocr_words,
                    };

                    // Non-blocking send: the spool writer drains this promptly, so a
                    // full channel means something is badly wedged — drop rather than
                    // stall capture. Only advance dedup state on an accepted frame.
                    match tx.try_send(frame) {
                        Ok(()) => {
                            last_hash[slot] = Some(hash);
                            if signature.is_some() { last_context[slot] = signature; }
                            stored_any = true;
                        }
                        Err(TrySendError::Full(_)) => {
                            debug!("Screen history: consumer busy; keyframe dropped.");
                        }
                        Err(TrySendError::Closed(_)) => {
                            info!("Screen history: receiver dropped; stopping capture.");
                            closed = true;
                            break;
                        }
                    }
                }

                if closed {
                    break;
                }
                if stored_any {
                    since_stored_ms = 0;
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("Failed to spawn screen-history thread: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod timing_tests {
    #[test]
    fn screenshot_timestamp_precedes_ocr_and_duration_excludes_it() {
        let (during, captured_at, duration) =
            super::capture_timed(|| Ok::<_, ()>(chrono::Utc::now())).unwrap();
        assert!(captured_at <= during);
        let measured = duration.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20)); // stand-in for later OCR
        assert_eq!(duration, Some(measured));
        assert!((chrono::Utc::now() - captured_at).num_milliseconds() >= 20);
    }
}
