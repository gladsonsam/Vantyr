//! Full-text and context search over an agent's OCR'd frames.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::timeline::{frame_page, FrameMeta, FrameRow, ScreenFramePage, ScreenFramePosition};

/// One search hit: [`FrameRow`] plus its rank and snippet.
#[derive(sqlx::FromRow)]
struct SearchRow {
    #[sqlx(flatten)]
    frame: FrameRow,
    rank: Option<f32>,
    snippet: Option<String>,
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
