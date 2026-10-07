//! Per-event telemetry persistence: window/key/URL/activity events and app icons.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::db::unix_to_dt;

pub async fn insert_window(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let title = v["title"].as_str().unwrap_or("");
    let app = v["app"].as_str().unwrap_or("");
    let app_display = v["app_display"].as_str().unwrap_or(app);
    let hwnd = v["hwnd"].as_i64().unwrap_or(0);
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query!(
        "INSERT INTO window_events (agent_id, title, app, app_display, hwnd, ts, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        agent,
        title,
        app,
        app_display,
        hwnd,
        ts,
        user_name,
    )
    .execute(pool)
    .await?;

    sqlx::query!(
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
        agent,
        app,
        app_display,
        title,
        ts,
    )
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

    let updated = sqlx::query!(
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
        text,
        app_display,
        agent,
        app,
        window,
        user_name,
    )
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        sqlx::query!(
            "INSERT INTO key_sessions (agent_id, app, app_display, window_title, text, started_at, updated_at, user_name) \
             VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)",
            agent,
            app,
            app_display,
            window,
            text,
            ts,
            user_name,
        )
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

    sqlx::query!(
        "INSERT INTO activity_log (agent_id, event_type, idle_secs, ts, user_name) VALUES ($1,$2,$3,$4,$5)",
        agent,
        kind,
        idle_secs,
        ts,
        user_name,
    )
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

    sqlx::query!(
        r"
        INSERT INTO app_icons (agent_id, exe_name, png_bytes, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_id, exe_name) DO UPDATE
        SET png_bytes = EXCLUDED.png_bytes,
            updated_at = NOW()
        ",
        agent,
        &exe,
        png_bytes,
    )
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
    Ok(sqlx::query_scalar!(
        "SELECT png_bytes FROM app_icons WHERE agent_id=$1 AND exe_name=$2",
        agent,
        &exe,
    )
    .fetch_optional(pool)
    .await?)
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
    sqlx::query!(
        "INSERT INTO agent_metrics
           (agent_id, cpu_pct, mem_used_mb, mem_total_mb, mem_pct, disk_pct, disk_used_gb, disk_total_gb)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        agent_id,
        getf("cpu_pct"),
        geti("mem_used_mb"),
        geti("mem_total_mb"),
        getf("mem_pct"),
        getf("disk_pct"),
        getf("disk_used_gb"),
        getf("disk_total_gb"),
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One chart point of [`query_agent_metrics`] (`points[]` of the metrics history).
#[derive(Debug, Serialize)]
pub struct MetricsBucket {
    /// Bucket start (unix seconds).
    pub t: i64,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub mem_used_mb: i64,
    pub mem_total_mb: i64,
    pub disk_pct: f32,
    pub disk_used_gb: f32,
    pub disk_total_gb: f32,
}

/// Bucketed averages over a time range for charting (downsamples long ranges so
/// the payload stays small regardless of sample density).
pub async fn query_agent_metrics(
    pool: &PgPool,
    agent_id: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket_secs: i64,
) -> Result<Vec<MetricsBucket>> {
    let bucket = bucket_secs.max(1);
    // `$4::bigint` keeps the bucket an int8 parameter, as the runtime bind declared it.
    let rows = sqlx::query!(
        "SELECT
           (floor(extract(epoch from ts) / $4::bigint) * $4::bigint)::bigint AS t,
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
        agent_id,
        from,
        to,
        bucket,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| MetricsBucket {
            t: r.t.unwrap_or(0),
            cpu_pct: r.cpu_pct.unwrap_or(0.0),
            mem_pct: r.mem_pct.unwrap_or(0.0),
            mem_used_mb: r.mem_used_mb.unwrap_or(0),
            mem_total_mb: r.mem_total_mb.unwrap_or(0),
            disk_pct: r.disk_pct.unwrap_or(0.0),
            disk_used_gb: r.disk_used_gb.unwrap_or(0.0),
            disk_total_gb: r.disk_total_gb.unwrap_or(0.0),
        })
        .collect())
}

/// Delete stale resource samples (by `ts`).
pub async fn prune_metrics_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM agent_metrics WHERE ts < NOW() - ($1::bigint * INTERVAL '1 day')",
        days,
    )
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
    Ok(sqlx::query_as!(
        WindowTopRow,
        r"
        SELECT app, app_display, title, focus_count, last_ts
        FROM window_top_stats
        WHERE agent_id = $1
        ORDER BY focus_count DESC, last_ts DESC
        LIMIT $2 OFFSET $3
        ",
        agent,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?)
}

/// One focused-window event (`GET /api/agents/:id/windows`).
#[derive(Debug, Serialize)]
pub struct WindowEventRow {
    pub title: String,
    pub app: String,
    pub app_display: String,
    pub hwnd: i64,
    pub ts: DateTime<Utc>,
    #[serde(rename = "user")]
    pub user_name: Option<String>,
}

pub async fn query_windows(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<WindowEventRow>> {
    Ok(sqlx::query_as!(
        WindowEventRow,
        "SELECT title, app, app_display, hwnd, ts, user_name \
         FROM window_events WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
        agent,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?)
}

/// One keystroke session (`GET /api/agents/:id/keys`).
#[derive(Debug, Serialize)]
pub struct KeySessionRow {
    pub app: String,
    pub app_display: String,
    pub window_title: String,
    pub text: String,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(rename = "user")]
    pub user_name: Option<String>,
}

pub async fn query_keys(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<KeySessionRow>> {
    Ok(sqlx::query_as!(
        KeySessionRow,
        "SELECT app, app_display, window_title, text, started_at, updated_at, user_name \
         FROM key_sessions WHERE agent_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        agent,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?)
}

/// One AFK/active transition (`GET /api/agents/:id/activity`).
#[derive(Debug, Serialize)]
pub struct ActivityRow {
    pub event_type: String,
    pub idle_secs: Option<i64>,
    pub ts: DateTime<Utc>,
    #[serde(rename = "user")]
    pub user_name: Option<String>,
}

pub async fn query_activity(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<ActivityRow>> {
    Ok(sqlx::query_as!(
        ActivityRow,
        "SELECT event_type, idle_secs, ts, user_name \
         FROM activity_log WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
        agent,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?)
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

    let results = [
        // Raw telemetry
        sqlx::query!("DELETE FROM window_events WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM key_sessions WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM url_visits WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM activity_log WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        // Websocket connection history (so "last seen" becomes empty)
        sqlx::query!("DELETE FROM agent_sessions WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        // Derived/aggregate tables that survive raw-row retention
        sqlx::query!("DELETE FROM url_sessions WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM url_top_stats WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM window_top_stats WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM url_site_stats WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!("DELETE FROM url_category_stats WHERE agent_id = $1", agent)
            .execute(&mut *tx)
            .await?,
        sqlx::query!(
            "DELETE FROM url_category_time_stats WHERE agent_id = $1",
            agent
        )
        .execute(&mut *tx)
        .await?,
    ];
    for result in results {
        total = total.saturating_add(result.rows_affected());
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
