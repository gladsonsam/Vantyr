//! Browsing telemetry persistence: URL visits and time-on-site sessions, their aggregates,
//! and the per-agent URL analytics queries.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::db::unix_to_dt;
use crate::web_activity::ingest::{UrlSessionEvent, UrlVisit};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UrlTopRow {
    pub url: String,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

/// Insert a URL visit, skipping exact consecutive duplicates for this agent.
/// Callers filter out incomplete navigations first (see `web_activity::ingest`).
pub async fn insert_url(pool: &PgPool, agent: Uuid, ev: &UrlVisit) -> Result<()> {
    let ts = unix_to_dt(ev.ts);
    let user_name = ev.user.as_deref();

    // Skip if same URL as the most-recent visit for this agent.
    let last: Option<String> = sqlx::query_scalar!(
        "SELECT url FROM url_visits WHERE agent_id = $1 ORDER BY ts DESC LIMIT 1",
        agent
    )
    .fetch_optional(pool)
    .await?;

    if last.as_deref() == Some(ev.url.as_str()) {
        return Ok(());
    }

    let visit_id: i64 = sqlx::query_scalar!(
        r"
        INSERT INTO url_visits (agent_id, url, title, browser, ts, user_name)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
        ",
        agent,
        ev.url,
        ev.title.as_deref(),
        ev.browser.as_deref(),
        ts,
        user_name
    )
    .fetch_one(pool)
    .await?;

    sqlx::query!(
        r"
        INSERT INTO url_top_stats (agent_id, url, visit_count, last_ts)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (agent_id, url) DO UPDATE
        SET visit_count = url_top_stats.visit_count + 1,
            last_ts = GREATEST(url_top_stats.last_ts, EXCLUDED.last_ts)
        ",
        agent,
        ev.url,
        ts
    )
    .execute(pool)
    .await?;

    // Enqueue for categorization only when the feature is enabled.
    // This avoids unbounded queue growth when categorization is turned off.
    sqlx::query!(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT $1, $2, $3, $4, ''
        WHERE (SELECT enabled FROM url_categorization_settings WHERE id = 1) = true
        ON CONFLICT (url_visit_id) DO NOTHING
        ",
        visit_id,
        agent,
        ts,
        ev.url
    )
    .execute(pool)
    .await
    .ok();

    Ok(())
}

/// Insert a time-on-site session and update the per-site / per-category aggregates.
/// `hostname` and `category_id` come from the caller's categorization of `v["url"]`.
pub async fn insert_url_session(
    pool: &PgPool,
    agent: Uuid,
    ev: &UrlSessionEvent,
    hostname: &str,
    category_id: Option<i64>,
) -> Result<()> {
    let start_ts = unix_to_dt(ev.started_at_ts);
    let end_ts = unix_to_dt(ev.ended_at_ts);
    let user_name = ev.user.as_deref();

    sqlx::query!(
        r"
        INSERT INTO url_sessions (agent_id, url, hostname, title, browser, ts_start, ts_end, duration_ms, category_id, user_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ",
        agent,
        ev.url,
        hostname,
        ev.title.as_deref(),
        ev.browser.as_deref(),
        start_ts,
        end_ts,
        ev.duration_ms,
        category_id,
        user_name
    )
    .execute(pool)
    .await?;

    // Aggregate per-site.
    if !hostname.is_empty() {
        sqlx::query!(
            r"
            INSERT INTO url_site_stats (agent_id, hostname, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, hostname) DO UPDATE
            SET time_ms = url_site_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_site_stats.visit_count + 1,
                last_ts = GREATEST(url_site_stats.last_ts, EXCLUDED.last_ts)
            ",
            agent,
            hostname,
            ev.duration_ms,
            end_ts
        )
        .execute(pool)
        .await?;
    }

    // Aggregate per-category.
    if let Some(cid) = category_id {
        sqlx::query!(
            r"
            INSERT INTO url_category_time_stats (agent_id, category_id, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, category_id) DO UPDATE
            SET time_ms = url_category_time_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_category_time_stats.visit_count + 1,
                last_ts = GREATEST(url_category_time_stats.last_ts, EXCLUDED.last_ts)
            ",
            agent,
            cid,
            ev.duration_ms,
            end_ts
        )
        .execute(pool)
        .await?;
    }

    Ok(())
}

pub async fn query_top_urls(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<UrlTopRow>> {
    Ok(sqlx::query_as!(
        UrlTopRow,
        r"
        SELECT url, visit_count, last_ts
        FROM url_top_stats
        WHERE agent_id = $1
        ORDER BY visit_count DESC, last_ts DESC
        LIMIT $2 OFFSET $3
        ",
        agent,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

/// One URL visit with its effective category (`GET /api/agents/:id/urls`).
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct UrlVisitRow {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub browser: Option<String>,
    pub ts: DateTime<Utc>,
    #[serde(rename = "user")]
    pub user_name: Option<String>,
    pub category_key: Option<String>,
    pub category: Option<String>,
}

pub async fn query_urls(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<UrlVisitRow>> {
    Ok(sqlx::query_as!(
        UrlVisitRow,
        r"
        SELECT v.id, v.url, v.title, v.browser, v.ts, v.user_name,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        LEFT JOIN url_categories c ON c.id = vc.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE v.agent_id = $1
        ORDER BY v.ts DESC
        LIMIT $2 OFFSET $3
        ",
        agent,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

#[derive(Debug, Clone, Serialize)]
pub struct UrlCategoryStatRow {
    pub category: String,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_url_category_stats(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
) -> Result<Vec<UrlCategoryStatRow>> {
    let rows = sqlx::query!(
        r"
        SELECT COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category,
               SUM(s.visit_count)::bigint AS visit_count,
               MAX(s.last_ts) AS last_ts
        FROM url_category_stats s
        JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
        GROUP BY category
        ORDER BY visit_count DESC, last_ts DESC
        LIMIT $2
        ",
        agent,
        limit
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| UrlCategoryStatRow {
            category: r.category.unwrap_or_default(),
            visit_count: r.visit_count.unwrap_or(0),
            last_ts: r.last_ts.unwrap_or_else(Utc::now),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlCategoryTimeRow {
    pub category_key: String,
    pub category_label: String,
    pub time_ms: i64,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_agent_url_categories_time(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AgentUrlCategoryTimeRow>> {
    let rows = sqlx::query!(
        r"
        SELECT COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label,
               SUM(s.duration_ms)::bigint AS time_ms,
               COUNT(*)::bigint AS visit_count,
               MAX(s.ts_end) AS last_ts
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
        GROUP BY category_key, category_label
        ORDER BY time_ms DESC NULLS LAST
        LIMIT $4
        ",
        agent,
        from,
        to,
        limit
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlCategoryTimeRow {
            category_key: r.category_key.unwrap_or_else(|| "uncategorized".into()),
            category_label: r.category_label.unwrap_or_else(|| "uncategorized".into()),
            time_ms: r.time_ms.unwrap_or(0),
            visit_count: r.visit_count.unwrap_or(0),
            last_ts: r.last_ts.unwrap_or_else(Utc::now),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlSiteTimeRow {
    pub hostname: String,
    pub category_key: Option<String>,
    pub category_label: Option<String>,
    pub time_ms: i64,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_agent_url_sites_time(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    custom_category_key: Option<&str>,
    category_key: Option<&str>,
    limit: i64,
) -> Result<Vec<AgentUrlSiteTimeRow>> {
    let rows = sqlx::query!(
        r"
        SELECT s.hostname,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label,
               SUM(s.duration_ms)::bigint AS time_ms,
               COUNT(*)::bigint AS visit_count,
               MAX(s.ts_end) AS last_ts
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
          AND ($4::text IS NULL OR COALESCE(cc.key, c.key, 'uncategorized') = $4::text)
          AND ($5::text IS NULL OR c.key = $5::text)
        GROUP BY s.hostname, category_key, category_label
        ORDER BY time_ms DESC NULLS LAST
        LIMIT $6
        ",
        agent,
        from,
        to,
        custom_category_key,
        category_key,
        limit
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSiteTimeRow {
            hostname: r.hostname,
            category_key: r.category_key,
            category_label: r.category_label,
            time_ms: r.time_ms.unwrap_or(0),
            visit_count: r.visit_count.unwrap_or(0),
            last_ts: r.last_ts.unwrap_or_else(Utc::now),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlSessionRow {
    pub id: i64,
    pub url: String,
    pub hostname: String,
    pub ts_start: DateTime<Utc>,
    pub ts_end: DateTime<Utc>,
    pub duration_ms: i64,
    pub user: Option<String>,
    pub category_key: Option<String>,
    pub category_label: Option<String>,
    pub browser: Option<String>,
    pub title: Option<String>,
}

pub async fn query_agent_url_sessions(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AgentUrlSessionRow>> {
    let rows = sqlx::query!(
        r"
        SELECT s.id, s.url, s.hostname, s.ts_start, s.ts_end, s.duration_ms, s.browser, s.title, s.user_name,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
        ORDER BY s.ts_start DESC
        LIMIT $4
        ",
        agent,
        from,
        to,
        limit
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSessionRow {
            id: r.id,
            url: r.url,
            hostname: r.hostname,
            ts_start: r.ts_start,
            ts_end: r.ts_end,
            duration_ms: r.duration_ms,
            user: r.user_name,
            category_key: r.category_key,
            category_label: r.category_label,
            browser: r.browser,
            title: r.title,
        })
        .collect())
}
