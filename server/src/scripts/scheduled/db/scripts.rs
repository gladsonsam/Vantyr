//! Scheduled-script definitions with their scopes and schedules, and target resolution.

use std::collections::HashSet;

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use crate::scripts::scheduled::{
    ScheduledScriptRow, ScheduledScriptSchedule, ScheduledScriptScope,
};

pub async fn list_scripts(pool: &PgPool) -> Result<Vec<ScheduledScriptRow>> {
    let records = sqlx::query!(
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
        let scopes_val: serde_json::Value = r.scopes.unwrap_or_default();
        let scopes: Vec<ScheduledScriptScope> =
            serde_json::from_value(scopes_val).unwrap_or_default();

        let schedules_val: serde_json::Value = r.schedules.unwrap_or_default();
        let schedules: Vec<ScheduledScriptSchedule> =
            serde_json::from_value(schedules_val).unwrap_or_default();

        rules.push(ScheduledScriptRow {
            id: r.id,
            name: r.name,
            shell: r.shell,
            script: r.script,
            timeout_secs: r.timeout_secs,
            enabled: r.enabled,
            created_at: r.created_at,
            updated_at: r.updated_at,
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
    let records = sqlx::query!(
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
        let schedules_val: serde_json::Value = record.schedules.unwrap_or_default();
        let scopes_val: serde_json::Value = record.scopes.unwrap_or_default();
        out.push(EnabledScript {
            id: record.id,
            name: record.name,
            shell: record.shell,
            script: record.script,
            timeout_secs: record.timeout_secs,
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

    let id: i64 = sqlx::query_scalar!(
        "INSERT INTO scheduled_scripts (name, shell, script, timeout_secs) VALUES ($1, $2, $3, $4) RETURNING id",
        name,
        shell,
        script,
        timeout_secs
    )
    .fetch_one(&mut *tx)
    .await?;

    for scope in scopes {
        sqlx::query!(
            "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
            id,
            &scope.kind,
            scope.group_id,
            scope.agent_id
        )
        .execute(&mut *tx)
        .await?;
    }

    for sch in schedules {
        sqlx::query!(
            "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)",
            id,
            &sch.frequency,
            sch.day_of_week,
            sch.fire_minute
        )
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
        sqlx::query!(
            "UPDATE scheduled_scripts SET enabled = $1, updated_at = NOW() WHERE id = $2",
            enabled,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(name) = u.name {
        sqlx::query!(
            "UPDATE scheduled_scripts SET name = $1, updated_at = NOW() WHERE id = $2",
            name,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(shell) = u.shell {
        sqlx::query!(
            "UPDATE scheduled_scripts SET shell = $1, updated_at = NOW() WHERE id = $2",
            shell,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(script) = u.script {
        sqlx::query!(
            "UPDATE scheduled_scripts SET script = $1, updated_at = NOW() WHERE id = $2",
            script,
            id
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(timeout_secs) = u.timeout_secs {
        sqlx::query!(
            "UPDATE scheduled_scripts SET timeout_secs = $1, updated_at = NOW() WHERE id = $2",
            timeout_secs,
            id
        )
        .execute(&mut *tx)
        .await?;
    }

    if let Some(scopes) = u.scopes {
        sqlx::query!(
            "DELETE FROM scheduled_script_scopes WHERE script_id = $1",
            id
        )
        .execute(&mut *tx)
        .await?;
        for scope in &scopes {
            sqlx::query!(
                "INSERT INTO scheduled_script_scopes (script_id, kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
                id,
                &scope.kind,
                scope.group_id,
                scope.agent_id
            )
            .execute(&mut *tx).await?;
        }
    }

    if let Some(schedules) = u.schedules {
        sqlx::query!(
            "DELETE FROM scheduled_script_schedules WHERE script_id = $1",
            id
        )
        .execute(&mut *tx)
        .await?;
        for sch in &schedules {
            sqlx::query!(
                "INSERT INTO scheduled_script_schedules (script_id, frequency, day_of_week, fire_minute) VALUES ($1, $2, $3, $4)",
                id,
                &sch.frequency,
                sch.day_of_week,
                sch.fire_minute
            )
            .execute(&mut *tx).await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

/// `(name, shell, script, timeout_secs)` for one script.
pub async fn script_body(pool: &PgPool, id: i64) -> Result<Option<(String, String, String, i32)>> {
    let row = sqlx::query!(
        "SELECT name, shell, script, timeout_secs FROM scheduled_scripts WHERE id = $1",
        id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.name, r.shell, r.script, r.timeout_secs)))
}

pub async fn script_scopes(pool: &PgPool, id: i64) -> Result<Vec<ScheduledScriptScope>> {
    Ok(sqlx::query_as!(
        ScheduledScriptScope,
        "SELECT kind, group_id, agent_id FROM scheduled_script_scopes WHERE script_id = $1",
        id
    )
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
        let rows: Vec<Uuid> = sqlx::query_scalar!("SELECT id FROM agents")
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
                let rows: Vec<Uuid> = sqlx::query_scalar!(
                    "SELECT agent_id FROM agent_group_members WHERE group_id = $1",
                    gid
                )
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
    let r = sqlx::query!("DELETE FROM scheduled_scripts WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}
