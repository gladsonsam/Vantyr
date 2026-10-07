//! URL categorization (UT1 blacklists): import categories and enrich URL visits for analytics + alert rules.
//!
//! Design constraints:
//! - Disabled by default (no downloads, no work).
//! - When enabled, keep exactly one active release's entries in DB (overwrite on update).
//! - Categorization is async via a DB queue to keep ingest fast.

use anyhow::Result;
use flate2::read::GzDecoder;
use futures_util::{FutureExt, StreamExt};
use idna::domain_to_ascii;
use sqlx::PgPool;
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;
use tar::Archive;

use super::db;
use crate::auth::secrets;
use crate::policy::alert_rules;
use crate::state::AppState;

/// Poll interval for the categorization queue worker.
const WORKER_POLL_MS: u64 = 750;
/// How many queued URL visits to process per batch.
const WORKER_BATCH: i64 = 250;
/// Auto-update check cadence (when enabled). Kept conservative.
const AUTO_UPDATE_INTERVAL_SECS: u64 = 6 * 60 * 60; // 6h

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

/// Fire-and-forget download/import job with persisted progress for the dashboard UI.
pub fn spawn_update_job(pool: PgPool, source_url: String) {
    tokio::spawn(async move {
        let cur: Option<String> = db::job_state(&pool).await.ok().flatten();
        if matches!(cur.as_deref(), Some("downloading" | "importing")) {
            return;
        }

        let _ = db::job_reset(&pool).await;
        let _ = db::job_set(&pool, "downloading", 0, None, Some("Starting download")).await;

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
                        let _ = db::job_set(&pool, "downloading", bytes_done, total, None).await;
                        last_update = std::time::Instant::now();
                    }
                }

                let _ = db::job_set(
                    &pool,
                    "importing",
                    bytes_done,
                    total,
                    Some("Importing lists"),
                )
                .await;
                let sha256 = secrets::sha256_hex_bytes(&buf);
                import_from_targz_bytes(&pool, &buf, &sha256).await?;
                db::record_update_ok(&pool).await?;
                let _ = db::job_set(&pool, "ready", bytes_done, total, Some("Ready")).await;
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
                let _ = db::record_update_err(&pool, &msg).await;
                let _ = db::job_set(&pool, "error", 0, None, Some(msg.as_str())).await;
            }
            Err(_) => {
                let msg = "update job panicked".to_string();
                let _ = db::record_update_err(&pool, &msg).await;
                let _ = db::job_set(&pool, "error", 0, None, Some(msg.as_str())).await;
            }
        }
    });
}

async fn import_from_targz_bytes(pool: &PgPool, bytes: &[u8], sha256: &str) -> Result<()> {
    // Create release metadata row (not strictly required, but useful for UI).
    let release_id = db::insert_release(pool, sha256).await?;

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

    db::activate_release(pool, release_id, cat_domains, cat_urls).await
}

/// Spawn background tasks (queue worker + optional auto-update loop).
pub fn spawn(state: Arc<AppState>) {
    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let settings = match db::get_settings(&st.db).await {
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
            let settings = match db::get_settings(&st_worker.db).await {
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
            let settings = match db::get_settings(&state.db).await {
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
    let rows = db::queue_batch(&state.db, WORKER_BATCH).await?;

    if rows.is_empty() {
        return Ok(());
    }

    for r in rows {
        let db::QueuedVisit {
            url_visit_id: visit_id,
            agent_id,
            ts,
            url,
            hostname: hostname_raw,
        } = r;
        let hostname = if hostname_raw.is_empty() {
            extract_hostname_from_url(&url)
        } else {
            hostname_raw
        };
        let cat = categorize_url_now(&state.db, &hostname, &url).await?;
        let category_id = cat.as_ref().map(|(id, _)| *id);

        // Persist mapping.
        db::set_visit_category(&state.db, visit_id, category_id).await?;

        if let Some((cid, ref cat_key)) = cat {
            db::bump_category_stats(&state.db, agent_id, cid, ts).await?;

            // Fire category-based alert rules asynchronously.
            let agent_name = crate::db::agent_name_by_id(&state.db, agent_id)
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
        db::dequeue(&state.db, visit_id).await?;
    }

    Ok(())
}

/// Absolute form used for URL-prefix matching (`https://` is assumed when no scheme is given).
fn normalize_url_for_prefix_match(url_str: &str) -> String {
    if let Ok(u) = url::Url::parse(url_str) {
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
    }
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
        if let Some(hit) = db::override_domain_match(pool, &suffixes).await? {
            return Ok(Some(hit));
        }
    }

    // URL prefix overrides.
    let url_norm = normalize_url_for_prefix_match(url_str);
    db::override_url_match(pool, &url_norm).await
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
    if let Some(hit) = db::domain_entry_match(pool, &suffixes).await? {
        return Ok(Some(hit));
    }

    // 2) URL prefix match (optional).
    let url_norm = normalize_url_for_prefix_match(url_str);
    db::url_entry_match(pool, &url_norm).await
}

/// Re-categorize the most recent URL sessions with the current overrides/UT1 lists.
/// Returns the number of sessions updated.
pub async fn recategorize_recent_sessions(pool: &PgPool, limit: i64) -> Result<i64> {
    // Load latest sessions and recompute category; update rows + aggregates best-effort.
    let rows = db::recent_sessions(pool, limit).await?;
    let mut updated: i64 = 0;
    for (id, url, hostname) in rows {
        let cat = categorize_url_now(pool, &hostname, &url).await?;
        let category_id: Option<i64> = cat.as_ref().map(|(cid, _)| *cid);
        if db::set_session_category(pool, id, category_id).await? > 0 {
            updated += 1;
        }
    }
    Ok(updated)
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
