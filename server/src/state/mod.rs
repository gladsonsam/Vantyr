//! Shared application state, threaded through Axum via `Arc<AppState>`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use sqlx::PgPool;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use uuid::Uuid;

pub mod agent_lifecycle;
mod live_media;
mod settings;

pub use live_media::{LiveMedia, MjpegSession, MjpegViewerPrefs};
pub use settings::Settings;

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

    /// Per-agent command fan-in (viewer → server → agent WebSocket).
    pub agent_cmds: Mutex<HashMap<Uuid, AgentCmdSender>>,

    pub pending_enrollment_tokens: Mutex<HashMap<Uuid, PendingEnrollmentToken>>,
    wol_last_wake: Mutex<HashMap<Uuid, Instant>>,
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

    /// Active interactive-terminal sessions: `session_id` → sink that forwards
    /// agent terminal frames to the owning browser WebSocket.
    pub terminal_sessions: Mutex<HashMap<Uuid, mpsc::Sender<String>>>,

    /// Last time each (viewer, agent, action) triple was written to the audit log,
    /// so replaying a timeline records *that someone watched* without inserting a
    /// row per keyframe. See [`Self::should_audit_recall_access`].
    pub recall_audit_seen: Mutex<HashMap<(Uuid, Uuid, &'static str), Instant>>,
}

/// How long one audited Recall view "covers". A viewer scrubbing continuously logs
/// one row per window rather than one per frame fetched.
const RECALL_AUDIT_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Cap on tracked triples, so the throttle map can't grow without bound on a large
/// fleet. Exceeding it prunes expired entries, then (worst case) clears.
const RECALL_AUDIT_MAX_TRACKED: usize = 4_096;

