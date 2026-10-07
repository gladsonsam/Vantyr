//! Exclusive input integration. No parking_lot guard crosses an await.
//! Lock order: `agents.lifecycle` (when needed), control, `agents.connections`,
//! `agents.modules`, `agents.cmds`.
//! Every registration/removal and permission publication takes `control` too.
use crate::http::AuthUser;
use crate::platform::audit;
use crate::{
    agents::modules::{CommandDenied, Module},
    control::sessions::{ControlSessions, LeaseCleanup, LeaseError, LeaseOwner, DEFAULT_LEASE_TTL},
    state::{AgentControl, AppState, Broadcast},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Instant};
use uuid::Uuid;

pub(crate) struct ControlRuntime {
    pub sessions: ControlSessions,
    pub clipboard: HashMap<Uuid, crate::control::clipboard::PendingClipboard>,
    pub capture: HashMap<Uuid, crate::control::capture_arbitration::FrozenCapture>,
    audit_seen: HashMap<(Uuid, Uuid, &'static str, bool), Instant>,
    audit_inflight: Arc<tokio::sync::Semaphore>,
}

impl Default for ControlRuntime {
    fn default() -> Self {
        Self {
            sessions: ControlSessions::default(),
            clipboard: HashMap::new(),
            capture: HashMap::new(),
            audit_seen: HashMap::new(),
            audit_inflight: Arc::new(tokio::sync::Semaphore::new(64)),
        }
    }
}
pub(crate) fn is_remote_input(kind: &str) -> bool {
    matches!(
        kind,
        "MouseMove"
            | "MouseClick"
            | "MouseDoubleClick"
            | "MouseDown"
            | "MouseUp"
            | "MouseScroll"
            | "Scroll"
            | "KeyPress"
            | "KeyDown"
            | "KeyUp"
            | "KeyChar"
            | "TypeText"
            | "Notify"
    )
}
fn lease_error(error: LeaseError) -> CommandDenied {
    let (code, message) = match error {
        LeaseError::Conflict { .. } => ("control_conflict", "Another viewer owns remote control."),
        LeaseError::Missing => (
            "control_lease_required",
            "Acquire remote control before sending input.",
        ),
        LeaseError::Expired => (
            "control_lease_expired",
            "Remote control expired; acquire it again.",
        ),
        LeaseError::Mismatch => (
            "control_lease_mismatch",
            "Lease does not match this viewer or device connection.",
        ),
        LeaseError::InvalidHeldInput => ("invalid_command", "Invalid held input command."),
    };
    CommandDenied::new(code, message, Some(Module::RemoteInput))
}
impl AppState {
    /// Called only while `control` is locked. Fence cleanup to the old socket;
    /// never use a replacement's sender. Queue failure closes out of band and
    /// marks the current connection unavailable for all subsequent grants/input.
    pub(crate) fn deliver_control_cleanup(
        &self,
        control: &mut ControlRuntime,
        batches: Vec<LeaseCleanup>,
    ) -> bool {
        let mut safe = true;
        for batch in batches {
            control.capture.remove(&batch.agent_id);
            let agents = self.agents.connections.lock();
            if let Some(connection) = agents
                .get(&batch.agent_id)
                .filter(|c| c.conn_id == batch.owner.agent_connection_id)
            {
                let senders = self.agents.cmds.lock();
                for command in batch.commands {
                    if !senders.get(&batch.agent_id).is_some_and(|sender| {
                        sender
                            .try_send(AgentControl::InputCleanup {
                                conn_id: connection.conn_id,
                                command,
                            })
                            .is_ok()
                    }) {
                        connection.shutdown.send_replace(Some(""));
                        safe = false;
                        break;
                    }
                }
            }
            drop(agents);
            if batch.reason == crate::control::sessions::TeardownReason::Released {
                continue;
            }
            let event = json!({"event":"control_lease", "agent_id":batch.agent_id,
            "status":"revoked", "lease_token":batch.token, "expires_in_ms":0, "code":match batch.reason {
                crate::control::sessions::TeardownReason::Expired => "control_lease_expired",
                _ => "control_lease_revoked",
            }});
            let _ = self.tx.send(Broadcast::PrivateText(
                batch.owner.viewer_connection_id,
                event.to_string(),
            ));
        }
        safe
    }
    pub(crate) fn control_cleanup_deliverable(
        &self,
        agent_id: Uuid,
        socket: Uuid,
        cleanup_socket: Uuid,
        command: &Value,
    ) -> bool {
        if socket != cleanup_socket
            || !self
                .agents
                .connections
                .lock()
                .get(&agent_id)
                .is_some_and(|c| c.conn_id == socket && c.shutdown.borrow().is_none())
        {
            return false;
        }
        // Even this server-only variant can only release fixed tracked inputs.
        let key_ok = command["key"]
            .as_str()
            .is_some_and(crate::control::sessions::tracked_key);
        let button_ok = command["button"]
            .as_str()
            .is_some_and(|b| matches!(b, "left" | "right" | "middle"));
        match command["type"].as_str() {
            Some("KeyUp") => key_ok,
            Some("MouseUp") => {
                button_ok
                    && ["x", "y"].iter().all(|k| {
                        command[*k]
                            .as_i64()
                            .is_some_and(|n| i32::try_from(n).is_ok())
                    })
            }
            _ => false,
        }
    }
    fn current_control_owner(
        &self,
        agent_id: Uuid,
        viewer: Uuid,
        user: &AuthUser,
    ) -> Result<LeaseOwner, CommandDenied> {
        if !user.is_operator() {
            return Err(CommandDenied::new(
                "permission_denied",
                "Operator permission is required.",
                Some(Module::RemoteInput),
            ));
        }
        let agents = self.agents.connections.lock();
        let connection = agents
            .get(&agent_id)
            .filter(|c| c.shutdown.borrow().is_none())
            .ok_or_else(|| {
                CommandDenied::new(
                    "agent_offline",
                    "Agent is not connected or is closing.",
                    None,
                )
            })?;
        Ok(LeaseOwner {
            viewer_connection_id: viewer,
            user_id: user.user_id,
            agent_connection_id: connection.conn_id,
        })
    }
    /// Actual WS protocol dispatcher; synchronous to keep authorization, cleanup,
    /// and enqueue ordered. Server identities never come from the JSON envelope.
    pub(crate) fn control_lease_message(
        &self,
        viewer: Uuid,
        user: &AuthUser,
        value: &Value,
        now: Instant,
    ) -> Value {
        let agent_id = value["agent_id"]
            .as_str()
            .and_then(|s| s.parse::<Uuid>().ok());
        let request_id = value["request_id"]
            .as_str()
            .and_then(|s| s.parse::<Uuid>().ok());
        let mut reply = json!({"event":"control_lease", "agent_id":agent_id, "request_id":request_id,
            "status":"denied", "expires_in_ms":0});
        let Some((agent_id, _)) = agent_id.zip(request_id) else {
            reply["code"] = "invalid_request".into();
            reply["error"] = "agent_id and request_id must be UUIDs.".into();
            return reply;
        };
        let kind = value["type"].as_str().unwrap_or("");
        let mut control = self.control.lock();
        let result = (|| {
            let owner = self.current_control_owner(agent_id, viewer, user)?;
            // Explicit release remains allowed after local revocation so cleanup
            // can run. Acquire and heartbeat require current device permission.
            if kind != "control_release" {
                self.agents.authorize_agent_command(
                    agent_id,
                    &json!({"type":"MouseMove", "x":0, "y":0}),
                )?;
            }
            let token = value["lease_token"]
                .as_str()
                .and_then(|s| s.parse::<Uuid>().ok());
            if kind == "control_acquire" {
                let expired = control.sessions.expire_agent(agent_id, now);
                if !self.deliver_control_cleanup(&mut control, expired) {
                    return Err(CommandDenied::new(
                        "control_cleanup_failed",
                        "Device connection is closing after failed input cleanup.",
                        Some(Module::RemoteInput),
                    ));
                }
                let frozen = self.validate_control_capture(agent_id, owner, value)?;
                if control
                    .capture
                    .get(&agent_id)
                    .is_some_and(|c| c.owner == owner && c.session_id != frozen.session_id)
                {
                    return Err(CommandDenied::new("capture_session_locked", "Release the existing lease before binding a different live stream session.", Some(Module::LiveScreen)));
                }
                let transition = control
                    .sessions
                    .acquire(agent_id, owner, DEFAULT_LEASE_TTL, now);
                let safe = self.deliver_control_cleanup(&mut control, transition.cleanup);
                if !safe {
                    let cleanup = control
                        .sessions
                        .revoke_agent(agent_id, owner.agent_connection_id);
                    self.deliver_control_cleanup(&mut control, cleanup);
                    return Err(CommandDenied::new(
                        "control_cleanup_failed",
                        "Device connection is closing after failed input cleanup.",
                        Some(Module::RemoteInput),
                    ));
                }
                let grant = transition.result.map_err(lease_error)?;
                self.commit_control_capture(agent_id, &frozen);
                control.capture.entry(agent_id).or_insert(frozen);
                Ok(Some(grant))
            } else {
                let token = token.ok_or_else(|| lease_error(LeaseError::Missing))?;
                if kind == "control_heartbeat" {
                    let transition =
                        control
                            .sessions
                            .heartbeat(agent_id, owner, token, DEFAULT_LEASE_TTL, now);
                    self.deliver_control_cleanup(&mut control, transition.cleanup);
                    Ok(Some(transition.result.map_err(lease_error)?))
                } else if kind == "control_release" {
                    let transition = control.sessions.release(agent_id, owner, token, now);
                    self.deliver_control_cleanup(&mut control, transition.cleanup);
                    transition.result.map_err(lease_error)?;
                    Ok(None)
                } else {
                    Err(CommandDenied::new(
                        "invalid_request",
                        "Unknown control lease operation.",
                        None,
                    ))
                }
            }
        })();
        match &result {
            Ok(Some(grant)) => {
                reply["status"] = "granted".into();
                reply["lease_token"] = grant.token.to_string().into();
                if let Some(capture) = control.capture.get(&agent_id) {
                    reply["capture_session"] = capture.session_id.to_string().into();
                    reply["monitor"] = json!(capture.active.prefs.monitor);
                }
                reply["expires_in_ms"] = json!(grant.remaining(now).as_millis() as u64);
            }
            Ok(None) => reply["status"] = "released".into(),
            Err(error) => {
                reply["code"] = error.code.into();
                reply["error"] = error.error.clone().into();
            }
        }
        drop(control);
        if kind != "control_heartbeat" || result.is_err() {
            self.audit_control_lease(
                user,
                agent_id,
                if kind == "control_release" {
                    "control_release"
                } else {
                    "control_acquire"
                },
                result.as_ref().err(),
            );
        }
        reply
    }
    pub(crate) fn send_viewer_input(
        &self,
        agent_id: Uuid,
        viewer: Uuid,
        user: &AuthUser,
        token: Option<Uuid>,
        cmd: &Value,
        now: Instant,
    ) -> Result<(), CommandDenied> {
        let mut control = self.control.lock();
        let owner = self.current_control_owner(agent_id, viewer, user)?;
        let token = token.ok_or_else(|| lease_error(LeaseError::Missing))?;
        // Existing module authorization stamps the generation, never strip it.
        let authorized = self.agents.authorize_agent_command(agent_id, cmd)?;
        let transition = control
            .sessions
            .authorize_and_track(agent_id, owner, token, cmd, now);
        self.deliver_control_cleanup(&mut control, transition.cleanup);
        transition.result.map_err(lease_error)?;
        let result =
            self.agents
                .enqueue_authorized_command(agent_id, owner.agent_connection_id, authorized);
        if result.is_err() {
            // A failed KeyUp/MouseUp enqueue has already cleared tracking. Close
            // even if the remaining drain is empty; disconnect is the safety reset.
            if let Some(connection) = self
                .agents
                .connections
                .lock()
                .get(&agent_id)
                .filter(|c| c.conn_id == owner.agent_connection_id)
            {
                connection.shutdown.send_replace(Some(""));
            }
            let cleanup = control
                .sessions
                .revoke_agent(agent_id, owner.agent_connection_id);
            self.deliver_control_cleanup(&mut control, cleanup);
        }
        result
    }
    pub(crate) fn revoke_viewer_control(&self, viewer: Uuid) {
        let mut control = self.control.lock();
        let cleanup = control.sessions.revoke_viewer(viewer);
        self.deliver_control_cleanup(&mut control, cleanup);
    }
    /// Caller already holds `control`; lifecycle mutation and permission update
    /// paths use this to revoke before publishing a new connection/generation.
    pub(crate) fn revoke_agent_control_locked(
        &self,
        control: &mut ControlRuntime,
        id: Uuid,
        conn: Uuid,
    ) {
        let cleanup = control.sessions.revoke_agent(id, conn);
        self.deliver_control_cleanup(control, cleanup);
    }
    pub(crate) fn expire_control(&self, now: Instant) {
        let mut control = self.control.lock();
        let cleanup = control.sessions.expire(now);
        self.deliver_control_cleanup(&mut control, cleanup);
    }
    pub(crate) fn audit_control_lease(
        &self,
        user: &AuthUser,
        agent: Uuid,
        action: &'static str,
        denied: Option<&CommandDenied>,
    ) {
        self.audit_control_event(
            user,
            agent,
            action,
            denied.is_some(),
            json!({"code":denied.map(|d| d.code)}),
        );
    }
    pub(crate) fn audit_control_command(
        &self,
        user: &AuthUser,
        agent: Uuid,
        kind: &str,
        denied: Option<&CommandDenied>,
    ) {
        self.audit_control_event(
            user,
            agent,
            "control_command",
            denied.is_some(),
            json!({"cmd_type":kind,"error":denied}),
        );
    }
    fn audit_control_event(
        &self,
        user: &AuthUser,
        agent: Uuid,
        action: &'static str,
        rejected: bool,
        detail: Value,
    ) {
        let now = Instant::now();
        let permit = {
            let mut control = self.control.lock();
            let Ok(permit) = control.audit_inflight.clone().try_acquire_owned() else {
                return;
            };
            if control.audit_seen.len() >= 4096 {
                control
                    .audit_seen
                    .retain(|_, at| now.duration_since(*at).as_secs() < 2);
                if control.audit_seen.len() >= 4096 {
                    return;
                }
            }
            let key = (user.user_id, agent, action, rejected);
            if control
                .audit_seen
                .get(&key)
                .is_some_and(|at| now.duration_since(*at).as_secs() < 2)
            {
                return;
            }
            control.audit_seen.insert(key, now);
            permit
        };
        let pool = self.db.clone();
        let actor = user.username.clone();
        let status = if rejected { "rejected" } else { "ok" };
        tokio::spawn(async move {
            let _permit = permit;
            audit::insert_audit_log_dedup_traced(
                &pool,
                audit::AuditLogDedup {
                    actor: &actor,
                    agent_id: Some(agent),
                    action,
                    status,
                    detail: &detail,
                    dedup_window_secs: 2,
                    client_ip: None,
                },
            )
            .await;
        });
    }
}
pub(crate) fn spawn_expiry(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            state.expire_control(Instant::now());
        }
    });
}

#[cfg(test)]
pub(crate) mod tests;
