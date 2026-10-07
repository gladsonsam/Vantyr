//! Agent auto-update policy: the global switch and per-agent overrides.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

pub async fn get_agent_auto_update_global(pool: &PgPool) -> Result<bool> {
    let v: bool = sqlx::query_scalar("SELECT enabled FROM agent_auto_update WHERE id = 1")
        .fetch_one(pool)
        .await?;
    Ok(v)
}

pub async fn set_agent_auto_update_global(pool: &PgPool, enabled: bool) -> Result<()> {
    sqlx::query("UPDATE agent_auto_update SET enabled = $1 WHERE id = 1")
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_agent_auto_update_override(pool: &PgPool, agent_id: Uuid) -> Result<Option<bool>> {
    let v: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM agent_auto_update_override WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    Ok(v)
}

pub async fn set_agent_auto_update_override(
    pool: &PgPool,
    agent_id: Uuid,
    enabled: bool,
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO agent_auto_update_override (agent_id, enabled)
        VALUES ($1, $2)
        ON CONFLICT (agent_id) DO UPDATE SET
            enabled = EXCLUDED.enabled
        ",
    )
    .bind(agent_id)
    .bind(enabled)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_agent_auto_update_override(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM agent_auto_update_override WHERE agent_id = $1")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn effective_agent_auto_update_enabled(pool: &PgPool, agent_id: Uuid) -> Result<bool> {
    let global = get_agent_auto_update_global(pool).await?;
    let ov = get_agent_auto_update_override(pool, agent_id).await?;
    Ok(ov.unwrap_or(global))
}
