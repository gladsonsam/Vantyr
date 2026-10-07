//! Audit log persistence: every audited action is written to `audit_log` and mirrored to
//! `tracing` (target `vantyr_audit`) so `docker logs` matches the dashboard log.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct AuditRecord {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub actor: String,
    /// Set on HTTP audit rows; null for older rows or WebSocket-only events.
    pub client_ip: Option<String>,
    pub agent_id: Option<Uuid>,
    pub action: String,
    pub status: String,
    pub detail: serde_json::Value,
}

/// Arguments for [`insert_audit_log_dedup`] and [`insert_audit_log_dedup_traced`].
#[derive(Clone, Copy)]
pub struct AuditLogDedup<'a> {
    pub actor: &'a str,
    pub agent_id: Option<Uuid>,
    pub action: &'a str,
    pub status: &'a str,
    pub detail: &'a serde_json::Value,
    pub dedup_window_secs: i64,
    pub client_ip: Option<&'a str>,
}

/// Mirrors each persisted audit row to `tracing` so `docker logs` matches the dashboard log.
fn emit_audit_tracing_line(actor: &str, action: &str, status: &str, client_ip: Option<&str>) {
    let ip = client_ip.unwrap_or("-");
    match status {
        "error" => tracing::error!(
            target: "vantyr_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        "rejected" => tracing::warn!(
            target: "vantyr_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        _ => tracing::info!(
            target: "vantyr_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
    }
}

pub async fn insert_audit_log(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO audit_log (actor, agent_id, action, status, detail, client_ip) VALUES ($1, $2, $3, $4, $5, $6)",
        actor,
        agent_id,
        action,
        status,
        detail,
        client_ip,
    )
    .execute(pool)
    .await?;

    emit_audit_tracing_line(actor, action, status, client_ip);

    Ok(())
}

/// Insert an audit row unless an identical recent row already exists.
///
/// "Identical" means same actor/agent/action/status/detail JSON and within
/// `dedup_window_secs` from now.
pub async fn insert_audit_log_dedup(pool: &PgPool, row: AuditLogDedup<'_>) -> Result<()> {
    let exists: Option<i64> = sqlx::query_scalar!(
        r"
        SELECT id
        FROM audit_log
        WHERE actor = $1
          AND (($2::uuid IS NULL AND agent_id IS NULL) OR agent_id = $2)
          AND action = $3
          AND status = $4
          AND detail = $5::jsonb
          AND (client_ip IS NOT DISTINCT FROM $7::text)
          AND ts > NOW() - ($6::bigint * INTERVAL '1 second')
        ORDER BY ts DESC
        LIMIT 1
        ",
        row.actor,
        row.agent_id,
        row.action,
        row.status,
        row.detail,
        row.dedup_window_secs,
        row.client_ip,
    )
    .fetch_optional(pool)
    .await?;

    if exists.is_none() {
        insert_audit_log(
            pool,
            row.actor,
            row.agent_id,
            row.action,
            row.status,
            row.detail,
            row.client_ip,
        )
        .await?;
    }

    Ok(())
}

/// Like [`insert_audit_log`], but emits a warning when the insert fails (HTTP handlers may still return 200).
pub async fn insert_audit_log_traced(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) {
    if let Err(e) = insert_audit_log(pool, actor, agent_id, action, status, detail, client_ip).await
    {
        tracing::warn!(error = %e, action, "audit log insert failed");
    }
}

/// Like [`insert_audit_log_dedup`], but warns on failure.
pub async fn insert_audit_log_dedup_traced(pool: &PgPool, row: AuditLogDedup<'_>) {
    if let Err(e) = insert_audit_log_dedup(pool, row).await {
        tracing::warn!(error = %e, action = row.action, "audit log dedup insert failed");
    }
}

pub async fn query_audit_log(
    pool: &PgPool,
    agent_id: Option<Uuid>,
    action: Option<&str>,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<AuditRecord>> {
    Ok(sqlx::query_as!(
        AuditRecord,
        r"
        SELECT id, ts, actor, client_ip, agent_id, action, status, detail
        FROM audit_log
        WHERE ($1::uuid IS NULL OR agent_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY ts DESC
        LIMIT $4 OFFSET $5
        ",
        agent_id,
        action,
        status,
        limit,
        offset,
    )
    .fetch_all(pool)
    .await?)
}
