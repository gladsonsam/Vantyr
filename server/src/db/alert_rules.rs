//! Alert rule persistence (carved out of the monolithic `db.rs`).

use super::*;

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleRow {
    pub id: i64,
    pub name: String,
    pub pattern: String,
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub take_screenshot: bool,
    // Monitoring channels (`resource` / `agent_offline`).
    pub metric: Option<String>,
    pub comparator: Option<String>,
    pub threshold: Option<f32>,
    pub duration_secs: Option<i32>,
}

/// Rules that apply to this agent (global + group memberships + direct agent scope).
pub async fn alert_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    channel: &str,
) -> Result<Vec<AlertRuleRow>> {
    let rows = sqlx::query(
        r"
        SELECT DISTINCT r.id, r.name, r.pattern, r.match_mode,
               r.case_insensitive, r.cooldown_secs, r.take_screenshot,
               r.metric, r.comparator, r.threshold, r.duration_secs
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
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .bind(channel)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AlertRuleRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            pattern: r.try_get("pattern")?,
            match_mode: r.try_get("match_mode")?,
            case_insensitive: r.try_get("case_insensitive")?,
            cooldown_secs: r.try_get("cooldown_secs")?,
            take_screenshot: r.try_get::<bool, _>("take_screenshot").unwrap_or(false),
            metric: r.try_get::<Option<String>, _>("metric").unwrap_or(None),
            comparator: r.try_get::<Option<String>, _>("comparator").unwrap_or(None),
            threshold: r.try_get::<Option<f32>, _>("threshold").unwrap_or(None),
            duration_secs: r.try_get::<Option<i32>, _>("duration_secs").unwrap_or(None),
        });
    }
    Ok(out)
}

/// Cheap existence check so periodic evaluators can no-op when a channel is unused.
pub async fn has_enabled_alert_rules(pool: &PgPool, channel: &str) -> Result<bool> {
    let found: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM alert_rules WHERE channel = $1 AND enabled LIMIT 1")
            .bind(channel)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some())
}

