//! Alert firings: insert, screenshots, history lists per rule and agent, and retention.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleEventRow {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<i64>,
    pub rule_name: String,
    pub channel: String,
    pub snippet: String,
    pub has_screenshot: bool,
    /// Whether the rule currently has "take screenshot" enabled (best-effort join).
    pub screenshot_requested: bool,
    pub created_at: DateTime<Utc>,
}

/// One alert firing for admin "history by rule" (includes which agent triggered it).
#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleEventTriggeredRow {
    pub id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_name: String,
    pub channel: String,
    pub snippet: String,
    pub has_screenshot: bool,
    pub screenshot_requested: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn alert_rule_event_insert(
    pool: &PgPool,
    agent_id: Uuid,
    rule_id: i64,
    rule_name: &str,
    channel: &str,
    snippet: &str,
) -> Result<i64> {
    let id: i64 = sqlx::query_scalar!(
        r"
        INSERT INTO alert_rule_events (agent_id, rule_id, rule_name, channel, snippet)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        ",
        agent_id,
        rule_id,
        rule_name,
        channel,
        snippet
    )
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn alert_rule_event_screenshot_upsert(
    pool: &PgPool,
    event_id: i64,
    jpeg: &[u8],
) -> Result<()> {
    sqlx::query!(
        r"
        INSERT INTO alert_rule_event_screenshots (event_id, jpeg)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO UPDATE SET
            jpeg = EXCLUDED.jpeg,
            created_at = NOW()
        ",
        event_id,
        jpeg
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn alert_rule_event_screenshot_get(
    pool: &PgPool,
    event_id: i64,
) -> Result<Option<Vec<u8>>> {
    let v: Option<Vec<u8>> = sqlx::query_scalar!(
        "SELECT jpeg FROM alert_rule_event_screenshots WHERE event_id = $1",
        event_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(v)
}

/// All alert events across all agents — newest first (admin).
pub async fn alert_rule_events_list_all(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    Ok(sqlx::query_as!(
        AlertRuleEventTriggeredRow,
        r#"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS "agent_name!",
               e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS "has_screenshot!",
               COALESCE(r.take_screenshot, false) AS "screenshot_requested!"
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        ORDER BY e.created_at DESC
        LIMIT $1 OFFSET $2
        "#,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

pub async fn alert_rule_events_list_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventRow>> {
    Ok(sqlx::query_as!(
        AlertRuleEventRow,
        r#"
        SELECT e.id, e.rule_id, e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS "has_screenshot!",
               COALESCE(r.take_screenshot, false) AS "screenshot_requested!"
        FROM alert_rule_events e
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.agent_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3
        "#,
        agent_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

pub async fn alert_rule_events_list_for_rule(
    pool: &PgPool,
    rule_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    Ok(sqlx::query_as!(
        AlertRuleEventTriggeredRow,
        r#"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS "agent_name!", e.rule_name, e.channel, e.snippet,
               e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS "has_screenshot!",
               COALESCE(r.take_screenshot, false) AS "screenshot_requested!"
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.rule_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3
        "#,
        rule_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?)
}

/// Delete alert-rule events older than `days` (screenshots cascade via FK).
pub async fn prune_alert_events_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM alert_rule_events WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
        days
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}
