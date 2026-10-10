//! Shared application state, threaded through Axum via `Arc<AppState>`.

use std::sync::Arc;

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
    pub recall_retention: crate::recall::retention::Coordinator,
    /// Lock order: `agents.lifecycle` gate -> control -> `agents.connections`
    /// -> `agents.modules` -> `agents.cmds`.
    pub(crate) control: Mutex<crate::control::runtime::ControlRuntime>,
    /// Cached frames, MJPEG viewer sessions, and audio channels.
    pub media: LiveMedia,
    /// One-shot replies and session sinks for agent RPCs (scripts, logs, terminals).
    pub rpc: RpcWaiters,
    /// In-memory rate limits, cooldowns, and dedup windows.
    pub throttles: Throttles,

    /// Optional Prometheus metrics (when `METRICS_ENABLED`).
    pub metrics: Option<Arc<crate::platform::metrics::AppMetrics>>,

    /// External notification providers (Home Assistant, future: Slack, ntfy, …).
    pub notify_hub: crate::notify::NotifyHub,
}

impl AppState {
    pub fn new(
        db: PgPool,
        settings: Settings,
        metrics: Option<Arc<crate::platform::metrics::AppMetrics>>,
        notify_hub: crate::notify::NotifyHub,
    ) -> Self {
        let (tx, _) = broadcast::channel(4096);
        Self {
            db,
            settings,
            tx,
            agents: AgentRegistry::default(),
            recall_retention: crate::recall::retention::Coordinator::default(),
            control: Mutex::new(crate::control::runtime::ControlRuntime::default()),
            media: LiveMedia::default(),
            rpc: RpcWaiters::default(),
            throttles: Throttles::default(),
            metrics,
            notify_hub,
        }
    }

    /// Send a JSON string to every connected viewer (fire-and-forget).
    pub fn broadcast(&self, msg: impl Into<String>) {
        let _ = self.tx.send(Broadcast::Text(msg.into()));
    }
}
