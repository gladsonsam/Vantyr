//! Frame index rows: the ingest insert and single-frame reads/cleanup.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Insert one keyframe index row.
///
/// Returns `Some(id)` for a newly stored frame, or `None` when `client_uid` matches
/// a frame already stored — the agent re-sent it because an ack was lost. Callers
/// treat `None` as success (and should delete the now-redundant blob they just
/// wrote), since the frame *is* durably persisted either way.
#[allow(clippy::too_many_arguments)]
pub async fn insert_screen_frame(
    pool: &PgPool,
    agent_id: Uuid,
    captured_at: DateTime<Utc>,
    monitor: i32,
    w: i32,
    h: i32,
    phash: i64,
    blob_ref: &str,
    ocr_text: Option<&str>,
    ocr_words: Option<&serde_json::Value>,
    client_uid: Option<Uuid>,
    metadata: &crate::recall::context::Metadata,
) -> Result<Option<i64>> {
    // ocr_tsv is computed here (not a generated column) since to_tsvector is only STABLE.
    // ON CONFLICT makes the agent's at-least-once retry idempotent (migration 0063).
    let id: Option<i64> = sqlx::query_scalar!(
        "INSERT INTO screen_frames
           (agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv,
            client_uid, ocr_words, capture_duration_ms, capture_context, context_app, context_title, context_url_host)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('english', coalesce($8, '')), $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (agent_id, captured_at, client_uid) DO NOTHING
         RETURNING id",
        agent_id,
        captured_at,
        monitor,
        w,
        h,
        phash,
        blob_ref,
        ocr_text,
        client_uid,
        ocr_words,
        metadata.duration_ms,
        metadata.context,
        metadata.app,
        metadata.title,
        metadata.host,
    )
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// OCR text and word boxes of one frame (`GET /agents/:id/history/text/:frame_id`).
#[derive(Debug, Serialize)]
pub struct FrameText {
    pub text: Option<String>,
    /// Agent-reported word geometry (`[]` when the frame has none).
    pub words: serde_json::Value,
}

/// OCR text plus per-word geometry for one frame owned by `agent_id`.
///
/// Fetched on demand for the frame currently on screen rather than included in the
/// range listing: a 3000-frame scrub would otherwise carry every word box on every
/// frame, which dwarfs the metadata it's attached to.
pub async fn screen_frame_text(
    pool: &PgPool,
    agent_id: Uuid,
    id: i64,
) -> Result<Option<FrameText>> {
    let row = sqlx::query!(
        "SELECT ocr_text, ocr_words FROM screen_frames WHERE id = $1 AND agent_id = $2",
        id,
        agent_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| FrameText {
        text: r.ocr_text,
        words: r.ocr_words.unwrap_or_else(|| serde_json::json!([])),
    }))
}

/// The blob path (relative to `SCREEN_HISTORY_DIR`) for a frame owned by `agent_id`.
/// Scoped by agent so the blob endpoint can't be used to enumerate other agents' frames.
pub async fn screen_frame_blob_ref(
    pool: &PgPool,
    agent_id: Uuid,
    id: i64,
) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar!(
        "SELECT blob_ref FROM screen_frames WHERE id = $1 AND agent_id = $2",
        id,
        agent_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(v)
}

/// Delete a single frame row whose blob file is missing on disk (orphaned by a prior
/// retention run that dropped the blob dir but failed to drop the DB partition). Called
/// from `history_blob` on a disk-read miss so orphans self-heal on next access instead
/// of 404ing forever.
pub async fn delete_orphaned_screen_frame(pool: &PgPool, agent_id: Uuid, id: i64) -> Result<()> {
    sqlx::query!(
        "DELETE FROM screen_frames WHERE id = $1 AND agent_id = $2",
        id,
        agent_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
