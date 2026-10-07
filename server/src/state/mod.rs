//! Shared application state, threaded through Axum via `Arc<AppState>`.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use sqlx::PgPool;
use tokio::sync::{broadcast, mpsc, watch};
use uuid::Uuid;

pub mod agent_lifecycle;
mod live_media;
mod rpc_waiters;
mod settings;
mod throttles;

pub use live_media::{LiveMedia, MjpegSession, MjpegViewerPrefs};
pub use rpc_waiters::RpcWaiters;
pub use settings::Settings;
pub use throttles::Throttles;

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

/// Online agent entry (keyed by agent id in [`AppState::agents`]).
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

/// A message fanned-out to every active dashboard viewer.
#[derive(Clone)]
pub enum Broadcast {
    /// Serialised JSON event (keystroke, window change, URL, etc.).
    Text(String),
    /// Never fan out lease ownership notifications to other viewers.
    PrivateText(Uuid, String),
}

impl std::fmt::Debug for Broadcast {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text(text) => f.debug_tuple("Text").field(text).finish(),
            Self::PrivateText(viewer, _) => f
                .debug_tuple("PrivateText")
                .field(viewer)
                .field(&"[redacted]")
                .finish(),
        }
    }
}

/// Global application state (DB pool, live agents, sessions, telemetry broadcast).
pub struct AppState {
    pub db: PgPool,
    pub settings: Settings,
    pub tx: broadcast::Sender<Broadcast>,
    pub agents: Mutex<HashMap<Uuid, AgentConn>>,
    pub agent_lifecycle: agent_lifecycle::AgentLifecycle,
    pub recall_retention: crate::recall_retention::Coordinator,
    pub agent_modules: Mutex<HashMap<Uuid, crate::agent_modules::RuntimeModules>>,
    /// Lock order: lifecycle gate -> control -> agents -> modules -> command senders.
    pub(crate) control: Mutex<crate::control_runtime::ControlRuntime>,
    /// Cached frames, MJPEG viewer sessions, and audio channels.
    pub media: LiveMedia,
    /// One-shot replies and session sinks for agent RPCs (scripts, logs, terminals).
    pub rpc: RpcWaiters,
    /// In-memory rate limits, cooldowns, and dedup windows.
    pub throttles: Throttles,

    /// Per-agent command fan-in (viewer → server → agent WebSocket).
    pub agent_cmds: Mutex<HashMap<Uuid, AgentCmdSender>>,

    pub pending_enrollment_tokens: Mutex<HashMap<Uuid, PendingEnrollmentToken>>,

    /// Optional Prometheus metrics (when `METRICS_ENABLED`).
    pub metrics: Option<Arc<crate::metrics::AppMetrics>>,

    /// External notification providers (Home Assistant, future: Slack, ntfy, …).
    pub notify_hub: crate::notify::NotifyHub,

    /// Last-known live telemetry per connected agent (window, URL, AFK). Cleared on disconnect.
    pub agent_live: Mutex<HashMap<Uuid, AgentLiveSnapshot>>,
}

#[derive(Clone, Debug)]
pub struct PendingEnrollmentToken {
    pub agent_id: Uuid,
    pub agent_name: String,
    pub agent_token: String,
}

impl AppState {
    pub fn new(
        db: PgPool,
        settings: Settings,
        metrics: Option<Arc<crate::metrics::AppMetrics>>,
        notify_hub: crate::notify::NotifyHub,
    ) -> Self {
        let (tx, _) = broadcast::channel(4096);
        Self {
            db,
            settings,
            tx,
            agents: Mutex::new(HashMap::new()),
            agent_lifecycle: agent_lifecycle::AgentLifecycle::default(),
            recall_retention: crate::recall_retention::Coordinator::default(),
            agent_modules: Mutex::new(HashMap::new()),
            control: Mutex::new(crate::control_runtime::ControlRuntime::default()),
            media: LiveMedia::default(),
            rpc: RpcWaiters::default(),
            throttles: Throttles::default(),
            agent_cmds: Mutex::new(HashMap::new()),
            pending_enrollment_tokens: Mutex::new(HashMap::new()),

            metrics,

            notify_hub,
            agent_live: Mutex::new(HashMap::new()),
        }
    }

