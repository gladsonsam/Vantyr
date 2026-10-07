//! Alert rules and their scopes: effective-rule lookup, admin CRUD and the offline-agent feed.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AlertRuleRow {
    pub id: i64,
    pub name: String,
    pub pattern: String,
    #[ts(type = "\"substring\" | \"regex\"")]
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub take_screenshot: bool,
    // Monitoring channels (`resource` / `agent_offline`).
    #[ts(type = "\"cpu_pct\" | \"mem_pct\" | \"disk_pct\" | null")]
    pub metric: Option<String>,
    #[ts(type = "\"gt\" | \"lt\" | null")]
    pub comparator: Option<String>,
    pub threshold: Option<f32>,
    pub duration_secs: Option<i32>,
    /// Most-permissive of the scopes through which this rule applies to the agent
    /// (`all` > `group` > `agent`), shown in the dashboard's "From" column.
    #[ts(type = "\"all\" | \"group\" | \"agent\"")]
    pub scope_kind: String,
}

/// Rules that apply to this agent (global + group memberships + direct agent scope).
pub async fn alert_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    channel: &str,
) -> Result<Vec<AlertRuleRow>> {
    Ok(sqlx::query_as!(
        AlertRuleRow,
        r#"
        SELECT r.id, r.name, r.pattern, r.match_mode,
               r.case_insensitive, r.cooldown_secs, r.take_screenshot,
               r.metric, r.comparator, r.threshold, r.duration_secs,
               -- Only scopes that matched this agent (the WHERE below), most permissive first.
               (array_agg(s.scope_kind ORDER BY CASE s.scope_kind
                                                    WHEN 'all'   THEN 1
                                                    WHEN 'group' THEN 2
                                                    ELSE 3
                                                END))[1] AS "scope_kind!"
        FROM alert_rules r
        INNER JOIN alert_rule_scopes s ON s.rule_id = r.id
        WHERE r.enabled
          AND r.channel = $2
          AND (
            s.scope_kind = 'all'
            OR (s.scope_kind = 'agent' AND s.agent_id = $1)
            OR (
                s.scope_kind = 'group'
                AND s.group_id IN (
                    SELECT group_id FROM agent_group_members WHERE agent_id = $1
                )
            )
          )
        GROUP BY r.id
        ORDER BY r.id
        "#,
        agent_id,
        channel
    )
    .fetch_all(pool)
    .await?)
}

/// Cheap existence check so periodic evaluators can no-op when a channel is unused.
pub async fn has_enabled_alert_rules(pool: &PgPool, channel: &str) -> Result<bool> {
    let found: Option<Option<i32>> = sqlx::query_scalar!(
        "SELECT 1 FROM alert_rules WHERE channel = $1 AND enabled LIMIT 1",
        channel
    )
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// (id, name, last_seen) for every agent — caller cross-checks against the live
/// connected set to evaluate `agent_offline` alert rules.
pub async fn all_agents_last_seen(pool: &PgPool) -> Result<Vec<(Uuid, String, DateTime<Utc>)>> {
    let rows = sqlx::query!("SELECT id, name, last_seen FROM agents")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.id, r.name, r.last_seen))
        .collect())
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AlertRuleScopeJson {
    #[ts(type = "\"all\" | \"group\" | \"agent\"")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AlertRuleListItem {
    pub id: i64,
    pub name: String,
    #[ts(type = "\"url\" | \"keys\" | \"url_category\" | \"agent_offline\" | \"resource\"")]
    pub channel: String,
    pub pattern: String,
    #[ts(type = "\"substring\" | \"regex\"")]
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub enabled: bool,
    pub take_screenshot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "\"cpu_pct\" | \"mem_pct\" | \"disk_pct\"")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "\"gt\" | \"lt\"")]
    pub comparator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_secs: Option<i32>,
    pub scopes: Vec<AlertRuleScopeJson>,
}

