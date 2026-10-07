//! Agent identity, system info snapshots, icons, and connection history.

use std::collections::HashMap;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

/// Final credential revalidation after the WebSocket upgrade. Match both UUID
/// and the hash authenticated by the HTTP handler; name alone is insufficient.
/// Record the touch and session in one transaction, only if that credential is
/// still installed. The caller holds the lifecycle write gate through registration.
pub async fn register_authenticated_agent(
    pool: &PgPool,
    agent_id: Uuid,
    authenticated_hash: &str,
) -> Result<Option<i64>> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query!(
        "UPDATE agents SET last_seen = NOW() WHERE id = $1 AND api_token_hash = $2",
        agent_id,
        authenticated_hash,
    )
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    let session_id = sqlx::query_scalar!(
        "INSERT INTO agent_sessions (agent_id) VALUES ($1) RETURNING id",
        agent_id,
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(session_id))
}

/// Update `last_seen` when the agent disconnects.
pub async fn touch_agent(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query!("UPDATE agents SET last_seen = NOW() WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn agent_name_by_id(pool: &PgPool, id: Uuid) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar!("SELECT name FROM agents WHERE id = $1", id)
            .fetch_optional(pool)
            .await?,
    )
}

/// Stable agent id + optional per-machine API token hash (Argon2). Used by WebSocket auth.
pub async fn get_agent_auth_by_name(
    pool: &PgPool,
    name: &str,
) -> Result<Option<(Uuid, Option<String>)>> {
    let row = sqlx::query!(
        "SELECT id, api_token_hash FROM agents WHERE name = $1",
        name
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.id, r.api_token_hash)))
}

