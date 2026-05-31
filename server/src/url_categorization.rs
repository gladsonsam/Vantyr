//! URL categorization (UT1 blacklists): import categories and enrich URL visits for analytics + alert rules.
//!
//! Design constraints:
//! - Disabled by default (no downloads, no work).
//! - When enabled, keep exactly one active release's entries in DB (overwrite on update).
//! - Categorization is async via a DB queue to keep ingest fast.

use anyhow::Result;
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use futures_util::{FutureExt, StreamExt};
use idna::domain_to_ascii;
use sqlx::PgPool;
use sqlx::Row;
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;
use tar::Archive;
use uuid::Uuid;

use crate::{alert_rules, db, state::AppState};

/// Poll interval for the categorization queue worker.
const WORKER_POLL_MS: u64 = 750;
/// How many queued URL visits to process per batch.
const WORKER_BATCH: i64 = 250;
/// Auto-update check cadence (when enabled). Kept conservative.
const AUTO_UPDATE_INTERVAL_SECS: u64 = 6 * 60 * 60; // 6h

#[derive(Debug, Clone)]
pub struct Settings {
    pub enabled: bool,
    pub auto_update: bool,
    pub source_url: String,
    pub last_update_at: Option<DateTime<Utc>>,
    pub last_update_error: Option<String>,
}

pub async fn get_settings(pool: &PgPool) -> Result<Settings> {
    let row = sqlx::query(
        r"
        SELECT enabled, auto_update, source_url, last_update_at, last_update_error
        FROM url_categorization_settings
        WHERE id = 1
        ",
    )
    .fetch_one(pool)
    .await?;
    Ok(Settings {
        enabled: row.try_get::<bool, _>("enabled").unwrap_or(false),
        auto_update: row.try_get::<bool, _>("auto_update").unwrap_or(true),
        source_url: row
            .try_get::<String, _>("source_url")
            .unwrap_or_else(|_| String::new()),
        last_update_at: row
            .try_get::<Option<DateTime<Utc>>, _>("last_update_at")
            .unwrap_or(None),
        last_update_error: row
            .try_get::<Option<String>, _>("last_update_error")
            .unwrap_or(None),
    })
}

pub async fn set_settings(
    pool: &PgPool,
    enabled: bool,
    auto_update: bool,
    source_url: &str,
) -> Result<()> {
    sqlx::query(
        r"
        UPDATE url_categorization_settings
        SET enabled = $1,
            auto_update = $2,
            source_url = $3
        WHERE id = 1
        ",
    )
    .bind(enabled)
    .bind(auto_update)
    .bind(source_url)
    .execute(pool)
    .await?;
    Ok(())
}

async fn record_update_ok(pool: &PgPool) -> Result<()> {
    sqlx::query(
        r"
        UPDATE url_categorization_settings
        SET last_update_at = NOW(),
            last_update_error = NULL
        WHERE id = 1
        ",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn record_update_err(pool: &PgPool, err: &str) -> Result<()> {
    sqlx::query(
        r"
        UPDATE url_categorization_settings
        SET last_update_error = $1
        WHERE id = 1
        ",
    )
    .bind(err)
    .execute(pool)
    .await?;
    Ok(())
}

pub fn normalize_hostname(host: &str) -> String {
    let raw = host.trim().trim_end_matches('.').to_lowercase();
    if raw.is_empty() {
        return String::new();
    }
    domain_to_ascii(&raw).unwrap_or(raw)
}

/// True only when `raw` looks like a finished browser navigation, not omnibox typing.
///
/// `UIAutomation` reads the address bar edit control, so partial input (e.g. `anti` while
/// typing `antigravity.com`) must be ignored for URL history and analytics.
pub fn looks_like_complete_navigation_url(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_ascii_lowercase();

    // Internal / special browser destinations — never treat as partial search text.
    if lower.starts_with("chrome:")
        || lower.starts_with("edge:")
        || lower.starts_with("brave:")
        || lower.starts_with("about:")
        || lower.starts_with("file:")
        || lower.starts_with("moz-extension:")
        || lower.starts_with("devtools:")
    {
        return true;
    }

    let to_parse = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };

    let Ok(u) = url::Url::parse(&to_parse) else {
        return false;
    };

    let Some(host) = u.host_str() else {
        return false;
    };

    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    if host.starts_with('[')
        && host.ends_with(']')
        && host[1..host.len() - 1].parse::<IpAddr>().is_ok()
    {
        return true;
    }
    // Reject single-label hosts (`anti`, `searchterm`) — real public sites use a registered name with a dot.
    host.contains('.')
}

