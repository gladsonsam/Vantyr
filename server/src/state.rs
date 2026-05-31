//! Shared application state, threaded through Axum via `Arc<AppState>`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use sqlx::PgPool;
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

/// Capacity for each agent’s command queue (viewer → server → agent). Bounded to bound memory.
pub const AGENT_CMD_CHANNEL_CAPACITY: usize = 512;

/// Bounded sender for JSON command lines to the agent WebSocket task.
#[derive(Debug, Clone)]
pub enum AgentControl {
    Text(String),
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

/// Normalised MJPEG viewer tuning (after clamping query params).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MjpegViewerPrefs {
    pub jpeg_quality: u8,
    pub interval_ms: u32,
}

/// Active MJPEG HTTP session (`?session=<uuid>` → agent + tuning).
#[derive(Clone, Copy, Debug)]
pub struct MjpegSession {
    pub agent_id: Uuid,
    pub prefs: MjpegViewerPrefs,
}

/// A message fanned-out to every active dashboard viewer.
#[derive(Clone, Debug)]
pub enum Broadcast {
    /// Serialised JSON event (keystroke, window change, URL, etc.).
    Text(String),
}

/// Global application state (DB pool, live agents, sessions, telemetry broadcast).
pub struct AppState {
    pub db: PgPool,
    pub tx: broadcast::Sender<Broadcast>,
    pub agents: Mutex<HashMap<Uuid, AgentConn>>,
    pub frames: Mutex<HashMap<Uuid, Frame>>,

    /// Per-agent command fan-in (viewer → server → agent WebSocket).
    pub agent_cmds: Mutex<HashMap<Uuid, AgentCmdSender>>,

    /// MJPEG viewer refcount per agent; drives `start_capture` / `stop_capture`.
    pub capture_viewers: Mutex<HashMap<Uuid, u32>>,

    /// Active MJPEG HTTP sessions (`?session=<uuid>` → agent + tuning). Used so explicit “leave”
    /// can drop refcount immediately (browser may delay closing the image request).
    pub mjpeg_sessions: Mutex<HashMap<Uuid, MjpegSession>>,
    /// Last `start_capture` parameters applied for an agent (so we can restart capture when merged prefs change).
    pub mjpeg_active_capture: Mutex<HashMap<Uuid, MjpegViewerPrefs>>,

    pub allow_insecure_dashboard_open: bool,
    pub pending_enrollment_tokens: Mutex<HashMap<Uuid, PendingEnrollmentToken>>,
    wol_last_wake: Mutex<HashMap<Uuid, Instant>>,
    pub wol_min_interval: Duration,
    pub allow_remote_script: bool,
    pub script_waiters: Mutex<HashMap<Uuid, oneshot::Sender<serde_json::Value>>>,
    /// One-shot waiters for agent log RPC responses (`log_tail`, `log_sources`).
    pub log_waiters: Mutex<HashMap<Uuid, oneshot::Sender<serde_json::Value>>>,
    pub(crate) login_failures: Mutex<HashMap<String, Vec<Instant>>>,
    /// Per (`rule_id`, `agent_id`) last fire time for alert cooldowns.
    pub alert_match_cooldowns: Mutex<HashMap<(i64, Uuid), Instant>>,

    /// Optional Prometheus metrics (when `METRICS_ENABLED`).
    pub metrics: Option<Arc<crate::metrics::AppMetrics>>,

    /// Idempotency for `POST .../software/collect`: (`agent_id`, key) → last use time.
    pub software_collect_dedup: Mutex<HashMap<(Uuid, String), Instant>>,

    /// External notification providers (Home Assistant, future: Slack, ntfy, …).
    pub notify_hub: crate::notify::NotifyHub,

    /// Last-known live telemetry per connected agent (window, URL, AFK). Cleared on disconnect.
    pub agent_live: Mutex<HashMap<Uuid, AgentLiveSnapshot>>,

    /// When set, `GET /api/integration/agents/live` accepts `Authorization: Bearer <token>`.
    pub integration_api_token: Option<String>,

    /// Public base URL for deep links in external notifications (e.g. Home Assistant).
    /// Example: `https://sentinel.example.com`
    pub public_base_url: Option<String>,

    /// TCP listen port (for mDNS default port hints; same value passed to `mdns_broadcast`).
    pub agent_listen_port: u16,

    /// Timezone used by the scheduler when matching `fire_minute` / `day_of_week`.
    /// Defaults to UTC if `SCHEDULER_TIMEZONE` is not set or invalid.
    pub scheduler_tz: chrono_tz::Tz,

    /// Reverse proxies whose forwarding headers are trusted for security decisions
    /// (login rate limiting / lockout). Shared with the rate-limit key extractor.
    pub trusted_proxies: Arc<crate::trusted_proxy::TrustedProxies>,
}

/// Cached JPEG with a monotonic `seq` for MJPEG change detection.
#[derive(Clone, Debug)]
pub struct Frame {
    pub seq: u64,
    pub jpeg: Bytes,
    /// Last time this frame was written; used for LRU eviction of the bounded frame cache.
    pub last_update: Instant,
}

/// Upper bound on agents whose latest frame we cache. Each frame is up to ~8 MiB, so this caps
/// frame-cache memory (e.g. stale frames left over from alert-screenshot captures on agents with
/// no live viewer can't accumulate without bound).
const MAX_CACHED_FRAMES: usize = 16;

#[derive(Clone, Debug)]
pub struct PendingEnrollmentToken {
    pub agent_id: Uuid,
    pub agent_name: String,
    pub agent_token: String,
}

