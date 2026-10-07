//! Browsing telemetry persistence: URL visits and time-on-site sessions, their aggregates,
//! and the per-agent URL analytics queries.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::db::unix_to_dt;

#[derive(Debug, Clone, Serialize)]
pub struct UrlTopRow {
    pub url: String,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

/// Insert a URL visit, skipping exact consecutive duplicates for this agent.
/// Callers filter out incomplete navigations first (see `web_activity::ingest`).
pub async fn insert_url(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    let title = v["title"].as_str();
    let browser = v["browser"].as_str();
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    // Skip if same URL as the most-recent visit for this agent.
    let last: Option<String> = sqlx::query_scalar(
        "SELECT url FROM url_visits WHERE agent_id = $1 ORDER BY ts DESC LIMIT 1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await?;

    if last.as_deref() == Some(url) {
        return Ok(());
    }

    let visit_id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO url_visits (agent_id, url, title, browser, ts, user_name)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(title)
    .bind(browser)
    .bind(ts)
    .bind(user_name)
    .fetch_one(pool)
    .await?;

    sqlx::query(
        r"
        INSERT INTO url_top_stats (agent_id, url, visit_count, last_ts)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (agent_id, url) DO UPDATE
        SET visit_count = url_top_stats.visit_count + 1,
            last_ts = GREATEST(url_top_stats.last_ts, EXCLUDED.last_ts)
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(ts)
    .execute(pool)
    .await?;

    // Enqueue for categorization only when the feature is enabled.
    // This avoids unbounded queue growth when categorization is turned off.
    sqlx::query(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT $1, $2, $3, $4, ''
        WHERE (SELECT enabled FROM url_categorization_settings WHERE id = 1) = true
        ON CONFLICT (url_visit_id) DO NOTHING
        ",
    )
    .bind(visit_id)
    .bind(agent)
    .bind(ts)
    .bind(url)
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
    v: &serde_json::Value,
    hostname: &str,
    category_id: Option<i64>,
) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    let title = v["title"].as_str();
    let browser = v["browser"].as_str();
    let start_ts = unix_to_dt(v["started_at_ts"].as_i64());
    let end_ts = unix_to_dt(v["ended_at_ts"].as_i64());
    let duration_ms: i64 = v["duration_ms"]
        .as_i64()
        .or_else(|| {
            v["duration_ms"]
                .as_u64()
                .and_then(|u| i64::try_from(u).ok())
        })
        .unwrap_or(0)
        .max(0);
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query(
        r"
        INSERT INTO url_sessions (agent_id, url, hostname, title, browser, ts_start, ts_end, duration_ms, category_id, user_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(hostname)
    .bind(title)
    .bind(browser)
    .bind(start_ts)
    .bind(end_ts)
    .bind(duration_ms)
    .bind(category_id)
    .bind(user_name)
    .execute(pool)
    .await?;

    // Aggregate per-site.
    if !hostname.is_empty() {
        sqlx::query(
            r"
            INSERT INTO url_site_stats (agent_id, hostname, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, hostname) DO UPDATE
            SET time_ms = url_site_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_site_stats.visit_count + 1,
                last_ts = GREATEST(url_site_stats.last_ts, EXCLUDED.last_ts)
            ",
        )
        .bind(agent)
        .bind(hostname)
        .bind(duration_ms)
        .bind(end_ts)
        .execute(pool)
        .await?;
    }

    // Aggregate per-category.
    if let Some(cid) = category_id {
        sqlx::query(
            r"
            INSERT INTO url_category_time_stats (agent_id, category_id, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, category_id) DO UPDATE
            SET time_ms = url_category_time_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_category_time_stats.visit_count + 1,
                last_ts = GREATEST(url_category_time_stats.last_ts, EXCLUDED.last_ts)
            ",
        )
        .bind(agent)
        .bind(cid)
        .bind(duration_ms)
        .bind(end_ts)
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
    let rows = sqlx::query(
        r"
        SELECT url, visit_count, last_ts
        FROM url_top_stats
        WHERE agent_id = $1
        ORDER BY visit_count DESC, last_ts DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| UrlTopRow {
            url: r.try_get("url").unwrap_or_default(),
            visit_count: r.try_get("visit_count").unwrap_or_default(),
            last_ts: r.try_get("last_ts").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

pub async fn query_urls(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let id: i64 = r.try_get("id").unwrap_or_default();
            let url: String = r.try_get("url").unwrap_or_default();
            let title: Option<String> = r.try_get("title").ok().flatten();
            let browser: Option<String> = r.try_get("browser").ok().flatten();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            let category: Option<String> = r.try_get("category").ok().flatten();
            let category_key: Option<String> = r.try_get("category_key").ok().flatten();
            serde_json::json!({ "id": id, "url": url, "title": title, "browser": browser, "ts": ts, "user": user_name, "category_key": category_key, "category": category })
        })
        .collect())
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
    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| UrlCategoryStatRow {
            category: r.try_get::<String, _>("category").unwrap_or_default(),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
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
    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlCategoryTimeRow {
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None)
                .unwrap_or_else(|| "uncategorized".into()),
            category_label: r
                .try_get::<String, _>("category_label")
                .unwrap_or_else(|_| "uncategorized".into()),
            time_ms: r.try_get::<i64, _>("time_ms").unwrap_or(0),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
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
    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(custom_category_key)
    .bind(category_key)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSiteTimeRow {
            hostname: r.try_get::<String, _>("hostname").unwrap_or_default(),
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None),
            category_label: r
                .try_get::<Option<String>, _>("category_label")
                .unwrap_or(None),
            time_ms: r.try_get::<i64, _>("time_ms").unwrap_or(0),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
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
    let rows = sqlx::query(
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
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSessionRow {
            id: r.try_get::<i64, _>("id").unwrap_or_default(),
            url: r.try_get::<String, _>("url").unwrap_or_default(),
            hostname: r.try_get::<String, _>("hostname").unwrap_or_default(),
            ts_start: r
                .try_get::<DateTime<Utc>, _>("ts_start")
                .unwrap_or_else(|_| Utc::now()),
            ts_end: r
                .try_get::<DateTime<Utc>, _>("ts_end")
                .unwrap_or_else(|_| Utc::now()),
            duration_ms: r.try_get::<i64, _>("duration_ms").unwrap_or(0),
            user: r.try_get::<Option<String>, _>("user_name").unwrap_or(None),
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None),
            category_label: r
                .try_get::<Option<String>, _>("category_label")
                .unwrap_or(None),
            browser: r.try_get::<Option<String>, _>("browser").unwrap_or(None),
            title: r.try_get::<Option<String>, _>("title").unwrap_or(None),
        })
        .collect())
}
