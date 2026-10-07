//! URL categorization persistence.

use std::collections::HashMap;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
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

pub async fn record_update_ok(pool: &PgPool) -> Result<()> {
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

pub async fn record_update_err(pool: &PgPool, err: &str) -> Result<()> {
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

pub async fn job_set(
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

pub async fn job_reset(pool: &PgPool) -> Result<()> {
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

pub async fn job_state(pool: &PgPool) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT state FROM url_categorization_job WHERE id = 1")
            .fetch_optional(pool)
            .await?,
    )
}

/// Record a new (inactive) release row; [`activate_release`] makes it the active one.
pub async fn insert_release(pool: &PgPool, sha256: &str) -> Result<i64> {
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
    Ok(release_id)
}

/// Replace every list entry with the parsed release (`category_key -> domains / url prefixes`)
/// and make `release_id` the single active release, atomically.
pub async fn activate_release(
    pool: &PgPool,
    release_id: i64,
    cat_domains: HashMap<String, Vec<String>>,
    cat_urls: HashMap<String, Vec<String>>,
) -> Result<()> {
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

pub struct QueuedVisit {
    pub url_visit_id: i64,
    pub agent_id: Uuid,
    pub ts: DateTime<Utc>,
    pub url: String,
    pub hostname: String,
}

pub async fn queue_batch(pool: &PgPool, limit: i64) -> Result<Vec<QueuedVisit>> {
    let rows = sqlx::query(
        r"
        SELECT url_visit_id, agent_id, ts, url, hostname
        FROM url_categorization_queue
        ORDER BY ts ASC
        LIMIT $1
        ",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(QueuedVisit {
            url_visit_id: r.try_get("url_visit_id")?,
            agent_id: r.try_get("agent_id")?,
            ts: r.try_get("ts")?,
            url: r.try_get("url")?,
            hostname: r.try_get("hostname")?,
        });
    }
    Ok(out)
}

pub async fn set_visit_category(
    pool: &PgPool,
    visit_id: i64,
    category_id: Option<i64>,
) -> Result<()> {
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
    .bind(category_id)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dequeue(pool: &PgPool, visit_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM url_categorization_queue WHERE url_visit_id = $1")
        .bind(visit_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn category_hit(row: Option<sqlx::postgres::PgRow>) -> Result<Option<(i64, String)>> {
    match row {
        Some(r) => Ok(Some((
            r.try_get::<i64, _>("category_id")?,
            r.try_get::<String, _>("key")?,
        ))),
        None => Ok(None),
    }
}

/// Enabled category of a domain override matching any of `suffixes`.
pub async fn override_domain_match(
    pool: &PgPool,
    suffixes: &[String],
) -> Result<Option<(i64, String)>> {
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
    .bind(suffixes)
    .fetch_optional(pool)
    .await?;
    category_hit(row)
}

/// Enabled category of a URL-prefix override matching `url_norm`.
pub async fn override_url_match(pool: &PgPool, url_norm: &str) -> Result<Option<(i64, String)>> {
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
    .bind(url_norm)
    .fetch_optional(pool)
    .await?;
    category_hit(row)
}

/// Enabled UT1 category whose domain list contains any of `suffixes`.
pub async fn domain_entry_match(
    pool: &PgPool,
    suffixes: &[String],
) -> Result<Option<(i64, String)>> {
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
    .bind(suffixes)
    .fetch_optional(pool)
    .await?;
    category_hit(row)
}

/// Enabled UT1 category whose URL list has a prefix of `url_norm`.
pub async fn url_entry_match(pool: &PgPool, url_norm: &str) -> Result<Option<(i64, String)>> {
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
    .bind(url_norm)
    .fetch_optional(pool)
    .await?;
    category_hit(row)
}

/// `(id, url, hostname)` of the most recent URL sessions.
pub async fn recent_sessions(pool: &PgPool, limit: i64) -> Result<Vec<(i64, String, String)>> {
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
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let url: String = r.try_get("url").unwrap_or_default();
        let hostname: String = r.try_get("hostname").unwrap_or_default();
        out.push((id, url, hostname));
    }
    Ok(out)
}

pub async fn set_session_category(pool: &PgPool, id: i64, category_id: Option<i64>) -> Result<u64> {
    let res = sqlx::query("UPDATE url_sessions SET category_id = $1 WHERE id = $2")
        .bind(category_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ─── Admin status ────────────────────────────────────────────────────────────

pub async fn active_release_sha(pool: &PgPool) -> Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT sha256 FROM url_categorization_release WHERE active = true ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn count_categories(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_categories")
            .fetch_one(pool)
            .await?,
    )
}

pub async fn count_domain_entries(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_category_domain_entries")
            .fetch_one(pool)
            .await?,
    )
}

pub async fn count_url_entries(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_category_url_entries")
            .fetch_one(pool)
            .await?,
    )
}

/// Progress of the list download/import job, as shown by the admin UI.
#[derive(Serialize)]
pub struct JobStatus {
    pub state: String,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub bytes_total: Option<i64>,
    pub bytes_done: i64,
    pub message: Option<String>,
}

pub async fn job_status(pool: &PgPool) -> Result<Option<JobStatus>> {
    let row = sqlx::query(
        "SELECT state, started_at, updated_at, bytes_total, bytes_done, message FROM url_categorization_job WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| JobStatus {
        state: r.try_get("state").unwrap_or_else(|_| "idle".to_string()),
        started_at: r.try_get("started_at").ok().flatten(),
        updated_at: r.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
        bytes_total: r.try_get("bytes_total").ok().flatten(),
        bytes_done: r.try_get("bytes_done").unwrap_or(0),
        message: r.try_get("message").ok().flatten(),
    }))
}

