//! Per-viewer capability gating: which control commands need which agent capability, and a
//! small per-connection cache of capability lookups.

use tracing::warn;
use uuid::Uuid;

use crate::state::AppState;

pub(crate) type CapabilityCache =
    std::collections::HashMap<(Uuid, Uuid, &'static str), Option<String>>;

pub(super) async fn capability_denial(
    state: &AppState,
    agent: Uuid,
    capability: &'static str,
    cache: &mut CapabilityCache,
) -> Option<crate::agents::modules::CommandDenied> {
    let connection = state
        .agents
        .connections
        .lock()
        .get(&agent)
        .map(|c| c.conn_id);
    let connection = connection?;
    let key = (agent, connection, capability);
    if cache.len() >= 4096 {
        cache.clear();
    }
    cache.retain(|(id, conn, _), _| *id != agent || *conn == connection);
    let status = if let Some(status) = cache.get(&key) {
        status.clone()
    } else {
        match crate::agents::capabilities::capability_status(&state.db, agent, capability).await {
            Ok(status) => {
                cache.insert(key, status.clone());
                status
            }
            Err(error) => {
                warn!(%agent, %error, "failed to check viewer command capability");
                None
            }
        }
    };
    if state
        .agents
        .connections
        .lock()
        .get(&agent)
        .map(|c| c.conn_id)
        != Some(connection)
    {
        return Some(crate::agents::modules::CommandDenied::new(
            "agent_offline",
            "Connection changed during capability lookup; retry.",
            None,
        ));
    }
    status
        .filter(|s| crate::agents::capabilities::capability_is_unavailable(s))
        .map(|_| {
            crate::agents::modules::CommandDenied::new(
                "capability_unavailable",
                "This capability is unavailable on the device.",
                None,
            )
        })
}

pub(super) fn command_capability(cmd_type: &str) -> Option<&'static str> {
    match cmd_type {
        "MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp"
        | "MouseScroll" | "TypeText" | "KeyPress" | "KeyDown" | "KeyUp" | "KeyChar" | "Notify" => {
            Some("remote_input")
        }
        "RestartHost" | "ShutdownHost" | "LockHost" => Some("system_control"),
        "CollectSoftware" => Some("software_inventory"),
        _ => None,
    }
}