/// Constructor input for [`AppState::new`].
pub struct AppStateParams {
    pub db: PgPool,
    pub allow_insecure_dashboard_open: bool,
    pub wol_min_interval: Duration,
    pub allow_remote_script: bool,
    pub metrics: Option<Arc<crate::metrics::AppMetrics>>,
    pub notify_hub: crate::notify::NotifyHub,
    pub integration_api_token: Option<String>,
    pub public_base_url: Option<String>,
    pub agent_listen_port: u16,
    pub scheduler_tz: chrono_tz::Tz,
    pub trusted_proxies: Arc<crate::trusted_proxy::TrustedProxies>,
}

impl AppState {
    pub fn new(p: AppStateParams) -> Self {
        let AppStateParams {
            db,
            allow_insecure_dashboard_open,
            wol_min_interval,
            allow_remote_script,
            metrics,
            notify_hub,
            integration_api_token,
            public_base_url,
            agent_listen_port,
            scheduler_tz,
            trusted_proxies,
        } = p;
        let (tx, _) = broadcast::channel(4096);
        Self {
            db,
            tx,
            agents: Mutex::new(HashMap::new()),
            frames: Mutex::new(HashMap::new()),
            agent_cmds: Mutex::new(HashMap::new()),
            capture_viewers: Mutex::new(HashMap::new()),
            mjpeg_sessions: Mutex::new(HashMap::new()),
            mjpeg_active_capture: Mutex::new(HashMap::new()),
            allow_insecure_dashboard_open,
            pending_enrollment_tokens: Mutex::new(HashMap::new()),
            wol_last_wake: Mutex::new(HashMap::new()),
            wol_min_interval,
            allow_remote_script,
            script_waiters: Mutex::new(HashMap::new()),
            log_waiters: Mutex::new(HashMap::new()),
            login_failures: Mutex::new(HashMap::new()),
            alert_match_cooldowns: Mutex::new(HashMap::new()),
            metrics,
            software_collect_dedup: Mutex::new(HashMap::new()),
            notify_hub,
            agent_live: Mutex::new(HashMap::new()),
            integration_api_token,
            public_base_url,
            agent_listen_port,
            scheduler_tz,
            trusted_proxies,
        }
    }

    /// Cache the latest JPEG frame for `agent_id`, bumping its `seq`. Bounds the cache to
    /// [`MAX_CACHED_FRAMES`] agents, evicting the least-recently-updated frame when a new agent
    /// would exceed the cap.
    pub fn store_frame(&self, agent_id: Uuid, jpeg: Bytes) {
        let mut frames = self.frames.lock();
        let next_seq = frames.get(&agent_id).map_or(1, |f| f.seq.saturating_add(1));
        if !frames.contains_key(&agent_id) && frames.len() >= MAX_CACHED_FRAMES {
            if let Some(oldest) = frames
                .iter()
                .min_by_key(|(_, f)| f.last_update)
                .map(|(k, _)| *k)
            {
                frames.remove(&oldest);
            }
        }
        frames.insert(
            agent_id,
            Frame {
                seq: next_seq,
                jpeg,
                last_update: Instant::now(),
            },
        );
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

    /// Returns `Err(retry_after_secs)` when `WoL` for this agent is throttled.
    pub fn wol_throttle_check(&self, agent_id: Uuid) -> Result<(), u64> {
        if self.wol_min_interval.is_zero() {
            return Ok(());
        }
        let map = self.wol_last_wake.lock();
        let now = Instant::now();
        if let Some(last) = map.get(&agent_id) {
            let elapsed = now.saturating_duration_since(*last);
            if elapsed < self.wol_min_interval {
                let wait = self
                    .wol_min_interval
                    .checked_sub(elapsed)
                    .unwrap_or_default()
                    .as_secs()
                    .max(1);
                return Err(wait);
            }
        }
        Ok(())
    }

    pub fn wol_mark_sent(&self, agent_id: Uuid) {
        if self.wol_min_interval.is_zero() {
            return;
        }
        self.wol_last_wake.lock().insert(agent_id, Instant::now());
    }

    pub fn register_script_waiter(&self, id: Uuid, sender: oneshot::Sender<serde_json::Value>) {
        self.script_waiters.lock().insert(id, sender);
    }

    pub fn remove_script_waiter(&self, id: Uuid) {
        self.script_waiters.lock().remove(&id);
    }

    /// Deliver an agent `script_result` to a waiting HTTP request, if any.
    pub fn try_complete_script_waiter(&self, id: Uuid, payload: serde_json::Value) -> bool {
        if let Some(tx) = self.script_waiters.lock().remove(&id) {
            let _ = tx.send(payload);
            return true;
        }
        false
    }

    pub fn register_log_waiter(&self, id: Uuid, sender: oneshot::Sender<serde_json::Value>) {
        self.log_waiters.lock().insert(id, sender);
    }

    pub fn remove_log_waiter(&self, id: Uuid) {
        self.log_waiters.lock().remove(&id);
    }

    /// Deliver an agent log RPC response (`log_tail` / `log_sources`) to a waiting HTTP request, if any.
    pub fn try_complete_log_waiter(&self, id: Uuid, payload: serde_json::Value) -> bool {
        if let Some(tx) = self.log_waiters.lock().remove(&id) {
            let _ = tx.send(payload);
            return true;
        }
        false
    }

    /// Forward a control payload to a connected agent (same wire format as viewer controls).
    pub fn try_send_agent_command_json(&self, agent_id: Uuid, cmd: &serde_json::Value) -> bool {
        let Ok(s) = serde_json::to_string(cmd) else {
            return false;
        };
        self.agent_cmds
            .lock()
            .get(&agent_id)
            .is_some_and(|tx| tx.try_send(AgentControl::Text(s)).is_ok())
    }

    /// Best-effort: ask a connected agent to close its WebSocket.
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
