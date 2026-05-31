use chrono::{Datelike, Timelike};
use sqlx::Row;
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::state::AppState;

pub fn spawn(state: Arc<AppState>) {
    if !state.allow_remote_script {
        warn!("ALLOW_REMOTE_SCRIPT_EXECUTION is disabled. Scheduled scripts will not run.");
        return;
    }

    tokio::spawn(async move {
        // Sleep until the next minute boundary (use UTC — seconds-within-minute is TZ-independent)
        let seconds = chrono::Utc::now().second();
        let wait = if seconds == 0 {
            60
        } else {
            60 - u64::from(seconds)
        };
        tokio::time::sleep(Duration::from_secs(wait)).await;

        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            if let Err(e) = tick(&state).await {
                warn!("Scheduled scripts tick error: {}", e);
            }
        }
    });
}

async fn tick(state: &Arc<AppState>) -> anyhow::Result<()> {
    use chrono::TimeZone as _;
    let now_utc = chrono::Utc::now();
    // Convert to the configured scheduler timezone so fire_minute/day_of_week match user expectations
    let now = state.scheduler_tz.from_utc_datetime(&now_utc.naive_utc());
    let current_day_of_week = now.weekday().num_days_from_sunday(); // 0 = Sun, 6 = Sat
    let current_minute_of_day = (now.hour() * 60 + now.minute()) as i32;

    // Truncate to the start of the minute (in UTC) for expected_fire_time storage
    let expected_fire_time = now_utc
        .with_second(0)
        .unwrap_or(now_utc)
        .with_nanosecond(0)
        .unwrap_or(now_utc);

    // 1. Fetch enabled scheduled scripts with their schedules and scopes
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
    .fetch_all(&state.db)
    .await?;

    for record in records {
        let id: i64 = record.try_get("id")?;
        let name: String = record.try_get("name")?;
        let shell: String = record.try_get("shell")?;
        let script: String = record.try_get("script")?;
        let timeout_secs: i32 = record.try_get("timeout_secs")?;

        let schedules_val: serde_json::Value = record.try_get("schedules").unwrap_or_default();
        let schedules: Vec<crate::api::scheduled_scripts::ScheduledScriptSchedule> =
            serde_json::from_value(schedules_val).unwrap_or_default();

        let mut should_fire = false;

        for sch in schedules {
            let matches_freq = match sch.frequency.as_str() {
                "hourly" => current_minute_of_day % 60 == sch.fire_minute % 60,
                "daily" => current_minute_of_day == sch.fire_minute,
                "weekly" => {
                    sch.day_of_week == Some(current_day_of_week as i32)
                        && current_minute_of_day == sch.fire_minute
                }
                _ => false,
            };
            if matches_freq {
                should_fire = true;
                break;
            }
        }

        if !should_fire {
            continue;
        }

        let scopes_val: serde_json::Value = record.try_get("scopes").unwrap_or_default();
        let scopes: Vec<crate::api::scheduled_scripts::ScheduledScriptScope> =
            serde_json::from_value(scopes_val).unwrap_or_default();
        if scopes.is_empty() {
            continue;
        }

        let target_agents =
            crate::api::scheduled_scripts::resolve_agents(&state.db, &scopes).await?;
        if target_agents.is_empty() {
            continue;
        }

        let connected_agents = state
            .agents
            .lock()
            .keys()
            .copied()
            .collect::<std::collections::HashSet<_>>();

        for agent_id in target_agents {
            let is_online = connected_agents.contains(&agent_id);
            let status = if is_online {
                "fired"
            } else {
                "skipped_offline"
            };

            info!(
                "Scheduled script '{}' (ID {}) matched for agent {} (Online: {})",
                name, id, agent_id, is_online
            );

            // Check if already executed in this exact minute window to prevent double firing
            let exists: Option<i32> = sqlx::query_scalar(
                "SELECT 1::int FROM scheduled_script_executions WHERE script_id = $1 AND agent_id = $2 AND expected_fire_time = $3"
            )
            .bind(id)
            .bind(agent_id)
            .bind(expected_fire_time)
            .fetch_optional(&state.db)
            .await?;

            if exists.is_some() {
                debug!(
                    "Script '{}' already fired for agent {} at {}",
                    name, agent_id, expected_fire_time
                );
                continue;
            }

            info!(
                "Dispatching scheduled script '{}' (ID {}) to agent {} (Status: {})",
                name, id, agent_id, status
            );

            // Record execution attempt/skip
            let _ = sqlx::query(
                "INSERT INTO scheduled_script_executions (script_id, agent_id, status, expected_fire_time) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"
            )
            .bind(id)
            .bind(agent_id)
            .bind(status)
            .bind(expected_fire_time)
            .execute(&state.db)
            .await;

            if !is_online {
                continue;
            }

            let state_clone = state.clone();
            let shell_clone = shell.clone();
            let script_clone = script.clone();

            tokio::spawn(async move {
                let result = crate::api::software_scripts::run_script_and_wait(
                    state_clone.clone(),
                    agent_id,
                    shell_clone,
                    script_clone,
                    timeout_secs as u64,
                )
                .await;

                let mut output = String::new();
                if let Some(stdout) = result.get("stdout").and_then(|v| v.as_str()) {
                    if !stdout.is_empty() {
                        output.push_str("--- STDOUT ---\n");
                        output.push_str(stdout);
                        output.push('\n');
                    }
                }
                if let Some(stderr) = result.get("stderr").and_then(|v| v.as_str()) {
                    if !stderr.is_empty() {
                        output.push_str("--- STDERR ---\n");
                        output.push_str(stderr);
                        output.push('\n');
                    }
                }
                if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
                    output.push_str("--- ERROR ---\n");
                    output.push_str(err);
                    output.push('\n');
                }

                let final_status = if (result.get("ok") == Some(&serde_json::json!(false)))
                    || (result.get("error").is_some() && result.get("exit_code").is_none())
                {
                    "error"
                } else if result.get("exit_code") == Some(&serde_json::json!(0)) {
                    "success"
                } else {
                    "failed"
                };

                let _ = sqlx::query(
                    "UPDATE scheduled_script_executions SET status = $1, output = $2 WHERE script_id = $3 AND agent_id = $4 AND expected_fire_time = $5"
                )
                .bind(final_status)
                .bind(output)
                .bind(id)
                .bind(agent_id)
                .bind(expected_fire_time)
                .execute(&state_clone.db)
                .await;
            });
        }
    }

    Ok(())
}
