//! Shipping spooled Recall keyframes to the server and handling their acks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use super::now_epoch_ms;
use crate::capture::recall_context::ContextExt;

/// How often the session sweeps the keyframe spool for backlog and ack timeouts.
pub(super) const HISTORY_PUMP_INTERVAL_SECS: u64 = 5;
/// Keyframes allowed on the wire without an ack. Bounded so a reconnect backlog
/// drains steadily instead of dumping thousands of frames into the socket at once
/// and starving live telemetry behind them.
const HISTORY_MAX_IN_FLIGHT: usize = 4;
/// Re-send a keyframe if the server hasn't acked it within this long.
const HISTORY_ACK_TIMEOUT: Duration = Duration::from_secs(90);
use vantyr_protocol::frames::HISTORY_FRAME_MAGIC;

/// A spooled keyframe handed to the server, awaiting its ack.
#[derive(Debug, Clone)]
pub(super) struct InFlightFrame {
    path: PathBuf,
    sent_at: std::time::Instant,
}

/// Ship spooled keyframes to the server, up to [`HISTORY_MAX_IN_FLIGHT`] unacked.
///
/// Frames stay on disk until the server acks them, so this is safe to call as often
/// as we like: it re-sends anything whose ack timed out and skips anything already
/// on the wire. Unparseable spool files (truncated by a crash, or written by an older
/// agent) are dropped here rather than blocking the queue forever.
pub(super) async fn pump_history_spool(
    spool: &crate::capture::history::spool::Spool,
    out_tx: &mpsc::Sender<Message>,
    in_flight: &mut HashMap<String, InFlightFrame>,
) -> Result<()> {
    if !crate::permissions::allowed(crate::permissions::Module::Recall) {
        return Ok(());
    }
    // Expire stale sends so a lost ack retries instead of wedging the queue.
    in_flight.retain(|_, f| f.sent_at.elapsed() < HISTORY_ACK_TIMEOUT);
    if in_flight.len() >= HISTORY_MAX_IN_FLIGHT {
        return Ok(());
    }

    let busy: std::collections::HashSet<PathBuf> =
        in_flight.values().map(|f| f.path.clone()).collect();
    // Scan deeper than the in-flight budget so frames already on the wire don't
    // hide the ones behind them.
    for path in spool.pending(HISTORY_MAX_IN_FLIGHT * 8) {
        if in_flight.len() >= HISTORY_MAX_IN_FLIGHT {
            break;
        }
        if busy.contains(&path) {
            continue;
        }
        let mut frame = match crate::capture::history::spool::Spool::load(&path) {
            Ok(f) => f,
            Err(e) => {
                warn!("Screen history: dropping unreadable spool frame: {e:#}");
                crate::capture::history::spool::Spool::remove(&path);
                continue;
            }
        };
        if let Some(c) = frame.header.context.as_mut() {
            c.sanitize(frame.header.context_generations);
        }
        let h = &frame.header;
        if !h.generation.is_some_and(|g| g.valid_fresh()) {
            crate::capture::history::spool::Spool::remove(&path);
            continue;
        }
        // Binary, not base64-in-JSON: base64 inflated every keyframe by ~33% on a
        // socket shared with live telemetry, and the encode/parse cost was paid on
        // both ends for bytes that were already binary. Wire format is
        // `HST\0` + u32 LE header length + header JSON + raw JPEG.
        let header = serde_json::json!({
            // Echoed back in the ack, and the server's dedup key so a retry after a
            // lost ack cannot insert the same keyframe twice.
            "uid"        : h.uid,
            "captured_at": h.captured_at,
            "capture_duration_ms": h.capture_duration_ms,
            "context": h.context,
            "monitor"    : h.monitor,
            "w"          : h.w,
            "h"          : h.h,
            // u64 as string: JSON numbers lose precision past 2^53.
            "phash"      : h.phash,
            "ocr_text"   : h.ocr_text,
            // Per-word boxes: what lets the dashboard overlay selectable text on a
            // replayed frame. Omitted entirely when empty to keep the header small.
            "ocr_words"  : if h.ocr_words.is_empty() { serde_json::Value::Null }
                           else { serde_json::to_value(&h.ocr_words)? },
        });
        let header_bytes = serde_json::to_vec(&header)?;
        let mut payload = Vec::with_capacity(
            HISTORY_FRAME_MAGIC.len() + 4 + header_bytes.len() + frame.jpeg.len(),
        );
        payload.extend_from_slice(HISTORY_FRAME_MAGIC);
        payload.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(&frame.jpeg);

        if out_tx
            .send(Message::Binary(crate::permissions::tag_recall_binary(
                payload,
                h.generation,
                h.context_generations,
            )))
            .await
            .is_err()
        {
            return Err(anyhow::anyhow!(
                "Outbound channel closed; writer task exited unexpectedly."
            ));
        }
        in_flight.insert(
            h.uid.clone(),
            InFlightFrame {
                path,
                sent_at: std::time::Instant::now(),
            },
        );
    }
    Ok(())
}

/// Handle a server acknowledgement for a spooled keyframe.
///
/// `ok` frames are deleted from the spool. A `reject` (frame the server will never
/// accept — oversized, corrupt base64) is also deleted: retrying it forever would
/// wedge the queue behind a frame that can never land.
pub(super) fn handle_history_ack(
    text: &str,
    in_flight: &mut HashMap<String, InFlightFrame>,
) -> bool {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let kind = val["type"].as_str().unwrap_or("");
    if kind != "history_frame_ack" {
        return false;
    }
    let Some(uid) = val["uid"].as_str() else {
        return true;
    };
    if let Some(f) = in_flight.remove(uid) {
        crate::capture::history::spool::Spool::remove(&f.path);
        if val["rejected"].as_bool().unwrap_or(false) {
            warn!(
                "Screen history: server rejected keyframe {uid} ({}); dropped from spool.",
                val["reason"].as_str().unwrap_or("no reason given")
            );
        }
    }
    true
}

