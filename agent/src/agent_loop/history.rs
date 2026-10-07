//! Shipping spooled Recall keyframes to the server and handling their acks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

/// How often the session sweeps the keyframe spool for backlog and ack timeouts.
pub(super) const HISTORY_PUMP_INTERVAL_SECS: u64 = 5;
/// Keyframes allowed on the wire without an ack. Bounded so a reconnect backlog
/// drains steadily instead of dumping thousands of frames into the socket at once
/// and starving live telemetry behind them.
const HISTORY_MAX_IN_FLIGHT: usize = 4;
/// Re-send a keyframe if the server hasn't acked it within this long.
const HISTORY_ACK_TIMEOUT: Duration = Duration::from_secs(90);
/// Magic prefix marking a binary WebSocket frame as a Recall keyframe, alongside the
/// existing `AUD\0` (audio) / bare-JPEG (MJPEG) conventions on the same socket.
/// Keep in sync with `HISTORY_FRAME_MAGIC` in `server/src/ws_agent.rs`.
const HISTORY_FRAME_MAGIC: &[u8; 4] = b"HST\0";

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
    spool: &crate::screen_spool::Spool,
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
        let mut frame = match crate::screen_spool::Spool::load(&path) {
            Ok(f) => f,
            Err(e) => {
                warn!("Screen history: dropping unreadable spool frame: {e:#}");
                crate::screen_spool::Spool::remove(&path);
                continue;
            }
        };
        if let Some(c) = frame.header.context.as_mut() {
            c.sanitize(frame.header.context_generations);
        }
        let h = &frame.header;
        if !h.generation.is_some_and(|g| g.valid_fresh()) {
            crate::screen_spool::Spool::remove(&path);
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
        crate::screen_spool::Spool::remove(&f.path);
        if val["rejected"].as_bool().unwrap_or(false) {
            warn!(
                "Screen history: server rejected keyframe {uid} ({}); dropped from spool.",
                val["reason"].as_str().unwrap_or("no reason given")
            );
        }
    }
    true
}
