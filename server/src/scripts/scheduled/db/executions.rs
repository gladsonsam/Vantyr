//! The per-agent scheduled-script execution log.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

pub async fn execution_exists(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    fire_time: DateTime<Utc>,
) -> Result<bool> {
    let exists: Option<Option<i32>> = sqlx::query_scalar!(
        "SELECT 1::int FROM scheduled_script_executions WHERE script_id = $1 AND agent_id = $2 AND expected_fire_time = $3",
        script_id,
        agent_id,
        fire_time
    )
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

/// Record a scheduled fire (or an offline skip) for one agent.
pub async fn insert_scheduled_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    status: &str,
    fire_time: DateTime<Utc>,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        script_id,
        agent_id,
        status,
        fire_time
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Record a manual "run now" (or an offline skip) for one agent.
pub async fn insert_manual_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    status: &str,
    fire_time: DateTime<Utc>,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time, is_manual) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING",
        script_id,
        agent_id,
        status,
        fire_time
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn finish_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    fire_time: DateTime<Utc>,
    status: &str,
    output: &str,
) -> Result<()> {
    sqlx::query!(
        "UPDATE scheduled_script_executions SET status = $1, output = $2 WHERE script_id = $3 AND agent_id = $4 AND expected_fire_time = $5",
        status,
        output,
        script_id,
        agent_id,
        fire_time
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One row of the global execution log (`GET /api/scheduled-script-events`).
#[derive(Serialize, TS)]
#[ts(export)]
pub struct ExecutionEvent {
    pub script_id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_name: String,
    pub status: String,
    pub expected_fire_time: DateTime<Utc>,
    pub output: Option<String>,
    pub is_manual: bool,
}

pub async fn list_executions(pool: &PgPool, limit: i64) -> Result<Vec<ExecutionEvent>> {
    Ok(sqlx::query_as!(
        ExecutionEvent,
        r"
        SELECT
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            s.name as rule_name, a.name as agent_name
        FROM scheduled_script_executions e
        JOIN scheduled_scripts s ON s.id = e.script_id
        JOIN agents a ON a.id = e.agent_id
        ORDER BY e.expected_fire_time DESC
        LIMIT $1
        ",
        limit
    )
    .fetch_all(pool)
    .await?)
}

/// One row of a single script's execution log (`GET /api/scheduled-scripts/:id/events`).
#[derive(Serialize, TS)]
#[ts(export)]
pub struct ScriptExecutionEvent {
    pub script_id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub status: String,
    pub expected_fire_time: DateTime<Utc>,
    pub output: Option<String>,
}

pub async fn list_executions_for_script(
    pool: &PgPool,
    id: i64,
    limit: i64,
) -> Result<Vec<ScriptExecutionEvent>> {
    let rows = sqlx::query!(
        r"
        SELECT
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            a.name as agent_name
        FROM scheduled_script_executions e
        JOIN agents a ON a.id = e.agent_id
        WHERE e.script_id = $1
        ORDER BY e.expected_fire_time DESC
        LIMIT $2
        ",
        id,
        limit
    )
    .fetch_all(pool)
    .await?;
    // `is_manual` is selected but not part of this response.
    Ok(rows
        .into_iter()
        .map(|r| ScriptExecutionEvent {
            script_id: r.script_id,
            agent_id: r.agent_id,
            agent_name: r.agent_name,
            status: r.status,
            expected_fire_time: r.expected_fire_time,
            output: r.output,
        })
        .collect())
}

/// Delete stale scheduled-script execution rows (by `created_at`).
///
/// This table is append-only — one row per (script, agent) per fire/trigger — and
/// nothing else bounds it, so without this it grows without limit. Index
/// `idx_sse_created_at` (migration 0053) serves the predicate.
pub async fn prune_script_executions_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM scheduled_script_executions WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
        days
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}