pub fn extract_hostname_from_url(url: &str) -> String {
    let raw = url.trim();
    if raw.is_empty() {
        return String::new();
    }
    let href = if raw.to_lowercase().starts_with("http://")
        || raw.to_lowercase().starts_with("https://")
    {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    if let Ok(u) = url::Url::parse(&href) {
        u.host_str().map(normalize_hostname).unwrap_or_default()
    } else {
        // Fallback: take first token up to a delimiter.
        let host = raw.split(['/', ':', '?', '#']).next().unwrap_or("");
        normalize_hostname(host)
    }
}

fn suffix_candidates(hostname: &str) -> Vec<String> {
    // Example: a.b.c -> ["a.b.c","b.c","c"]
    let parts: Vec<&str> = hostname.split('.').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::new();
    for i in 0..parts.len() {
        out.push(parts[i..].join("."));
    }
    out
}

async fn job_set(
    pool: &PgPool,
    state: &str,
    bytes_done: i64,
    bytes_total: Option<i64>,
    message: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r"
        UPDATE url_categorization_job
        SET state = $1,
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW(),
            bytes_done = $2,
            bytes_total = $3,
            message = $4
        WHERE id = 1
        ",
    )
    .bind(state)
    .bind(bytes_done.max(0))
    .bind(bytes_total)
    .bind(message)
    .execute(pool)
    .await?;
    Ok(())
}

async fn job_reset(pool: &PgPool) -> Result<()> {
    sqlx::query(
        r"
        UPDATE url_categorization_job
        SET state = 'idle',
            started_at = NULL,
            updated_at = NOW(),
            bytes_total = NULL,
            bytes_done = 0,
            message = NULL
        WHERE id = 1
        ",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Fire-and-forget download/import job with persisted progress for the dashboard UI.
pub fn spawn_update_job(pool: PgPool, source_url: String) {
    tokio::spawn(async move {
        let cur: Option<String> =
            sqlx::query_scalar("SELECT state FROM url_categorization_job WHERE id = 1")
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
        if matches!(cur.as_deref(), Some("downloading" | "importing")) {
            return;
        }

        let _ = job_reset(&pool).await;
        let _ = job_set(&pool, "downloading", 0, None, Some("Starting download")).await;

        // Guard against panics/timeouts leaving the persisted job state stuck forever.
        let res = AssertUnwindSafe(async {
            tokio::time::timeout(Duration::from_secs(30 * 60), async {
                let client = reqwest::Client::new();
                let resp = client.get(&source_url).send().await?;
                let total = resp.content_length().and_then(|u| i64::try_from(u).ok());

                let mut bytes_done: i64 = 0;
                let mut buf: Vec<u8> = Vec::new();
                let mut stream = resp.bytes_stream();

                let mut last_update = std::time::Instant::now();
                while let Some(chunk) = stream.next().await {
                    let chunk: bytes::Bytes = chunk?;
                    bytes_done = bytes_done.saturating_add(chunk.len() as i64);
                    buf.extend_from_slice(&chunk);

                    if last_update.elapsed() >= Duration::from_millis(500) {
                        let _ = job_set(&pool, "downloading", bytes_done, total, None).await;
                        last_update = std::time::Instant::now();
                    }
                }

                let _ = job_set(
                    &pool,
                    "importing",
                    bytes_done,
                    total,
                    Some("Importing lists"),
                )
                .await;
                let sha256 = db::sha256_hex_bytes(&buf);
                import_from_targz_bytes(&pool, &buf, &sha256).await?;
                record_update_ok(&pool).await?;
                let _ = job_set(&pool, "ready", bytes_done, total, Some("Ready")).await;
                Ok::<(), anyhow::Error>(())
            })
            .await
            .map_err(|_| anyhow::anyhow!("update job timed out"))?
        })
        .catch_unwind()
        .await;

        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let msg = format!("{e:#}");
                let _ = record_update_err(&pool, &msg).await;
                let _ = job_set(&pool, "error", 0, None, Some(msg.as_str())).await;
            }
            Err(_) => {
                let msg = "update job panicked".to_string();
                let _ = record_update_err(&pool, &msg).await;
                let _ = job_set(&pool, "error", 0, None, Some(msg.as_str())).await;
            }
        }
    });
}

