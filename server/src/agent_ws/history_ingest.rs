//! Recall keyframe ingest: the `HST\0` binary frame codec, legacy base64 JSON frames,
//! blob storage under the lifecycle lease, and spool acks back to the agent.

use std::sync::Arc;

use crate::state::agent_lifecycle::{spawn_blocking_ingestion, IngestionLease};
use base64::Engine;
use tracing::{error, warn};
use uuid::Uuid;
#[cfg(test)]
use vantyr_protocol::frames::AUDIO_FRAME_MAGIC;
use vantyr_protocol::frames::HISTORY_FRAME_MAGIC;

use crate::recall::db as recall_db;
use crate::state::AppState;

/// Max decoded bytes for a single screen-history JPEG keyframe. Downscaled frames
/// are ~15–60 KB; this is a generous DoS bound well under `MAX_AGENT_TEXT_BYTES`.
const MAX_HISTORY_JPEG_BYTES: usize = 2 * 1024 * 1024;

const MAX_OCR_TEXT_CHARS: usize = 20_000;

/// Tell the agent a spooled keyframe is durably stored (or permanently unacceptable),
/// so it can delete it from its on-disk spool.
///
/// `rejected` frames are ones no retry will fix — oversized, bad base64, unwritable
/// blob. The agent drops those too: retrying forever would wedge its queue behind a
/// frame that can never land. Transient failures (DB down) are deliberately *not*
/// acked, so the agent re-sends them on its next session.
fn ack_history_frame(
    agent_id: Uuid,
    val: &serde_json::Value,
    state: &Arc<AppState>,
    rejected: Option<&str>,
) {
    let Some(uid) = val["uid"].as_str().filter(|s| !s.is_empty()) else {
        return; // Pre-spool agent; nothing to ack.
    };
    let mut ack = serde_json::json!({ "type": "history_frame_ack", "uid": uid });
    if let Some(reason) = rejected {
        ack["rejected"] = serde_json::Value::Bool(true);
        ack["reason"] = serde_json::Value::String(reason.to_string());
    }
    state.agents.try_send_agent_command_json(agent_id, &ack);
}

/// Persist a legacy JSON `history_frame` (base64 JPEG).
///
/// Superseded by the binary `HST\0` frame, which avoids base64's ~33% inflation on a
/// socket shared with live telemetry. Kept so an agent that hasn't been updated yet
/// keeps recording rather than silently losing its history.
pub(super) async fn ingest_history_frame(
    agent_id: Uuid,
    conn_id: Uuid,
    val: &serde_json::Value,
    state: &Arc<AppState>,
    lease: &IngestionLease,
) {
    let b64 = val["jpeg_b64"].as_str().unwrap_or("");
    if b64.is_empty() {
        warn!("Dropping history_frame from {agent_id}: empty jpeg_b64");
        ack_history_frame(agent_id, val, state, Some("empty jpeg"));
        return;
    }
    let jpeg = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(bytes) if bytes.len() <= MAX_HISTORY_JPEG_BYTES => bytes,
        Ok(bytes) => {
            warn!(
                "Dropping history_frame from {agent_id}: jpeg too large ({} bytes)",
                bytes.len()
            );
            ack_history_frame(agent_id, val, state, Some("jpeg too large"));
            return;
        }
        Err(e) => {
            warn!("Dropping history_frame from {agent_id}: bad base64 ({e})");
            ack_history_frame(agent_id, val, state, Some("bad base64"));
            return;
        }
    };

    store_history_frame(agent_id, conn_id, val, jpeg, state, lease).await;
}

/// Decode a binary `HST\0` keyframe and persist it.
///
/// Layout: `HST\0` + u32 LE header length + header JSON + raw JPEG bytes. This is the
/// path modern agents use; the JSON/base64 `history_frame` event above is kept so an
/// agent that hasn't been updated yet still works.
pub(super) async fn ingest_history_frame_binary(
    agent_id: Uuid,
    conn_id: Uuid,
    frame: &[u8],
    state: &Arc<AppState>,
    lease: &IngestionLease,
) {
    let (val, jpeg) = match parse_history_frame_binary(frame) {
        Ok(v) => v,
        Err(e) => {
            warn!("Dropping binary history frame from {agent_id}: {e}");
            return;
        }
    };
    if jpeg.is_empty() {
        warn!("Dropping binary history frame from {agent_id}: empty jpeg");
        ack_history_frame(agent_id, &val, state, Some("empty jpeg"));
        return;
    }
    if jpeg.len() > MAX_HISTORY_JPEG_BYTES {
        warn!(
            "Dropping binary history frame from {agent_id}: jpeg too large ({} bytes)",
            jpeg.len()
        );
        ack_history_frame(agent_id, &val, state, Some("jpeg too large"));
        return;
    }
    store_history_frame(agent_id, conn_id, &val, jpeg, state, lease).await;
}