/// Process-lifetime Recall capture state, shared with every session.
#[derive(Clone)]
pub(super) struct RecallPipeline {
    /// Durable keyframe spool the session ships from; `None` when Recall is off.
    pub(super) spool: Option<Arc<crate::capture::history::spool::Spool>>,
    /// Woken by the spool writer when a new keyframe lands.
    pub(super) notify: Arc<tokio::sync::Notify>,
    /// Capture runs only while the user is not AFK.
    pub(super) active: Arc<AtomicBool>,
    /// Epoch-ms of the last user interaction (capture cadence hint).
    pub(super) last_input: Arc<AtomicU64>,
    /// Server-pushed capture tunables.
    pub(super) settings: Arc<Mutex<crate::capture::history::HistorySettings>>,
    pub(super) enabled: bool,
}

/// Start screen-history ("Recall") capture and its spool writer, if enabled in
/// config. Any startup failure disables Recall for this process.
pub(super) fn start_recall_capture(shared_cfg: &Mutex<crate::config::Config>) -> RecallPipeline {
    // ── Screen history ("Recall") capture ─────────────────────────────────────
    // A slow, deduped keyframe pipeline independent of the demand-driven MJPEG
    // capture. Spawned once for the process lifetime; `history_active`
    // gates capture on the user being non-AFK.
    //
    // Capture never talks to the session directly. It feeds a dedicated drain
    // thread that writes every keyframe to the durable on-disk spool, and the
    // session ships frames *from the spool*, deleting each only once the server
    // acks it. That is what makes the timeline survive disconnects, reconnect
    // backoff, and agent restarts instead of silently losing those frames.
    let history_active = Arc::new(AtomicBool::new(true));
    // Epoch-ms of the last user interaction (keystroke / window switch / return from
    // AFK). The capture thread reads this to speed up while the user is actively using
    // the machine and slow down when they're not. Seed to "now" so we don't start hot.
    let history_last_input = Arc::new(AtomicU64::new(now_epoch_ms()));
    // Capture tunables, shared with the capture thread so a server push (cadence,
    // quality, or the kill switch) applies on its next tick without a restart.
    // Seeded from the cached copy so policy survives restarts and offline periods.
    let history_settings = Arc::new(Mutex::new(
        shared_cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recall_settings
            .unwrap_or_default(),
    ));
    // Depth is generous only so a brief stall in the spool writer can't make the
    // capture thread drop a keyframe; the writer just appends to disk, so it drains
    // far faster than the 6–20s capture cadence produces.
    let (history_tx, history_rx) = mpsc::channel::<crate::capture::history::HistoryFrame>(64);
    let mut history_enabled = {
        shared_cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .screen_history_enabled
    };
    // Woken by the spool writer so a freshly captured frame ships immediately
    // rather than waiting for the session's next poll tick.
    let history_notify = Arc::new(tokio::sync::Notify::new());
    let history_spool = if history_enabled {
        match crate::capture::history::spool::Spool::new(
            crate::config::screen_spool_dir(),
            crate::capture::history::spool::DEFAULT_MAX_BYTES,
        ) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                warn!("Screen history spool unavailable; disabling Recall capture: {e}");
                history_enabled = false;
                None
            }
        }
    } else {
        None
    };
    if history_enabled {
        let stop = Arc::new(AtomicBool::new(false));
        match crate::capture::history::start_history_capture(
            history_tx,
            stop,
            history_active.clone(),
            history_last_input.clone(),
            history_settings.clone(),
        ) {
            Ok(()) => info!("Screen history ('Recall') capture enabled."),
            Err(e) => {
                warn!("Screen history capture failed to start; disabling: {e}");
                history_enabled = false;
            }
        }
    }
    if history_enabled {
        // Drain capture → disk on a dedicated thread. This runs for the process
        // lifetime, independent of any session, so frames captured while offline
        // are persisted rather than dropped. Blocking file IO stays off the reactor.
        if let Some(spool) = history_spool.clone() {
            let notify = history_notify.clone();
            let mut rx = history_rx;
            if let Err(e) = std::thread::Builder::new()
                .name("screen-spool".into())
                .spawn(move || {
                    while let Some(mut frame) = rx.blocking_recv() {
                        if !frame.generation.is_some_and(|g| g.valid_fresh()) {
                            continue;
                        }
                        if let Some(c) = frame.context.as_mut() {
                            c.sanitize(frame.context_generations);
                        }
                        match spool.push(&frame) {
                            Ok(_) => notify.notify_one(),
                            Err(e) => warn!("Screen history: failed to spool keyframe: {e}"),
                        }
                    }
                    info!("Screen history: capture channel closed; spool writer exiting.");
                })
            {
                warn!("Failed to spawn screen-spool thread; disabling Recall capture: {e}");
                history_enabled = false;
            }
        }
    }
    RecallPipeline {
        enabled: history_enabled && history_spool.is_some(),
        spool: history_spool,
        notify: history_notify,
        active: history_active,
        last_input: history_last_input,
        settings: history_settings,
    }
}
