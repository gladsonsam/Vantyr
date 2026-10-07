//! Scheduled-script persistence: definitions with their scopes/schedules, target
//! resolution, and the per-agent execution log.

use std::collections::HashSet;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{ScheduledScriptRow, ScheduledScriptSchedule, ScheduledScriptScope};

pub async fn list_scripts(pool: &PgPool) -> Result<Vec<ScheduledScriptRow>> {
    let records = sqlx::query(
        r"
        SELECT
            s.id, s.name, s.shell, s.script, s.timeout_secs, s.enabled, s.created_at, s.updated_at,
            COALESCE(json_agg(json_build_object('kind', sc.kind, 'group_id', sc.group_id, 'agent_id', sc.agent_id)) FILTER (WHERE sc.kind IS NOT NULL), '[]'::json) as scopes,
            COALESCE((
                SELECT json_agg(json_build_object('frequency', sch.frequency, 'day_of_week', sch.day_of_week, 'fire_minute', sch.fire_minute))
                FROM scheduled_script_schedules sch WHERE sch.script_id = s.id
            ), '[]'::json) as schedules
        FROM scheduled_scripts s
        LEFT JOIN scheduled_script_scopes sc ON sc.script_id = s.id
        GROUP BY s.id
        ORDER BY s.id DESC
        "
    )
    .fetch_all(pool)
    .await?;

    let mut rules = Vec::new();
    for r in records {
        let scopes_val: serde_json::Value = r.try_get("scopes").unwrap_or_default();
        let scopes: Vec<ScheduledScriptScope> =
            serde_json::from_value(scopes_val).unwrap_or_default();

        let schedules_val: serde_json::Value = r.try_get("schedules").unwrap_or_default();
        let schedules: Vec<ScheduledScriptSchedule> =
            serde_json::from_value(schedules_val).unwrap_or_default();

        rules.push(ScheduledScriptRow {
            id: r.try_get("id").unwrap_or_default(),
            name: r.try_get("name").unwrap_or_default(),
            shell: r.try_get("shell").unwrap_or_default(),
            script: r.try_get("script").unwrap_or_default(),
            timeout_secs: r.try_get("timeout_secs").unwrap_or_default(),
            enabled: r.try_get("enabled").unwrap_or_default(),
            created_at: r.try_get("created_at").unwrap_or_default(),
            updated_at: r.try_get("updated_at").unwrap_or_default(),
            scopes,
            schedules,
        });
    }
    Ok(rules)
}

/// An enabled script as seen by the minute scheduler.
pub struct EnabledScript {
    pub id: i64,
    pub name: String,
    pub shell: String,
    pub script: String,
    pub timeout_secs: i32,
    pub schedules: Vec<ScheduledScriptSchedule>,
    pub scopes: Vec<ScheduledScriptScope>,
}