// ─── Categories ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CategoryRow {
    pub key: String,
    pub label: String,
    pub enabled: bool,
    pub description: String,
}

pub async fn list_categories(pool: &PgPool) -> Result<Vec<CategoryRow>> {
    let rows = sqlx::query(
        r"
        SELECT c.key,
               c.enabled,
               COALESCE(l.description_en, c.description, '') AS description,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS label
        FROM url_categories c
        LEFT JOIN url_category_labels l ON l.key = c.key
        ORDER BY c.key ASC
        ",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let key: String = r.try_get("key").unwrap_or_default();
            let enabled: bool = r.try_get("enabled").unwrap_or(true);
            let description: String = r.try_get("description").unwrap_or_default();
            let label: String = r.try_get("label").unwrap_or_else(|_| key.clone());
            CategoryRow {
                key,
                label,
                enabled,
                description,
            }
        })
        .collect())
}

/// One category toggle; `label` (already trimmed, non-empty) also upserts the display label.
pub struct CategoryUpdate<'a> {
    pub key: &'a str,
    pub enabled: bool,
    pub label: Option<&'a str>,
    pub description: &'a str,
}

pub async fn set_categories(pool: &PgPool, updates: &[CategoryUpdate<'_>]) -> Result<()> {
    let mut tx = pool.begin().await?;
    for c in updates {
        sqlx::query("UPDATE url_categories SET enabled = $1 WHERE key = $2")
            .bind(c.enabled)
            .bind(c.key)
            .execute(&mut *tx)
            .await?;
        if let Some(label) = c.label {
            sqlx::query(
                r"
                INSERT INTO url_category_labels (key, label_en, description_en, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (key) DO UPDATE
                    SET label_en = EXCLUDED.label_en,
                        description_en = EXCLUDED.description_en,
                        updated_at = NOW()
                ",
            )
            .bind(c.key)
            .bind(label)
            .bind(c.description)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn category_id_by_key(pool: &PgPool, key: &str) -> Result<Option<i64>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM url_categories WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?,
    )
}

// ─── Overrides ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OverrideRow {
    pub id: i64,
    pub kind: String,
    pub value: String,
    pub category_key: String,
    pub category_label: String,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

/// Domain overrides then URL-prefix overrides, each newest first and paged independently.
pub async fn list_overrides(
    pool: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<OverrideRow>> {
    let domain_rows = sqlx::query(
        r"
        SELECT o.id, 'domain' AS kind, o.domain AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_domain o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.domain ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(query)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await;

    let url_rows = sqlx::query(
        r"
        SELECT o.id, 'url' AS kind, o.url_prefix AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_url o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.url_prefix ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(query)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await;

    let (d, u) = match (domain_rows, url_rows) {
        (Ok(d), Ok(u)) => (d, u),
        (Err(e), _) | (_, Err(e)) => return Err(e.into()),
    };
    Ok(d.into_iter()
        .chain(u)
        .map(|r| OverrideRow {
            id: r.try_get::<i64, _>("id").unwrap_or_default(),
            kind: r
                .try_get::<String, _>("kind")
                .unwrap_or_else(|_| "domain".into()),
            value: r.try_get::<String, _>("value").unwrap_or_default(),
            category_key: r.try_get::<String, _>("category_key").unwrap_or_default(),
            category_label: r.try_get::<String, _>("category_label").unwrap_or_default(),
            note: r.try_get::<String, _>("note").unwrap_or_default(),
            created_at: r
                .try_get::<DateTime<Utc>, _>("created_at")
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

pub enum OverrideTarget {
    Domain(String),
    UrlPrefix(String),
}

/// Distinguishes the override upsert failing (e.g. a lock timeout) from the surrounding
/// transaction plumbing failing.
pub enum OverrideWriteError {
    Insert(sqlx::Error),
    Tx(sqlx::Error),
}

/// Upsert a domain or URL-prefix override with short lock/statement timeouts so the admin
/// UI doesn't hang if another transaction holds locks on the overrides tables.
pub async fn upsert_override(
    pool: &PgPool,
    category_id: i64,
    target: &OverrideTarget,
    note: &str,
) -> std::result::Result<(), OverrideWriteError> {
    let mut tx = pool.begin().await.map_err(OverrideWriteError::Tx)?;
    sqlx::query("SET LOCAL lock_timeout = '1s'")
        .execute(&mut *tx)
        .await
        .map_err(OverrideWriteError::Tx)?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await
        .map_err(OverrideWriteError::Tx)?;

    let res = match target {
        OverrideTarget::Domain(domain) => sqlx::query(
            r"INSERT INTO url_category_overrides_domain (category_id, domain, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (domain) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
        )
        .bind(category_id)
        .bind(domain)
        .bind(note)
        .execute(&mut *tx)
        .await,
        OverrideTarget::UrlPrefix(url_prefix) => sqlx::query(
            r"INSERT INTO url_category_overrides_url (category_id, url_prefix, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (url_prefix) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
        )
        .bind(category_id)
        .bind(url_prefix)
        .bind(note)
        .execute(&mut *tx)
        .await,
    };
    if let Err(e) = res {
        let _ = tx.rollback().await;
        return Err(OverrideWriteError::Insert(e));
    }
    tx.commit().await.map_err(OverrideWriteError::Tx)?;
    Ok(())
}

pub async fn delete_domain_override(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query("DELETE FROM url_category_overrides_domain WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

pub async fn delete_url_override(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query("DELETE FROM url_category_overrides_url WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

// ─── Custom rollup categories ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CustomCategoryRow {
    pub id: i64,
    pub key: String,
    pub label_en: String,
    pub description_en: String,
    pub display_order: i32,
    pub hidden: bool,
    pub updated_at: DateTime<Utc>,
    pub member_count: i64,
    pub ut1_keys: Vec<String>,
}

pub async fn list_custom_categories(pool: &PgPool) -> Result<Vec<CustomCategoryRow>> {
    let cats = sqlx::query(
        r"
        SELECT c.id, c.key, c.label_en, c.description_en, c.display_order, c.hidden, c.updated_at,
               COALESCE(m.member_count, 0)::bigint AS member_count
        FROM url_custom_categories c
        LEFT JOIN (
            SELECT custom_category_id, COUNT(*)::bigint AS member_count
            FROM url_custom_category_members
            GROUP BY custom_category_id
        ) m ON m.custom_category_id = c.id
        ORDER BY c.display_order ASC, c.label_en ASC, c.id ASC
        ",
    )
    .fetch_all(pool)
    .await;

    let members = sqlx::query(
        r"
        SELECT m.custom_category_id, m.ut1_key
        FROM url_custom_category_members m
        ORDER BY m.custom_category_id ASC, m.ut1_key ASC
        ",
    )
    .fetch_all(pool)
    .await;

    let (cats, members) = match (cats, members) {
        (Ok(cats), Ok(members)) => (cats, members),
        (Err(e), _) | (_, Err(e)) => return Err(e.into()),
    };
    let mut by_id: HashMap<i64, Vec<String>> = HashMap::new();
    for r in members {
        let id: i64 = r.try_get("custom_category_id").unwrap_or_default();
        let k: String = r.try_get("ut1_key").unwrap_or_default();
        by_id.entry(id).or_default().push(k);
    }
    Ok(cats
        .iter()
        .map(|r| {
            let id: i64 = r.try_get("id").unwrap_or_default();
            CustomCategoryRow {
                id,
                key: r.try_get::<String, _>("key").unwrap_or_default(),
                label_en: r.try_get::<String, _>("label_en").unwrap_or_default(),
                description_en: r.try_get::<String, _>("description_en").unwrap_or_default(),
                display_order: r.try_get::<i32, _>("display_order").unwrap_or(0),
                hidden: r.try_get::<bool, _>("hidden").unwrap_or(false),
                updated_at: r
                    .try_get::<DateTime<Utc>, _>("updated_at")
                    .unwrap_or_else(|_| Utc::now()),
                member_count: r.try_get::<i64, _>("member_count").unwrap_or(0),
                ut1_keys: by_id.get(&id).cloned().unwrap_or_default(),
            }
        })
        .collect())
}

pub async fn create_custom_category(
    pool: &PgPool,
    key: &str,
    label_en: &str,
    description_en: &str,
    display_order: i32,
    hidden: bool,
) -> Result<i64> {
    let r = sqlx::query(
        r"
        INSERT INTO url_custom_categories (key, label_en, description_en, display_order, hidden, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        RETURNING id
        ",
    )
    .bind(key)
    .bind(label_en)
    .bind(description_en)
    .bind(display_order)
    .bind(hidden)
    .fetch_one(pool)
    .await?;
    Ok(r.try_get("id").unwrap_or_default())
}

pub struct CustomCategory {
    pub key: String,
    pub label_en: String,
    pub description_en: String,
    pub display_order: i32,
    pub hidden: bool,
}

pub async fn get_custom_category(pool: &PgPool, id: i64) -> Result<Option<CustomCategory>> {
    let cur = sqlx::query("SELECT id, key, label_en, description_en, display_order, hidden FROM url_custom_categories WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(cur.map(|cur| CustomCategory {
        key: cur.try_get("key").unwrap_or_default(),
        label_en: cur.try_get("label_en").unwrap_or_default(),
        description_en: cur
            .try_get::<String, _>("description_en")
            .unwrap_or_default(),
        display_order: cur.try_get::<i32, _>("display_order").unwrap_or(0),
        hidden: cur.try_get::<bool, _>("hidden").unwrap_or(false),
    }))
}

pub async fn update_custom_category(
    pool: &PgPool,
    id: i64,
    label_en: &str,
    description_en: &str,
    display_order: i32,
    hidden: bool,
) -> Result<u64> {
    let r = sqlx::query(
        r"
        UPDATE url_custom_categories
        SET label_en = $2,
            description_en = $3,
            display_order = $4,
            hidden = $5,
            updated_at = NOW()
        WHERE id = $1
        ",
    )
    .bind(id)
    .bind(label_en)
    .bind(description_en)
    .bind(display_order)
    .bind(hidden)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

pub async fn custom_category_exists(pool: &PgPool, id: i64) -> Result<bool> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM url_custom_categories WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(exists.is_some())
}

/// Up to 25 of `keys` that are not known UT1 category keys.
pub async fn unknown_ut1_keys(pool: &PgPool, keys: &[String]) -> Result<Vec<String>> {
    let missing = sqlx::query(
        r"
        SELECT k AS missing
        FROM UNNEST($1::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM url_categories c WHERE c.key = k)
        LIMIT 25
        ",
    )
    .bind(keys)
    .fetch_all(pool)
    .await?;
    Ok(missing
        .iter()
        .map(|r| r.try_get::<String, _>("missing").unwrap_or_default())
        .collect())
}

pub async fn replace_custom_category_members(
    pool: &PgPool,
    id: i64,
    keys: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    if let Err(e) =
        sqlx::query("DELETE FROM url_custom_category_members WHERE custom_category_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
    {
        let _ = tx.rollback().await;
        return Err(e.into());
    }
    for k in keys {
        if let Err(e) = sqlx::query(
            "INSERT INTO url_custom_category_members (custom_category_id, ut1_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(k)
        .execute(&mut *tx)
        .await
        {
            let _ = tx.rollback().await;
            return Err(e.into());
        }
    }
    tx.commit().await?;
    Ok(())
}

pub async fn delete_custom_category(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query("DELETE FROM url_custom_categories WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}
