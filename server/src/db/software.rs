//! Installed software inventory persistence (carved out of the monolithic `db.rs`).

use super::*;

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
    sqlx::query("DELETE FROM agent_software WHERE agent_id = $1")
        .bind(agent_id)
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
        sqlx::query(
            r"
            INSERT INTO agent_software (agent_id, name, version, publisher, install_location, install_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            ",
        )
        .bind(agent_id)
        .bind(name)
        .bind(version.as_deref())
        .bind(publisher.as_deref())
        .bind(install_location.as_deref())
        .bind(install_date.as_deref())
        .execute(&mut *tx)
        .await?;
        n += 1;
    }
    tx.commit().await?;
    Ok(n)
}

pub async fn list_agent_software(pool: &PgPool, agent_id: Uuid) -> Result<Vec<AgentSoftwareRow>> {
    let rows = sqlx::query(
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentSoftwareRow {
            name: r.try_get("name")?,
            version: r.try_get("version")?,
            publisher: r.try_get("publisher")?,
            install_location: r.try_get("install_location")?,
            install_date: r.try_get("install_date")?,
            captured_at: r.try_get("captured_at")?,
        });
    }
    Ok(out)
}

/// Paginated software list (`ORDER BY lower(name)`). Returns `(rows, total_count)`.
pub async fn list_agent_software_paged(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AgentSoftwareRow>, i64)> {
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM agent_software WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_one(pool)
            .await?;

    let rows = sqlx::query(
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentSoftwareRow {
            name: r.try_get("name")?,
            version: r.try_get("version")?,
            publisher: r.try_get("publisher")?,
            install_location: r.try_get("install_location")?,
            install_date: r.try_get("install_date")?,
            captured_at: r.try_get("captured_at")?,
        });
    }
    Ok((out, total))
}

pub async fn latest_software_capture_time(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<DateTime<Utc>>> {
    let v: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT MAX(captured_at) FROM agent_software WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_one(pool)
            .await?;
    Ok(v)
}
