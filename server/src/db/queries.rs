//! List / query / analytics helpers used by the API (carved out of the monolithic `db.rs`).

use super::*;

pub async fn list_agents(pool: &PgPool) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT id, name, first_seen, last_seen, icon FROM agents ORDER BY last_seen DESC",
    )
    .fetch_all(pool)
    .await?;

    // Propagate row-read failures with `?` instead of fabricating values (e.g. `Utc::now()` for a
    // missing `first_seen`), so schema drift fails loudly rather than returning silently-wrong data.
    rows.iter()
        .map(|r| {
            let id: Uuid = r.try_get("id")?;
            let name: String = r.try_get("name")?;
            let first: DateTime<Utc> = r.try_get("first_seen")?;
            let last: DateTime<Utc> = r.try_get("last_seen")?;
            let icon: Option<String> = r.try_get("icon")?;
            Ok(serde_json::json!({ "id": id, "name": name, "first_seen": first, "last_seen": last, "icon": icon }))
        })
        .collect()
}

/// Set (or clear) an agent icon label.
pub async fn set_agent_icon(pool: &PgPool, agent_id: Uuid, icon: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE agents SET icon = $2 WHERE id = $1")
        .bind(agent_id)
        .bind(icon)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_agent_icon(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar("SELECT icon FROM agents WHERE id = $1")
        .bind(agent_id)
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(v)
}

pub async fn insert_audit_log(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO audit_log (actor, agent_id, action, status, detail, client_ip) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(actor)
    .bind(agent_id)
    .bind(action)
    .bind(status)
    .bind(detail)
    .bind(client_ip)
    .execute(pool)
    .await?;

    emit_audit_tracing_line(actor, action, status, client_ip);

    Ok(())
}

/// Insert an audit row unless an identical recent row already exists.
///
/// "Identical" means same actor/agent/action/status/detail JSON and within
/// `dedup_window_secs` from now.
pub async fn insert_audit_log_dedup(pool: &PgPool, row: AuditLogDedup<'_>) -> Result<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        r"
        SELECT id
        FROM audit_log
        WHERE actor = $1
          AND (($2::uuid IS NULL AND agent_id IS NULL) OR agent_id = $2)
          AND action = $3
          AND status = $4
          AND detail = $5::jsonb
          AND (client_ip IS NOT DISTINCT FROM $7::text)
          AND ts > NOW() - ($6::bigint * INTERVAL '1 second')
        ORDER BY ts DESC
        LIMIT 1
        ",
    )
    .bind(row.actor)
    .bind(row.agent_id)
    .bind(row.action)
    .bind(row.status)
    .bind(row.detail)
    .bind(row.dedup_window_secs)
    .bind(row.client_ip)
    .fetch_optional(pool)
    .await?;

    if exists.is_none() {
        insert_audit_log(
            pool,
            row.actor,
            row.agent_id,
            row.action,
            row.status,
            row.detail,
            row.client_ip,
        )
        .await?;
    }

    Ok(())
}

/// Like [`insert_audit_log`], but emits a warning when the insert fails (HTTP handlers may still return 200).
pub async fn insert_audit_log_traced(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) {
    if let Err(e) = insert_audit_log(pool, actor, agent_id, action, status, detail, client_ip).await
    {
        tracing::warn!(error = %e, action, "audit log insert failed");
    }
}

/// Like [`insert_audit_log_dedup`], but warns on failure.
pub async fn insert_audit_log_dedup_traced(pool: &PgPool, row: AuditLogDedup<'_>) {
    if let Err(e) = insert_audit_log_dedup(pool, row).await {
        tracing::warn!(error = %e, action = row.action, "audit log dedup insert failed");
    }
}

