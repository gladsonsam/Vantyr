//! Per-event telemetry persistence: window/key/URL/activity events and app icons.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::db::unix_to_dt;

pub async fn insert_window(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let title = v["title"].as_str().unwrap_or("");
    let app = v["app"].as_str().unwrap_or("");
    let app_display = v["app_display"].as_str().unwrap_or(app);
    let hwnd = v["hwnd"].as_i64().unwrap_or(0);
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query(
        "INSERT INTO window_events (agent_id, title, app, app_display, hwnd, ts, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(agent)
    .bind(title)
    .bind(app)
    .bind(app_display)
    .bind(hwnd)
    .bind(ts)
    .bind(user_name)
    .execute(pool)
    .await?;

    sqlx::query(
        r"
        INSERT INTO window_top_stats (agent_id, app, app_display, title, focus_count, last_ts)
        VALUES ($1, $2, $3, $4, 1, $5)
        ON CONFLICT (agent_id, app, title) DO UPDATE
        SET app_display = CASE
                WHEN EXCLUDED.app_display <> ''
                 AND lower(EXCLUDED.app_display) <> lower(window_top_stats.app)
                THEN EXCLUDED.app_display
                ELSE window_top_stats.app_display
            END,
            focus_count = window_top_stats.focus_count + 1,
            last_ts = GREATEST(window_top_stats.last_ts, EXCLUDED.last_ts)
        ",
    )
    .bind(agent)
    .bind(app)
    .bind(app_display)
    .bind(title)
    .bind(ts)
    .execute(pool)
    .await?;

    Ok(())
}

// ─── Key sessions ─────────────────────────────────────────────────────────────

/// Append text to an open session (same agent/app/window, updated ≤ 30 s ago).
/// Creates a new session row if no open one exists.
pub async fn upsert_keys(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let app = v["app"].as_str().unwrap_or("");
    let app_display = v["app_display"].as_str().unwrap_or(app);
    let window = v["window"].as_str().unwrap_or("");
    let text = v["text"].as_str().unwrap_or("");
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    let updated = sqlx::query(
        r"
        UPDATE key_sessions
        SET    text         = text || $1,
               app_display  = CASE
                                WHEN $2 <> '' AND lower($2) <> lower(app)
                                THEN $2 ELSE app_display
                              END,
               user_name    = COALESCE($6, user_name),
               updated_at   = NOW()
        WHERE  agent_id     = $3
          AND  app          = $4
          AND  window_title = $5
          AND  updated_at   > NOW() - INTERVAL '30 seconds'
        ",
    )
    .bind(text)
    .bind(app_display)
    .bind(agent)
    .bind(app)
    .bind(window)
    .bind(user_name)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        sqlx::query(
            "INSERT INTO key_sessions (agent_id, app, app_display, window_title, text, started_at, updated_at, user_name) \
             VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)",
        )
        .bind(agent)
        .bind(app)
        .bind(app_display)
        .bind(window)
        .bind(text)
        .bind(ts)
        .bind(user_name)
        .execute(pool)
        .await?;
    }

    Ok(())
}

// ─── URL visits ───────────────────────────────────────────────────────────────

// ─── URL sessions (time-on-site) ─────────────────────────────────────────────

// ─── Activity log ─────────────────────────────────────────────────────────────