    /// Merge WebSocket telemetry into the live snapshot for integration consumers (Home Assistant, etc.).
    pub fn update_agent_live_from_event(
        &self,
        agent_id: Uuid,
        kind: &str,
        val: &serde_json::Value,
    ) {
        let mut map = self.agent_live.lock();
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

    pub fn clear_agent_live(&self, agent_id: Uuid) {
        self.agent_live.lock().remove(&agent_id);
    }

    /// Timezone to bucket an agent's Recall days in.
    ///
    /// Prefers the agent's self-reported IANA zone (`agent_info.timezone`), falling
    /// back to the deployment's configured [`Settings::scheduler_tz`] for agents too old
    /// to report one, and finally to UTC. A "day summary" is meaningless without
    /// this: bucketing by UTC gives a UTC+8 user a day that runs 8am–8am.
    pub async fn agent_timezone(&self, agent_id: Uuid) -> chrono_tz::Tz {
        match crate::db::agent_timezone(&self.db, agent_id).await {
            Ok(Some(name)) => name.trim().parse::<chrono_tz::Tz>().unwrap_or_else(|_| {
                tracing::debug!(%agent_id, tz = %name, "unrecognized agent timezone; using default");
                self.settings.scheduler_tz
            }),
            Ok(None) => self.settings.scheduler_tz,
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "agent timezone lookup failed; using default");
                self.settings.scheduler_tz
            }
        }
    }

    /// Forward a control payload to a connected agent (same wire format as viewer controls).
    pub fn try_send_agent_command_json(&self, agent_id: Uuid, cmd: &serde_json::Value) -> bool {
        self.send_agent_command_json(agent_id, cmd).is_ok()
    }

    /// Bound enrollment rotates the credential. Keep approval and token publication
    /// under the same gate as final socket registration and administrative removal.
    pub async fn approve_agent_enrollment_claim(
        &self,
        claim_id: Uuid,
        approved_by: &str,
        agent_name: Option<&str>,
        group_id: Option<Uuid>,
    ) -> anyhow::Result<Result<(Uuid, String, String), crate::db::ClaimApproveReject>> {
        let bound = crate::db::enrollment_claim_bound_agent_id(&self.db, claim_id).await?;
        let _lifecycle = match bound {
            Some(id) => Some(self.agent_lifecycle.for_agent(id).write_owned().await),
            None => None,
        };
        if let Some(id) = bound {
            // Another approval/removal may have completed while we waited.
            // A duplicate or stale claim must not kick off the new installation.
            if crate::db::enrollment_claim_bound_agent_id(&self.db, claim_id).await? != Some(id) {
                return Ok(Err(crate::db::ClaimApproveReject::NotPending));
            }
            self.invalidate_agent_connection(id, "agent_credentials_revoked")
                .await;
        }
        let outcome = crate::db::approve_agent_enrollment_claim_with_binding(
            &self.db,
            claim_id,
            approved_by,
            agent_name,
            group_id,
            bound,
        )
        .await?;
        if let Ok((agent_id, token, name)) = &outcome {
            self.pending_enrollment_tokens.lock().insert(
                claim_id,
                PendingEnrollmentToken {
                    agent_id: *agent_id,
                    agent_name: name.clone(),
                    agent_token: token.clone(),
                },
            );
        }
        Ok(outcome)
    }

    /// Caller must hold this device's lifecycle write gate. Detach immediately:
    /// an old socket may still be closing, but cannot ingest or own the new session.
    pub async fn invalidate_agent_connection(&self, agent_id: Uuid, reason: &'static str) {
        let connection = {
            let mut control = self.control.lock();
            let conn_id = self.agents.lock().get(&agent_id).map(|c| c.conn_id);
            if let Some(conn_id) = conn_id {
                let cleanup = control.sessions.revoke_agent(agent_id, conn_id);
                self.deliver_control_cleanup(&mut control, cleanup);
                self.clear_capture_connection_locked(agent_id, conn_id);
            }
            let connection = self.agents.lock().remove(&agent_id);
            self.agent_cmds.lock().remove(&agent_id);
            self.agent_modules.lock().remove(&agent_id);
            connection
        };
        self.clear_agent_live(agent_id);
        self.media.frames.lock().remove(&agent_id);
        if let Some(connection) = connection {
            connection.shutdown.send_replace(Some(reason));
            let disconnected_at = Utc::now();
            if let Err(e) = crate::db::touch_agent(&self.db, agent_id).await {
                tracing::warn!(error = %e, %agent_id, "failed to record lifecycle disconnect");
            }
            if let Err(e) = crate::db::end_agent_session(&self.db, connection.session_id).await {
                tracing::warn!(error = %e, %agent_id, "failed to end invalidated agent session");
            }
            self.broadcast(
                serde_json::json!({
                    "event": "agent_disconnected", "agent_id": agent_id,
                    "disconnected_at": disconnected_at,
                })
                .to_string(),
            );
        }
    }

    /// Best-effort: ask a connected agent to close its WebSocket.
    ///
    /// Lifecycle changes use [`Self::invalidate_agent_connection`] under the
    /// device's write gate instead of relying on this bounded command queue.
    #[allow(dead_code)]
    pub fn try_disconnect_agent(&self, agent_id: Uuid) -> bool {
        self.agent_cmds
            .lock()
            .get(&agent_id)
            .is_some_and(|tx| tx.try_send(AgentControl::Close).is_ok())
    }

    /// Send a JSON string to every connected viewer (fire-and-forget).
    pub fn broadcast(&self, msg: impl Into<String>) {
        let _ = self.tx.send(Broadcast::Text(msg.into()));
    }
}
