//! Scheduled scripts: CRUD, manual trigger, and execution history.
//!
//! [`spawn_run_and_record`] is the shared dispatch path for both the minute scheduler
//! (`scripts::scheduler`) and the manual "run now" endpoint.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::scripts::dispatch;
use crate::state::AppState;

pub mod api;
pub mod db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledScriptScope {
    pub kind: String,
    pub group_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ScheduledScriptSchedule {
    pub frequency: String,
    pub day_of_week: Option<i32>,
    pub fire_minute: i32,
}

#[derive(Serialize)]
pub struct ScheduledScriptRow {
    pub id: i64,
    pub name: String,
    pub shell: String,
    pub script: String,
    pub timeout_secs: i32,
    pub enabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub scopes: Vec<ScheduledScriptScope>,
    pub schedules: Vec<ScheduledScriptSchedule>,
}

/// Run `script` on `agent_id` in the background and store the outcome on the execution row
/// keyed by (`script_id`, `agent_id`, `fire_time`).
///
/// `skip_empty_error`: manual triggers omit the `--- ERROR ---` section when the agent
/// reports an empty error string; scheduled fires always include it.
#[allow(clippy::too_many_arguments)]
pub fn spawn_run_and_record(
    state: Arc<AppState>,
    script_id: i64,
    agent_id: Uuid,
    shell: String,
    script: String,
    timeout_secs: i32,
    fire_time: DateTime<Utc>,
    skip_empty_error: bool,
) {
    tokio::spawn(async move {
        let result = dispatch::run_script_and_wait(
            state.clone(),
            agent_id,
            shell,
            script,
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
            if !(skip_empty_error && err.is_empty()) {
                output.push_str("--- ERROR ---\n");
                output.push_str(err);
                output.push('\n');
            }
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

        let _ = db::finish_execution(
            &state.db,
            script_id,
            agent_id,
            fire_time,
            final_status,
            &output,
        )
        .await;
    });
}
