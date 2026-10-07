//! Screen-history ("Recall") frame index + day-partition management + retention.
//!
//! The JPEG bytes live in a filesystem blob store (`SCREEN_HISTORY_DIR`); this
//! module owns only the Postgres *index* rows (`screen_frames`, partitioned by
//! day) and the on-demand creation / DROP of those day partitions.
//!
//! `phash` is a `u64` aHash. Postgres has no unsigned 64-bit type, so it is stored
//! as the same 64 bits reinterpreted as `i64` (`u64 as i64`) and reversed on read.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use chrono::{Datelike, Duration, NaiveDate};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

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
struct FrameRow {
    id: i64,
    captured_at: DateTime<Utc>,
    monitor: i32,
    w: i32,
    h: i32,
    phash: i64,
    capture_context: Option<serde_json::Value>,
    capture_duration_ms: Option<i32>,
    has_ocr: Option<bool>,
}

impl FrameRow {
    fn into_meta(self) -> FrameMeta {
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

/// One search hit: [`FrameRow`] plus its rank and snippet.
#[derive(sqlx::FromRow)]
struct SearchRow {
    #[sqlx(flatten)]
    frame: FrameRow,
    rank: Option<f32>,
    snippet: Option<String>,
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
fn frame_page<R>(
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

/// Full-text search over one agent's OCR'd keyframes in a time range, ranked by
/// relevance. Each hit carries a highlighted `snippet` (`ts_headline`). Empty or
/// stop-word-only queries match nothing (the caller should reject blank input).
#[allow(dead_code)] // Preserve the existing DB facade for callers that only need the first page.
pub async fn search_screen_frames(
    pool: &PgPool,
    agent_id: Uuid,
    query: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    limit: i64,
) -> Result<Vec<FrameMeta>> {
    Ok(search_screen_frames_page(
        pool,
        agent_id,
        query,
        Some(from),
        to,
        monitor,
        limit,
        false,
        None,
    )
    .await?
    .items)
}

/// Ranked (rank/time/id DESC) or newest (time/id DESC) keyset search.
/// A missing lower bound explicitly searches all retained history.
#[allow(clippy::too_many_arguments)]
pub async fn search_screen_frames_page(
    pool: &PgPool,
    agent_id: Uuid,
    query: &str,
    from: Option<DateTime<Utc>>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    limit: i64,
    newest: bool,
    after: Option<&ScreenFramePosition>,
) -> Result<ScreenFramePage> {
    search_screen_frames_filtered_page(
        pool,
        agent_id,
        query,
        from,
        to,
        monitor,
        limit,
        newest,
        after,
        &crate::recall::context::Filters::default(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn search_screen_frames_filtered_page(
    pool: &PgPool,
    agent_id: Uuid,
    query: &str,
    from: Option<DateTime<Utc>>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    limit: i64,
    newest: bool,
    after: Option<&ScreenFramePosition>,
    filters: &crate::recall::context::Filters,
) -> Result<ScreenFramePage> {
    filters.validate().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        !query.is_empty() || (filters.active() && newest),
        "invalid context-only search"
    );
    let limit = limit.clamp(1, 500);
    let order = if newest {
        "captured_at DESC, id DESC"
    } else {
        "rank DESC, captured_at DESC, id DESC"
    };
    let predicate = if newest {
        "(captured_at, id) < ($7, $8)"
    } else {
        "(rank, captured_at, id) < ($9::real, $7, $8)"
    };
    let sql = format!(
        r#"WITH hits AS (
           SELECT sf.id, sf.captured_at, sf.monitor, sf.w, sf.h, sf.phash,
             (sf.ocr_text IS NOT NULL AND length(sf.ocr_text) > 0) AS has_ocr,
             sf.capture_context, sf.capture_duration_ms,
             CASE WHEN $2 = '' THEN 0::real ELSE ts_rank(sf.ocr_tsv, q) END AS rank,
             CASE WHEN $2 = '' THEN '' ELSE ts_headline('english', coalesce(sf.ocr_text, ''), q,
               'StartSel=[[[, StopSel=]]], MaxWords=14, MinWords=4, ShortWord=2, MaxFragments=1') END AS snippet
           FROM screen_frames sf, websearch_to_tsquery('english', $2) q
           WHERE sf.agent_id = $1
             AND ($3::timestamptz IS NULL OR sf.captured_at >= $3)
             AND sf.captured_at <= $4
             AND ($5::int IS NULL OR sf.monitor = $5::int)
             AND ($2 = '' OR sf.ocr_tsv @@ q)
             AND ($10::text IS NULL OR ($11 = 'exact' AND sf.context_app = $10)
                  OR ($11 = 'prefix' AND sf.context_app LIKE $10 ESCAPE '\'))
             AND ($12::text IS NULL OR sf.context_title COLLATE "C" ILIKE $12 ESCAPE '\')
             AND ($13::text IS NULL OR sf.context_url_host = $13)
             AND ($14 = 'all'
                  OR ($14 = 'known' AND (sf.context_app IS NOT NULL OR sf.context_title IS NOT NULL OR sf.context_url_host IS NOT NULL))
                  OR ($14 = 'unknown' AND sf.context_app IS NULL AND sf.context_title IS NULL AND sf.context_url_host IS NULL))
         ) SELECT * FROM hits
         WHERE ($9::real IS NULL OR $9::real >= 0) AND ($7::timestamptz IS NULL OR {predicate})
         ORDER BY {order} LIMIT $6"#
    );
    // Runtime query: ORDER BY and the keyset predicate depend on `newest`.
    let mut statement = sqlx::query_as::<_, SearchRow>(&sql)
        .bind(agent_id)
        .bind(query)
        .bind(from)
        .bind(to)
        .bind(monitor)
        .bind(limit + 1)
        .bind(after.map(|p| p.captured_at))
        .bind(after.map(|p| p.id));
    // Always reserve $9 for rank so context binds have stable positions.
    statement = statement.bind(after.and_then(|p| p.rank));
    let app = filters.app.as_ref().map(|app| {
        if filters.app_mode == "prefix" {
            format!("{}%", crate::recall::context::literal_like(app))
        } else {
            app.clone()
        }
    });
    let title = filters
        .title
        .as_ref()
        .map(|s| format!("%{}%", crate::recall::context::literal_like(s)));
    statement = statement
        .bind(app)
        .bind(&filters.app_mode)
        .bind(title)
        .bind(&filters.url_host)
        .bind(&filters.context);
    let rows = statement.fetch_all(pool).await?;
    Ok(frame_page(
        rows,
        limit,
        |r| ScreenFramePosition {
            captured_at: r.frame.captured_at,
            id: r.frame.id,
            rank: r.rank,
        },
        |r| FrameMeta {
            rank: Some(r.rank.unwrap_or(0.0)),
            snippet: Some(r.snippet.unwrap_or_default()),
            ..r.frame.into_meta()
        },
    ))
}

// ── Capture settings ──────────────────────────────────────────────────────────

/// Capture settings in the shape the agent consumes (`set_recall_settings`) and the
/// settings UI shows, so exactly one type knows the field names on the wire.
#[derive(Debug, Clone, Serialize)]
pub struct RecallSettings {
    pub enabled: bool,
    pub interval_ms: i32,
    pub hot_interval_ms: i32,
    pub jpeg_quality: i16,
    pub max_dim: i32,
    pub dedup_hamming: i16,
    pub keyframe_max_gap_ms: i32,
    pub ocr: bool,
}

/// Effective capture settings for one agent: the global row with any per-agent
/// override applied column-by-column (`COALESCE`, so NULL means "inherit").
///
/// `None` when the global row is missing (migration not applied): the agent then keeps
/// its built-in defaults rather than receiving a half-formed policy.
pub async fn effective_recall_settings(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<RecallSettings>> {
    let row = sqlx::query!(
        "SELECT
           COALESCE(a.enabled,             g.enabled)             AS enabled,
           COALESCE(a.interval_ms,         g.interval_ms)         AS interval_ms,
           COALESCE(a.hot_interval_ms,     g.hot_interval_ms)     AS hot_interval_ms,
           COALESCE(a.jpeg_quality,        g.jpeg_quality)        AS jpeg_quality,
           COALESCE(a.max_dim,             g.max_dim)             AS max_dim,
           COALESCE(a.dedup_hamming,       g.dedup_hamming)       AS dedup_hamming,
           COALESCE(a.keyframe_max_gap_ms, g.keyframe_max_gap_ms) AS keyframe_max_gap_ms,
           COALESCE(a.ocr,                 g.ocr)                 AS ocr
         FROM recall_settings_global g
         LEFT JOIN recall_settings_agent a ON a.agent_id = $1
         WHERE g.id = 1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| RecallSettings {
        enabled: r.enabled.unwrap_or(true),
        interval_ms: r.interval_ms.unwrap_or(20_000),
        hot_interval_ms: r.hot_interval_ms.unwrap_or(6_000),
        jpeg_quality: r.jpeg_quality.unwrap_or(45),
        max_dim: r.max_dim.unwrap_or(1_600),
        dedup_hamming: r.dedup_hamming.unwrap_or(4),
        keyframe_max_gap_ms: r.keyframe_max_gap_ms.unwrap_or(300_000),
        ocr: r.ocr.unwrap_or(true),
    }))
}

/// The raw global capture settings row (for the settings UI).
pub async fn get_recall_settings_global(pool: &PgPool) -> Result<RecallSettings> {
    Ok(sqlx::query_as!(
        RecallSettings,
        "SELECT enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
                dedup_hamming, keyframe_max_gap_ms, ocr
         FROM recall_settings_global WHERE id = 1",
    )
    .fetch_one(pool)
    .await?)
}

/// The per-agent override row: `None` fields inherit the global value.
#[derive(Debug, Clone, Serialize)]
pub struct RecallSettingsOverride {
    pub enabled: Option<bool>,
    pub interval_ms: Option<i32>,
    pub hot_interval_ms: Option<i32>,
    pub jpeg_quality: Option<i16>,
    pub max_dim: Option<i32>,
    pub dedup_hamming: Option<i16>,
    pub keyframe_max_gap_ms: Option<i32>,
    pub ocr: Option<bool>,
    pub updated_at: DateTime<Utc>,
}

/// The raw per-agent override row, or `None` when the agent has none.
///
/// Distinct from [`effective_recall_settings`], which COALESCEs the override over the
/// global row: the settings UI needs to know *which* fields are overridden so it can
/// show the rest as inherited rather than as deliberate local values.
pub async fn get_recall_settings_agent_override(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<RecallSettingsOverride>> {
    Ok(sqlx::query_as!(
        RecallSettingsOverride,
        "SELECT enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
                dedup_hamming, keyframe_max_gap_ms, ocr, updated_at
         FROM recall_settings_agent WHERE agent_id = $1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?)
}

/// Capture settings the operator may change. `None` leaves a column untouched.
#[derive(Debug, Default, Clone)]
pub struct RecallSettingsPatch {
    pub enabled: Option<bool>,
    pub interval_ms: Option<i32>,
    pub hot_interval_ms: Option<i32>,
    pub jpeg_quality: Option<i16>,
    pub max_dim: Option<i32>,
    pub dedup_hamming: Option<i16>,
    pub keyframe_max_gap_ms: Option<i32>,
    pub ocr: Option<bool>,
}

/// Update the global capture settings. Omitted fields keep their current value.
pub async fn set_recall_settings_global(pool: &PgPool, p: &RecallSettingsPatch) -> Result<()> {
    sqlx::query!(
        "UPDATE recall_settings_global SET
           enabled             = COALESCE($1, enabled),
           interval_ms         = COALESCE($2, interval_ms),
           hot_interval_ms     = COALESCE($3, hot_interval_ms),
           jpeg_quality        = COALESCE($4, jpeg_quality),
           max_dim             = COALESCE($5, max_dim),
           dedup_hamming       = COALESCE($6, dedup_hamming),
           keyframe_max_gap_ms = COALESCE($7, keyframe_max_gap_ms),
           ocr                 = COALESCE($8, ocr),
           updated_at          = NOW()
         WHERE id = 1",
        p.enabled,
        p.interval_ms,
        p.hot_interval_ms,
        p.jpeg_quality,
        p.max_dim,
        p.dedup_hamming,
        p.keyframe_max_gap_ms,
        p.ocr
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Set (or clear) the per-agent override. Fields left `None` become NULL, i.e. the
/// agent inherits the global value for them.
pub async fn set_recall_settings_agent(
    pool: &PgPool,
    agent_id: Uuid,
    p: &RecallSettingsPatch,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO recall_settings_agent
           (agent_id, enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
            dedup_hamming, keyframe_max_gap_ms, ocr, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           interval_ms = EXCLUDED.interval_ms,
           hot_interval_ms = EXCLUDED.hot_interval_ms,
           jpeg_quality = EXCLUDED.jpeg_quality,
           max_dim = EXCLUDED.max_dim,
           dedup_hamming = EXCLUDED.dedup_hamming,
           keyframe_max_gap_ms = EXCLUDED.keyframe_max_gap_ms,
           ocr = EXCLUDED.ocr,
           updated_at = NOW()",
        agent_id,
        p.enabled,
        p.interval_ms,
        p.hot_interval_ms,
        p.jpeg_quality,
        p.max_dim,
        p.dedup_hamming,
        p.keyframe_max_gap_ms,
        p.ocr
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove an agent's override so it fully inherits the global settings again.
pub async fn clear_recall_settings_agent(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query!(
        "DELETE FROM recall_settings_agent WHERE agent_id = $1",
        agent_id
    )
    .execute(pool)
    .await?;
    Ok(())
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

/// Drop a bounded batch of old partitions belonging to the resolved parent only.
/// Blob cleanup is coordinated separately under device lifecycle gates.
pub async fn prune_screen_history_partitions(pool: &PgPool, cutoff: NaiveDate) -> Result<u64> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(r#"SET LOCAL lock_timeout = '1s'"#)
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query!(
        r#"SELECT c.relname::text AS "name!", n.nspname::text AS "schema!"
         FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
         JOIN pg_partitioned_table p ON p.partrelid=i.inhparent
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE i.inhparent='screen_frames'::regclass AND c.relispartition
           AND c.oid<>p.partdefid
           AND c.relname ~ '^screen_frames_[0-9]{8}$'
           AND CASE WHEN pg_input_is_valid(substring(c.relname FROM 15), 'date')
               THEN substring(c.relname FROM 15)::date END < $1
         ORDER BY c.relname LIMIT 4"#,
        cutoff
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut dropped = Vec::new();
    for row in rows {
        let (name, schema) = (row.name, row.schema);
        let Some(datestr) = name.strip_prefix("screen_frames_") else {
            continue;
        };
        let Ok(day) = NaiveDate::parse_from_str(datestr, "%Y%m%d") else {
            continue;
        };
        if day >= cutoff || day.format("%Y%m%d").to_string() != datestr {
            continue;
        }
        let qualified = format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            name.replace('"', "\"\"")
        );
        sqlx::query(&format!("DROP TABLE {qualified}"))
            .execute(&mut *tx)
            .await?;
        dropped.push(day);
    }
    tx.commit().await?;
    for day in &dropped {
        ensured_partitions()
            .lock()
            .unwrap()
            .remove(&day.num_days_from_ce());
    }
    Ok(dropped.len() as u64)
}

/// One committed DEFAULT-row batch, never a claim of complete reconciliation.
#[derive(Debug, Default)]
pub struct DefaultPruneBatch {
    pub deleted: u64,
    pub pending: bool,
}

pub const DEFAULT_PRUNE_ROWS: i64 = 256;

/// Resolve and lock catalog identities before using qualified names. Parent SUE
/// excludes partition DDL while permitting ordinary ingestion. Row locks skip
/// busy rows; ctid is used only within this transaction and this leaf relation.
pub async fn prune_screen_history_default(
    pool: &PgPool,
    cutoff: NaiveDate,
) -> Result<DefaultPruneBatch> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(r#"SET LOCAL lock_timeout = '1s'"#)
        .execute(&mut *tx)
        .await?;
    let parent = sqlx::query!(
        r#"SELECT c.oid::bigint AS "oid!", c.relname::text AS "name!", n.nspname::text AS "schema!"
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.oid='screen_frames'::regclass"#
    )
    .fetch_one(&mut *tx)
    .await?;
    let qualify = |schema: &str, name: &str| -> String {
        format!(
            "\"{}\".\"{}\"",
            schema.replace('"', "\"\""),
            name.replace('"', "\"\"")
        )
    };
    let parent_name = qualify(&parent.schema, &parent.name);
    let parent_oid: i64 = parent.oid;
    sqlx::query(&format!(
        "LOCK TABLE ONLY {parent_name} IN SHARE UPDATE EXCLUSIVE MODE"
    ))
    .execute(&mut *tx)
    .await?;
    let supported: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM pg_partitioned_table p
         JOIN pg_attribute a ON a.attrelid=p.partrelid AND a.attnum=p.partattrs[0]
         WHERE p.partrelid=$1::bigint::oid AND p.partstrat='r' AND p.partnatts=1
           AND a.attname='captured_at' AND a.atttypid IN ('date'::regtype,'timestamptz'::regtype)
           AND p.partrelid=to_regclass($2)) AS "exists!""#,
        parent_oid,
        &parent_name
    )
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(
        supported,
        "unsupported screen_frames partition structure or changed parent identity"
    );
    let child = sqlx::query!(
        r#"SELECT c.oid::bigint AS "oid!", c.relname::text AS "name!", n.nspname::text AS "schema!",
                c.relkind::text AS "kind!"
         FROM pg_partitioned_table p JOIN pg_inherits i
           ON i.inhparent=p.partrelid AND i.inhrelid=p.partdefid
         JOIN pg_class c ON c.oid=i.inhrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE p.partrelid=$1::bigint::oid AND c.relispartition"#,
        parent_oid
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(child) = child else {
        tx.commit().await?;
        return Ok(DefaultPruneBatch::default());
    };
    anyhow::ensure!(
        child.kind == "r",
        "unsupported screen_frames DEFAULT child: expected ordinary leaf table"
    );
    let child_name = qualify(&child.schema, &child.name);
    let child_oid: i64 = child.oid;
    sqlx::query(&format!(
        "LOCK TABLE ONLY {child_name} IN ROW EXCLUSIVE MODE"
    ))
    .execute(&mut *tx)
    .await?;
    let same: bool = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM pg_partitioned_table p JOIN pg_inherits i
          ON i.inhparent=p.partrelid AND i.inhrelid=p.partdefid
          WHERE p.partrelid=$1::bigint::oid AND i.inhrelid=$2::bigint::oid
            AND i.inhrelid=to_regclass($3)) AS "exists!""#,
        parent_oid,
        child_oid,
        &child_name
    )
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(same, "screen_frames DEFAULT child identity changed");
    // Bind an actual UTC instant, independent of the session TimeZone. DATE
    // fixtures compare with the same UTC day because the transaction uses UTC.
    sqlx::query!(r#"SET LOCAL TIME ZONE 'UTC'"#)
        .execute(&mut *tx)
        .await?;
    let before = cutoff.and_hms_opt(0, 0, 0).unwrap().and_utc();
    // Runtime queries: the DEFAULT child's name is only known at run time.
    let deleted = sqlx::query(&format!(
        "WITH batch AS MATERIALIZED (
           SELECT ctid FROM ONLY {child_name} WHERE captured_at < $1
           ORDER BY captured_at, ctid LIMIT $2 FOR UPDATE SKIP LOCKED
         ) DELETE FROM ONLY {child_name} f USING batch b
           WHERE f.ctid=b.ctid AND f.captured_at < $1"
    ))
    .bind(before)
    .bind(DEFAULT_PRUNE_ROWS)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let pending = sqlx::query_scalar(&format!(
        "SELECT EXISTS(SELECT 1 FROM ONLY {child_name} WHERE captured_at < $1)"
    ))
    .bind(before)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(DefaultPruneBatch { deleted, pending })
}

/// Check references across ALL partitions, including the default partition.
/// Ingestion derives `<agent>/<YYYYMMDD>/` from the row's own agent and UTC
/// `captured_at`, so the owner/time bounds (with a day of margin each side)
/// use idx_screen_frames_agent_ts instead of scanning every row's blob_ref.
pub async fn screen_history_day_is_indexed(
    pool: &PgPool,
    agent: Uuid,
    day: NaiveDate,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query!(r#"SET LOCAL statement_timeout = '2s'"#)
        .execute(&mut *tx)
        .await?;
    let prefix = format!("{agent}/{}/%", day.format("%Y%m%d"));
    let from = (day - Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let to = (day + Duration::days(2))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let indexed = sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM screen_frames
           WHERE agent_id = $1 AND captured_at >= $2 AND captured_at < $3
             AND blob_ref LIKE $4) AS "exists!""#,
        agent,
        from,
        to,
        prefix
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(indexed)
}

#[cfg(test)]
mod pagination_tests {
    use super::*;
    use chrono::TimeZone;

    #[sqlx::test]
    async fn keyset_pages_cover_ties_caps_filters_and_search_orders(pool: PgPool) -> Result<()> {
        let agent = Uuid::new_v4();
        let other = Uuid::new_v4();
        crate::test_support::insert_agent(&pool, agent).await?;
        crate::test_support::insert_agent(&pool, other).await?;
        let from = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let to = from + Duration::days(1);
        sqlx::query("INSERT INTO screen_frames (id, agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv)
            OVERRIDING SYSTEM VALUE
            SELECT n, $1, $2::timestamptz, (n % 2)::int, 100, 100, 0, 'fixture.jpg',
                CASE WHEN n % 3 = 0 THEN 'needle needle needle' ELSE 'needle' END,
                to_tsvector('english', CASE WHEN n % 3 = 0 THEN 'needle needle needle' ELSE 'needle' END)
            FROM generate_series(1, 5003) n")
            .bind(agent).bind(from + Duration::microseconds(123456)).execute(&pool).await?;
        sqlx::query(
            "INSERT INTO screen_frames (id, agent_id, captured_at, monitor, w, h, phash, blob_ref, ocr_text, ocr_tsv)
            OVERRIDING SYSTEM VALUE VALUES
            (6000, $1, $3, 0, 100, 100, 0, 'fixture.jpg', 'needle', to_tsvector('english', 'needle')),
            (6001, $2, $4, 0, 100, 100, 0, 'fixture.jpg', 'needle', to_tsvector('english', 'needle'))",
        )
        .bind(agent)
        .bind(other)
        .bind(from - Duration::days(100))
        .bind(from)
        .execute(&pool)
        .await?;

        let first = list_screen_frames_page(&pool, agent, from, to, None, 5000, None).await?;
        assert_eq!(first.items.len(), 5000);
        assert_eq!(first.next.as_ref().unwrap().id, 5000);
        let last = list_screen_frames_page(&pool, agent, from, to, None, 5000, first.next.as_ref())
            .await?;
        assert_eq!(
            last.items.iter().map(|v| v.id).collect::<Vec<_>>(),
            vec![5001, 5002, 5003]
        );
        assert!(last.next.is_none());
        let client_page = list_screen_frames_page(&pool, agent, from, to, None, 3000, None).await?;
        assert_eq!(client_page.items.len(), 3000);
        let client_tail = list_screen_frames_page(
            &pool,
            agent,
            from,
            to,
            None,
            3000,
            client_page.next.as_ref(),
        )
        .await?;
        assert_eq!(client_tail.items.len(), 2003);
        assert!(client_tail.next.is_none());
        let exact = list_screen_frames_page(&pool, agent, from, to, Some(0), 2501, None).await?;
        assert_eq!(exact.items.len(), 2501);
        assert!(exact.next.is_none(), "exactly full final page is complete");
        assert!(exact.items.iter().all(|v| v.monitor == 0));
        let empty = list_screen_frames_page(&pool, agent, to, to, None, 10, None).await?;
        assert!(empty.items.is_empty() && empty.next.is_none());

        for newest in [false, true] {
            let expected_sql = if newest {
                "SELECT id FROM screen_frames WHERE agent_id=$1 ORDER BY captured_at DESC, id DESC"
            } else {
                "SELECT id FROM screen_frames WHERE agent_id=$1 ORDER BY ts_rank(ocr_tsv, websearch_to_tsquery('english', 'needle')) DESC, captured_at DESC, id DESC"
            };
            let expected: Vec<i64> = sqlx::query_scalar(expected_sql)
                .bind(agent)
                .fetch_all(&pool)
                .await?;
            let mut actual = Vec::new();
            let mut after = None;
            for _ in 0..150 {
                let page = search_screen_frames_page(
                    &pool,
                    agent,
                    "needle",
                    None,
                    to,
                    None,
                    37,
                    newest,
                    after.as_ref(),
                )
                .await?;
                actual.extend(page.items.iter().map(|v| v.id));
                after = page.next;
                if after.is_none() {
                    break;
                }
            }
            assert!(after.is_none(), "pagination must terminate");
            assert_eq!(
                actual, expected,
                "all retained hits exactly once, in stable order"
            );
        }
        let range = search_screen_frames_page(
            &pool,
            agent,
            "needle",
            Some(from),
            to,
            Some(0),
            500,
            false,
            None,
        )
        .await?;
        assert_eq!(range.items.len(), 500);
        assert!(range.next.is_some());
        assert!(range.items.iter().all(|v| v.monitor == 0 && v.id != 6000));
        let stopwords =
            search_screen_frames_page(&pool, agent, "the", None, to, None, 10, false, None).await?;
        assert!(stopwords.items.is_empty() && stopwords.next.is_none());
        Ok(())
    }
}

#[cfg(test)]
mod context_query_tests;
