//! Derived screen-history narrative persistence: `activity_segments` + `day_summaries`.
//!
//! The worker (`crate::recall::narrative`) computes these from `window_events` +
//! `url_visits` + `screen_frames`; this module owns the reads/writes and the
//! idempotent per-(agent, day) rebuild.

use chrono::NaiveDate;

use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

/// A window-focus row for the day (oldest-first), used to segment activity.
#[derive(Debug, Clone)]
pub struct FocusRow {
    pub ts: DateTime<Utc>,
    pub app: String,
    pub title: String,
}

/// One activity segment to persist (worker output).
#[derive(Debug, Clone)]
pub struct SegmentInput {
    pub start_ts: DateTime<Utc>,
    pub end_ts: DateTime<Utc>,
    pub category: String,
    pub app: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub distraction_score: f32,
    pub source: String,
}

/// Distinct agents with at least one keyframe in `[from, to)` — the set to summarize.
pub async fn agents_with_frames_between(
    pool: &PgPool,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Uuid>> {
    let ids: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT DISTINCT agent_id FROM screen_frames WHERE captured_at >= $1 AND captured_at < $2",
        from,
        to
    )
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// Window-focus events for one agent in `[from, to)`, oldest-first.
pub async fn window_events_for_range(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<FocusRow>> {
    Ok(sqlx::query_as!(
        FocusRow,
        "SELECT ts, app, title FROM window_events
         WHERE agent_id = $1 AND ts >= $2 AND ts < $3
         ORDER BY ts ASC",
        agent_id,
        from,
        to
    )
    .fetch_all(pool)
    .await?)
}

/// Idempotently replace one day's segments for an agent (delete-then-insert in a tx).
pub async fn replace_activity_segments(
    pool: &PgPool,
    agent_id: Uuid,
    day_start: DateTime<Utc>,
    day_end: DateTime<Utc>,
    segments: &[SegmentInput],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "DELETE FROM activity_segments
         WHERE agent_id = $1 AND start_ts >= $2 AND start_ts < $3",
        agent_id,
        day_start,
        day_end
    )
    .execute(&mut *tx)
    .await?;

    for s in segments {
        sqlx::query!(
            "INSERT INTO activity_segments
               (agent_id, start_ts, end_ts, category, app, title, summary, distraction_score, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            agent_id,
            s.start_ts,
            s.end_ts,
            &s.category,
            s.app.as_deref(),
            s.title.as_deref(),
            s.summary.as_deref(),
            s.distraction_score,
            &s.source
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// What the worker needs to decide whether a day is worth rebuilding.
#[derive(Debug, Clone, Default)]
pub struct DaySummaryState {
    /// Fingerprint of the segments the stored summary was built from.
    pub content_hash: Option<String>,
    /// Day is over and has had its final summarization pass.
    pub finalized: bool,
    /// Whether a narrative is stored at all.
    pub has_narrative: bool,
}

/// Incremental-rebuild state for one (agent, day). Absent row => never summarized.
pub async fn day_summary_state(
    pool: &PgPool,
    agent_id: Uuid,
    day: NaiveDate,
) -> Result<Option<DaySummaryState>> {
    let row = sqlx::query!(
        "SELECT content_hash, finalized,
                (narrative IS NOT NULL AND length(narrative) > 0) AS has_narrative
         FROM day_summaries WHERE agent_id = $1 AND day = $2",
        agent_id,
        day
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| DaySummaryState {
        content_hash: r.content_hash,
        finalized: r.finalized,
        has_narrative: r.has_narrative.unwrap_or(false),
    }))
}

/// Fields written by one summarization pass.
pub struct DaySummaryWrite<'a> {
    pub agent_id: Uuid,
    pub day: NaiveDate,
    pub narrative: &'a str,
    pub totals: &'a serde_json::Value,
    pub top_apps: &'a serde_json::Value,
    pub highlights: &'a serde_json::Value,
    pub source: &'a str,
    pub content_hash: &'a str,
    /// `true` once the day is over and this is its last pass.
    pub finalized: bool,
}

/// Upsert the per-day summary for an agent.
pub async fn upsert_day_summary(pool: &PgPool, w: DaySummaryWrite<'_>) -> Result<()> {
    sqlx::query!(
        "INSERT INTO day_summaries
           (agent_id, day, narrative, totals, top_apps, highlights, source,
            content_hash, finalized, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (agent_id, day) DO UPDATE SET
           narrative = EXCLUDED.narrative,
           totals = EXCLUDED.totals,
           top_apps = EXCLUDED.top_apps,
           highlights = EXCLUDED.highlights,
           source = EXCLUDED.source,
           content_hash = EXCLUDED.content_hash,
           finalized = EXCLUDED.finalized,
           updated_at = NOW()",
        w.agent_id,
        w.day,
        w.narrative,
        w.totals,
        w.top_apps,
        w.highlights,
        w.source,
        w.content_hash,
        w.finalized
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One stored activity segment (`segments[]` of the day view).
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ActivitySegment {
    pub id: i64,
    pub start_ts: DateTime<Utc>,
    pub end_ts: DateTime<Utc>,
    pub category: String,
    pub app: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub distraction_score: f32,
    pub source: String,
}

/// Segments for one agent within `[from, to)`, oldest-first (for the day view).
pub async fn list_activity_segments(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<ActivitySegment>> {
    Ok(sqlx::query_as!(
        ActivitySegment,
        "SELECT id, start_ts, end_ts, category, app, title, summary, distraction_score, source
         FROM activity_segments
         WHERE agent_id = $1 AND start_ts >= $2 AND start_ts < $3
         ORDER BY start_ts ASC",
        agent_id,
        from,
        to
    )
    .fetch_all(pool)
    .await?)
}

/// A stored day summary (`summary` of the day-summary view).
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct DaySummary {
    /// `YYYY-MM-DD`.
    pub day: String,
    pub narrative: Option<String>,
    #[ts(
        type = "{ active_seconds?: number, segment_count?: number, by_category?: { [category: string]: number } }"
    )]
    pub totals: serde_json::Value,
    #[ts(type = "Array<{ app: string, seconds: number }>")]
    pub top_apps: serde_json::Value,
    #[ts(type = "Array<{ label: string, category: string, start_ts: string, end_ts: string }>")]
    pub highlights: serde_json::Value,
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

/// The stored day summary for an agent, if any.
pub async fn get_day_summary(
    pool: &PgPool,
    agent_id: Uuid,
    day: NaiveDate,
) -> Result<Option<DaySummary>> {
    let row = sqlx::query!(
        "SELECT day, narrative, totals, top_apps, highlights, source, updated_at
         FROM day_summaries WHERE agent_id = $1 AND day = $2",
        agent_id,
        day
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| DaySummary {
        day: r.day.to_string(),
        narrative: r.narrative,
        totals: r.totals,
        top_apps: r.top_apps,
        highlights: r.highlights,
        source: r.source,
        updated_at: r.updated_at,
    }))
}

/// Retention: drop derived narrative rows whose day is older than `cutoff`.
pub async fn prune_narrative_before(pool: &PgPool, cutoff: NaiveDate) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!("SET LOCAL statement_timeout = '2s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query!("SET LOCAL lock_timeout = '1s'")
        .execute(&mut *tx)
        .await?;
    // start_ts predicate keyed to the cutoff day's UTC midnight.
    let cutoff_ts = Utc.from_utc_datetime(&cutoff.and_hms_opt(0, 0, 0).unwrap_or_default());
    sqlx::query!(
        "DELETE FROM activity_segments WHERE start_ts < $1",
        cutoff_ts
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("DELETE FROM day_summaries WHERE day < $1", cutoff)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