async fn import_from_targz_bytes(pool: &PgPool, bytes: &[u8], sha256: &str) -> Result<()> {
    // Create release metadata row (not strictly required, but useful for UI).
    let release_id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO url_categorization_release (version, sha256, active)
        VALUES ($1, $2, false)
        RETURNING id
        ",
    )
    .bind("sha256")
    .bind(sha256)
    .fetch_one(pool)
    .await?;

    // Parse archive and accumulate entries per category.
    let mut gz = GzDecoder::new(bytes);
    let mut tar_bytes = Vec::new();
    gz.read_to_end(&mut tar_bytes)?;
    let mut ar = Archive::new(std::io::Cursor::new(tar_bytes));

    // category_key -> { domains, url_prefixes }
    let mut cat_domains: HashMap<String, Vec<String>> = HashMap::new();
    let mut cat_urls: HashMap<String, Vec<String>> = HashMap::new();

    for entry in ar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let path_str = path.to_string_lossy().to_string();
        // Support both UT1 tarball and GitHub repo tarball layouts.
        // We look for .../blacklists/<category>/(domains|urls)
        let parts: Vec<&str> = path_str.split('/').collect();
        let mut idx = None;
        for (i, p) in parts.iter().enumerate() {
            if *p == "blacklists" {
                idx = Some(i);
                break;
            }
        }
        let Some(i) = idx else {
            continue;
        };
        if parts.len() < i + 3 {
            continue;
        }
        let category = parts[i + 1];
        let leaf = parts[i + 2];
        if category.is_empty() {
            continue;
        }
        if leaf != "domains" && leaf != "urls" {
            continue;
        }
        let mut s = String::new();
        entry.read_to_string(&mut s).ok();
        if s.trim().is_empty() {
            continue;
        }
        if leaf == "domains" {
            let v = cat_domains.entry(category.to_string()).or_default();
            for line in s.lines() {
                let t = line.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                let d = normalize_hostname(t);
                if !d.is_empty() {
                    v.push(d);
                }
            }
        } else {
            let v = cat_urls.entry(category.to_string()).or_default();
            for line in s.lines() {
                let t = line.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                // Store a normalized absolute prefix if possible, else keep raw.
                let norm = if let Ok(u) = url::Url::parse(t) {
                    u.to_string()
                } else if t.starts_with("http://") || t.starts_with("https://") {
                    t.to_string()
                } else {
                    format!("https://{t}")
                };
                v.push(norm);
            }
        }
    }

    // Transaction: wipe existing entries, upsert categories, insert entries, activate new release (single active).
    let mut tx = pool.begin().await?;

    // Clear old active release + entries.
    sqlx::query("UPDATE url_categorization_release SET active = false WHERE active = true")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM url_category_domain_entries")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM url_category_url_entries")
        .execute(&mut *tx)
        .await?;

    // Ensure categories exist and build key->id map.
    let mut cat_id: HashMap<String, i64> = HashMap::new();
    for key in cat_domains.keys().chain(cat_urls.keys()) {
        let id: i64 = sqlx::query_scalar(
            r"
            INSERT INTO url_categories (key, enabled)
            VALUES ($1, true)
            ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
            RETURNING id
            ",
        )
        .bind(key)
        .fetch_one(&mut *tx)
        .await?;
        cat_id.insert(key.clone(), id);
    }

    // Bulk insert entries (chunked).
    for (key, domains) in cat_domains {
        let Some(&id) = cat_id.get(&key) else {
            continue;
        };
        // Smaller chunks reduce statement size and avoid slow-query log spam on some setups.
        for chunk in domains.chunks(2_000) {
            let mut qb = sqlx::QueryBuilder::new(
                "INSERT INTO url_category_domain_entries (category_id, domain) ",
            );
            qb.push_values(chunk, |mut b, d| {
                b.push_bind(id).push_bind(d);
            });
            qb.push(" ON CONFLICT DO NOTHING");
            qb.build().execute(&mut *tx).await?;
        }
    }
    for (key, prefixes) in cat_urls {
        let Some(&id) = cat_id.get(&key) else {
            continue;
        };
        for chunk in prefixes.chunks(2_000) {
            let mut qb = sqlx::QueryBuilder::new(
                "INSERT INTO url_category_url_entries (category_id, url_prefix) ",
            );
            qb.push_values(chunk, |mut b, p| {
                b.push_bind(id).push_bind(p);
            });
            qb.push(" ON CONFLICT DO NOTHING");
            qb.build().execute(&mut *tx).await?;
        }
    }

    sqlx::query("UPDATE url_categorization_release SET active = true WHERE id = $1")
        .bind(release_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

/// Spawn background tasks (queue worker + optional auto-update loop).
pub fn spawn(state: Arc<AppState>) {
    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let settings = match get_settings(&st.db).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "url_categorization get_settings failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            if settings.enabled {
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    let st_worker = state.clone();
    tokio::spawn(async move {
        loop {
            let settings = match get_settings(&st_worker.db).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "url_categorization get_settings failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            if !settings.enabled {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            if let Err(e) = worker_tick(&st_worker).await {
                tracing::warn!(error = %e, "url_categorization worker_tick failed");
            }
            tokio::time::sleep(Duration::from_millis(WORKER_POLL_MS)).await;
        }
    });

    tokio::spawn(async move {
        loop {
            let settings = match get_settings(&state.db).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "url_categorization get_settings failed");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    continue;
                }
            };
            if settings.enabled && settings.auto_update {
                spawn_update_job(state.db.clone(), settings.source_url.clone());
            }
            tokio::time::sleep(Duration::from_secs(AUTO_UPDATE_INTERVAL_SECS)).await;
        }
    });
}

