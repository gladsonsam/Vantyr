//! Browsing an agent's frames: keyset pages, the frame at an instant, the activity
//! histogram, and the day/monitor/device pickers.

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Frame metadata (no blob) as listed by the timeline and search endpoints.
#[derive(Debug, Serialize)]
pub struct FrameMeta {
    pub id: i64,
    pub captured_at: DateTime<Utc>,
    pub monitor: i32,
    pub w: i32,
    pub h: i32,
    /// The u64 aHash as a JS-safe decimal string (see the module docs).
    pub phash: String,
    pub has_ocr: bool,
    pub context: Option<serde_json::Value>,
    pub capture_duration_ms: Option<i32>,
    /// Search hits only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<f32>,
    /// Search hits only: `ts_headline` with `[[[`/`]]]` around matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// One frame row as selected by the timeline queries (and, flattened, by search).
#[derive(sqlx::FromRow)]
pub(super) struct FrameRow {
    pub(super) id: i64,
    pub(super) captured_at: DateTime<Utc>,
    monitor: i32,
    w: i32,
    h: i32,
    phash: i64,
    capture_context: Option<serde_json::Value>,
    capture_duration_ms: Option<i32>,
    has_ocr: Option<bool>,
}

impl FrameRow {
    pub(super) fn into_meta(self) -> FrameMeta {
        FrameMeta {
            id: self.id,
            captured_at: self.captured_at,
            monitor: self.monitor,
            w: self.w,
            h: self.h,
            // Reverse the u64→i64 bit reinterpretation and hand back a JS-safe string.
            phash: (self.phash as u64).to_string(),
            has_ocr: self.has_ocr.unwrap_or(false),
            context: self.capture_context,
            capture_duration_ms: self.capture_duration_ms,
            rank: None,
            snippet: None,
        }
    }
}

/// Frame metadata (no blob) for one agent over a time range, oldest-first (timelapse order).
///
/// `monitor` selects a single display; `None` returns every monitor's frames
/// interleaved. Filtering matters on multi-head machines: the agent captures each
/// monitor independently, so an unfiltered timelapse cuts between two different
/// screens on alternating frames.
#[allow(dead_code)] // Preserve the existing DB facade for callers that only need the first page.
pub async fn list_screen_frames(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    limit: i64,
) -> Result<Vec<FrameMeta>> {
    Ok(
        list_screen_frames_page(pool, agent_id, from, to, monitor, limit, None)
            .await?
            .items,
    )
}

/// Exact keyset position, read directly from PostgreSQL (including its float4 rank).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScreenFramePosition {
    pub captured_at: DateTime<Utc>,
    pub id: i64,
    pub rank: Option<f32>,
}

pub struct ScreenFramePage {
    pub items: Vec<FrameMeta>,
    pub next: Option<ScreenFramePosition>,
}

/// Truncate `limit + 1` keyset rows to a page; the extra row only signals `next`.
pub(super) fn frame_page<R>(
    mut rows: Vec<R>,
    limit: i64,
    position: impl Fn(&R) -> ScreenFramePosition,
    meta: impl Fn(R) -> FrameMeta,
) -> ScreenFramePage {
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if has_more {
        rows.last().map(&position)
    } else {
        None
    };
    let items = rows.into_iter().map(meta).collect();
    ScreenFramePage { items, next }
}

/// Oldest-first keyset page, with one extra row to detect truncation accurately.
#[allow(clippy::too_many_arguments)]
pub async fn list_screen_frames_page(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    limit: i64,
    after: Option<&ScreenFramePosition>,
) -> Result<ScreenFramePage> {
    let limit = limit.clamp(1, 5_000);
    let rows = sqlx::query_as!(
        FrameRow,
        "SELECT id, captured_at, monitor, w, h, phash, capture_context, capture_duration_ms, \
     (ocr_text IS NOT NULL AND length(ocr_text) > 0) AS has_ocr FROM screen_frames
         WHERE agent_id = $1 AND captured_at >= $2 AND captured_at <= $3
           AND ($4::int IS NULL OR monitor = $4::int)
           AND ($6::timestamptz IS NULL OR (captured_at, id) > ($6, $7))
         ORDER BY captured_at ASC, id ASC LIMIT $5",
        agent_id,
        from,
        to,
        monitor,
        limit + 1,
        after.map(|p| p.captured_at),
        after.map(|p| p.id),
    )
    .fetch_all(pool)
    .await?;
    Ok(frame_page(
        rows,
        limit,
        |r| ScreenFramePosition {
            captured_at: r.captured_at,
            id: r.id,
            rank: None,
        },
        FrameRow::into_meta,
    ))
}

/// The frame at-or-before `at` (nearest earlier); falls back to the nearest later
/// frame so scrubbing to an empty edge still lands on something. `None` if the
/// agent has no frames at all.
pub async fn screen_frame_at(
    pool: &PgPool,
    agent_id: Uuid,
    at: DateTime<Utc>,
    monitor: Option<i32>,
) -> Result<Option<FrameMeta>> {
    if let Some(r) = sqlx::query_as!(
        FrameRow,
        "SELECT id, captured_at, monitor, w, h, phash, capture_context, capture_duration_ms, \
     (ocr_text IS NOT NULL AND length(ocr_text) > 0) AS has_ocr
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at <= $2
           AND ($3::int IS NULL OR monitor = $3::int)
         ORDER BY captured_at DESC, id DESC
         LIMIT 1",
        agent_id,
        at,
        monitor,
    )
    .fetch_optional(pool)
    .await?
    {
        return Ok(Some(r.into_meta()));
    }
    let after = sqlx::query_as!(
        FrameRow,
        "SELECT id, captured_at, monitor, w, h, phash, capture_context, capture_duration_ms, \
     (ocr_text IS NOT NULL AND length(ocr_text) > 0) AS has_ocr
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at > $2
           AND ($3::int IS NULL OR monitor = $3::int)
         ORDER BY captured_at ASC, id ASC
         LIMIT 1",
        agent_id,
        at,
        monitor,
    )
    .fetch_optional(pool)
    .await?;
    Ok(after.map(FrameRow::into_meta))
}

