//! Minute scheduler: fires enabled scheduled scripts whose schedule matches the current
//! minute in `SCHEDULER_TIMEZONE`.

use chrono::{Datelike, Timelike};
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::scripts::scheduled::{self, db};
use crate::state::AppState;

pub fn spawn(state: Arc<AppState>) {
    if !state.settings.allow_remote_script {
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
    let now = state
        .settings
        .scheduler_tz
        .from_utc_datetime(&now_utc.naive_utc());
    let current_day_of_week = now.weekday().num_days_from_sunday(); // 0 = Sun, 6 = Sat
    let current_minute_of_day = (now.hour() * 60 + now.minute()) as i32;

    // Truncate to the start of the minute (in UTC) for expected_fire_time storage
    let expected_fire_time = now_utc
        .with_second(0)
        .unwrap_or(now_utc)
        .with_nanosecond(0)
        .unwrap_or(now_utc);

    // 1. Fetch enabled scheduled scripts with their schedules and scopes
    let records = db::scripts::list_enabled_scripts(&state.db).await?;

    for record in records {
        let db::scripts::EnabledScript {
            id,
            name,
            shell,
            script,
            timeout_secs,
            schedules,
            scopes,
        } = record;

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

        if scopes.is_empty() {
            continue;
        }

        let target_agents = db::scripts::resolve_agents(&state.db, &scopes).await?;
        if target_agents.is_empty() {
            continue;
        }

        let connected_agents = state
            .agents
            .connections
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
            let exists =
                db::executions::execution_exists(&state.db, id, agent_id, expected_fire_time)
                    .await?;

            if exists {
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
            let _ = db::executions::insert_scheduled_execution(
                &state.db,
                id,
                agent_id,
                status,
                expected_fire_time,
            )
            .await;

            if !is_online {
                continue;
            }

            scheduled::spawn_run_and_record(
                state.clone(),
                id,
                agent_id,
                shell.clone(),
                script.clone(),
                timeout_secs,
                expected_fire_time,
                false,
            );
        }
    }

    Ok(())
}
