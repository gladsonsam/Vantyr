//! Window, keystroke and activity events: ingest, paged reads, top-app stats and history clear.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::agents::telemetry::ingest::WindowFocusEvent;
use crate::db::unix_to_dt;
use ts_rs::TS;

pub async fn insert_window(pool: &PgPool, agent: Uuid, ev: &WindowFocusEvent) -> Result<()> {
    let ts = unix_to_dt(ev.ts);
    let user_name = ev.user.as_deref();

    sqlx::query!(
        "INSERT INTO window_events (agent_id, title, app, app_display, hwnd, ts, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        agent,
        ev.title,
        ev.app,
        ev.app_display(),
        ev.hwnd,
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
        ev.app,
        ev.app_display(),
        ev.title,
        ts,
    )
    .execute(pool)
    .await?;

    Ok(())
}

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
#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
#[derive(Debug, Serialize, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct WindowTopRow {
    pub app: String,
    pub app_display: String,
    pub title: String,
    pub focus_count: i64,
    pub last_ts: DateTime<Utc>,
}