/// Split a binary `HST\0` keyframe into its header JSON and JPEG bytes.
///
/// Pure so the wire format can be tested directly: a mismatch between this and the
/// agent's encoder would silently drop every keyframe on the floor.
pub(super) fn parse_history_frame_binary(
    frame: &[u8],
) -> Result<(serde_json::Value, Vec<u8>), &'static str> {
    const PREFIX: usize = 8; // magic + u32 header length
    if frame.len() < PREFIX {
        return Err("truncated header");
    }
    if &frame[..4] != HISTORY_FRAME_MAGIC {
        return Err("bad magic");
    }
    let hlen = u32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]) as usize;
    let hend = PREFIX
        .checked_add(hlen)
        .filter(|e| *e <= frame.len())
        .ok_or("bad header length")?;
    let val: serde_json::Value =
        serde_json::from_slice(&frame[PREFIX..hend]).map_err(|_| "bad header JSON")?;
    Ok((val, frame[hend..].to_vec()))
}

/// Write the JPEG to the blob store and insert its index row, then ack.
///
/// Shared by both wire formats so the durability semantics — at-least-once with
/// `client_uid` dedup, ack only on success, no ack on transient failure — live in one
/// place regardless of how the bytes arrived.
pub(super) async fn store_history_frame(
    agent_id: Uuid,
    conn_id: Uuid,
    val: &serde_json::Value,
    jpeg: Vec<u8>,
    state: &Arc<AppState>,
    lease: &IngestionLease,
) {
    let parsed_at = val["captured_at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));
    let client_uid = val["uid"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s.trim()).ok());
    if val.get("context").is_some_and(|v| !v.is_null())
        && (parsed_at.is_none() || client_uid.is_none())
    {
        ack_history_frame(agent_id, val, state, Some("invalid frame identity"));
        return;
    }
    // Legacy frames retain timestamp fallback; modern context never changes retry identity.
    let captured_at = parsed_at.unwrap_or_else(chrono::Utc::now);

    let monitor = val["monitor"].as_i64().unwrap_or(0) as i32;
    let w = val["w"].as_i64().unwrap_or(0) as i32;
    let h = val["h"].as_i64().unwrap_or(0) as i32;

    // u64 aHash sent as a decimal string (JS precision). Reinterpret bits as i64.
    let phash = val["phash"]
        .as_str()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0) as i64;

    // Per-word OCR geometry, when the agent produced any. Stored as-is; the shape is
    // validated by the frontend rather than re-parsed here.
    let ocr_words = val
        .get("ocr_words")
        .filter(|v| v.is_array())
        .filter(|v| !v.as_array().is_some_and(std::vec::Vec::is_empty));

    let ocr_text = val["ocr_text"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_OCR_TEXT_CHARS).collect::<String>());

    // Blob layout: <agent>/<YYYYMMDD>/<uuid>.jpg. Relative path stored in the row;
    // the on-disk path is joined against SCREEN_HISTORY_DIR at read time.
    let day = captured_at.format("%Y%m%d").to_string();
    let file = format!("{}.jpg", Uuid::new_v4());
    let rel = format!("{agent_id}/{day}/{file}");
    let dir = state
        .settings
        .screen_history_dir
        .join(agent_id.to_string())
        .join(&day);
    let path = dir.join(&file);

    // Filesystem writes are blocking; keep them off the async reactor.
    let write_res = spawn_blocking_ingestion(lease, move || {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, &jpeg)
    })
    .await;
    match write_res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            // Disk full / permissions: retrying the same frame won't help, and the
            // agent's spool is bounded, so let it move on rather than jam.
            error!("history_frame blob write failed for {agent_id}: {e}");
            ack_history_frame(agent_id, val, state, Some("blob write failed"));
            return;
        }
        Err(e) => {
            error!("history_frame blob write task panicked for {agent_id}: {e}");
            ack_history_frame(agent_id, val, state, Some("blob write panicked"));
            return;
        }
    }

    // Partition work can wait. Validate metadata only after it completes, just
    // before INSERT, while this socket's lifecycle ingestion lease is retained.
    if let Err(e) =
        recall_db::partitions::ensure_screen_frame_partition(&state.db, captured_at.date_naive())
            .await
    {
        tracing::warn!(error = %e, "Recall partition unavailable; using default");
    }
    let Some((window, browser)) = state.agents.recall_context_grants(agent_id, conn_id) else {
        let _ = tokio::fs::remove_file(state.settings.screen_history_dir.join(&rel)).await;
        return;
    };
    let metadata = crate::recall::context::sanitize(val, window, browser);
    match recall_db::frames::insert_screen_frame(
        &state.db,
        agent_id,
        captured_at,
        monitor,
        w,
        h,
        phash,
        &rel,
        ocr_text.as_deref(),
        ocr_words,
        client_uid,
        &metadata,
    )
    .await
    {
        Ok(Some(_)) => ack_history_frame(agent_id, val, state, None),
        Ok(None) => {
            // Already stored — the agent re-sent after a lost ack. The blob we just
            // wrote is a duplicate of the one the original row points at, so drop it
            // rather than leave it orphaned until the day-dir sweep.
            let dup = state.settings.screen_history_dir.join(&rel);
            let _ = tokio::fs::remove_file(dup).await;
            ack_history_frame(agent_id, val, state, None);
        }
        Err(e) => {
            // Transient (DB down / lock contention): do NOT ack, so the agent keeps
            // the frame spooled and re-sends it later.
            error!("insert_screen_frame failed for {agent_id}: {e}");
            // Orphaned blob: cheap to leave; retention's day-dir sweep reclaims it.
        }
    }
}