pub async fn delete_agents_by_ids(pool: &PgPool, agent_ids: &[Uuid]) -> Result<u64> {
    if agent_ids.is_empty() {
        return Ok(0);
    }
    let res = sqlx::query!("DELETE FROM agents WHERE id = ANY($1)", agent_ids)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Upsert the latest system/specs snapshot for an agent.
pub async fn upsert_agent_info(
    pool: &PgPool,
    agent_id: Uuid,
    info: &serde_json::Value,
) -> Result<()> {
    // The monitor list can only be enumerated from an interactive desktop, so
    // snapshots from the Session-0 service arrive without one. Carry a
    // previously-reported list forward when the incoming snapshot omits it, so
    // the dashboard's monitor picker doesn't flicker away between updates. A
    // non-empty incoming list always wins (handles monitors being added/removed).
    let info = preserve_monitors(pool, agent_id, info).await;

    sqlx::query!(
        r"
        INSERT INTO agent_info (agent_id, info, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (agent_id)
        DO UPDATE SET info = EXCLUDED.info, updated_at = NOW()
        ",
        agent_id,
        info,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// The agent's self-reported IANA timezone (e.g. `Australia/Perth`), if it sent one.
///
/// Recall buckets activity into *days*, and a day only means something in a local
/// timezone: bucketing a UTC+8 user's activity by UTC days puts their morning in
/// yesterday's summary and splits every real day across two rows. Agents report this
/// in `agent_info`; older agents that don't are handled by the caller's fallback.
pub async fn agent_timezone(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let tz: Option<String> = sqlx::query_scalar!(
        "SELECT info->>'timezone' FROM agent_info WHERE agent_id = $1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(tz.filter(|s| !s.trim().is_empty()))
}

/// Returns `info` with a `monitors` array carried over from the stored snapshot
/// when the incoming one has no non-empty list. Returns `info` unchanged when it
/// already carries monitors or there's nothing to preserve.
async fn preserve_monitors(
    pool: &PgPool,
    agent_id: Uuid,
    info: &serde_json::Value,
) -> serde_json::Value {
    let has_monitors = |v: &serde_json::Value| {
        v.get("monitors")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| !a.is_empty())
    };
    if has_monitors(info) {
        return info.clone();
    }
    let Ok(Some(prev)) = get_agent_info(pool, agent_id).await else {
        return info.clone();
    };
    if !has_monitors(&prev) {
        return info.clone();
    }
    let mut merged = info.clone();
    if let (Some(obj), Some(monitors)) = (merged.as_object_mut(), prev.get("monitors")) {
        obj.insert("monitors".to_string(), monitors.clone());
    }
    merged
}

/// Fetch the latest stored system/specs snapshot for an agent (if any).
pub async fn get_agent_info(pool: &PgPool, agent_id: Uuid) -> Result<Option<serde_json::Value>> {
    Ok(
        sqlx::query_scalar!("SELECT info FROM agent_info WHERE agent_id = $1", agent_id)
            .fetch_optional(pool)
            .await?,
    )
}

/// Fetch latest stored agent versions in batch (best-effort; missing entries omitted).
pub async fn agent_versions_batch(
    pool: &PgPool,
    agent_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>> {
    if agent_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query!(
        r"
        SELECT agent_id, info->>'agent_version' AS agent_version
        FROM agent_info
        WHERE agent_id = ANY($1)
        ",
        agent_ids,
    )
    .fetch_all(pool)
    .await?;

    let mut out = std::collections::HashMap::new();
    for r in rows {
        if let Some(s) = r.agent_version {
            let t = s.trim();
            if !t.is_empty() {
                out.insert(r.agent_id, t.to_string());
            }
        }
    }
    Ok(out)
}

/// Mark an agent session disconnected.
pub async fn end_agent_session(pool: &PgPool, session_id: i64) -> Result<()> {
    sqlx::query!(
        "UPDATE agent_sessions SET disconnected_at = NOW() WHERE id = $1 AND disconnected_at IS NULL",
        session_id,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns (`last_connected_at`, `last_disconnected_at`) for an agent.
#[allow(dead_code)] // Retained for ad-hoc use; hot paths use [`agent_last_session_times_batch`].
pub async fn agent_last_session_times(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<(Option<DateTime<Utc>>, Option<DateTime<Utc>>)> {
    let row = sqlx::query!(
        r"
        SELECT
            MAX(connected_at)    AS last_connected_at,
            MAX(disconnected_at) AS last_disconnected_at
        FROM agent_sessions
        WHERE agent_id = $1
        ",
        agent_id,
    )
    .fetch_one(pool)
    .await?;

    Ok((row.last_connected_at, row.last_disconnected_at))
}

/// Batch variant of [`agent_last_session_times`] for many agents in one round-trip.
pub async fn agent_last_session_times_batch(
    pool: &PgPool,
    agent_ids: &[Uuid],
) -> Result<HashMap<Uuid, (Option<DateTime<Utc>>, Option<DateTime<Utc>>)>> {
    if agent_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query!(
        r"
        SELECT agent_id,
               MAX(connected_at)    AS last_connected_at,
               MAX(disconnected_at) AS last_disconnected_at
        FROM agent_sessions
        WHERE agent_id = ANY($1)
        GROUP BY agent_id
        ",
        agent_ids,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.agent_id,
                (row.last_connected_at, row.last_disconnected_at),
            )
        })
        .collect())
}

/// One enrolled device as listed by the dashboard.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRow {
    pub id: Uuid,
    pub name: String,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    pub icon: Option<String>,
}

pub async fn list_agents(pool: &PgPool) -> Result<Vec<AgentRow>> {
    // Row-read failures propagate instead of fabricating values (e.g. `Utc::now()` for a
    // missing `first_seen`), so schema drift fails loudly rather than returning silently-wrong data.
    Ok(sqlx::query_as!(
        AgentRow,
        "SELECT id, name, first_seen, last_seen, icon FROM agents ORDER BY last_seen DESC",
    )
    .fetch_all(pool)
    .await?)
}

/// Set (or clear) an agent icon label.
pub async fn set_agent_icon(pool: &PgPool, agent_id: Uuid, icon: Option<&str>) -> Result<()> {
    sqlx::query!("UPDATE agents SET icon = $2 WHERE id = $1", agent_id, icon)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_agent_icon(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar!("SELECT icon FROM agents WHERE id = $1", agent_id)
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(v)
}

/// One row of the global connection log (`GET /api/agent-sessions`).
#[derive(Serialize)]
pub struct AgentSessionRow {
    pub id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub connected_at: DateTime<Utc>,
    pub disconnected_at: Option<DateTime<Utc>>,
}

pub async fn list_recent_sessions(pool: &PgPool, limit: i64) -> Result<Vec<AgentSessionRow>> {
    Ok(sqlx::query_as!(
        AgentSessionRow,
        r"
        SELECT
            s.id, s.agent_id, s.connected_at, s.disconnected_at,
            a.name as agent_name
        FROM agent_sessions s
        JOIN agents a ON a.id = s.agent_id
        ORDER BY s.connected_at DESC
        LIMIT $1
        ",
        limit,
    )
    .fetch_all(pool)
    .await?)
}