pub async fn insert_activity(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let kind = v["type"].as_str().unwrap_or("");
    let idle_secs = v["idle_secs"].as_i64();
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query(
        "INSERT INTO activity_log (agent_id, event_type, idle_secs, ts, user_name) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(agent)
    .bind(kind)
    .bind(idle_secs)
    .bind(ts)
    .bind(user_name)
    .execute(pool)
    .await?;

    Ok(())
}

// ─── App icons (per exe) ─────────────────────────────────────────────────────

pub async fn upsert_app_icon(
    pool: &PgPool,
    agent: Uuid,
    exe_name: &str,
    png_bytes: &[u8],
) -> Result<()> {
    // Keep exe_name small-ish; the WS layer also validates, but DB functions should be safe too.
    let exe = exe_name.trim().to_lowercase();
    if exe.is_empty() {
        return Ok(());
    }

    sqlx::query(
        r"
        INSERT INTO app_icons (agent_id, exe_name, png_bytes, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_id, exe_name) DO UPDATE
        SET png_bytes = EXCLUDED.png_bytes,
            updated_at = NOW()
        ",
    )
    .bind(agent)
    .bind(&exe)
    .bind(png_bytes)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_app_icon_png(
    pool: &PgPool,
    agent: Uuid,
    exe_name: &str,
) -> Result<Option<Vec<u8>>> {
    let exe = exe_name.trim().to_lowercase();
    if exe.is_empty() {
        return Ok(None);
    }
    let v: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT png_bytes FROM app_icons WHERE agent_id=$1 AND exe_name=$2")
            .bind(agent)
            .bind(&exe)
            .fetch_optional(pool)
            .await?
            .flatten();
    Ok(v)
}

// ─── Agent resource metrics (health history) ───

/// Insert one resource sample from a `metrics` WS frame.
pub async fn insert_agent_metrics(
    pool: &PgPool,
    agent_id: Uuid,
    v: &serde_json::Value,
) -> Result<()> {
    let getf = |k: &str| v[k].as_f64().unwrap_or(0.0) as f32;
    let geti = |k: &str| {
        v[k].as_i64()
            .or_else(|| v[k].as_u64().map(|u| u as i64))
            .unwrap_or(0)
    };
    sqlx::query(
        "INSERT INTO agent_metrics
           (agent_id, cpu_pct, mem_used_mb, mem_total_mb, mem_pct, disk_pct, disk_used_gb, disk_total_gb)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(agent_id)
    .bind(getf("cpu_pct"))
    .bind(geti("mem_used_mb"))
    .bind(geti("mem_total_mb"))
    .bind(getf("mem_pct"))
    .bind(getf("disk_pct"))
    .bind(getf("disk_used_gb"))
    .bind(getf("disk_total_gb"))
    .execute(pool)
    .await?;
    Ok(())
}

/// Bucketed averages over a time range for charting (downsamples long ranges so
/// the payload stays small regardless of sample density).
pub async fn query_agent_metrics(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_secs: i64,
) -> Result<Vec<serde_json::Value>> {
    let bucket = bucket_secs.max(1);
    let rows = sqlx::query(
        "SELECT
           (floor(extract(epoch from ts) / $4) * $4)::bigint AS t,
           avg(cpu_pct)::real       AS cpu_pct,
           avg(mem_pct)::real       AS mem_pct,
           max(mem_used_mb)         AS mem_used_mb,
           max(mem_total_mb)        AS mem_total_mb,
           avg(disk_pct)::real      AS disk_pct,
           max(disk_used_gb)::real  AS disk_used_gb,
           max(disk_total_gb)::real AS disk_total_gb
         FROM agent_metrics
         WHERE agent_id = $1 AND ts >= $2 AND ts <= $3
         GROUP BY t
         ORDER BY t",
    )
    .bind(agent_id)
    .bind(from)
    .bind(to)
    .bind(bucket)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "t": r.try_get::<i64, _>("t").unwrap_or(0),
                "cpu_pct": r.try_get::<f32, _>("cpu_pct").unwrap_or(0.0),
                "mem_pct": r.try_get::<f32, _>("mem_pct").unwrap_or(0.0),
                "mem_used_mb": r.try_get::<i64, _>("mem_used_mb").unwrap_or(0),
                "mem_total_mb": r.try_get::<i64, _>("mem_total_mb").unwrap_or(0),
                "disk_pct": r.try_get::<f32, _>("disk_pct").unwrap_or(0.0),
                "disk_used_gb": r.try_get::<f32, _>("disk_used_gb").unwrap_or(0.0),
                "disk_total_gb": r.try_get::<f32, _>("disk_total_gb").unwrap_or(0.0),
            })
        })
        .collect())
}

/// Delete stale resource samples (by `ts`).
pub async fn prune_metrics_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r =
        sqlx::query("DELETE FROM agent_metrics WHERE ts < NOW() - ($1::bigint * INTERVAL '1 day')")
            .bind(days)
            .execute(pool)
            .await?;
    Ok(r.rows_affected())
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

#[derive(Debug, Clone, Serialize)]
pub struct WindowTopRow {
    pub app: String,
    pub app_display: String,
    pub title: String,
    pub focus_count: i64,
    pub last_ts: DateTime<Utc>,
}