pub async fn query_audit_log(
    pool: &PgPool,
    agent_id: Option<Uuid>,
    action: Option<&str>,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<AuditRecord>> {
    let rows = sqlx::query(
        r"
        SELECT id, ts, actor, client_ip, agent_id, action, status, detail
        FROM audit_log
        WHERE ($1::uuid IS NULL OR agent_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY ts DESC
        LIMIT $4 OFFSET $5
        ",
    )
    .bind(agent_id)
    .bind(action)
    .bind(status)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| AuditRecord {
            id: r.try_get("id").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_else(|_| Utc::now()),
            actor: r
                .try_get("actor")
                .unwrap_or_else(|_| "dashboard".to_string()),
            client_ip: r.try_get("client_ip").ok(),
            agent_id: r.try_get("agent_id").ok(),
            action: r.try_get("action").unwrap_or_default(),
            status: r.try_get("status").unwrap_or_else(|_| "ok".to_string()),
            detail: r
                .try_get("detail")
                .unwrap_or_else(|_| serde_json::json!({})),
        })
        .collect())
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

pub async fn query_top_windows(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<WindowTopRow>> {
    let rows = sqlx::query(
        r"
        SELECT app, app_display, title, focus_count, last_ts
        FROM window_top_stats
        WHERE agent_id = $1
        ORDER BY focus_count DESC, last_ts DESC
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
        .map(|r| WindowTopRow {
            app: r.try_get("app").unwrap_or_default(),
            app_display: r.try_get("app_display").unwrap_or_default(),
            title: r.try_get("title").unwrap_or_default(),
            focus_count: r.try_get("focus_count").unwrap_or_default(),
            last_ts: r.try_get("last_ts").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

/// Disk usage for the connected database (`pg_database_size`) plus a per-relation breakdown
/// for the `public` schema. Partition children are omitted — their storage is counted on the
/// parent (`pg_total_relation_size` on a partitioned table includes all partitions).
pub async fn query_database_storage(pool: &PgPool) -> Result<serde_json::Value> {
    let db_size_bytes: i64 =
        sqlx::query_scalar("SELECT pg_database_size(current_database())::bigint")
            .fetch_one(pool)
            .await?;

    let table_rows = sqlx::query(
        r"
        SELECT
            c.relname::text AS name,
            pg_total_relation_size(c.oid)::bigint AS bytes
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'm')
          AND NOT c.relispartition
        ORDER BY bytes DESC
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut public_tables_bytes: i64 = 0;
    let tables = table_rows
        .iter()
        .map(|r| {
            let name = r.try_get::<String, _>("name").unwrap_or_default();
            let bytes = r.try_get::<i64, _>("bytes").unwrap_or_default();
            public_tables_bytes += bytes;
            serde_json::json!({ "name": name, "bytes": bytes })
        })
        .collect::<Vec<_>>();

    let other_bytes = (db_size_bytes - public_tables_bytes).max(0);

    Ok(serde_json::json!({
        "database_bytes": db_size_bytes,
        "public_tables_bytes": public_tables_bytes,
        "other_bytes": other_bytes,
        "tables": tables
    }))
}

pub async fn query_windows(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT title, app, app_display, hwnd, ts, user_name \
         FROM window_events WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let title: String = r.try_get("title").unwrap_or_default();
            let app: String = r.try_get("app").unwrap_or_default();
            let app_display: String = r.try_get("app_display").unwrap_or_default();
            let hwnd: i64 = r.try_get("hwnd").unwrap_or_default();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({ "title": title, "app": app, "app_display": app_display, "hwnd": hwnd, "ts": ts, "user": user_name })
        })
        .collect())
}

pub async fn query_keys(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT app, app_display, window_title, text, started_at, updated_at, user_name \
         FROM key_sessions WHERE agent_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let app: String = r.try_get("app").unwrap_or_default();
            let app_display: String = r.try_get("app_display").unwrap_or_default();
            let window: String = r.try_get("window_title").unwrap_or_default();
            let text: String = r.try_get("text").unwrap_or_default();
            let started_at: DateTime<Utc> = r.try_get("started_at").unwrap_or_else(|_| Utc::now());
            let updated_at: DateTime<Utc> = r.try_get("updated_at").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({
                "app": app, "app_display": app_display,
                "window_title": window, "text": text,
                "started_at": started_at, "updated_at": updated_at,
                "user": user_name
            })
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

// ─── Analytics queries (URL sessions) ────────────────────────────────────────

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
        let cat = url_categorization::categorize_url_now(pool, &hostname, &url).await?;
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

pub async fn query_activity(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT event_type, idle_secs, ts, user_name \
         FROM activity_log WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let event_type: String = r.try_get("event_type").unwrap_or_default();
            let idle_secs: Option<i64> = r.try_get("idle_secs").ok().flatten();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({ "event_type": event_type, "idle_secs": idle_secs, "ts": ts, "user": user_name })
        })
        .collect())
}

/// Clear all telemetry history for an agent while keeping the `agents` row.
///
/// This is used by the dashboard "clear history" UX so operators can
/// selectively wipe what they previously recorded for a single client.
///
/// IMPORTANT: this keeps the `agents` row, so the `ON DELETE CASCADE` on
/// `agents(id)` does NOT fire — every per-agent telemetry AND derived/aggregate
/// table must be deleted explicitly, or a "clear history" silently leaves the
/// long-lived Top URLs / Top Apps / time-on-site aggregates behind (a privacy
/// and compliance problem). Run in one transaction so the wipe is all-or-nothing.
///
/// `url_visit_category` and `url_categorization_queue` reference `url_visits(id)`
/// with `ON DELETE CASCADE`, so deleting `url_visits` clears them automatically.
pub async fn clear_agent_history(pool: &PgPool, agent: Uuid) -> Result<u64> {
    let mut tx = pool.begin().await?;
    let mut total: u64 = 0;

    // Each (&str) is a static, compile-time table name — never user input.
    let deletes: &[&str] = &[
        // Raw telemetry
        "DELETE FROM window_events WHERE agent_id = $1",
        "DELETE FROM key_sessions WHERE agent_id = $1",
        "DELETE FROM url_visits WHERE agent_id = $1",
        "DELETE FROM activity_log WHERE agent_id = $1",
        // Websocket connection history (so "last seen" becomes empty)
        "DELETE FROM agent_sessions WHERE agent_id = $1",
        // Derived/aggregate tables that survive raw-row retention
        "DELETE FROM url_sessions WHERE agent_id = $1",
        "DELETE FROM url_top_stats WHERE agent_id = $1",
        "DELETE FROM window_top_stats WHERE agent_id = $1",
        "DELETE FROM url_site_stats WHERE agent_id = $1",
        "DELETE FROM url_category_stats WHERE agent_id = $1",
        "DELETE FROM url_category_time_stats WHERE agent_id = $1",
    ];

    for stmt in deletes {
        total = total.saturating_add(
            sqlx::query(stmt)
                .bind(agent)
                .execute(&mut *tx)
                .await?
                .rows_affected(),
        );
    }

    tx.commit().await?;
    Ok(total)
}