#[cfg(test)]
#[cfg(test)]
mod history_frame_wire_tests {
    use super::*;

    /// Build a frame exactly the way `agent/src/agent_loop.rs::pump_history_spool`
    /// does. If the two encoders drift apart, these tests fail rather than the fleet
    /// silently losing its screen history.
    fn encode(header: &serde_json::Value, jpeg: &[u8]) -> Vec<u8> {
        let hb = serde_json::to_vec(header).unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(HISTORY_FRAME_MAGIC);
        out.extend_from_slice(&(hb.len() as u32).to_le_bytes());
        out.extend_from_slice(&hb);
        out.extend_from_slice(jpeg);
        out
    }

    fn sample_header() -> serde_json::Value {
        serde_json::json!({
            "uid": "3f1a9c62-0000-4000-8000-000000000001",
            "captured_at": "2026-08-08T01:23:45+00:00",
            "monitor": 1,
            "w": 1600,
            "h": 900,
            "phash": u64::MAX.to_string(),
            "ocr_text": "hello world",
        })
    }

    #[test]
    fn round_trips_header_and_jpeg() {
        let jpeg: Vec<u8> = (0..=255u8).cycle().take(5000).collect();
        let frame = encode(&sample_header(), &jpeg);
        let (val, out) = parse_history_frame_binary(&frame).unwrap();

        assert_eq!(out, jpeg, "JPEG bytes must survive framing exactly");
        assert_eq!(val["monitor"].as_i64(), Some(1));
        assert_eq!(val["w"].as_i64(), Some(1600));
        assert_eq!(val["ocr_text"].as_str(), Some("hello world"));
        // The u64 aHash must survive as a string — a JSON number would lose bits.
        assert_eq!(val["phash"].as_str(), Some(u64::MAX.to_string().as_str()));
    }

    #[test]
    fn binary_framing_is_smaller_than_base64_json() {
        // The whole point of the format: no ~33% inflation on a shared socket.
        let jpeg: Vec<u8> = (0..=255u8).cycle().take(40_000).collect();
        let binary = encode(&sample_header(), &jpeg).len();
        let legacy = serde_json::json!({
            "type": "history_frame",
            "uid": sample_header()["uid"],
            "captured_at": sample_header()["captured_at"],
            "monitor": 1, "w": 1600, "h": 900,
            "phash": u64::MAX.to_string(),
            "jpeg_b64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
            "ocr_text": "hello world",
        })
        .to_string()
        .len();
        assert!(
            binary < legacy,
            "binary framing ({binary}B) should beat base64 JSON ({legacy}B)"
        );
        // Base64 is 4/3 of the payload, so the saving should be roughly a quarter.
        assert!(legacy - binary > jpeg.len() / 4);
    }

    #[test]
    fn empty_jpeg_parses_but_yields_no_bytes() {
        // Parsing succeeds; the caller is what rejects and acks it.
        let frame = encode(&sample_header(), &[]);
        let (_, out) = parse_history_frame_binary(&frame).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn rejects_wrong_magic() {
        let mut frame = encode(&sample_header(), &[1, 2, 3]);
        frame[..4].copy_from_slice(AUDIO_FRAME_MAGIC);
        assert_eq!(parse_history_frame_binary(&frame), Err("bad magic"));
    }

    #[test]
    fn rejects_truncated_and_overlong_headers() {
        assert_eq!(
            parse_history_frame_binary(b"HST\0"),
            Err("truncated header")
        );
        // Header length pointing past the end of the buffer must not panic.
        let mut frame = encode(&sample_header(), &[1, 2, 3]);
        frame[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_history_frame_binary(&frame), Err("bad header length"));
    }

    #[test]
    fn rejects_malformed_header_json() {
        let mut out = Vec::new();
        out.extend_from_slice(HISTORY_FRAME_MAGIC);
        out.extend_from_slice(&5u32.to_le_bytes());
        out.extend_from_slice(b"{not!");
        out.extend_from_slice(&[0xFF, 0xD8]);
        assert_eq!(parse_history_frame_binary(&out), Err("bad header JSON"));
    }

    #[test]
    fn a_jpeg_starting_with_other_magics_is_not_confused() {
        // Guard the dispatch convention: a Recall frame is identified by its own
        // prefix, and arbitrary JPEG payload bytes inside it can't re-trigger it.
        let jpeg = b"HST\0AUD\0 arbitrary payload".to_vec();
        let frame = encode(&sample_header(), &jpeg);
        let (_, out) = parse_history_frame_binary(&frame).unwrap();
        assert_eq!(out, jpeg);
    }
}

#[cfg(test)]
mod recall_context_tests;
