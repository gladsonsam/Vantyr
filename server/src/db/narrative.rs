//! Derived screen-history narrative persistence: `activity_segments` + `day_summaries`.
//!
//! The worker (`crate::screen_narrative`) computes these from `window_events` +
//! `url_visits` + `screen_frames`; this module owns the reads/writes and the
//! idempotent per-(agent, day) rebuild.

use chrono::NaiveDate;

use super::*;

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
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT agent_id FROM screen_frames WHERE captured_at >= $1 AND captured_at < $2",
    )
    .bind(from)
    .bind(to)
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
    let rows = sqlx::query(
        "SELECT ts, app, title FROM window_events
         WHERE agent_id = $1 AND ts >= $2 AND ts < $3
         ORDER BY ts ASC",
    )
    .bind(agent_id)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| FocusRow {
            ts: r.try_get("ts").unwrap_or_else(|_| Utc::now()),
            app: r.try_get::<String, _>("app").unwrap_or_default(),
            title: r.try_get::<String, _>("title").unwrap_or_default(),
        })
        .collect())
}

/// Up to `limit` frames evenly-ish sampled across `[from, to)`: `(blob_ref, ocr_text)`.
/// Used to attach images/text to the optional AI vision call.
pub async fn sample_frames_for_range(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<(String, Option<String>)>> {
    // NTILE buckets the range and we take the first frame per bucket for even coverage.
    let rows = sqlx::query(
        "SELECT blob_ref, ocr_text FROM (
           SELECT blob_ref, ocr_text, captured_at,
                  ntile($4) OVER (ORDER BY captured_at) AS bucket,
                  row_number() OVER (PARTITION BY ntile($4) OVER (ORDER BY captured_at)
                                     ORDER BY captured_at) AS rn
           FROM screen_frames
           WHERE agent_id = $1 AND captured_at >= $2 AND captured_at < $3
         ) s
         WHERE rn = 1
         ORDER BY captured_at",
    )
    .bind(agent_id)
    .bind(from)
    .bind(to)
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>("blob_ref").unwrap_or_default(),
                r.try_get::<Option<String>, _>("ocr_text").unwrap_or(None),
            )
        })
        .collect())
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
    sqlx::query(
        "DELETE FROM activity_segments
         WHERE agent_id = $1 AND start_ts >= $2 AND start_ts < $3",
    )
    .bind(agent_id)
    .bind(day_start)
    .bind(day_end)
    .execute(&mut *tx)
    .await?;

    for s in segments {
        sqlx::query(
            "INSERT INTO activity_segments
               (agent_id, start_ts, end_ts, category, app, title, summary, distraction_score, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        )
        .bind(agent_id)
        .bind(s.start_ts)
        .bind(s.end_ts)
        .bind(&s.category)
        .bind(s.app.as_deref())
        .bind(s.title.as_deref())
        .bind(s.summary.as_deref())
        .bind(s.distraction_score)
        .bind(&s.source)
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
    /// When the vision narrative was last generated (rate-limits AI independently).
    pub ai_generated_at: Option<DateTime<Utc>>,
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
    let row = sqlx::query(
        "SELECT content_hash, ai_generated_at, finalized,
                (narrative IS NOT NULL AND length(narrative) > 0) AS has_narrative
         FROM day_summaries WHERE agent_id = $1 AND day = $2",
    )
    .bind(agent_id)
    .bind(day)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| DaySummaryState {
        content_hash: r.try_get("content_hash").unwrap_or(None),
        ai_generated_at: r.try_get("ai_generated_at").unwrap_or(None),
        finalized: r.try_get("finalized").unwrap_or(false),
        has_narrative: r.try_get("has_narrative").unwrap_or(false),
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
    /// `true` when this pass produced a fresh AI narrative (stamps `ai_generated_at`).
    pub ai_refreshed: bool,
    /// `true` once the day is over and this is its last pass.
    pub finalized: bool,
}

/// Upsert the per-day summary for an agent.
pub async fn upsert_day_summary(pool: &PgPool, w: DaySummaryWrite<'_>) -> Result<()> {
    sqlx::query(
        "INSERT INTO day_summaries
           (agent_id, day, narrative, totals, top_apps, highlights, source,
            content_hash, ai_generated_at, finalized, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 CASE WHEN $9 THEN NOW() ELSE NULL END, $10, NOW())
         ON CONFLICT (agent_id, day) DO UPDATE SET
           narrative = EXCLUDED.narrative,
           totals = EXCLUDED.totals,
           top_apps = EXCLUDED.top_apps,
           highlights = EXCLUDED.highlights,
           source = EXCLUDED.source,
           content_hash = EXCLUDED.content_hash,
           -- Keep the previous stamp when this pass reused the existing narrative,
           -- so the AI rate-limit measures time since the last *real* AI call.
           ai_generated_at = CASE WHEN $9 THEN NOW() ELSE day_summaries.ai_generated_at END,
           finalized = EXCLUDED.finalized,
           updated_at = NOW()",
    )
    .bind(w.agent_id)
    .bind(w.day)
    .bind(w.narrative)
    .bind(w.totals)
    .bind(w.top_apps)
    .bind(w.highlights)
    .bind(w.source)
    .bind(w.content_hash)
    .bind(w.ai_refreshed)
    .bind(w.finalized)
    .execute(pool)
    .await?;
    Ok(())
}

/// Segments for one agent within `[from, to)`, oldest-first (for the day view).
pub async fn list_activity_segments(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT id, start_ts, end_ts, category, app, title, summary, distraction_score, source
         FROM activity_segments
         WHERE agent_id = $1 AND start_ts >= $2 AND start_ts < $3
         ORDER BY start_ts ASC",
    )
    .bind(agent_id)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.try_get::<i64, _>("id").unwrap_or(0),
                "start_ts": r.try_get::<DateTime<Utc>, _>("start_ts").ok(),
                "end_ts": r.try_get::<DateTime<Utc>, _>("end_ts").ok(),
                "category": r.try_get::<String, _>("category").unwrap_or_default(),
                "app": r.try_get::<Option<String>, _>("app").unwrap_or(None),
                "title": r.try_get::<Option<String>, _>("title").unwrap_or(None),
                "summary": r.try_get::<Option<String>, _>("summary").unwrap_or(None),
                "distraction_score": r.try_get::<f32, _>("distraction_score").unwrap_or(0.0),
                "source": r.try_get::<String, _>("source").unwrap_or_default(),
            })
        })
        .collect())
}

