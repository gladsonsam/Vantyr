//! Send a `RunScript` command to a connected agent and wait for its result.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use uuid::Uuid;

use crate::state::AppState;
use vantyr_protocol::commands::RunScript;
use vantyr_protocol::ServerCommand;

pub async fn run_script_and_wait(
    s: Arc<AppState>,
    agent_id: Uuid,
    shell: String,
    script: String,
    timeout: u64,
) -> serde_json::Value {
    let rid = Uuid::new_v4();
    let (tx, rx) = oneshot::channel();
    s.rpc.register_script_waiter(rid, tx);
    let cmd = ServerCommand::RunScript(RunScript::new(&rid.to_string(), &shell, &script, timeout));
    if let Err(e) = s.agents.send_command(agent_id, &cmd) {
        s.rpc.remove_script_waiter(rid);
        return serde_json::json!({
            "agent_id": agent_id,
            "ok": false,
            "error": e.error, "code":e.code,
        });
    }
    let wait = Duration::from_secs((timeout + 15).min(330));
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(mut val)) => {
            if let Some(o) = val.as_object_mut() {
                o.insert(
                    "agent_id".to_string(),
                    serde_json::Value::String(agent_id.to_string()),
                );
            }
            val
        }
        Ok(Err(_)) => serde_json::json!({
            "agent_id": agent_id,
            "ok": false,
            "error": "Internal wait channel closed.",
        }),
        Err(_) => {
            s.rpc.remove_script_waiter(rid);
            serde_json::json!({
                "agent_id": agent_id,
                "ok": false,
                "error": "Timed out waiting for script result.",
                "request_id": rid,
            })
        }
    }
}