async fn worker_tick(state: &Arc<AppState>) -> Result<()> {
    // Pop a batch.
    let rows = sqlx::query(
        r"
        SELECT url_visit_id, agent_id, ts, url, hostname
        FROM url_categorization_queue
        ORDER BY ts ASC
        LIMIT $1
        ",
    )
    .bind(WORKER_BATCH)
    .fetch_all(&state.db)
    .await?;

    if rows.is_empty() {
        return Ok(());
    }

    for r in rows {
        let visit_id: i64 = r.try_get("url_visit_id")?;
        let agent_id: Uuid = r.try_get("agent_id")?;
        let ts: DateTime<Utc> = r.try_get("ts")?;
        let url: String = r.try_get("url")?;
        let hostname_raw: String = r.try_get("hostname")?;
        let hostname = if hostname_raw.is_empty() {
            extract_hostname_from_url(&url)
        } else {
            hostname_raw
        };
        let cat = categorize_url_now(&state.db, &hostname, &url).await?;
        let category_id = cat.as_ref().map(|(id, _)| *id);

        // Persist mapping.
        sqlx::query(
            r"
            INSERT INTO url_visit_category (url_visit_id, category_id)
            VALUES ($1, $2)
            ON CONFLICT (url_visit_id) DO UPDATE
            SET category_id = EXCLUDED.category_id,
                categorized_at = NOW()
            ",
        )
        .bind(visit_id)
        .bind(category_id)
        .execute(&state.db)
        .await?;

        if let Some((cid, ref cat_key)) = cat {
            sqlx::query(
                r"
                INSERT INTO url_category_stats (agent_id, category_id, visit_count, last_ts)
                VALUES ($1, $2, 1, $3)
                ON CONFLICT (agent_id, category_id) DO UPDATE
                SET visit_count = url_category_stats.visit_count + 1,
                    last_ts = GREATEST(url_category_stats.last_ts, EXCLUDED.last_ts)
                ",
            )
            .bind(agent_id)
            .bind(cid)
            .bind(ts)
            .execute(&state.db)
            .await?;

            // Fire category-based alert rules asynchronously.
            let agent_name = db::agent_name_by_id(&state.db, agent_id)
                .await
                .unwrap_or_default()
                .unwrap_or_else(|| "unknown".to_string());
            let payload = serde_json::json!({
                "url": url,
                "hostname": hostname,
                "category_id": cid,
                "category_key": cat_key,
            });
            alert_rules::on_url_category_event(state, agent_id, agent_name.as_str(), &payload)
                .await;
        }

        // Remove from queue.
        sqlx::query("DELETE FROM url_categorization_queue WHERE url_visit_id = $1")
            .bind(visit_id)
            .execute(&state.db)
            .await?;
    }

    Ok(())
}

