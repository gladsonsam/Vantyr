//! The categorization queue: backfill, batches for the worker, recording results, and
//! recategorizing recent URL sessions.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Enqueue existing URL visits that have not been categorized yet (best-effort backfill).
/// Returns number of rows enqueued.
pub async fn enqueue_url_categorization_backfill(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
) -> Result<i64> {
    // Only enqueue when categorization is enabled to avoid unbounded queue growth.
    let enabled: bool =
        sqlx::query_scalar!("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }

    let rows = sqlx::query_scalar!(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT v.id, v.agent_id, v.ts, v.url, ''
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        WHERE v.agent_id = $1
          AND vc.url_visit_id IS NULL
        ORDER BY v.ts ASC
        LIMIT $2
        ON CONFLICT (url_visit_id) DO NOTHING
        RETURNING url_visit_id
        ",
        agent,
        limit.max(0)
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.len() as i64)
}

pub async fn enqueue_url_categorization_backfill_all(pool: &PgPool, limit: i64) -> Result<i64> {
    let enabled: bool =
        sqlx::query_scalar!("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }
    let rows = sqlx::query_scalar!(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT v.id, v.agent_id, v.ts, v.url, ''
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        WHERE vc.url_visit_id IS NULL
        ORDER BY v.ts ASC
        LIMIT $1
        ON CONFLICT (url_visit_id) DO NOTHING
        RETURNING url_visit_id
        ",
        limit.max(0)
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.len() as i64)
}

pub struct QueuedVisit {
    pub url_visit_id: i64,
    pub agent_id: Uuid,
    pub ts: DateTime<Utc>,
    pub url: String,
    pub hostname: String,
}

pub async fn queue_batch(pool: &PgPool, limit: i64) -> Result<Vec<QueuedVisit>> {
    Ok(sqlx::query_as!(
        QueuedVisit,
        r"
        SELECT url_visit_id, agent_id, ts, url, hostname
        FROM url_categorization_queue
        ORDER BY ts ASC
        LIMIT $1
        ",
        limit
    )
    .fetch_all(pool)
    .await?)
}

pub async fn set_visit_category(
    pool: &PgPool,
    visit_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
    sqlx::query!(
        r"
        INSERT INTO url_visit_category (url_visit_id, category_id)
        VALUES ($1, $2)
        ON CONFLICT (url_visit_id) DO UPDATE
        SET category_id = EXCLUDED.category_id,
            categorized_at = NOW()
        ",
        visit_id,
        category_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn bump_category_stats(
    pool: &PgPool,
    agent_id: Uuid,
    category_id: i64,
    ts: DateTime<Utc>,
) -> Result<()> {
    sqlx::query!(
        r"
        INSERT INTO url_category_stats (agent_id, category_id, visit_count, last_ts)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (agent_id, category_id) DO UPDATE
        SET visit_count = url_category_stats.visit_count + 1,
            last_ts = GREATEST(url_category_stats.last_ts, EXCLUDED.last_ts)
        ",
        agent_id,
        category_id,
        ts
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dequeue(pool: &PgPool, visit_id: i64) -> Result<()> {
    sqlx::query!(
        "DELETE FROM url_categorization_queue WHERE url_visit_id = $1",
        visit_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// `(id, url, hostname)` of the most recent URL sessions.
pub async fn recent_sessions(pool: &PgPool, limit: i64) -> Result<Vec<(i64, String, String)>> {
    let rows = sqlx::query!(
        r"
        SELECT id, agent_id, url, hostname, ts_end, duration_ms
        FROM url_sessions
        ORDER BY ts_end DESC
        LIMIT $1
        ",
        limit.max(0)
    )
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push((r.id, r.url, r.hostname));
    }
    Ok(out)
}

pub async fn set_session_category(pool: &PgPool, id: i64, category_id: Option<i64>) -> Result<u64> {
    let res = sqlx::query!(
        "UPDATE url_sessions SET category_id = $1 WHERE id = $2",
        category_id,
        id
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}
