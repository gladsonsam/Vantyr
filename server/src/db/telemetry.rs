//! Per-event telemetry persistence: window/key/URL/activity events and app icons (carved out of `db.rs`).

use super::*;

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
        SET app_display = EXCLUDED.app_display,
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
               app_display  = $2,
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

/// Insert a URL visit, skipping exact consecutive duplicates for this agent.
pub async fn insert_url(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
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

// ─── URL sessions (time-on-site) ─────────────────────────────────────────────

pub async fn insert_url_session(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
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

    let hostname = url_categorization::extract_hostname_from_url(url);
    let cat = url_categorization::categorize_url_now(pool, &hostname, url).await?;
    let category_id: Option<i64> = cat.as_ref().map(|(id, _)| *id);

    sqlx::query(
        r"
        INSERT INTO url_sessions (agent_id, url, hostname, title, browser, ts_start, ts_end, duration_ms, category_id, user_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(&hostname)
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
        .bind(&hostname)
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
