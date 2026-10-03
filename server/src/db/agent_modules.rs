use super::*;
use crate::agent_modules::{Module, ModuleReport};

#[derive(Debug, Clone, Serialize)]
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
fn request(row: sqlx::postgres::PgRow) -> Result<ModuleDisableRequest> {
    let status: String = row.try_get("status")?;
    Ok(ModuleDisableRequest {
        command_id: row.try_get("command_id")?,
        agent_id: row.try_get("agent_id")?,
        module: serde_json::from_value(serde_json::Value::String(row.try_get("module")?))?,
        expected_revision: row
            .try_get::<String, _>("expected_revision_text")?
            .parse()?,
        pending: matches!(status.as_str(), "queued" | "sent"),
        status,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        acknowledged_at: row.try_get("acknowledged_at")?,
        persisted: row.try_get("persisted")?,
        stopped: false,
        stop_status: row.try_get("stop_status")?,
    })
}
const COLUMNS: &str = "command_id,agent_id,module,expected_revision::TEXT AS expected_revision_text,status,error,created_at,acknowledged_at,persisted,stop_status";
pub async fn module_report(
    pool: &PgPool,
    id: Uuid,
) -> Result<Option<(ModuleReport, DateTime<Utc>, Uuid)>> {
    let row =
        sqlx::query("SELECT state,reported_at,conn_id FROM agent_module_reports WHERE agent_id=$1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|row| {
        Ok((
            ModuleReport::parse(row.try_get("state")?)?,
            row.try_get("reported_at")?,
            row.try_get("conn_id")?,
        ))
    })
    .transpose()
}
pub async fn save_module_report(
    pool: &PgPool,
    id: Uuid,
    conn: Uuid,
    report: &ModuleReport,
) -> Result<()> {
    sqlx::query("INSERT INTO agent_module_reports(agent_id,state,conn_id) VALUES($1,$2,$3) ON CONFLICT(agent_id) DO UPDATE SET state=EXCLUDED.state,conn_id=EXCLUDED.conn_id,reported_at=NOW()")
        .bind(id).bind(serde_json::to_value(report)?).bind(conn).execute(pool).await?;
    Ok(())
}
pub async fn module_disable_requests(
    pool: &PgPool,
    id: Uuid,
    pending_only: bool,
) -> Result<Vec<ModuleDisableRequest>> {
    let query = format!("SELECT {COLUMNS} FROM agent_module_disable_requests WHERE agent_id=$1 {} ORDER BY (status IN ('queued','sent')) DESC,created_at DESC LIMIT 200", if pending_only { "AND status IN ('queued','sent')" } else { "" });
    sqlx::query(&query)
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
    sqlx::query(&format!(
        "SELECT {COLUMNS} FROM agent_module_disable_requests WHERE agent_id=$1 AND command_id=$2"
    ))
    .bind(id)
    .bind(command_id)
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
    sqlx::query("INSERT INTO agent_module_disable_requests(command_id,agent_id,module,expected_revision) VALUES($1,$2,$3,$4::TEXT::NUMERIC) ON CONFLICT DO NOTHING")
        .bind(command_id).bind(id).bind(module.key()).bind(revision.to_string()).execute(pool).await?;
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
    sqlx::query("UPDATE agent_module_disable_requests SET status='sent',last_sent_conn_id=$3 WHERE agent_id=$1 AND command_id=$2 AND status IN ('queued','sent')")
        .bind(id).bind(command).bind(conn).execute(pool).await?;
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
    sqlx::query("UPDATE agent_module_disable_requests SET status=$3,error=$4,persisted=($3 IN ('disabled','duplicate')),acknowledged_at=NOW(),stop_status=$5 WHERE agent_id=$1 AND command_id=$2 AND status IN ('queued','sent')")
        .bind(id).bind(command).bind(status).bind(error).bind(stop_status).execute(pool).await?;
    Ok(())
}