pub async fn alert_rules_list_all(pool: &PgPool) -> Result<Vec<AlertRuleListItem>> {
    let rules = sqlx::query!(
        r"
        SELECT id, name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot,
               metric, comparator, threshold, duration_secs
        FROM alert_rules
        ORDER BY id
        "
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in rules {
        let id = r.id;
        let scopes_rows = sqlx::query!(
            "SELECT scope_kind, group_id, agent_id FROM alert_rule_scopes WHERE rule_id = $1 ORDER BY id",
            id
        )
        .fetch_all(pool)
        .await?;

        let mut scopes = Vec::with_capacity(scopes_rows.len());
        for s in scopes_rows {
            scopes.push(AlertRuleScopeJson {
                kind: s.scope_kind,
                group_id: s.group_id,
                agent_id: s.agent_id,
            });
        }

        out.push(AlertRuleListItem {
            id,
            name: r.name,
            channel: r.channel,
            pattern: r.pattern,
            match_mode: r.match_mode,
            case_insensitive: r.case_insensitive,
            cooldown_secs: r.cooldown_secs,
            enabled: r.enabled,
            take_screenshot: r.take_screenshot,
            metric: r.metric,
            comparator: r.comparator,
            threshold: r.threshold,
            duration_secs: r.duration_secs,
            scopes,
        });
    }
    Ok(out)
}

async fn alert_rule_scopes_write_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    rule_id: i64,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
) -> Result<()> {
    let conn = &mut **tx;
    sqlx::query!("DELETE FROM alert_rule_scopes WHERE rule_id = $1", rule_id)
        .execute(&mut *conn)
        .await?;

    for (kind, group_id, agent_id) in scopes {
        sqlx::query!(
            r"
            INSERT INTO alert_rule_scopes (rule_id, scope_kind, group_id, agent_id)
            VALUES ($1, $2, $3, $4)
            ",
            rule_id,
            kind.as_str(),
            *group_id,
            *agent_id
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub async fn alert_rule_create_with_scopes(
    pool: &PgPool,
    params: &AlertRuleUpsert<'_>,
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar!(
        r"
        INSERT INTO alert_rules (name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot,
                                 metric, comparator, threshold, duration_secs)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        ",
        params.name,
        params.channel,
        params.pattern,
        params.match_mode,
        params.case_insensitive,
        params.cooldown_secs,
        params.enabled,
        params.take_screenshot,
        params.metric,
        params.comparator,
        params.threshold,
        params.duration_secs
    )
    .fetch_one(&mut *tx)
    .await?;
    alert_rule_scopes_write_tx(&mut tx, id, params.scopes).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn alert_rule_update_with_scopes(
    pool: &PgPool,
    rule_id: i64,
    params: &AlertRuleUpsert<'_>,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query!(
        r"
        UPDATE alert_rules
        SET name = $2, channel = $3, pattern = $4, match_mode = $5,
            case_insensitive = $6, cooldown_secs = $7, enabled = $8, take_screenshot = $9,
            metric = $10, comparator = $11, threshold = $12, duration_secs = $13, updated_at = NOW()
        WHERE id = $1
        ",
        rule_id,
        params.name,
        params.channel,
        params.pattern,
        params.match_mode,
        params.case_insensitive,
        params.cooldown_secs,
        params.enabled,
        params.take_screenshot,
        params.metric,
        params.comparator,
        params.threshold,
        params.duration_secs
    )
    .execute(&mut *tx)
    .await?;
    if r.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(false);
    }
    alert_rule_scopes_write_tx(&mut tx, rule_id, params.scopes).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn alert_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query!("DELETE FROM alert_rules WHERE id = $1", rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Arguments for [`alert_rule_create_with_scopes`] and [`alert_rule_update_with_scopes`].
#[derive(Clone, Copy)]
pub struct AlertRuleUpsert<'a> {
    pub name: &'a str,
    pub channel: &'a str,
    pub pattern: &'a str,
    pub match_mode: &'a str,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub enabled: bool,
    pub take_screenshot: bool,
    /// Monitoring channels only: which metric (`resource`) — cpu_pct/mem_pct/disk_pct.
    pub metric: Option<&'a str>,
    /// Monitoring channels only: `gt` | `lt` (`resource`).
    pub comparator: Option<&'a str>,
    /// Monitoring channels only: percent threshold (`resource`).
    pub threshold: Option<f32>,
    /// Monitoring channels only: offline grace / sustained breach seconds.
    pub duration_secs: Option<i32>,
    pub scopes: &'a [(String, Option<Uuid>, Option<Uuid>)],
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn insert_agent(pool: &PgPool, name: &str) -> Uuid {
        sqlx::query_scalar("INSERT INTO agents (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn insert_rule(
        pool: &PgPool,
        name: &str,
        kind: &str,
        group_id: Option<Uuid>,
        agent_id: Option<Uuid>,
    ) {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO alert_rules (name, channel, pattern) VALUES ($1, 'url', 'x') RETURNING id",
        )
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO alert_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(kind)
        .bind(group_id)
        .bind(agent_id)
        .execute(pool)
        .await
        .unwrap();
    }

    fn scope_by_name(rows: &[AlertRuleRow]) -> std::collections::HashMap<&str, &str> {
        rows.iter()
            .map(|r| (r.name.as_str(), r.scope_kind.as_str()))
            .collect()
    }

    #[sqlx::test]
    async fn effective_rules_report_the_most_permissive_scope_kind(pool: PgPool) {
        let agent = insert_agent(&pool, "device").await;
        let outsider = insert_agent(&pool, "outsider").await;
        let group: Uuid =
            sqlx::query_scalar("INSERT INTO agent_groups (name) VALUES ('g') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2)")
            .bind(group)
            .bind(agent)
            .execute(&pool)
            .await
            .unwrap();

        insert_rule(&pool, "device rule", "agent", None, Some(agent)).await;
        insert_rule(&pool, "group rule", "group", Some(group), None).await;
        insert_rule(&pool, "all rule", "all", None, None).await;

        let rows = alert_rules_effective_for_agent(&pool, agent, "url")
            .await
            .unwrap();
        assert_eq!(
            scope_by_name(&rows),
            std::collections::HashMap::from([
                ("device rule", "agent"),
                ("group rule", "group"),
                ("all rule", "all"),
            ])
        );

        // The outsider is in no group and owns no device rule: only the
        // all-devices rule applies, still labelled `all`.
        let rows = alert_rules_effective_for_agent(&pool, outsider, "url")
            .await
            .unwrap();
        assert_eq!(
            scope_by_name(&rows),
            std::collections::HashMap::from([("all rule", "all")])
        );
    }

    #[sqlx::test]
    async fn effective_scope_kind_ignores_scopes_that_do_not_match_the_agent(pool: PgPool) {
        let agent = insert_agent(&pool, "device").await;
        let other_group: Uuid =
            sqlx::query_scalar("INSERT INTO agent_groups (name) VALUES ('other') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        // Scoped both to a group the agent is not in and directly to the agent: it
        // applies only through the device scope, so it must not be labelled `group`.
        insert_rule(&pool, "mixed rule", "group", Some(other_group), None).await;
        sqlx::query(
            "INSERT INTO alert_rule_scopes (rule_id, scope_kind, agent_id)
             SELECT id, 'agent', $1 FROM alert_rules WHERE name = 'mixed rule'",
        )
        .bind(agent)
        .execute(&pool)
        .await
        .unwrap();

        let rows = alert_rules_effective_for_agent(&pool, agent, "url")
            .await
            .unwrap();
        assert_eq!(
            scope_by_name(&rows),
            std::collections::HashMap::from([("mixed rule", "agent")])
        );
    }
}
