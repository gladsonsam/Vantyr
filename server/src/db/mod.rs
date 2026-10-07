//! Database operations.
//!
//! All queries use the non-macro `sqlx::query()` / `sqlx::query_scalar()` API
//! so the server compiles without a running database (no `SQLX_OFFLINE` flag
//! needed in CI or Docker builds).

// Re-exported (`pub(crate)`) so the `db/` submodules can pull the whole shared prelude with a
// single `use super::*;`.
pub(crate) use anyhow::Result;
pub(crate) use chrono::{DateTime, TimeZone, Utc};
pub(crate) use serde::Serialize;
pub(crate) use sqlx::{PgPool, Row};
pub(crate) use uuid::Uuid;

// Submodules carved out of the original monolithic `db.rs`. Each is `pub use`d so existing
// `db::<fn>` call sites keep working unchanged (facade pattern).
mod queries;
mod web_push;
pub use queries::*;
pub use web_push::*;

// ─── Retention policy ─────────────────────────────────────────────────────────

/// Global retention: `None` / NULL = keep forever (no automatic deletion). `Some(0)` is never stored (API normalizes to `None`).
#[derive(Debug, Clone, Serialize)]
pub struct RetentionPolicy {
    pub keylog_days: Option<i32>,
    pub window_days: Option<i32>,
    pub url_days: Option<i32>,
}

/// Per-agent override. Each `None` means “use global default for that category”.
/// `Some(0)` means unlimited for that stream (no prune), regardless of global.
#[derive(Debug, Clone, Serialize)]
pub struct RetentionAgentOverride {
    pub keylog_days: Option<i32>,
    pub window_days: Option<i32>,
    pub url_days: Option<i32>,
}

// ─── Retention settings & pruning ─────────────────────────────────────────────

pub async fn get_retention_global(pool: &PgPool) -> Result<RetentionPolicy> {
    let row =
        sqlx::query("SELECT keylog_days, window_days, url_days FROM retention_global WHERE id = 1")
            .fetch_one(pool)
            .await?;

    Ok(RetentionPolicy {
        keylog_days: row.try_get::<Option<i32>, _>("keylog_days").unwrap_or(None),
        window_days: row.try_get::<Option<i32>, _>("window_days").unwrap_or(None),
        url_days: row.try_get::<Option<i32>, _>("url_days").unwrap_or(None),
    })
}

pub async fn set_retention_global(pool: &PgPool, p: &RetentionPolicy) -> Result<()> {
    sqlx::query(
        "UPDATE retention_global SET keylog_days = $1, window_days = $2, url_days = $3 WHERE id = 1",
    )
    .bind(p.keylog_days)
    .bind(p.window_days)
    .bind(p.url_days)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_retention_agent(
    pool: &PgPool,
    agent: Uuid,
) -> Result<Option<RetentionAgentOverride>> {
    let row = sqlx::query(
        "SELECT keylog_days, window_days, url_days FROM retention_agent WHERE agent_id = $1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RetentionAgentOverride {
        keylog_days: r.try_get::<Option<i32>, _>("keylog_days").unwrap_or(None),
        window_days: r.try_get::<Option<i32>, _>("window_days").unwrap_or(None),
        url_days: r.try_get::<Option<i32>, _>("url_days").unwrap_or(None),
    }))
}