/// (id, name, last_seen) for every agent — caller cross-checks against the live
/// connected set to evaluate `agent_offline` alert rules.
pub async fn all_agents_last_seen(pool: &PgPool) -> Result<Vec<(Uuid, String, DateTime<Utc>)>> {
    let rows = sqlx::query("SELECT id, name, last_seen FROM agents")
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push((
            r.try_get("id")?,
            r.try_get::<String, _>("name").unwrap_or_default(),
            r.try_get("last_seen")?,
        ));
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleScopeJson {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleListItem {
    pub id: i64,
    pub name: String,
    pub channel: String,
    pub pattern: String,
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub enabled: bool,
    pub take_screenshot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<i32>,
    pub scopes: Vec<AlertRuleScopeJson>,
}

pub async fn alert_rules_list_all(pool: &PgPool) -> Result<Vec<AlertRuleListItem>> {
    let rules = sqlx::query(
        r"
        SELECT id, name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot,
               metric, comparator, threshold, duration_secs
        FROM alert_rules
        ORDER BY id
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in rules {
        let id: i64 = r.try_get("id")?;
        let scopes_rows = sqlx::query(
            "SELECT scope_kind, group_id, agent_id FROM alert_rule_scopes WHERE rule_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        let mut scopes = Vec::with_capacity(scopes_rows.len());
        for s in scopes_rows {
            let kind: String = s.try_get("scope_kind")?;
            scopes.push(AlertRuleScopeJson {
                kind,
                group_id: s.try_get::<Option<Uuid>, _>("group_id")?,
                agent_id: s.try_get::<Option<Uuid>, _>("agent_id")?,
            });
        }

        out.push(AlertRuleListItem {
            id,
            name: r.try_get("name")?,
            channel: r.try_get("channel")?,
            pattern: r.try_get("pattern")?,
            match_mode: r.try_get("match_mode")?,
            case_insensitive: r.try_get("case_insensitive")?,
            cooldown_secs: r.try_get("cooldown_secs")?,
            enabled: r.try_get("enabled")?,
            take_screenshot: r.try_get::<bool, _>("take_screenshot").unwrap_or(false),
            metric: r.try_get::<Option<String>, _>("metric").unwrap_or(None),
            comparator: r.try_get::<Option<String>, _>("comparator").unwrap_or(None),
            threshold: r.try_get::<Option<f32>, _>("threshold").unwrap_or(None),
            duration_secs: r.try_get::<Option<i32>, _>("duration_secs").unwrap_or(None),
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
    sqlx::query("DELETE FROM alert_rule_scopes WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *conn)
        .await?;

    for (kind, group_id, agent_id) in scopes {
        sqlx::query(
            r"
            INSERT INTO alert_rule_scopes (rule_id, scope_kind, group_id, agent_id)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(rule_id)
        .bind(kind.as_str())
        .bind(group_id)
        .bind(agent_id)
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
    let id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO alert_rules (name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot,
                                 metric, comparator, threshold, duration_secs)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        ",
    )
    .bind(params.name)
    .bind(params.channel)
    .bind(params.pattern)
    .bind(params.match_mode)
    .bind(params.case_insensitive)
    .bind(params.cooldown_secs)
    .bind(params.enabled)
    .bind(params.take_screenshot)
    .bind(params.metric)
    .bind(params.comparator)
    .bind(params.threshold)
    .bind(params.duration_secs)
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
    let r = sqlx::query(
        r"
        UPDATE alert_rules
        SET name = $2, channel = $3, pattern = $4, match_mode = $5,
            case_insensitive = $6, cooldown_secs = $7, enabled = $8, take_screenshot = $9,
            metric = $10, comparator = $11, threshold = $12, duration_secs = $13, updated_at = NOW()
        WHERE id = $1
        ",
    )
    .bind(rule_id)
    .bind(params.name)
    .bind(params.channel)
    .bind(params.pattern)
    .bind(params.match_mode)
    .bind(params.case_insensitive)
    .bind(params.cooldown_secs)
    .bind(params.enabled)
    .bind(params.take_screenshot)
    .bind(params.metric)
    .bind(params.comparator)
    .bind(params.threshold)
    .bind(params.duration_secs)
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
    let r = sqlx::query("DELETE FROM alert_rules WHERE id = $1")
        .bind(rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

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
    let id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO alert_rule_events (agent_id, rule_id, rule_name, channel, snippet)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        ",
    )
    .bind(agent_id)
    .bind(rule_id)
    .bind(rule_name)
    .bind(channel)
    .bind(snippet)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn alert_rule_event_screenshot_upsert(
    pool: &PgPool,
    event_id: i64,
    jpeg: &[u8],
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO alert_rule_event_screenshots (event_id, jpeg)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO UPDATE SET
            jpeg = EXCLUDED.jpeg,
            created_at = NOW()
        ",
    )
    .bind(event_id)
    .bind(jpeg)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn alert_rule_event_screenshot_get(
    pool: &PgPool,
    event_id: i64,
) -> Result<Option<Vec<u8>>> {
    let v: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT jpeg FROM alert_rule_event_screenshots WHERE event_id = $1")
            .bind(event_id)
            .fetch_optional(pool)
            .await?
            .flatten();
    Ok(v)
}

/// All alert events across all agents — newest first (admin).
pub async fn alert_rule_events_list_all(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS agent_name,
               e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        ORDER BY e.created_at DESC
        LIMIT $1 OFFSET $2
        ",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| {
            Ok(AlertRuleEventTriggeredRow {
                id: r.try_get("id")?,
                agent_id: r.try_get("agent_id")?,
                agent_name: r.try_get("agent_name")?,
                rule_name: r.try_get("rule_name")?,
                channel: r.try_get("channel")?,
                snippet: r.try_get("snippet")?,
                has_screenshot: r.try_get::<bool, _>("has_screenshot").unwrap_or(false),
                screenshot_requested: r
                    .try_get::<bool, _>("screenshot_requested")
                    .unwrap_or(false),
                created_at: r.try_get("created_at")?,
            })
        })
        .collect()
}

pub async fn alert_rule_events_list_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.rule_id, e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.agent_id = $1
        ORDER BY e.created_at DESC
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
        out.push(AlertRuleEventRow {
            id: r.try_get("id")?,
            rule_id: r.try_get("rule_id")?,
            rule_name: r.try_get("rule_name")?,
            channel: r.try_get("channel")?,
            snippet: r.try_get("snippet")?,
            has_screenshot: r.try_get::<bool, _>("has_screenshot").unwrap_or(false),
            screenshot_requested: r
                .try_get::<bool, _>("screenshot_requested")
                .unwrap_or(false),
            created_at: r.try_get("created_at")?,
        });
    }
    Ok(out)
}

pub async fn alert_rule_events_list_for_rule(
    pool: &PgPool,
    rule_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS agent_name, e.rule_name, e.channel, e.snippet,
               e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.rule_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(rule_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(AlertRuleEventTriggeredRow {
            id: row.try_get("id")?,
            agent_id: row.try_get("agent_id")?,
            agent_name: row.try_get("agent_name")?,
            rule_name: row.try_get("rule_name")?,
            channel: row.try_get("channel")?,
            snippet: row.try_get("snippet")?,
            has_screenshot: row.try_get::<bool, _>("has_screenshot").unwrap_or(false),
            screenshot_requested: row
                .try_get::<bool, _>("screenshot_requested")
                .unwrap_or(false),
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(out)
}
