//! Shared application state, threaded through Axum via `Arc<AppState>`.

use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use sqlx::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

pub mod agent_lifecycle;
mod agent_registry;
mod live_media;
mod rpc_waiters;
mod settings;
mod throttles;

pub use agent_registry::{
    AgentConn, AgentControl, AgentRegistry, PendingEnrollmentToken, AGENT_CMD_CHANNEL_CAPACITY,
};
pub use live_media::{LiveMedia, MjpegSession, MjpegViewerPrefs};
pub use rpc_waiters::RpcWaiters;
pub use settings::Settings;
pub use throttles::Throttles;

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
    /// Connected agents and everything keyed to their current socket.
    pub agents: AgentRegistry,
    pub recall_retention: crate::recall_retention::Coordinator,
    /// Lock order: `agents.lifecycle` gate -> control -> `agents.connections`
    /// -> `agents.modules` -> `agents.cmds`.
    pub(crate) control: Mutex<crate::control_runtime::ControlRuntime>,
    /// Cached frames, MJPEG viewer sessions, and audio channels.
    pub media: LiveMedia,
    /// One-shot replies and session sinks for agent RPCs (scripts, logs, terminals).
    pub rpc: RpcWaiters,
    /// In-memory rate limits, cooldowns, and dedup windows.
    pub throttles: Throttles,

    /// Optional Prometheus metrics (when `METRICS_ENABLED`).
    pub metrics: Option<Arc<crate::metrics::AppMetrics>>,

    /// External notification providers (Home Assistant, future: Slack, ntfy, …).
    pub notify_hub: crate::notify::NotifyHub,
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
            agents: AgentRegistry::default(),
            recall_retention: crate::recall_retention::Coordinator::default(),
            control: Mutex::new(crate::control_runtime::ControlRuntime::default()),
            media: LiveMedia::default(),
            rpc: RpcWaiters::default(),
            throttles: Throttles::default(),
            metrics,
            notify_hub,
        }
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
            Some(id) => Some(self.agents.lifecycle.for_agent(id).write_owned().await),
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
            self.agents.pending_enrollment_tokens.lock().insert(
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
            let conn_id = self
                .agents
                .connections
                .lock()
                .get(&agent_id)
                .map(|c| c.conn_id);
            if let Some(conn_id) = conn_id {
                let cleanup = control.sessions.revoke_agent(agent_id, conn_id);
                self.deliver_control_cleanup(&mut control, cleanup);
                self.clear_capture_connection_locked(agent_id, conn_id);
            }
            let connection = self.agents.connections.lock().remove(&agent_id);
            self.agents.cmds.lock().remove(&agent_id);
            self.agents.modules.lock().remove(&agent_id);
            connection
        };
        self.agents.clear_live(agent_id);
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

    /// Send a JSON string to every connected viewer (fire-and-forget).
    pub fn broadcast(&self, msg: impl Into<String>) {
        let _ = self.tx.send(Broadcast::Text(msg.into()));
    }
}