pub async fn set_retention_agent(
    pool: &PgPool,
    agent: Uuid,
    p: &RetentionAgentOverride,
) -> Result<()> {
    let all_inherit = p.keylog_days.is_none() && p.window_days.is_none() && p.url_days.is_none();
    if all_inherit {
        sqlx::query("DELETE FROM retention_agent WHERE agent_id = $1")
            .bind(agent)
            .execute(pool)
            .await?;
        return Ok(());
    }

    sqlx::query(
        r"
        INSERT INTO retention_agent (agent_id, keylog_days, window_days, url_days)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agent_id) DO UPDATE SET
            keylog_days = EXCLUDED.keylog_days,
            window_days = EXCLUDED.window_days,
            url_days = EXCLUDED.url_days
        ",
    )
    .bind(agent)
    .bind(p.keylog_days)
    .bind(p.window_days)
    .bind(p.url_days)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_retention_agent(pool: &PgPool, agent: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM retention_agent WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete telemetry older than the effective retention for each agent.
/// Activity (AFK) rows use the same cutoff as window history.
pub async fn prune_telemetry_by_retention(pool: &PgPool) -> Result<()> {
    let global = get_retention_global(pool).await?;

    let agent_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM agents")
        .fetch_all(pool)
        .await?;

    for aid in agent_ids {
        let ov = get_retention_agent(pool, aid)
            .await?
            .unwrap_or(RetentionAgentOverride {
                keylog_days: None,
                window_days: None,
                url_days: None,
            });

        let key_d = ov.keylog_days.or(global.keylog_days);
        let win_d = ov.window_days.or(global.window_days);
        let url_d = ov.url_days.or(global.url_days);

        if let Some(days) = key_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM key_sessions WHERE agent_id = $1 AND updated_at < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = win_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM window_events WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;

                sqlx::query(
                    "DELETE FROM activity_log WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = url_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM url_visits WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;

                // url_sessions (time-on-site) is parallel raw navigation telemetry
                // to url_visits; without this it grows forever and silently bypasses
                // the operator-configured URL retention. Use ts_start (indexed).
                sqlx::query(
                    "DELETE FROM url_sessions WHERE agent_id = $1 AND ts_start < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(())
}

/// Delete alert-rule events older than `days` (screenshots cascade via FK).
pub async fn prune_alert_events_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query(
        "DELETE FROM alert_rule_events WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Optional extra pruning (alert history + old software rows + script executions).
/// Telemetry uses [`prune_telemetry_by_retention`].
pub async fn prune_auxiliary_retention(
    pool: &PgPool,
    alert_event_days: Option<i64>,
    software_inventory_days: Option<i64>,
    script_execution_days: Option<i64>,
    metrics_days: Option<i64>,
) -> Result<()> {
    if let Some(d) = alert_event_days {
        let n = prune_alert_events_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old alert_rule_events by retention");
        }
    }
    if let Some(d) = software_inventory_days {
        let n =
            crate::scripts::software_inventory::db::prune_agent_software_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_software rows by retention");
        }
    }
    if let Some(d) = script_execution_days {
        let n = crate::scripts::scheduled::db::prune_script_executions_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(
                rows = n,
                "pruned old scheduled_script_executions by retention"
            );
        }
    }
    if let Some(d) = metrics_days {
        let n = crate::agents::telemetry::db::prune_metrics_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_metrics by retention");
        }
    }
    Ok(())
}

// ─── Agent local UI password (Argon2 PHC string) ───

/// `true` if this hash means the user must type a non-empty password to open settings.
pub fn agent_ui_password_is_set(hash: Option<&str>) -> bool {
    matches!(hash, Some(h) if !h.is_empty() && h.starts_with("$argon2"))
}

pub async fn get_local_ui_global_hash(pool: &PgPool) -> Result<Option<String>> {
    let v: Option<String> =
        sqlx::query_scalar("SELECT password_hash_sha256 FROM agent_local_ui_password WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(v)
}

pub async fn get_local_ui_override_hash(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<Option<String>> = sqlx::query_scalar(
        "SELECT password_hash_sha256 FROM agent_local_ui_password_override WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;

    Ok(v.flatten())
}

// ─── Utility ──────────────────────────────────────────────────────────────────

pub(crate) fn pg_is_unique_violation(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db) => db.code().is_some_and(|c| c == "23505"),
        _ => false,
    }
}

pub(crate) fn unix_to_dt(ts: Option<i64>) -> DateTime<Utc> {
    ts.and_then(|s| Utc.timestamp_opt(s, 0).single())
        .unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_violation_detection_is_conservative() {
        // A non-database error is never treated as a unique violation.
        assert!(!pg_is_unique_violation(&sqlx::Error::RowNotFound));
    }
}