/// Key identifying one viewer's access of one agent's Recall data for one action.
type RecallAuditKey = (Uuid, Uuid, &'static str);

/// Decide whether this access should be audited, updating `seen` in place.
///
/// Split out from [`AppState::should_audit_recall_access`] so the throttle can be
/// tested without standing up a database pool. `now` is injected for the same reason.
fn recall_audit_decision(
    seen: &mut HashMap<RecallAuditKey, Instant>,
    key: RecallAuditKey,
    now: Instant,
) -> bool {
    if seen.len() >= RECALL_AUDIT_MAX_TRACKED {
        seen.retain(|_, at| now.duration_since(*at) < RECALL_AUDIT_WINDOW);
        if seen.len() >= RECALL_AUDIT_MAX_TRACKED {
            // Everything is live; drop the table rather than grow unbounded. Costs a
            // burst of duplicate audit rows, never a missing one.
            seen.clear();
        }
    }

    match seen.get(&key) {
        Some(at) if now.duration_since(*at) < RECALL_AUDIT_WINDOW => false,
        _ => {
            seen.insert(key, now);
            true
        }
    }
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
            agent_cmds: Mutex::new(HashMap::new()),
            pending_enrollment_tokens: Mutex::new(HashMap::new()),
            wol_last_wake: Mutex::new(HashMap::new()),
            script_waiters: Mutex::new(HashMap::new()),
            log_waiters: Mutex::new(HashMap::new()),
            login_failures: Mutex::new(HashMap::new()),
            alert_match_cooldowns: Mutex::new(HashMap::new()),
            metrics,
            software_collect_dedup: Mutex::new(HashMap::new()),
            notify_hub,
            agent_live: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
            recall_audit_seen: Mutex::new(HashMap::new()),
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

    /// Returns `Err(retry_after_secs)` when `WoL` for this agent is throttled.
    pub fn wol_throttle_check(&self, agent_id: Uuid) -> Result<(), u64> {
        if self.settings.wol_min_interval.is_zero() {
            return Ok(());
        }
        let map = self.wol_last_wake.lock();
        let now = Instant::now();
        if let Some(last) = map.get(&agent_id) {
            let elapsed = now.saturating_duration_since(*last);
            if elapsed < self.settings.wol_min_interval {
                let wait = self
                    .settings
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
        if self.settings.wol_min_interval.is_zero() {
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

    /// Whether this Recall access should produce an audit row.
    ///
    /// Watching someone's screen history is the most privacy-sensitive thing this
    /// product does, so it has to be on the record — but replaying an hour of
    /// timeline fetches hundreds of keyframe blobs, and a row per blob would bury
    /// the signal and hammer the DB. This collapses a continuous viewing session
    /// into one audit row per [`RECALL_AUDIT_WINDOW`], entirely in memory.
    ///
    /// Returns `true` the first time a (viewer, agent, action) triple is seen and
    /// then at most once per window. Deliberately fail-open on restart: a fresh
    /// process re-logs, which over-records rather than under-records.
    pub fn should_audit_recall_access(
        &self,
        user_id: Uuid,
        agent_id: Uuid,
        action: &'static str,
    ) -> bool {
        let mut seen = self.recall_audit_seen.lock();
        recall_audit_decision(&mut seen, (user_id, agent_id, action), Instant::now())
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

    pub fn register_terminal_session(&self, session_id: Uuid, tx: mpsc::Sender<String>) {
        self.terminal_sessions.lock().insert(session_id, tx);
    }

    pub fn remove_terminal_session(&self, session_id: Uuid) {
        self.terminal_sessions.lock().remove(&session_id);
    }

    /// Route a terminal output/exit frame to its owning browser session.
    /// Returns false when no such session exists (stale agent frame).
    pub fn route_terminal_output(&self, session_id: Uuid, frame: String) -> bool {
        let tx = self.terminal_sessions.lock().get(&session_id).cloned();
        tx.is_some_and(|tx| tx.try_send(frame).is_ok())
    }
}

#[cfg(test)]
mod recall_audit_tests {
    use super::*;

    const ACTION: &str = "recall_replay";

    fn key() -> RecallAuditKey {
        (Uuid::nil(), Uuid::nil(), ACTION)
    }

    #[test]
    fn first_access_is_audited() {
        let mut seen = HashMap::new();
        assert!(recall_audit_decision(&mut seen, key(), Instant::now()));
    }

    #[test]
    fn repeat_access_within_window_is_throttled() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        assert!(recall_audit_decision(&mut seen, key(), t0));
        // A replay fetches hundreds of blobs; none of them should add a row.
        for i in 1..500 {
            let t = t0 + Duration::from_millis(i * 100);
            assert!(
                !recall_audit_decision(&mut seen, key(), t),
                "blob fetch at +{i}00ms should not have been audited"
            );
        }
    }

    #[test]
    fn access_after_window_is_audited_again() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        assert!(recall_audit_decision(&mut seen, key(), t0));
        assert!(!recall_audit_decision(
            &mut seen,
            key(),
            t0 + RECALL_AUDIT_WINDOW - Duration::from_secs(1)
        ));
        assert!(recall_audit_decision(
            &mut seen,
            key(),
            t0 + RECALL_AUDIT_WINDOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn different_viewers_agents_and_actions_are_tracked_separately() {
        let mut seen = HashMap::new();
        let t = Instant::now();
        let (viewer_a, viewer_b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let (agent_a, agent_b) = (Uuid::from_u128(10), Uuid::from_u128(11));

        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, ACTION),
            t
        ));
        // A second operator watching the same agent must produce its own row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_b, agent_a, ACTION),
            t
        ));
        // Same operator, different agent: separate row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_b, ACTION),
            t
        ));
        // Same operator+agent, different action: separate row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, "recall_day_view"),
            t
        ));
        // ...and each is now throttled independently.
        assert!(!recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, ACTION),
            t
        ));
    }

    #[test]
    fn tracking_map_stays_bounded() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        // Far more distinct triples than the cap, all live.
        for i in 0..(RECALL_AUDIT_MAX_TRACKED as u128 * 2) {
            recall_audit_decision(&mut seen, (Uuid::from_u128(i), Uuid::nil(), ACTION), t0);
        }
        assert!(
            seen.len() <= RECALL_AUDIT_MAX_TRACKED,
            "throttle map grew past its cap: {}",
            seen.len()
        );
    }

    #[test]
    fn expired_entries_are_pruned_before_clearing() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        for i in 0..RECALL_AUDIT_MAX_TRACKED as u128 {
            recall_audit_decision(&mut seen, (Uuid::from_u128(i), Uuid::nil(), ACTION), t0);
        }
        // Well past the window: the next call should prune rather than clear, and the
        // pruned map must still admit (and remember) the new access.
        let later = t0 + RECALL_AUDIT_WINDOW + Duration::from_secs(1);
        let fresh = (Uuid::from_u128(9_999_999), Uuid::nil(), ACTION);
        assert!(recall_audit_decision(&mut seen, fresh, later));
        assert!(!recall_audit_decision(&mut seen, fresh, later));
        assert_eq!(seen.len(), 1, "expired entries should have been pruned");
    }
}
