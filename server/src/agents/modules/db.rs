use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::agents::modules::{Module, ModuleReport};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ModuleDisableRequest {
    pub command_id: Uuid,
    pub agent_id: Uuid,
    pub module: Module,
    pub expected_revision: u64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub persisted: bool,
    pub stopped: bool,
    pub stop_status: String,
    pub pending: bool,
}
/// One `agent_module_disable_requests` row as selected by [`COLUMNS`].
#[derive(sqlx::FromRow)]
struct DisableRequestRow {
    command_id: Uuid,
    agent_id: Uuid,
    module: String,
    expected_revision_text: String,
    status: String,
    error: Option<String>,
    created_at: DateTime<Utc>,
    acknowledged_at: Option<DateTime<Utc>>,
    persisted: bool,
    stop_status: String,
}
fn request(row: DisableRequestRow) -> Result<ModuleDisableRequest> {
    let status = row.status;
    Ok(ModuleDisableRequest {
        command_id: row.command_id,
        agent_id: row.agent_id,
        module: serde_json::from_value(serde_json::Value::String(row.module))?,
        expected_revision: row.expected_revision_text.parse()?,
        pending: matches!(status.as_str(), "queued" | "sent"),
        status,
        error: row.error,
        created_at: row.created_at,
        acknowledged_at: row.acknowledged_at,
        persisted: row.persisted,
        stopped: false,
        stop_status: row.stop_status,
    })
}
const COLUMNS: &str = "command_id,agent_id,module,expected_revision::TEXT AS expected_revision_text,status,error,created_at,acknowledged_at,persisted,stop_status";
pub async fn module_report(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<(ModuleReport, DateTime<Utc>, Uuid)>> {
    let row = sqlx::query!(
        "SELECT state,reported_at,conn_id FROM agent_module_reports WHERE agent_id=$1",
        id
    )
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok((
            ModuleReport::parse(row.state)?,
            row.reported_at,
            row.conn_id,
        ))
    })
    .transpose()
}
/// Whether this device has ever sent a module report (i.e. runs a modern agent).
pub async fn has_module_report(pool: &PgPool, id: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM agent_module_reports WHERE agent_id=$1) AS "exists!""#,
        id
    )
    .fetch_one(pool)
    .await?)
}
pub async fn save_module_report(
    pool: &PgPool,
    id: Uuid,
    conn: Uuid,
    report: &ModuleReport,
) -> Result<()> {
    sqlx::query!("INSERT INTO agent_module_reports(agent_id,state,conn_id) VALUES($1,$2,$3) ON CONFLICT(agent_id) DO UPDATE SET state=EXCLUDED.state,conn_id=EXCLUDED.conn_id,reported_at=NOW()",
        id, serde_json::to_value(report)?, conn).execute(pool).await?;
    Ok(())
}
pub async fn module_disable_requests(
    pool: &PgPool,
    id: Uuid,
    pending_only: bool,
) -> Result<Vec<ModuleDisableRequest>> {
    let query = format!("SELECT {COLUMNS} FROM agent_module_disable_requests WHERE agent_id=$1 {} ORDER BY (status IN ('queued','sent')) DESC,created_at DESC LIMIT 200", if pending_only { "AND status IN ('queued','sent')" } else { "" });
    sqlx::query_as::<_, DisableRequestRow>(&query)
        .bind(id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(request)
        .collect()
}
pub async fn module_disable_request(
    pool: &PgPool,
    id: Uuid,
    command_id: Uuid,
) -> Result<Option<ModuleDisableRequest>> {
    // Same columns as [`COLUMNS`]; the macro needs the SQL as a literal.
    sqlx::query_as!(
        DisableRequestRow,
        r#"SELECT command_id,agent_id,module,expected_revision::TEXT AS "expected_revision_text!",status,error,created_at,acknowledged_at,persisted,stop_status FROM agent_module_disable_requests WHERE agent_id=$1 AND command_id=$2"#,
        id,
        command_id
    )
    .fetch_optional(pool)
    .await?
    .map(request)
    .transpose()
}
/// Idempotent UUID replay must match agent/module/revision. Partial uniqueness
/// allows only one active request per device/module (at most 18 offline commands).
pub async fn create_module_disable(
    pool: &PgPool,
    id: Uuid,
    module: Module,
    revision: u64,
    command_id: Uuid,
) -> Result<Option<ModuleDisableRequest>> {
    sqlx::query!("INSERT INTO agent_module_disable_requests(command_id,agent_id,module,expected_revision) VALUES($1,$2,$3,$4::TEXT::NUMERIC) ON CONFLICT DO NOTHING",
        command_id, id, module.key(), revision.to_string()).execute(pool).await?;
    let existing = module_disable_request(pool, id, command_id).await?;
    Ok(
        existing
            .filter(|request| request.module == module && request.expected_revision == revision),
    )
}
pub async fn mark_module_disable_sent(
    pool: &PgPool,
    id: Uuid,
    command: Uuid,
    conn: Uuid,
) -> Result<()> {
    sqlx::query!("UPDATE agent_module_disable_requests SET status='sent',last_sent_conn_id=$3 WHERE agent_id=$1 AND command_id=$2 AND status IN ('queued','sent')",
        id, command, conn).execute(pool).await?;
    Ok(())
}
pub async fn acknowledge_module_disable(
    pool: &PgPool,
    id: Uuid,
    command: Uuid,
    status: &str,
    error: Option<&str>,
    stop_status: &str,
) -> Result<()> {
    sqlx::query!("UPDATE agent_module_disable_requests SET status=$3,error=$4,persisted=($3 IN ('disabled','duplicate')),acknowledged_at=NOW(),stop_status=$5 WHERE agent_id=$1 AND command_id=$2 AND status IN ('queued','sent')",
        id, command, status, error, stop_status).execute(pool).await?;
    Ok(())
}