/// The stored day summary for an agent, if any.
pub async fn get_day_summary(
    pool: &PgPool,
    agent_id: Uuid,
    day: NaiveDate,
) -> Result<Option<serde_json::Value>> {
    let row = sqlx::query(
        "SELECT day, narrative, totals, top_apps, highlights, source, updated_at
         FROM day_summaries WHERE agent_id = $1 AND day = $2",
    )
    .bind(agent_id)
    .bind(day)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| {
        serde_json::json!({
            "day": r.try_get::<NaiveDate, _>("day").ok().map(|d| d.to_string()),
            "narrative": r.try_get::<Option<String>, _>("narrative").unwrap_or(None),
            "totals": r.try_get::<serde_json::Value, _>("totals").unwrap_or(serde_json::json!({})),
            "top_apps": r.try_get::<serde_json::Value, _>("top_apps").unwrap_or(serde_json::json!([])),
            "highlights": r.try_get::<serde_json::Value, _>("highlights").unwrap_or(serde_json::json!([])),
            "source": r.try_get::<String, _>("source").unwrap_or_default(),
            "updated_at": r.try_get::<DateTime<Utc>, _>("updated_at").ok(),
        })
    }))
}

/// Retention: drop derived narrative rows whose day is older than `cutoff`.
pub async fn prune_narrative_before(pool: &PgPool, cutoff: NaiveDate) -> Result<()> {
    // start_ts predicate keyed to the cutoff day's UTC midnight.
    let cutoff_ts = Utc.from_utc_datetime(&cutoff.and_hms_opt(0, 0, 0).unwrap_or_default());
    sqlx::query("DELETE FROM activity_segments WHERE start_ts < $1")
        .bind(cutoff_ts)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM day_summaries WHERE day < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(())
}
