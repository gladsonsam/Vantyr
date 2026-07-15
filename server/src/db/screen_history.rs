//! Screen-history ("Recall") frame index + day-partition management + retention.
//!
//! The JPEG bytes live in a filesystem blob store (`SCREEN_HISTORY_DIR`); this
//! module owns only the Postgres *index* rows (`screen_frames`, partitioned by
//! day) and the on-demand creation / DROP of those day partitions.
//!
//! `phash` is a `u64` aHash. Postgres has no unsigned 64-bit type, so it is stored
//! as the same 64 bits reinterpreted as `i64` (`u64 as i64`) and reversed on read.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use chrono::{Datelike, Duration, NaiveDate};

use super::*;

/// Partitions this process has already ensured exist (keyed by proleptic-Gregorian
/// day number) so we run the `CREATE TABLE … PARTITION OF` DDL at most once per day.
fn ensured_partitions() -> &'static Mutex<HashSet<i32>> {
    static S: OnceLock<Mutex<HashSet<i32>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Create the day partition covering `day` (UTC) if it does not already exist.
///
/// Idempotent and cheap after the first call per day (in-memory guard). A failure
/// here is non-fatal: the parent's DEFAULT partition still accepts the insert.
pub async fn ensure_screen_frame_partition(pool: &PgPool, day: NaiveDate) -> Result<()> {
    let key = day.num_days_from_ce();
    if ensured_partitions().lock().unwrap().contains(&key) {
        return Ok(());
    }
    let end = day.succ_opt().unwrap_or(day);
    let name = format!("screen_frames_{}", day.format("%Y%m%d"));
    // Bounds are explicit UTC so they line up with the UTC `captured_at` values,
    // independent of the session TimeZone. Values are server-generated (date only),
    // never user input, so the format!-built DDL carries no injection surface.
    let ddl = format!(
        "CREATE TABLE IF NOT EXISTS {name} PARTITION OF screen_frames \
         FOR VALUES FROM ('{} 00:00:00+00') TO ('{} 00:00:00+00')",
        day.format("%Y-%m-%d"),
        end.format("%Y-%m-%d"),
    );
    sqlx::query(&ddl).execute(pool).await?;
    ensured_partitions().lock().unwrap().insert(key);
    Ok(())
}

/// Insert one keyframe index row; returns the new global frame id.
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
) -> Result<i64> {
    // Ensure the day partition first; ignore errors (DEFAULT partition is the fallback).
    if let Err(e) = ensure_screen_frame_partition(pool, captured_at.date_naive()).await {
        tracing::warn!(error = %e, "ensure_screen_frame_partition failed; using DEFAULT partition");
    }
    // ocr_tsv is computed here (not a generated column) since to_tsvector is only STABLE.
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO screen_frames
           (agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('english', coalesce($8, '')))
         RETURNING id",
    )
    .bind(agent_id)
    .bind(captured_at)
    .bind(monitor)
    .bind(w)
    .bind(h)
    .bind(phash)
    .bind(blob_ref)
    .bind(ocr_text)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

fn frame_meta_json(r: &sqlx::postgres::PgRow) -> serde_json::Value {
    let phash_i: i64 = r.try_get("phash").unwrap_or(0);
    serde_json::json!({
        "id": r.try_get::<i64, _>("id").unwrap_or(0),
        "captured_at": r.try_get::<DateTime<Utc>, _>("captured_at").ok(),
        "monitor": r.try_get::<i32, _>("monitor").unwrap_or(0),
        "w": r.try_get::<i32, _>("w").unwrap_or(0),
        "h": r.try_get::<i32, _>("h").unwrap_or(0),
        // Reverse the u64→i64 bit reinterpretation and hand back a JS-safe string.
        "phash": (phash_i as u64).to_string(),
        "has_ocr": r.try_get::<bool, _>("has_ocr").unwrap_or(false),
    })
}

const FRAME_META_COLS: &str =
    "id, captured_at, monitor, w, h, phash, \
     (ocr_text IS NOT NULL AND length(ocr_text) > 0) AS has_ocr";

/// Frame metadata (no blob) for one agent over a time range, oldest-first (timelapse order).
pub async fn list_screen_frames(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<serde_json::Value>> {
    let sql = format!(
        "SELECT {FRAME_META_COLS}
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at >= $2 AND captured_at <= $3
         ORDER BY captured_at ASC
         LIMIT $4"
    );
    let rows = sqlx::query(&sql)
        .bind(agent_id)
        .bind(from)
        .bind(to)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(frame_meta_json).collect())
}