pub async fn list_enabled_scripts(pool: &PgPool) -> Result<Vec<EnabledScript>> {
    let records = sqlx::query(
        r"
        SELECT
            s.id, s.name, s.shell, s.script, s.timeout_secs,
            COALESCE(json_agg(json_build_object('kind', sc.kind, 'group_id', sc.group_id, 'agent_id', sc.agent_id)) FILTER (WHERE sc.kind IS NOT NULL), '[]') as scopes,
            COALESCE((
                SELECT json_agg(json_build_object('frequency', sch.frequency, 'day_of_week', sch.day_of_week, 'fire_minute', sch.fire_minute))
                FROM scheduled_script_schedules sch WHERE sch.script_id = s.id
            ), '[]'::json) as schedules
        FROM scheduled_scripts s
        LEFT JOIN scheduled_script_scopes sc ON sc.script_id = s.id
        WHERE s.enabled = true
        GROUP BY s.id
        "
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(records.len());
    for record in records {
        let schedules_val: serde_json::Value = record.try_get("schedules").unwrap_or_default();
        let scopes_val: serde_json::Value = record.try_get("scopes").unwrap_or_default();
        out.push(EnabledScript {
            id: record.try_get("id")?,
            name: record.try_get("name")?,
            shell: record.try_get("shell")?,
            script: record.try_get("script")?,
            timeout_secs: record.try_get("timeout_secs")?,
            schedules: serde_json::from_value(schedules_val).unwrap_or_default(),
            scopes: serde_json::from_value(scopes_val).unwrap_or_default(),
        });
    }
    Ok(out)
}

pub async fn create_script(
    pool: &PgPool,
    name: &str,
    shell: &str,
    script: &str,
    timeout_secs: i32,
    scopes: &[ScheduledScriptScope],
    schedules: &[ScheduledScriptSchedule],
) -> Result<i64> {
    let mut tx = pool.begin().await?;

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO scheduled_scripts (name, shell, script, timeout_secs) VALUES ($1, $2, $3, $4) RETURNING id"
    )
    .bind(name)
    .bind(shell)
    .bind(script)
    .bind(timeout_secs)
    .fetch_one(&mut *tx)
    .await?;

    for scope in scopes {
        sqlx::query(
            "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)"
        )
        .bind(id)
        .bind(&scope.kind)
        .bind(scope.group_id)
        .bind(scope.agent_id)
        .execute(&mut *tx)
        .await?;
    }

    for sch in schedules {
        sqlx::query(
            "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)"
        )
        .bind(id)
        .bind(&sch.frequency)
        .bind(sch.day_of_week)
        .bind(sch.fire_minute)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(id)
}

/// Fields to change on an existing script; `None` leaves the column untouched. Scopes and
/// schedules are replaced wholesale when present.
#[derive(Default)]
pub struct ScriptUpdate {
    pub enabled: Option<bool>,
    pub name: Option<String>,
    pub shell: Option<String>,
    pub script: Option<String>,
    pub timeout_secs: Option<i32>,
    pub scopes: Option<Vec<ScheduledScriptScope>>,
    pub schedules: Option<Vec<ScheduledScriptSchedule>>,
}

pub async fn update_script(pool: &PgPool, id: i64, u: ScriptUpdate) -> Result<()> {
    let mut tx = pool.begin().await?;

    if let Some(enabled) = u.enabled {
        sqlx::query("UPDATE scheduled_scripts SET enabled = $1, updated_at = NOW() WHERE id = $2")
            .bind(enabled)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(name) = u.name {
        sqlx::query("UPDATE scheduled_scripts SET name = $1, updated_at = NOW() WHERE id = $2")
            .bind(name)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(shell) = u.shell {
        sqlx::query("UPDATE scheduled_scripts SET shell = $1, updated_at = NOW() WHERE id = $2")
            .bind(shell)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(script) = u.script {
        sqlx::query("UPDATE scheduled_scripts SET script = $1, updated_at = NOW() WHERE id = $2")
            .bind(script)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(timeout_secs) = u.timeout_secs {
        sqlx::query(
            "UPDATE scheduled_scripts SET timeout_secs = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(timeout_secs)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(scopes) = u.scopes {
        sqlx::query("DELETE FROM scheduled_script_scopes WHERE script_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for scope in &scopes {
            sqlx::query(
                "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)"
            )
            .bind(id).bind(&scope.kind).bind(scope.group_id).bind(scope.agent_id)
            .execute(&mut *tx).await?;
        }
    }

    if let Some(schedules) = u.schedules {
        sqlx::query("DELETE FROM scheduled_script_schedules WHERE script_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for sch in &schedules {
            sqlx::query(
                "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)"
            )
            .bind(id).bind(&sch.frequency).bind(sch.day_of_week).bind(sch.fire_minute)
            .execute(&mut *tx).await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

/// `(name, shell, script, timeout_secs)` for one script.
pub async fn script_body(pool: &PgPool, id: i64) -> Result<Option<(String, String, String, i32)>> {
    Ok(sqlx::query_as(
        "SELECT name, shell, script, timeout_secs FROM scheduled_scripts WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

pub async fn script_scopes(pool: &PgPool, id: i64) -> Result<Vec<ScheduledScriptScope>> {
    Ok(sqlx::query_as(
        "SELECT kind, group_id, agent_id FROM scheduled_script_scopes WHERE script_id = $1",
    )
    .bind(id)
    .fetch_all(pool)
    .await?)
}

/// Agents targeted by `scopes` (an `all` scope wins over everything else).
pub async fn resolve_agents(
    db: &sqlx::PgPool,
    scopes: &[ScheduledScriptScope],
) -> anyhow::Result<HashSet<Uuid>> {
    let mut all = HashSet::new();

    let has_all = scopes.iter().any(|s| s.kind == "all");
    if has_all {
        let rows: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM agents")
            .fetch_all(db)
            .await?;
        for id in rows {
            all.insert(id);
        }
        return Ok(all);
    }

    for scope in scopes {
        if scope.kind == "agent" {
            if let Some(aid) = scope.agent_id {
                all.insert(aid);
            }
        } else if scope.kind == "group" {
            if let Some(gid) = scope.group_id {
                let rows: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT agent_id FROM agent_group_members WHERE group_id = $1",
                )
                .bind(gid)
                .fetch_all(db)
                .await?;
                for aid in rows {
                    all.insert(aid);
                }
            }
        }
    }

    Ok(all)
}

/// Returns the number of deleted scripts (0 when the id is unknown).
pub async fn delete_script(pool: &PgPool, id: i64) -> Result<u64> {
    let r = sqlx::query("DELETE FROM scheduled_scripts WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Whether this (script, agent) already has an execution row for `fire_time`.
pub async fn execution_exists(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    fire_time: DateTime<Utc>,
) -> Result<bool> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1::int FROM scheduled_script_executions WHERE script_id = $1 AND agent_id = $2 AND expected_fire_time = $3"
    )
    .bind(script_id)
    .bind(agent_id)
    .bind(fire_time)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

/// Record a scheduled fire (or an offline skip) for one agent.
pub async fn insert_scheduled_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    status: &str,
    fire_time: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"
    )
    .bind(script_id)
    .bind(agent_id)
    .bind(status)
    .bind(fire_time)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record a manual "run now" (or an offline skip) for one agent.
pub async fn insert_manual_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    status: &str,
    fire_time: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time, is_manual) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING"
    )
    .bind(script_id)
    .bind(agent_id)
    .bind(status)
    .bind(fire_time)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn finish_execution(
    pool: &PgPool,
    script_id: i64,
    agent_id: Uuid,
    fire_time: DateTime<Utc>,
    status: &str,
    output: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE scheduled_script_executions SET status = $1, output = $2 WHERE script_id = $3 AND agent_id = $4 AND expected_fire_time = $5"
    )
    .bind(status)
    .bind(output)
    .bind(script_id)
    .bind(agent_id)
    .bind(fire_time)
    .execute(pool)
    .await?;
    Ok(())
}

/// One row of the global execution log (`GET /api/scheduled-script-events`).
#[derive(Serialize)]
pub struct ExecutionEvent {
    pub script_id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_name: String,
    pub status: String,
    pub expected_fire_time: DateTime<Utc>,
    pub output: Option<String>,
    pub is_manual: bool,
}

pub async fn list_executions(pool: &PgPool, limit: i64) -> Result<Vec<ExecutionEvent>> {
    let rows = sqlx::query(
        r"
        SELECT
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            s.name as rule_name, a.name as agent_name
        FROM scheduled_script_executions e
        JOIN scheduled_scripts s ON s.id = e.script_id
        JOIN agents a ON a.id = e.agent_id
        ORDER BY e.expected_fire_time DESC
        LIMIT $1
        ",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| ExecutionEvent {
            script_id: r.try_get::<i64, _>("script_id").unwrap_or(0),
            agent_id: r.try_get::<Uuid, _>("agent_id").unwrap_or_default(),
            agent_name: r.try_get::<String, _>("agent_name").unwrap_or_default(),
            rule_name: r.try_get::<String, _>("rule_name").unwrap_or_default(),
            status: r.try_get::<String, _>("status").unwrap_or_default(),
            expected_fire_time: r
                .try_get::<DateTime<Utc>, _>("expected_fire_time")
                .unwrap_or_default(),
            output: r.try_get::<Option<String>, _>("output").unwrap_or_default(),
            is_manual: r.try_get::<bool, _>("is_manual").unwrap_or(false),
        })
        .collect())
}

/// One row of a single script's execution log (`GET /api/scheduled-scripts/:id/events`).
#[derive(Serialize)]
pub struct ScriptExecutionEvent {
    pub script_id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub status: String,
    pub expected_fire_time: DateTime<Utc>,
    pub output: Option<String>,
}

pub async fn list_executions_for_script(
    pool: &PgPool,
    id: i64,
    limit: i64,
) -> Result<Vec<ScriptExecutionEvent>> {
    let rows = sqlx::query(
        r"
        SELECT
            e.script_id, e.agent_id, e.status, e.expected_fire_time, e.output,
            e.is_manual,
            a.name as agent_name
        FROM scheduled_script_executions e
        JOIN agents a ON a.id = e.agent_id
        WHERE e.script_id = $1
        ORDER BY e.expected_fire_time DESC
        LIMIT $2
        ",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| ScriptExecutionEvent {
            script_id: r.try_get::<i64, _>("script_id").unwrap_or(0),
            agent_id: r.try_get::<Uuid, _>("agent_id").unwrap_or_default(),
            agent_name: r.try_get::<String, _>("agent_name").unwrap_or_default(),
            status: r.try_get::<String, _>("status").unwrap_or_default(),
            expected_fire_time: r
                .try_get::<DateTime<Utc>, _>("expected_fire_time")
                .unwrap_or_default(),
            output: r.try_get::<Option<String>, _>("output").unwrap_or_default(),
        })
        .collect())
}

/// Delete stale scheduled-script execution rows (by `created_at`).
///
/// This table is append-only — one row per (script, agent) per fire/trigger — and
/// nothing else bounds it, so without this it grows without limit. Index
/// `idx_sse_created_at` (migration 0053) serves the predicate.
pub async fn prune_script_executions_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query(
        "DELETE FROM scheduled_script_executions WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}
