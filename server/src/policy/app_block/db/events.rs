//! App block events (process kills reported by agents) and rule-builder exe suggestions.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct AppBlockEventRow {
    pub id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_id: Option<i64>,
    pub rule_name: Option<String>,
    pub exe_name: String,
    pub killed_at: DateTime<Utc>,
}

/// Log a process kill event (sent by the agent via WebSocket).
pub async fn log_app_block_event(
    pool: &PgPool,
    agent_id: Uuid,
    rule_id: Option<i64>,
    rule_name: Option<&str>,
    exe_name: &str,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO app_block_events (agent_id, rule_id, rule_name, exe_name) VALUES ($1, $2, $3, $4)",
        agent_id,
        rule_id,
        rule_name,
        exe_name
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn app_block_events_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    Ok(sqlx::query_as!(
        AppBlockEventRow,
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        WHERE e.agent_id = $1
        ORDER BY e.killed_at DESC
        LIMIT $2 OFFSET $3
        ",
        agent_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

pub async fn app_block_events_for_rule(
    pool: &PgPool,
    rule_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    Ok(sqlx::query_as!(
        AppBlockEventRow,
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        WHERE e.rule_id = $1
        ORDER BY e.killed_at DESC
        LIMIT $2 OFFSET $3
        ",
        rule_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

/// All events across all agents, newest first.
pub async fn app_block_events_all(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    Ok(sqlx::query_as!(
        AppBlockEventRow,
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        ORDER BY e.killed_at DESC
        LIMIT $1 OFFSET $2
        ",
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

/// Distinct executables seen in this agent's window history (rule-builder suggestions).
pub async fn known_exes_for_agent(pool: &PgPool, agent_id: Uuid) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar!(
        "SELECT DISTINCT app FROM window_events WHERE agent_id = $1 AND app IS NOT NULL AND app <> '' ORDER BY app LIMIT 300",
        agent_id
    )
    .fetch_all(pool)
    .await?)
}
