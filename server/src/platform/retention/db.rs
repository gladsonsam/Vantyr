//! Telemetry retention settings (global + per-agent) and the per-agent telemetry prune.

use anyhow::Result;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

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

pub async fn get_retention_global(pool: &PgPool) -> Result<RetentionPolicy> {
    Ok(sqlx::query_as!(
        RetentionPolicy,
        "SELECT keylog_days, window_days, url_days FROM retention_global WHERE id = 1"
    )
    .fetch_one(pool)
    .await?)
}

pub async fn set_retention_global(pool: &PgPool, p: &RetentionPolicy) -> Result<()> {
    sqlx::query!(
        "UPDATE retention_global SET keylog_days = $1, window_days = $2, url_days = $3 WHERE id = 1",
        p.keylog_days,
        p.window_days,
        p.url_days,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_retention_agent(
    pool: &PgPool,
    agent: Uuid,
) -> Result<Option<RetentionAgentOverride>> {
    Ok(sqlx::query_as!(
        RetentionAgentOverride,
        "SELECT keylog_days, window_days, url_days FROM retention_agent WHERE agent_id = $1",
        agent,
    )
    .fetch_optional(pool)
    .await?)
}

pub async fn set_retention_agent(
    pool: &PgPool,
    agent: Uuid,
    p: &RetentionAgentOverride,
) -> Result<()> {
    let all_inherit = p.keylog_days.is_none() && p.window_days.is_none() && p.url_days.is_none();
    if all_inherit {
        sqlx::query!("DELETE FROM retention_agent WHERE agent_id = $1", agent)
            .execute(pool)
            .await?;
        return Ok(());
    }

    sqlx::query!(
        r"
        INSERT INTO retention_agent (agent_id, keylog_days, window_days, url_days)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agent_id) DO UPDATE SET
            keylog_days = EXCLUDED.keylog_days,
            window_days = EXCLUDED.window_days,
            url_days = EXCLUDED.url_days
        ",
        agent,
        p.keylog_days,
        p.window_days,
        p.url_days,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_retention_agent(pool: &PgPool, agent: Uuid) -> Result<()> {
    sqlx::query!("DELETE FROM retention_agent WHERE agent_id = $1", agent)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete telemetry older than the effective retention for each agent.
/// Activity (AFK) rows use the same cutoff as window history.
pub async fn prune_telemetry_by_retention(pool: &PgPool) -> Result<()> {
    let global = get_retention_global(pool).await?;

    let agent_ids: Vec<Uuid> = sqlx::query_scalar!("SELECT id FROM agents")
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
                sqlx::query!(
                    "DELETE FROM key_sessions WHERE agent_id = $1 AND updated_at < NOW() - ($2::bigint * INTERVAL '1 day')",
                    aid,
                    i64::from(days),
                )
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = win_d {
            if days > 0 {
                sqlx::query!(
                    "DELETE FROM window_events WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                    aid,
                    i64::from(days),
                )
                .execute(pool)
                .await?;

                sqlx::query!(
                    "DELETE FROM activity_log WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                    aid,
                    i64::from(days),
                )
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = url_d {
            if days > 0 {
                sqlx::query!(
                    "DELETE FROM url_visits WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                    aid,
                    i64::from(days),
                )
                .execute(pool)
                .await?;

                // url_sessions (time-on-site) is parallel raw navigation telemetry
                // to url_visits; without this it grows forever and silently bypasses
                // the operator-configured URL retention. Use ts_start (indexed).
                sqlx::query!(
                    "DELETE FROM url_sessions WHERE agent_id = $1 AND ts_start < NOW() - ($2::bigint * INTERVAL '1 day')",
                    aid,
                    i64::from(days),
                )
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(())
}