/// The frame at-or-before `at` (nearest earlier); falls back to the nearest later
/// frame so scrubbing to an empty edge still lands on something. `None` if the
/// agent has no frames at all.
pub async fn screen_frame_at(
    pool: &PgPool,
    agent_id: Uuid,
    at: DateTime<Utc>,
) -> Result<Option<serde_json::Value>> {
    let before_sql = format!(
        "SELECT {FRAME_META_COLS}
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at <= $2
         ORDER BY captured_at DESC
         LIMIT 1"
    );
    if let Some(r) = sqlx::query(&before_sql)
        .bind(agent_id)
        .bind(at)
        .fetch_optional(pool)
        .await?
    {
        return Ok(Some(frame_meta_json(&r)));
    }
    let after_sql = format!(
        "SELECT {FRAME_META_COLS}
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at > $2
         ORDER BY captured_at ASC
         LIMIT 1"
    );
    let after = sqlx::query(&after_sql)
        .bind(agent_id)
        .bind(at)
        .fetch_optional(pool)
        .await?;
    Ok(after.as_ref().map(frame_meta_json))
}

/// Interactivity histogram: keyframe count per time bucket over `[from, to]`.
/// Because near-duplicate frames are dropped at capture and cadence speeds up during
/// active use, frame density is a good proxy for "how interactive was the machine".
/// Returns `{ t: bucket-start epoch secs, count }`, oldest-first, only non-empty buckets.
pub async fn screen_frame_activity(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_secs: i64,
) -> Result<Vec<serde_json::Value>> {
    let bucket = bucket_secs.max(1);
    let rows = sqlx::query(
        "SELECT
           (floor(extract(epoch from captured_at) / $4) * $4)::bigint AS t,
           count(*) AS c
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at >= $2 AND captured_at <= $3
         GROUP BY t
         ORDER BY t",
    )
    .bind(agent_id)
    .bind(from)
    .bind(to)
    .bind(bucket)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "t": r.try_get::<i64, _>("t").unwrap_or(0),
                "count": r.try_get::<i64, _>("c").unwrap_or(0),
            })
        })
        .collect())
}

/// Full-text search over one agent's OCR'd keyframes in a time range, ranked by
/// relevance. Each hit carries a highlighted `snippet` (`ts_headline`). Empty or
/// stop-word-only queries match nothing (the caller should reject blank input).
pub async fn search_screen_frames(
    pool: &PgPool,
    agent_id: Uuid,
    query: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT
           sf.id, sf.captured_at, sf.monitor, sf.w, sf.h, sf.phash,
           (sf.ocr_text IS NOT NULL AND length(sf.ocr_text) > 0) AS has_ocr,
           ts_rank(sf.ocr_tsv, q) AS rank,
           ts_headline('english', coalesce(sf.ocr_text, ''), q,
             'StartSel=[[[, StopSel=]]], MaxWords=14, MinWords=4, ShortWord=2, MaxFragments=1') AS snippet
         FROM screen_frames sf, websearch_to_tsquery('english', $2) q
         WHERE sf.agent_id = $1
           AND sf.captured_at >= $3 AND sf.captured_at <= $4
           AND sf.ocr_tsv @@ q
         ORDER BY rank DESC, sf.captured_at DESC
         LIMIT $5",
    )
    .bind(agent_id)
    .bind(query)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let phash_i: i64 = r.try_get("phash").unwrap_or(0);
            serde_json::json!({
                "id": r.try_get::<i64, _>("id").unwrap_or(0),
                "captured_at": r.try_get::<DateTime<Utc>, _>("captured_at").ok(),
                "monitor": r.try_get::<i32, _>("monitor").unwrap_or(0),
                "w": r.try_get::<i32, _>("w").unwrap_or(0),
                "h": r.try_get::<i32, _>("h").unwrap_or(0),
                "phash": (phash_i as u64).to_string(),
                "has_ocr": r.try_get::<bool, _>("has_ocr").unwrap_or(false),
                "rank": r.try_get::<f32, _>("rank").unwrap_or(0.0),
                "snippet": r.try_get::<String, _>("snippet").unwrap_or_default(),
            })
        })
        .collect())
}

/// The blob path (relative to `SCREEN_HISTORY_DIR`) for a frame owned by `agent_id`.
/// Scoped by agent so the blob endpoint can't be used to enumerate other agents' frames.
pub async fn screen_frame_blob_ref(
    pool: &PgPool,
    agent_id: Uuid,
    id: i64,
) -> Result<Option<String>> {
    let v: Option<String> =
        sqlx::query_scalar("SELECT blob_ref FROM screen_frames WHERE id = $1 AND agent_id = $2")
            .bind(id)
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    Ok(v)
}