/// One non-empty bucket of [`screen_frame_activity`].
#[derive(Debug, Serialize)]
pub struct ActivityPoint {
    /// Bucket start (unix seconds).
    pub t: i64,
    pub count: i64,
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
    monitor: Option<i32>,
    bucket_secs: i64,
) -> Result<Vec<ActivityPoint>> {
    let bucket = bucket_secs.max(1);
    // `$4::bigint` keeps the bucket an int8 parameter, as the runtime bind declared it.
    let rows = sqlx::query!(
        "SELECT
           (floor(extract(epoch from captured_at) / $4::bigint) * $4::bigint)::bigint AS t,
           count(*) AS c
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at >= $2 AND captured_at <= $3
           AND ($5::int IS NULL OR monitor = $5::int)
         GROUP BY t
         ORDER BY t",
        agent_id,
        from,
        to,
        bucket,
        monitor,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ActivityPoint {
            t: r.t.unwrap_or(0),
            count: r.c.unwrap_or(0),
        })
        .collect())
}

/// How far back the device picker looks for "has any Recall history".
///
/// Bounded on purpose: an unbounded `SELECT DISTINCT agent_id` scans *every* day
/// partition on every page load, and this is the highest-cardinality table in the
/// schema. A predicate on the partition key lets Postgres prune to recent
/// partitions instead. An agent with nothing in this window has nothing worth
/// scrubbing anyway.
const DEVICE_LIST_LOOKBACK_DAYS: i64 = 30;

/// Distinct agent ids that recorded at least one screen-history frame recently. Used
/// to filter the Recall device picker down to agents that actually have history,
/// rather than every enrolled fleet agent.
pub async fn list_agents_with_screen_history(pool: &PgPool) -> Result<Vec<Uuid>> {
    let since = Utc::now() - Duration::days(DEVICE_LIST_LOOKBACK_DAYS);
    let ids: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT DISTINCT agent_id FROM screen_frames WHERE captured_at >= $1",
        since
    )
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// One local day with Recall coverage (`days[]` of `GET /agents/:id/history/days`).
#[derive(Debug, Serialize)]
pub struct CoverageDay {
    /// `YYYY-MM-DD` in the agent's zone.
    pub day: Option<String>,
    pub frame_count: i64,
    pub first_ts: Option<DateTime<Utc>>,
    pub last_ts: Option<DateTime<Utc>>,
    pub has_summary: bool,
}

/// Which local days have Recall coverage, with per-day frame counts and bounds.
///
/// The date picker was previously blind: an operator had to guess which days held
/// anything and step through empties one at a time. Days are bucketed in `tz` (the
/// agent's zone) so they line up exactly with the day the segments/summary endpoints
/// return, and `has_summary` says whether a narrative has been derived yet.
pub async fn screen_frame_days(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    tz: &str,
) -> Result<Vec<CoverageDay>> {
    let rows = sqlx::query!(
        "WITH d AS (
           SELECT (sf.captured_at AT TIME ZONE $4)::date AS day,
                  count(*)          AS frame_count,
                  min(sf.captured_at) AS first_ts,
                  max(sf.captured_at) AS last_ts
           FROM screen_frames sf
           WHERE sf.agent_id = $1 AND sf.captured_at >= $2 AND sf.captured_at <= $3
           GROUP BY 1
         )
         SELECT d.day, d.frame_count, d.first_ts, d.last_ts,
                (ds.narrative IS NOT NULL AND length(ds.narrative) > 0) AS has_summary
         FROM d
         LEFT JOIN day_summaries ds ON ds.agent_id = $1 AND ds.day = d.day
         ORDER BY d.day",
        agent_id,
        from,
        to,
        tz
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| CoverageDay {
            day: r.day.map(|d| d.to_string()),
            frame_count: r.frame_count.unwrap_or(0),
            first_ts: r.first_ts,
            last_ts: r.last_ts,
            has_summary: r.has_summary.unwrap_or(false),
        })
        .collect())
}

/// One display recorded in a range (`monitors[]` of `GET /agents/:id/history/monitors`).
#[derive(Debug, Serialize)]
pub struct RecordedMonitor {
    pub monitor: i32,
    pub frame_count: i64,
    pub w: i32,
    pub h: i32,
}

/// Monitors this agent actually recorded in `[from, to]`, with frame counts.
///
/// Drives the display picker: a machine that grew a second screen last week should
/// only offer that screen for ranges where it exists, and a single-monitor machine
/// should not show a picker at all.
pub async fn screen_frame_monitors(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<RecordedMonitor>> {
    let rows = sqlx::query!(
        "SELECT monitor, count(*) AS c, max(w) AS w, max(h) AS h
         FROM screen_frames
         WHERE agent_id = $1 AND captured_at >= $2 AND captured_at <= $3
         GROUP BY monitor
         ORDER BY monitor",
        agent_id,
        from,
        to
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| RecordedMonitor {
            monitor: r.monitor,
            frame_count: r.c.unwrap_or(0),
            w: r.w.unwrap_or(0),
            h: r.h.unwrap_or(0),
        })
        .collect())
}
