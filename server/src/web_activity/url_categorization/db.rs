//! URL categorization persistence.

use anyhow::Result;
use sqlx::{PgPool, Row};
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
        sqlx::query_scalar("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }

    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;

    Ok(rows.len() as i64)
}

pub async fn enqueue_url_categorization_backfill_all(pool: &PgPool, limit: i64) -> Result<i64> {
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }
    let rows = sqlx::query(
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
    )
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    Ok(rows.len() as i64)
}

pub async fn recalc_url_sessions_categories(pool: &PgPool, limit: i64) -> Result<i64> {
    // Load latest sessions and recompute category; update rows + aggregates best-effort.
    let rows = sqlx::query(
        r"
        SELECT id, agent_id, url, hostname, ts_end, duration_ms
        FROM url_sessions
        ORDER BY ts_end DESC
        LIMIT $1
        ",
    )
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    let mut updated: i64 = 0;
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let url: String = r.try_get("url").unwrap_or_default();
        let hostname: String = r.try_get("hostname").unwrap_or_default();
        let cat = super::engine::categorize_url_now(pool, &hostname, &url).await?;
        let category_id: Option<i64> = cat.as_ref().map(|(cid, _)| *cid);
        let res = sqlx::query("UPDATE url_sessions SET category_id = $1 WHERE id = $2")
            .bind(category_id)
            .bind(id)
            .execute(pool)
            .await?;
        if res.rows_affected() > 0 {
            updated += 1;
        }
    }
    Ok(updated)
}