/// Distinct agent ids that have recorded at least one screen-history frame. Used to
/// filter the Recall device picker down to agents that actually have history, rather
/// than every enrolled fleet agent.
pub async fn list_agents_with_screen_history(pool: &PgPool) -> Result<Vec<Uuid>> {
    let ids: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT agent_id FROM screen_frames")
        .fetch_all(pool)
        .await?;
    Ok(ids)
}

/// Delete a single frame row whose blob file is missing on disk (orphaned by a prior
/// retention run that dropped the blob dir but failed to drop the DB partition). Called
/// from `history_blob` on a disk-read miss so orphans self-heal on next access instead
/// of 404ing forever.
pub async fn delete_orphaned_screen_frame(pool: &PgPool, agent_id: Uuid, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM screen_frames WHERE id = $1 AND agent_id = $2")
        .bind(id)
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Retention: DROP whole day partitions (and delete their blob dirs) older than
/// `days`. Instant compared with the row-by-row DELETE the other heaps use.
pub async fn prune_screen_history(pool: &PgPool, blob_dir: &Path, days: i64) -> Result<()> {
    let cutoff = (Utc::now() - Duration::days(days)).date_naive();

    // Enumerate this parent's day partitions by their `screen_frames_YYYYMMDD` name.
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname = 'screen_frames'
           AND c.relname ~ '^screen_frames_[0-9]{8}$'",
    )
    .fetch_all(pool)
    .await?;

    let mut dropped = 0u64;
    let mut dropped_days: Vec<NaiveDate> = Vec::new();
    for name in names {
        let Some(datestr) = name.strip_prefix("screen_frames_") else {
            continue;
        };
        let Ok(day) = NaiveDate::parse_from_str(datestr, "%Y%m%d") else {
            continue;
        };
        if day >= cutoff {
            continue;
        }
        // Partition name is derived from a validated `NaiveDate`, not user input.
        if let Err(e) = sqlx::query(&format!("DROP TABLE IF EXISTS {name}"))
            .execute(pool)
            .await
        {
            tracing::warn!(error = %e, partition = %name, "failed to drop screen_frames partition");
            continue;
        }
        ensured_partitions().lock().unwrap().remove(&day.num_days_from_ce());
        dropped += 1;
        dropped_days.push(day);
    }
    if dropped > 0 {
        tracing::info!(partitions = dropped, "dropped old screen_frames day-partitions");
    }

    // Only remove blob dirs for days whose DB partition drop actually succeeded above —
    // otherwise a failed DROP TABLE (lock contention, etc.) leaves rows referencing
    // blobs we just deleted, and `history_blob` 404s on them forever.
    prune_screen_history_blobs(blob_dir, &dropped_days);

    // Derived narrative rows reference frames that are now gone — prune them to match.
    if let Err(e) = super::prune_narrative_before(pool, cutoff).await {
        tracing::warn!(error = %e, "failed to prune derived narrative rows");
    }
    Ok(())
}

/// Remove `SCREEN_HISTORY_DIR/<agent>/<YYYYMMDD>/` directories for days in `dropped_days`
/// (the day partitions we just confirmed were dropped from the DB). Best-effort: a delete
/// failure logs and moves on. Blob layout is written by `ws_agent` ingest as
/// `<agent>/<YYYYMMDD>/<uuid>.jpg`.
fn prune_screen_history_blobs(blob_dir: &Path, dropped_days: &[NaiveDate]) {
    if dropped_days.is_empty() {
        return;
    }
    let Ok(agents) = std::fs::read_dir(blob_dir) else {
        return;
    };
    for agent_entry in agents.flatten() {
        let agent_path = agent_entry.path();
        if !agent_path.is_dir() {
            continue;
        }
        let Ok(days) = std::fs::read_dir(&agent_path) else {
            continue;
        };
        for day_entry in days.flatten() {
            let day_path = day_entry.path();
            if !day_path.is_dir() {
                continue;
            }
            let Some(name) = day_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Ok(day) = NaiveDate::parse_from_str(name, "%Y%m%d") else {
                continue;
            };
            if dropped_days.contains(&day) {
                if let Err(e) = std::fs::remove_dir_all(&day_path) {
                    tracing::warn!(error = %e, dir = %day_path.display(), "failed to remove old screen-history blob dir");
                }
            }
        }
    }
}