async fn categorize_override(
    pool: &PgPool,
    hostname: &str,
    url_str: &str,
) -> Result<Option<(i64, String)>> {
    // Domain overrides: exact or suffix via equality on candidate suffixes.
    let host = normalize_hostname(hostname);
    if !host.is_empty() {
        let suffixes = suffix_candidates(&host);
        let row = sqlx::query(
            r"
            SELECT o.category_id, c.key
            FROM url_category_overrides_domain o
            JOIN url_categories c ON c.id = o.category_id
            WHERE c.enabled = true
              AND o.domain = ANY($1)
            LIMIT 1
            ",
        )
        .bind(&suffixes)
        .fetch_optional(pool)
        .await?;
        if let Some(r) = row {
            return Ok(Some((
                r.try_get::<i64, _>("category_id")?,
                r.try_get::<String, _>("key")?,
            )));
        }
    }

    // URL prefix overrides.
    let url_norm = if let Ok(u) = url::Url::parse(url_str) {
        u.to_string()
    } else {
        let href = if url_str.to_lowercase().starts_with("http://")
            || url_str.to_lowercase().starts_with("https://")
        {
            url_str.to_string()
        } else {
            format!("https://{url_str}")
        };
        href
    };
    let row = sqlx::query(
        r"
        SELECT o.category_id, c.key
        FROM url_category_overrides_url o
        JOIN url_categories c ON c.id = o.category_id
        WHERE c.enabled = true
          AND $1 LIKE (o.url_prefix || '%')
        LIMIT 1
        ",
    )
    .bind(&url_norm)
    .fetch_optional(pool)
    .await?;
    if let Some(r) = row {
        return Ok(Some((
            r.try_get::<i64, _>("category_id")?,
            r.try_get::<String, _>("key")?,
        )));
    }
    Ok(None)
}

pub async fn categorize_url_now(
    pool: &PgPool,
    hostname: &str,
    url_str: &str,
) -> Result<Option<(i64, String)>> {
    if let Some(v) = categorize_override(pool, hostname, url_str).await? {
        return Ok(Some(v));
    }
    let host = normalize_hostname(hostname);
    if host.is_empty() {
        return Ok(None);
    }

    // 1) Domain match: any enabled category where entry equals host or suffix.
    let suffixes = suffix_candidates(&host);
    let row = sqlx::query(
        r"
        SELECT e.category_id, c.key
        FROM url_category_domain_entries e
        JOIN url_categories c ON c.id = e.category_id
        WHERE c.enabled = true
          AND e.domain = ANY($1)
        LIMIT 1
        ",
    )
    .bind(&suffixes)
    .fetch_optional(pool)
    .await?;
    if let Some(r) = row {
        return Ok(Some((
            r.try_get::<i64, _>("category_id")?,
            r.try_get::<String, _>("key")?,
        )));
    }

    // 2) URL prefix match (optional).
    let url_norm = if let Ok(u) = url::Url::parse(url_str) {
        u.to_string()
    } else {
        let href = if url_str.to_lowercase().starts_with("http://")
            || url_str.to_lowercase().starts_with("https://")
        {
            url_str.to_string()
        } else {
            format!("https://{url_str}")
        };
        href
    };
    let row = sqlx::query(
        r"
        SELECT e.category_id, c.key
        FROM url_category_url_entries e
        JOIN url_categories c ON c.id = e.category_id
        WHERE c.enabled = true
          AND $1 LIKE (e.url_prefix || '%')
        LIMIT 1
        ",
    )
    .bind(&url_norm)
    .fetch_optional(pool)
    .await?;
    if let Some(r) = row {
        return Ok(Some((
            r.try_get::<i64, _>("category_id")?,
            r.try_get::<String, _>("key")?,
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod navigation_url_tests {
    use super::looks_like_complete_navigation_url;

    #[test]
    fn rejects_partial_omnibox_host() {
        assert!(!looks_like_complete_navigation_url("anti"));
        assert!(!looks_like_complete_navigation_url("  anti  "));
    }

    #[test]
    fn accepts_typical_urls() {
        assert!(looks_like_complete_navigation_url(
            "https://antigravity.com/path"
        ));
        assert!(looks_like_complete_navigation_url("antigravity.com/foo"));
        assert!(looks_like_complete_navigation_url("http://localhost:8080/"));
        assert!(looks_like_complete_navigation_url("http://127.0.0.1/"));
        assert!(looks_like_complete_navigation_url("http://[::1]/"));
    }

    #[test]
    fn accepts_browser_internal_schemes() {
        assert!(looks_like_complete_navigation_url("chrome://newtab/"));
        assert!(looks_like_complete_navigation_url("about:blank"));
    }
}
