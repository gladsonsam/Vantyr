//! Agent group persistence (carved out of the monolithic `db.rs`).

use super::*;

#[derive(Debug, Clone, Serialize)]
pub struct AgentGroupRow {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub member_count: i64,
}

pub async fn agent_groups_list(pool: &PgPool) -> Result<Vec<AgentGroupRow>> {
    let rows = sqlx::query(
        r"
        SELECT g.id, g.name, g.description, g.created_at,
               COALESCE(COUNT(m.agent_id), 0)::BIGINT AS member_count
        FROM agent_groups g
        LEFT JOIN agent_group_members m ON m.group_id = g.id
        GROUP BY g.id, g.name, g.description, g.created_at
        ORDER BY lower(g.name)
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentGroupRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            description: r.try_get("description")?,
            created_at: r.try_get("created_at")?,
            member_count: r.try_get("member_count")?,
        });
    }
    Ok(out)
}

pub async fn agent_group_create(pool: &PgPool, name: &str, description: &str) -> Result<Uuid> {
    let id: Uuid = sqlx::query_scalar(
        r"
        INSERT INTO agent_groups (name, description)
        VALUES ($1, $2)
        RETURNING id
        ",
    )
    .bind(name.trim())
    .bind(description)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn agent_group_delete(pool: &PgPool, id: Uuid) -> Result<bool> {
    let r = sqlx::query("DELETE FROM agent_groups WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_rename(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    description: &str,
) -> Result<bool> {
    let r = sqlx::query("UPDATE agent_groups SET name = $2, description = $3 WHERE id = $1")
        .bind(id)
        .bind(name.trim())
        .bind(description)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_add_members(
    pool: &PgPool,
    group_id: Uuid,
    agent_ids: &[Uuid],
) -> Result<u64> {
    let mut n = 0u64;
    for aid in agent_ids {
        let r = sqlx::query(
            "INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(group_id)
        .bind(aid)
        .execute(pool)
        .await?;
        n += r.rows_affected();
    }
    Ok(n)
}

pub async fn agent_group_remove_member(
    pool: &PgPool,
    group_id: Uuid,
    agent_id: Uuid,
) -> Result<bool> {
    let r = sqlx::query("DELETE FROM agent_group_members WHERE group_id = $1 AND agent_id = $2")
        .bind(group_id)
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_members(pool: &PgPool, group_id: Uuid) -> Result<Vec<Uuid>> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT agent_id FROM agent_group_members WHERE group_id = $1 ORDER BY agent_id",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Groups that include this agent (for dashboard agent detail).
#[derive(Debug, Clone, Serialize)]
pub struct AgentGroupForAgentRow {
    pub id: Uuid,
    pub name: String,
    pub description: String,
}

pub async fn agent_groups_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AgentGroupForAgentRow>> {
    let rows = sqlx::query(
        r"
        SELECT g.id, g.name, g.description
        FROM agent_groups g
        INNER JOIN agent_group_members m ON m.group_id = g.id
        WHERE m.agent_id = $1
        ORDER BY lower(g.name)
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentGroupForAgentRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            description: r.try_get("description")?,
        });
    }
    Ok(out)
}
