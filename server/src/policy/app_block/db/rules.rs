//! App block rules: effective/applicable/list queries, scopes, schedules and CRUD.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::policy::RuleScheduleJson;
use ts_rs::TS;

/// Minimal rule payload pushed to agents over WebSocket.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AppBlockRuleRow {
    pub id: i64,
    /// Optional friendly label; used by the dashboard UI.
    #[serde(default)]
    pub name: String,
    pub exe_pattern: String,
    #[ts(type = "\"exact\" | \"contains\"")]
    pub match_mode: String,
    /// Always true for "effective" rules (disabled rules are excluded).
    pub enabled: bool,
    /// Most-permissive scope kind that makes this rule apply to the agent
    /// (`all` > `group` > `agent`). Included so the dashboard can show a scope badge.
    #[ts(type = "\"all\" | \"group\" | \"agent\"")]
    pub scope_kind: String,
    pub schedules: Vec<RuleScheduleJson>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AppBlockScopeJson {
    #[ts(type = "\"all\" | \"group\" | \"agent\"")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_id: Option<Uuid>,
}

/// Full rule item returned by the list API (includes scopes and metadata).
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AppBlockRuleListItem {
    pub id: i64,
    pub name: String,
    pub exe_pattern: String,
    #[ts(type = "\"exact\" | \"contains\"")]
    pub match_mode: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub scopes: Vec<AppBlockScopeJson>,
    pub schedules: Vec<RuleScheduleJson>,
}

/// Rules effective for a specific agent (all-scope + group + agent-scope, enabled only).
pub async fn app_block_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AppBlockRuleRow>> {
    // Subquery picks the most-permissive scope kind (all=1, group=2, agent=3)
    // for display purposes; the WHERE clause checks actual applicability.
    let rows = sqlx::query!(
        r"
        SELECT r.id, r.name, r.exe_pattern, r.match_mode,
               (SELECT scope_kind
                FROM app_block_rule_scopes sub
                WHERE sub.rule_id = r.id
                ORDER BY CASE sub.scope_kind
                             WHEN 'all'   THEN 1
                             WHEN 'group' THEN 2
                             ELSE 3
                         END
                LIMIT 1) AS scope_kind
        FROM app_block_rules r
        WHERE r.enabled
          AND EXISTS (
            SELECT 1 FROM app_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (
                        SELECT group_id FROM agent_group_members WHERE agent_id = $1
                    ))
              )
          )
        ORDER BY r.id
        ",
        agent_id
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let rule_id = r.id;
        let schedules = sqlx::query_as!(
            RuleScheduleJson,
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
            rule_id
        )
        .fetch_all(pool)
        .await?;
        out.push(AppBlockRuleRow {
            id: rule_id,
            name: r.name,
            exe_pattern: r.exe_pattern,
            match_mode: r.match_mode,
            enabled: true,
            scope_kind: r.scope_kind.unwrap_or_else(|| "agent".into()),
            schedules,
        });
    }
    Ok(out)
}

/// Rules applicable to a specific agent (all-scope + group + agent-scope), including disabled.
/// Used by the dashboard Agent → Control tab so toggled-off rules remain visible.
pub async fn app_block_rules_applicable_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AppBlockRuleRow>> {
    let rows = sqlx::query!(
        r"
        SELECT r.id, r.name, r.exe_pattern, r.match_mode, r.enabled,
               (SELECT scope_kind
                FROM app_block_rule_scopes sub
                WHERE sub.rule_id = r.id
                ORDER BY CASE sub.scope_kind
                             WHEN 'all'   THEN 1
                             WHEN 'group' THEN 2
                             ELSE 3
                         END
                LIMIT 1) AS scope_kind
        FROM app_block_rules r
        WHERE EXISTS (
            SELECT 1 FROM app_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (
                        SELECT group_id FROM agent_group_members WHERE agent_id = $1
                    ))
              )
        )
        ORDER BY r.id
        ",
        agent_id
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let rule_id = r.id;
        let schedules = sqlx::query_as!(
            RuleScheduleJson,
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
            rule_id
        )
        .fetch_all(pool)
        .await?;
        out.push(AppBlockRuleRow {
            id: rule_id,
            name: r.name,
            exe_pattern: r.exe_pattern,
            match_mode: r.match_mode,
            enabled: r.enabled,
            scope_kind: r.scope_kind.unwrap_or_else(|| "agent".into()),
            schedules,
        });
    }
    Ok(out)
}

