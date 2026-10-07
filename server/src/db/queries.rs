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

/// PostgreSQL database bytes plus logical public-table storage. A partitioned
/// parent has no heap: explicitly sum its descendants (including indexes/TOAST)
/// instead of attributing retained Recall partitions to "other". Not blob usage.
pub async fn query_database_storage(pool: &PgPool) -> Result<serde_json::Value> {
    let db_size_bytes: i64 =
        sqlx::query_scalar("SELECT pg_database_size(current_database())::bigint")
            .fetch_one(pool)
            .await?;
    let tables = query_relation_storage(pool, "public").await?;
    storage_report(db_size_bytes, tables)
}

// Namespace is bound, not interpolated. Tests query only their temporary schema;
// production requests public non-partition relations. Walk only declarative
// partition children (one parent); ordinary inheritance tables remain separate
// entries, so a multiply inherited child is never charged to several parents.
async fn query_relation_storage(pool: &PgPool, schema: &str) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        r"
        WITH RECURSIVE storage_tree(root_oid, relation_oid) AS (
            SELECT c.oid, c.oid FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm')
              AND NOT c.relispartition
            UNION
            SELECT tree.root_oid, i.inhrelid FROM storage_tree tree
            JOIN pg_inherits i ON i.inhparent = tree.relation_oid
            JOIN pg_class child ON child.oid = i.inhrelid AND child.relispartition
        )
        SELECT root.relname::text AS name,
               SUM(pg_total_relation_size(tree.relation_oid))::bigint AS bytes
        FROM storage_tree tree JOIN pg_class root ON root.oid = tree.root_oid
        GROUP BY root.oid, root.relname ORDER BY bytes DESC, name ASC
    ",
    )
    .bind(schema)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| -> Result<serde_json::Value> {
            let name: String = r.try_get("name")?;
            let bytes: i64 = r.try_get("bytes")?;
            Ok(serde_json::json!({"name":name, "bytes":bytes}))
        })
        .collect()
}

fn storage_report(db_size_bytes: i64, tables: Vec<serde_json::Value>) -> Result<serde_json::Value> {
    let public_tables_bytes = tables.iter().try_fold(0_i64, |sum, table| {
        let bytes = table["bytes"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("invalid storage size"))?;
        anyhow::ensure!(bytes >= 0, "invalid storage size");
        sum.checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("storage size overflow"))
    })?;
    let other_bytes = db_size_bytes.saturating_sub(public_tables_bytes).max(0);
    Ok(serde_json::json!({
        "database_bytes":db_size_bytes, "public_tables_bytes":public_tables_bytes,
        "other_bytes":other_bytes, "tables":tables,
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

// ─── Analytics queries (URL sessions) ────────────────────────────────────────

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

#[cfg(test)]
#[path = "storage_accounting_tests.rs"]
mod storage_accounting_tests;
