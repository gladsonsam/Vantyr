//! Connected agents: sockets, command queues, module grants, live telemetry, and
//! the per-device lifecycle gates that serialize registration against removal.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use super::agent_lifecycle::AgentLifecycle;

/// Capacity for each agent’s command queue (viewer → server → agent). Bounded to bound memory.
pub const AGENT_CMD_CHANNEL_CAPACITY: usize = 512;

/// Bounded sender for JSON command lines to the agent WebSocket task.
#[derive(Debug, Clone)]
pub enum AgentControl {
    Text(String),
    /// Server-only held-input releases, fenced to a specific socket.
    InputCleanup {
        conn_id: Uuid,
        command: serde_json::Value,
    },
    Close,
}

/// Bounded sender for control messages to the agent WebSocket task.
pub type AgentCmdSender = mpsc::Sender<AgentControl>;

/// Online agent entry (keyed by agent id in [`AgentRegistry::connections`]).
#[derive(Debug, Clone)]
pub struct AgentConn {
    /// Unique identifier for this specific WebSocket session.
    /// Used to prevent stale-disconnect cleanup from a previous connection.
    pub conn_id: Uuid,
    pub connected_at: DateTime<Utc>,
    pub session_id: i64,
    /// Out-of-band shutdown, independent of a full command queue. Empty reason
    /// closes a superseded socket without telling its installation to re-enroll.
    pub shutdown: watch::Sender<Option<&'static str>>,
    /// The device has never sent a module report, so it predates module grants.
    /// Only server policy pushes keep their old unconditional delivery; a report
    /// on this connection replaces this with normal grant enforcement.
    pub legacy_policy_delivery: bool,
}

/// Latest foreground / URL / activity as reported by the agent over WebSocket (for integration API).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AgentLiveSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_secs: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
pub struct PendingEnrollmentToken {
    pub agent_id: Uuid,
    pub agent_name: String,
    pub agent_token: String,
}

/// Everything keyed to an agent's current WebSocket connection.
///
/// Within the registry, `connections` -> `modules` -> `cmds`, all after the
/// `lifecycle` gate and `AppState::control` (see that field). `live` and
/// `pending_enrollment_tokens` are leaf locks.
#[derive(Default)]
pub struct AgentRegistry {
    /// Online agents, keyed by agent id.
    pub connections: Mutex<HashMap<Uuid, AgentConn>>,
    /// Per-agent command fan-in (viewer → server → agent WebSocket).
    pub cmds: Mutex<HashMap<Uuid, AgentCmdSender>>,
    /// Module grants last reported on each agent's current connection.
    pub modules: Mutex<HashMap<Uuid, crate::agent_modules::RuntimeModules>>,
    /// Last-known live telemetry per connected agent (window, URL, AFK). Cleared on disconnect.
    pub live: Mutex<HashMap<Uuid, AgentLiveSnapshot>>,
    /// Per-device read/write gates for ingestion vs. lifecycle changes.
    pub lifecycle: AgentLifecycle,
    /// Credentials minted by an approved enrollment claim, held until the
    /// installation polls for them (keyed by claim id).
    pub pending_enrollment_tokens: Mutex<HashMap<Uuid, PendingEnrollmentToken>>,
}

impl AgentRegistry {
    /// Merge WebSocket telemetry into the live snapshot for integration consumers (Home Assistant, etc.).
    pub fn update_live_from_event(&self, agent_id: Uuid, kind: &str, val: &serde_json::Value) {
        let mut map = self.live.lock();
        let snap = map.entry(agent_id).or_default();
        let now = Utc::now();
        match kind {
            "window_focus" => {
                if let Some(t) = val["title"].as_str() {
                    snap.window_title = Some(t.to_string());
                }
                if let Some(a) = val["app"].as_str() {
                    snap.window_app = Some(a.to_string());
                }
                snap.updated_at = Some(now);
            }
            "url" => {
                if let Some(u) = val["url"].as_str() {
                    snap.url = Some(u.to_string());
                }
                snap.updated_at = Some(now);
            }
            "afk" => {
                let idle = val["idle_secs"]
                    .as_i64()
                    .or_else(|| val["idle_secs"].as_u64().map(|u| u as i64))
                    .unwrap_or(0);
                snap.activity = Some("afk".into());
                snap.idle_secs = Some(idle.max(0));
                snap.updated_at = Some(now);
            }
            "active" => {
                snap.activity = Some("active".into());
                snap.idle_secs = Some(0);
                snap.updated_at = Some(now);
            }
            _ => {}
        }
    }

    pub fn clear_live(&self, agent_id: Uuid) {
        self.live.lock().remove(&agent_id);
    }

    /// Best-effort: ask a connected agent to close its WebSocket.
    ///
    /// Lifecycle changes use [`AppState::invalidate_agent_connection`](super::AppState::invalidate_agent_connection) under the
    /// device's write gate instead of relying on this bounded command queue.
    #[allow(dead_code)]
    pub fn try_disconnect(&self, agent_id: Uuid) -> bool {
        self.cmds
            .lock()
            .get(&agent_id)
            .is_some_and(|tx| tx.try_send(AgentControl::Close).is_ok())
    }
}