/// All rules with their scopes — for the admin list view.
pub async fn app_block_rules_list_all(pool: &PgPool) -> Result<Vec<AppBlockRuleListItem>> {
    let rules = sqlx::query!(
        "SELECT id, name, exe_pattern, match_mode, enabled, created_at FROM app_block_rules ORDER BY id"
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in rules {
        let id = r.id;
        let scope_rows = sqlx::query!(
            "SELECT scope_kind, group_id, agent_id FROM app_block_rule_scopes WHERE rule_id = $1 ORDER BY id",
            id
        )
        .fetch_all(pool)
        .await?;

        let scopes = scope_rows
            .into_iter()
            .map(|s| AppBlockScopeJson {
                kind: s.scope_kind,
                group_id: s.group_id,
                agent_id: s.agent_id,
            })
            .collect();

        let schedules = sqlx::query_as!(
            RuleScheduleJson,
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
            id
        )
        .fetch_all(pool)
        .await?;
        out.push(AppBlockRuleListItem {
            id,
            name: r.name,
            exe_pattern: r.exe_pattern,
            match_mode: r.match_mode,
            enabled: r.enabled,
            created_at: r.created_at,
            scopes,
            schedules,
        });
    }
    Ok(out)
}

/// Insert a new rule with its scopes. Returns the new rule id.
pub async fn app_block_rule_create(
    pool: &PgPool,
    name: &str,
    exe_pattern: &str,
    match_mode: &str,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
    schedules: &[RuleScheduleJson],
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar!(
        "INSERT INTO app_block_rules (name, exe_pattern, match_mode) VALUES ($1, $2, $3) RETURNING id",
        name,
        exe_pattern,
        match_mode
    )
    .fetch_one(&mut *tx)
    .await?;

    for (kind, group_id, agent_id) in scopes {
        sqlx::query!(
            "INSERT INTO app_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
            id,
            kind.as_str(),
            *group_id,
            *agent_id
        )
        .execute(&mut *tx)
        .await?;
    }
    for s in schedules {
        sqlx::query!(
            r"
            INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
            id,
            s.day_of_week,
            s.start_minute,
            s.end_minute
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

#[allow(dead_code)]
pub async fn app_block_rule_set_schedules(
    pool: &PgPool,
    rule_id: i64,
    schedules: &[RuleScheduleJson],
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query_scalar!("SELECT 1 FROM app_block_rules WHERE id = $1", rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if r.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query!(
        "DELETE FROM app_block_rule_schedules WHERE rule_id = $1",
        rule_id
    )
    .execute(&mut *tx)
    .await?;
    for s in schedules {
        sqlx::query!(
            r"
            INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
            rule_id,
            s.day_of_week,
            s.start_minute,
            s.end_minute
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// A scope row used by app-block rule operations: `(kind, group_id, agent_id)`.
pub type ScopeRow = (String, Option<Uuid>, Option<Uuid>);

/// Optional fields that can be updated on an app-block rule.
pub struct AppBlockRuleUpdateOpts<'a> {
    pub name: Option<&'a str>,
    pub exe_pattern: Option<&'a str>,
    pub match_mode: Option<&'a str>,
    pub enabled: Option<bool>,
    pub scopes: Option<&'a [ScopeRow]>,
    pub schedules: Option<&'a [RuleScheduleJson]>,
}

pub async fn app_block_rule_update(
    pool: &PgPool,
    rule_id: i64,
    opts: AppBlockRuleUpdateOpts<'_>,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let exists = sqlx::query_scalar!("SELECT 1 FROM app_block_rules WHERE id = $1", rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }

    if opts.name.is_some()
        || opts.exe_pattern.is_some()
        || opts.match_mode.is_some()
        || opts.enabled.is_some()
    {
        sqlx::query!(
            r"
            UPDATE app_block_rules
            SET name = COALESCE($2, name),
                exe_pattern = COALESCE($3, exe_pattern),
                match_mode = COALESCE($4, match_mode),
                enabled = COALESCE($5, enabled)
            WHERE id = $1
            ",
            rule_id,
            opts.name,
            opts.exe_pattern,
            opts.match_mode,
            opts.enabled
        )
        .execute(&mut *tx)
        .await?;
    }

    if let Some(scopes_rows) = opts.scopes {
        sqlx::query!(
            "DELETE FROM app_block_rule_scopes WHERE rule_id = $1",
            rule_id
        )
        .execute(&mut *tx)
        .await?;
        for (kind, group_id, agent_id) in scopes_rows {
            sqlx::query!(
                "INSERT INTO app_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
                rule_id,
                kind.as_str(),
                *group_id,
                *agent_id
            )
            .execute(&mut *tx)
            .await?;
        }
    }

    if let Some(sched_rows) = opts.schedules {
        sqlx::query!(
            "DELETE FROM app_block_rule_schedules WHERE rule_id = $1",
            rule_id
        )
        .execute(&mut *tx)
        .await?;
        for s in sched_rows {
            sqlx::query!(
                r"
                INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
                VALUES ($1, $2, $3, $4)
                ",
                rule_id,
                s.day_of_week,
                s.start_minute,
                s.end_minute
            )
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(true)
}

/// Toggle a rule's enabled state. Returns false if the rule wasn't found.
#[allow(dead_code)]
pub async fn app_block_rule_set_enabled(
    pool: &PgPool,
    rule_id: i64,
    enabled: bool,
) -> Result<bool> {
    let r = sqlx::query!(
        "UPDATE app_block_rules SET enabled = $2 WHERE id = $1",
        rule_id,
        enabled
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

/// Delete a rule (cascades to scopes). Returns false if not found.
pub async fn app_block_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query!("DELETE FROM app_block_rules WHERE id = $1", rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Agent UUIDs that have a direct-scope rule for this `rule_id` (for targeted push).
pub async fn app_block_rule_direct_agent_ids(pool: &PgPool, rule_id: i64) -> Result<Vec<Uuid>> {
    let rows = sqlx::query_scalar!(
        "SELECT agent_id FROM app_block_rule_scopes WHERE rule_id = $1 AND scope_kind = 'agent' AND agent_id IS NOT NULL",
        rule_id
    )
    .fetch_all(pool)
    .await?;

    // `agent_id IS NOT NULL` is filtered in SQL; the column itself is nullable.
    Ok(rows.into_iter().flatten().collect())
}

/// Whether a rule has any all-scope entry.
pub async fn app_block_rule_has_all_scope(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM app_block_rule_scopes WHERE rule_id = $1 AND scope_kind = 'all'"#,
        rule_id
    )
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}
