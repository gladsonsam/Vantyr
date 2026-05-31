//! Internet block (parental controls) persistence (carved out of the monolithic `db.rs`).

use super::*;

/// Whether any enabled `internet_block_rule` applies to this agent (all/group/agent scope).
pub async fn get_agent_internet_blocked(pool: &PgPool, agent_id: Uuid) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        r"
        SELECT COUNT(*)
        FROM internet_block_rules r
        WHERE r.enabled
          -- Only always-on rules (no schedules) affect the boolean `set_network_policy` push.
          -- Scheduled rules are evaluated on-agent using local time.
          AND NOT EXISTS (SELECT 1 FROM internet_block_rule_schedules sch WHERE sch.rule_id = r.id)
          AND EXISTS (
            SELECT 1 FROM internet_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
              )
          )
        ",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

/// Effective scope kind for display: 'all' > 'group' > 'agent' > null.
pub async fn get_agent_internet_block_source(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<String>> {
    let row: Option<String> = sqlx::query_scalar(
        r"
        SELECT scope_kind FROM internet_block_rule_scopes s
        JOIN internet_block_rules r ON r.id = s.rule_id
        WHERE r.enabled
          AND NOT EXISTS (SELECT 1 FROM internet_block_rule_schedules sch WHERE sch.rule_id = r.id)
          AND (
            s.scope_kind = 'all'
            OR (s.scope_kind = 'agent' AND s.agent_id = $1)
            OR (s.scope_kind = 'group'
                AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
          )
        ORDER BY CASE s.scope_kind WHEN 'all' THEN 1 WHEN 'group' THEN 2 ELSE 3 END
        LIMIT 1
        ",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(row)
}

// ─── Internet block rules ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RuleScheduleJson {
    pub day_of_week: i32,
    pub start_minute: i32,
    pub end_minute: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockScopeJson {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockRuleRow {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub scopes: Vec<InternetBlockScopeJson>,
    pub schedules: Vec<RuleScheduleJson>,
}

pub async fn internet_block_rules_list_all(pool: &PgPool) -> Result<Vec<InternetBlockRuleRow>> {
    let rules =
        sqlx::query("SELECT id, name, enabled, created_at FROM internet_block_rules ORDER BY id")
            .fetch_all(pool)
            .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in &rules {
        let id: i64 = r.try_get("id")?;
        let scope_rows = sqlx::query(
            "SELECT scope_kind, group_id, agent_id FROM internet_block_rule_scopes WHERE rule_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        let scopes = scope_rows
            .iter()
            .map(|s| {
                Ok(InternetBlockScopeJson {
                    kind: s.try_get("scope_kind")?,
                    group_id: s.try_get::<Option<Uuid>, _>("group_id")?,
                    agent_id: s.try_get::<Option<Uuid>, _>("agent_id")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM internet_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        out.push(InternetBlockRuleRow {
            id,
            name: r.try_get("name")?,
            enabled: r.try_get("enabled")?,
            created_at: r.try_get("created_at")?,
            scopes,
            schedules,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockRuleEffectiveRow {
    pub id: i64,
    pub name: String,
    pub schedules: Vec<RuleScheduleJson>,
}

/// Effective internet block rules for a specific agent (enabled only).
/// Note: schedules may be empty (meaning "always active").
pub async fn internet_block_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<InternetBlockRuleEffectiveRow>> {
    let rules = sqlx::query(
        r"
        SELECT r.id, r.name
        FROM internet_block_rules r
        WHERE r.enabled
          AND EXISTS (
            SELECT 1 FROM internet_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
              )
          )
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in &rules {
        let id: i64 = r.try_get("id")?;
        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM internet_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        out.push(InternetBlockRuleEffectiveRow {
            id,
            name: r.try_get("name")?,
            schedules,
        });
    }

    Ok(out)
}

pub async fn internet_block_rule_create(
    pool: &PgPool,
    name: &str,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
    schedules: &[RuleScheduleJson],
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO internet_block_rules (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(&mut *tx)
            .await?;
    for (kind, group_id, agent_id) in scopes {
        sqlx::query(
            "INSERT INTO internet_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1,$2,$3,$4)",
        )
        .bind(id).bind(kind.as_str()).bind(group_id).bind(agent_id)
        .execute(&mut *tx)
        .await?;
    }
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO internet_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

pub async fn internet_block_rule_set_enabled(
    pool: &PgPool,
    rule_id: i64,
    enabled: bool,
) -> Result<bool> {
    let r = sqlx::query("UPDATE internet_block_rules SET enabled = $2 WHERE id = $1")
        .bind(rule_id)
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn internet_block_rule_set_schedules(
    pool: &PgPool,
    rule_id: i64,
    schedules: &[RuleScheduleJson],
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query("SELECT 1 FROM internet_block_rules WHERE id = $1")
        .bind(rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if r.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM internet_block_rule_schedules WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *tx)
        .await?;
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO internet_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(rule_id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn internet_block_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query("DELETE FROM internet_block_rules WHERE id = $1")
        .bind(rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Direct agent-scoped rule IDs for push-after-delete targeting.
pub async fn internet_block_rule_direct_agent_ids(
    pool: &PgPool,
    rule_id: i64,
) -> Result<Vec<Uuid>> {
    let rows = sqlx::query(
        "SELECT agent_id FROM internet_block_rule_scopes WHERE rule_id=$1 AND scope_kind='agent' AND agent_id IS NOT NULL",
    )
    .bind(rule_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| Ok(r.try_get::<Uuid, _>("agent_id")?))
        .collect()
}

pub async fn internet_block_rule_has_all_scope(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let c: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM internet_block_rule_scopes WHERE rule_id=$1 AND scope_kind='all'",
    )
    .bind(rule_id)
    .fetch_one(pool)
    .await?;
    Ok(c > 0)
}

/// Create or update the single agent-scoped rule for quick per-agent toggle.
/// Returns the new blocked state.
pub async fn internet_block_set_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    blocked: bool,
) -> Result<bool> {
    if blocked {
        // Create an agent-scoped rule if the agent isn't already blocked at agent scope.
        let already: i64 = sqlx::query_scalar(
            r"SELECT COUNT(*) FROM internet_block_rules r
               JOIN internet_block_rule_scopes s ON s.rule_id = r.id
               WHERE r.enabled AND s.scope_kind='agent' AND s.agent_id=$1",
        )
        .bind(agent_id)
        .fetch_one(pool)
        .await?;
        if already == 0 {
            internet_block_rule_create(
                pool,
                "Manual block",
                &[("agent".into(), None, Some(agent_id))],
                &[],
            )
            .await?;
        }
    } else {
        // Remove all agent-scoped rules for this specific agent.
        sqlx::query(
            r"DELETE FROM internet_block_rules WHERE id IN (
               SELECT rule_id FROM internet_block_rule_scopes WHERE scope_kind='agent' AND agent_id=$1
            )",
        )
        .bind(agent_id).execute(pool).await?;
    }
    get_agent_internet_blocked(pool, agent_id).await
}

pub async fn set_agent_internet_blocked(
    pool: &PgPool,
    agent_id: Uuid,
    blocked: bool,
) -> Result<()> {
    internet_block_set_for_agent(pool, agent_id, blocked).await?;
    Ok(())
}
