//! Installed software inventory persistence.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AgentSoftwareRow {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub install_date: Option<String>,
    pub captured_at: DateTime<Utc>,
}

/// Replace all software rows for an agent with a fresh snapshot (`items` from agent JSON).
pub async fn replace_agent_software(
    pool: &PgPool,
    agent_id: Uuid,
    items: &[serde_json::Value],
) -> Result<usize> {
    let mut tx = pool.begin().await?;
    sqlx::query!("DELETE FROM agent_software WHERE agent_id = $1", agent_id)
        .execute(&mut *tx)
        .await?;

    let mut n = 0usize;
    for item in items.iter().take(12_000) {
        let name = item["name"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let version = item["version"]
            .as_str()
            .map(std::string::ToString::to_string);
        let publisher = item["publisher"]
            .as_str()
            .map(std::string::ToString::to_string);
        let install_location = item["install_location"]
            .as_str()
            .map(std::string::ToString::to_string);
        let install_date = item["install_date"]
            .as_str()
            .map(std::string::ToString::to_string);
        sqlx::query!(
            r"
            INSERT INTO agent_software (agent_id, name, version, publisher, install_location, install_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            ",
            agent_id,
            name,
            version.as_deref(),
            publisher.as_deref(),
            install_location.as_deref(),
            install_date.as_deref()
        )
        .execute(&mut *tx)
        .await?;
        n += 1;
    }
    tx.commit().await?;
    Ok(n)
}

pub async fn list_agent_software(pool: &PgPool, agent_id: Uuid) -> Result<Vec<AgentSoftwareRow>> {
    Ok(sqlx::query_as!(
        AgentSoftwareRow,
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        ",
        agent_id
    )
    .fetch_all(pool)
    .await?)
}

/// Paginated software list (`ORDER BY lower(name)`). Returns `(rows, total_count)`.
pub async fn list_agent_software_paged(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AgentSoftwareRow>, i64)> {
    let total: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*)::bigint AS "count!" FROM agent_software WHERE agent_id = $1"#,
        agent_id
    )
    .fetch_one(pool)
    .await?;

    let rows = sqlx::query_as!(
        AgentSoftwareRow,
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        LIMIT $2 OFFSET $3
        ",
        agent_id,
        limit,
        offset
    )
    .fetch_all(pool)
    .await?;

    Ok((rows, total))
}

pub async fn latest_software_capture_time(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<DateTime<Utc>>> {
    let v: Option<DateTime<Utc>> = sqlx::query_scalar!(
        "SELECT MAX(captured_at) FROM agent_software WHERE agent_id = $1",
        agent_id
    )
    .fetch_one(pool)
    .await?;
    Ok(v)
}

/// Delete stale software inventory rows (by `captured_at`).
pub async fn prune_agent_software_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query!(
        "DELETE FROM agent_software WHERE captured_at < NOW() - ($1::bigint * INTERVAL '1 day')",
        days
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}
