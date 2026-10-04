//! Pure, exclusive remote-input leases. No I/O, authentication, or agent lookup.
//!
//! Integration must construct `LeaseOwner` from authenticated server-side connection
//! identities (never viewer JSON), verify the agent is currently connected, and hold
//! one mutex across authorization/tracking and ordered agent-channel enqueueing.
//! Deliver cleanup before a successor's input and ONLY to `owner.agent_connection_id`.
//! Do not look up just the latest sender by agent id: that would release a new session's
//! inputs after reconnect. Run `expire(Instant::now())` periodically, including while idle.
//!
//! Existing ws_viewer command shape/role/capability checks remain required. Use
//! `authorize_and_track` for remote-input commands, not just `authorize`: tracking
//! before enqueue is conservative if enqueue fails (revoke to drain remembered input).
//! Host/module commands need their own policy and are not granted by this lease.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

pub const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(15);
pub const MIN_LEASE_TTL: Duration = Duration::from_secs(1);
pub const MAX_LEASE_TTL: Duration = Duration::from_secs(30);

// Mirrors ws_viewer's SpecialKey whitelist. Fixed bitset: client strings are never stored.
const HELD_KEYS: &[&str] = &[
    "enter",
    "backspace",
    "tab",
    "escape",
    "delete",
    "insert",
    "space",
    "home",
    "end",
    "pageup",
    "pagedown",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "control",
    "alt",
    "shift",
    "meta",
    "capslock",
];
pub(crate) fn tracked_key(key: &str) -> bool {
    HELD_KEYS.contains(&key)
}

const BUTTONS: [&str; 3] = ["left", "right", "middle"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseOwner {
    pub viewer_connection_id: Uuid,
    pub user_id: Uuid,
    pub agent_connection_id: Uuid,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct LeaseGrant {
    /// UUID v4 generated with uuid's OS-backed cryptographic RNG. Treat as a secret.
    pub token: Uuid,
    pub owner: LeaseOwner,
    /// Monotonic deadline; do not serialize as a wall-clock timestamp.
    pub expires_at: Instant,
}
impl std::fmt::Debug for LeaseGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaseGrant")
            .field("token", &"[redacted]")
            .field("owner", &self.owner)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}
impl LeaseGrant {
    pub fn remaining(&self, now: Instant) -> Duration {
        self.expires_at.saturating_duration_since(now)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseError {
    Conflict { owner: LeaseOwner },
    Missing,
    Expired,
    Mismatch,
    InvalidHeldInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeardownReason {
    Released,
    Expired,
    ViewerDisconnected,
    AgentDisconnected,
}

#[derive(PartialEq)]
pub struct LeaseCleanup {
    /// Secret token for the owning viewer's private revocation notification.
    pub token: Uuid,
    pub agent_id: Uuid,
    pub owner: LeaseOwner,
    pub reason: TeardownReason,
    /// Bare agent wire commands, not the viewer's `{"type":"control",...}` envelope.
    pub commands: Vec<Value>,
}

impl std::fmt::Debug for LeaseCleanup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaseCleanup")
            .field("token", &"[redacted]")
            .field("agent_id", &self.agent_id)
            .field("owner", &self.owner)
            .field("reason", &self.reason)
            .field("commands", &self.commands)
            .finish()
    }
}

/// Errors can still carry cleanup (e.g. expiry during authorization). Always consume it.
#[must_use = "deliver connection-fenced cleanup even when result is an error"]
#[derive(Debug)]
pub struct Transition<T> {
    pub result: Result<T, LeaseError>,
    pub cleanup: Vec<LeaseCleanup>,
}

#[derive(Debug, Default)]
struct HeldInput {
    keys: u64,
    buttons: [Option<(i32, i32)>; 3],
}
impl HeldInput {
    fn position(cmd: &Value) -> Result<(i32, i32), LeaseError> {
        let parse = |name: &str| cmd[name].as_i64().and_then(|n| i32::try_from(n).ok());
        match (parse("x"), parse("y")) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => Err(LeaseError::InvalidHeldInput),
        }
    }
    fn button(cmd: &Value) -> Result<usize, LeaseError> {
        let button = match cmd.get("button") {
            None => "left", // Agent serde default.
            Some(value) => value.as_str().ok_or(LeaseError::InvalidHeldInput)?,
        };
        BUTTONS
            .iter()
            .position(|&b| b == button)
            .ok_or(LeaseError::InvalidHeldInput)
    }
    fn track(&mut self, cmd: &Value) -> Result<(), LeaseError> {
        match cmd["type"].as_str() {
            Some(kind @ ("KeyDown" | "KeyUp")) => {
                let key = cmd["key"].as_str().ok_or(LeaseError::InvalidHeldInput)?;
                let index = HELD_KEYS
                    .iter()
                    .position(|&k| k == key)
                    .ok_or(LeaseError::InvalidHeldInput)?;
                if kind == "KeyDown" {
                    self.keys |= 1u64 << index;
                } else {
                    self.keys &= !(1u64 << index);
                }
            }
            Some(kind @ ("MouseDown" | "MouseUp")) => {
                // Validate before mutating, so a rejected command cannot alter cleanup.
                let button = Self::button(cmd)?;
                let point = Self::position(cmd)?;
                // Every coordinate-bearing mouse command moves the host cursor.
                for held in self.buttons.iter_mut().flatten() {
                    *held = point;
                }
                if kind == "MouseDown" {
                    self.buttons[button] = Some(point);
                } else {
                    self.buttons[button] = None;
                }
            }
            Some("MouseMove" | "MouseClick" | "MouseDoubleClick") => {
                let point = Self::position(cmd)?;
                for held in self.buttons.iter_mut().flatten() {
                    *held = point;
                }
            }
            _ => {} // Other commands' shapes are checked by ws_viewer, not this module.
        }
        Ok(())
    }
    fn drain(self) -> Vec<Value> {
        let mut out = Vec::new();
        for (index, key) in HELD_KEYS.iter().enumerate() {
            if self.keys & (1u64 << index) != 0 {
                out.push(json!({"type": "KeyUp", "key": key}));
            }
        }
        for (index, point) in self.buttons.into_iter().enumerate() {
            if let Some((x, y)) = point {
                out.push(json!({"type": "MouseUp", "button": BUTTONS[index], "x": x, "y": y}));
            }
        }
        out
    }
}

#[derive(Debug)]
struct Lease {
    grant: LeaseGrant,
    held: HeldInput,
}

/// Caller synchronization makes transitions atomic. One entry at most per connected agent.
#[derive(Debug, Default)]
pub struct ControlSessions {
    leases: HashMap<Uuid, Lease>,
}
impl ControlSessions {
    fn deadline(now: Instant, requested_ttl: Duration) -> Instant {
        now + requested_ttl.clamp(MIN_LEASE_TTL, MAX_LEASE_TTL)
    }
    fn remove(&mut self, agent_id: Uuid, reason: TeardownReason) -> Option<LeaseCleanup> {
        self.leases.remove(&agent_id).map(|lease| LeaseCleanup {
            agent_id,
            token: lease.grant.token,
            owner: lease.grant.owner,
            reason,
            commands: lease.held.drain(),
        })
    }
    pub(crate) fn expire_agent(&mut self, agent_id: Uuid, now: Instant) -> Vec<LeaseCleanup> {
        if self
            .leases
            .get(&agent_id)
            .is_some_and(|lease| now >= lease.grant.expires_at)
        {
            self.remove(agent_id, TeardownReason::Expired)
                .into_iter()
                .collect()
        } else {
            Vec::new()
        }
    }
    fn check(&self, agent_id: Uuid, owner: LeaseOwner, token: Uuid) -> Result<(), LeaseError> {
        let lease = self.leases.get(&agent_id).ok_or(LeaseError::Missing)?;
        if lease.grant.owner != owner || lease.grant.token != token {
            return Err(LeaseError::Mismatch);
        }
        Ok(())
    }
    /// Idempotent for the exact same user/viewer/agent connection; does not renew TTL.
    /// A different agent connection must first revoke the old one, never silently steal.
    pub fn acquire(
        &mut self,
        agent_id: Uuid,
        owner: LeaseOwner,
        requested_ttl: Duration,
        now: Instant,
    ) -> Transition<LeaseGrant> {
        let cleanup = self.expire_agent(agent_id, now);
        let result = if let Some(existing) = self.leases.get(&agent_id) {
            if existing.grant.owner == owner {
                Ok(existing.grant)
            } else {
                Err(LeaseError::Conflict {
                    owner: existing.grant.owner,
                })
            }
        } else {
            let grant = LeaseGrant {
                token: Uuid::new_v4(),
                owner,
                expires_at: Self::deadline(now, requested_ttl),
            };
            self.leases.insert(
                agent_id,
                Lease {
                    grant,
                    held: HeldInput::default(),
                },
            );
            Ok(grant)
        };
        Transition { result, cleanup }
    }
    /// Resolve an HTTP bearer token only for its authenticated user. The viewer
    /// identity is taken from the existing lease, never from HTTP JSON.
    pub fn http_owner(&self, agent: Uuid, user: Uuid, token: Uuid) -> Option<LeaseOwner> {
        self.leases
            .get(&agent)
            .filter(|l| l.grant.token == token && l.grant.owner.user_id == user)
            .map(|l| l.grant.owner)
    }
    /// Authorization never renews a lease. Expiry is inclusive of the deadline.
    pub fn authorize(
        &mut self,
        agent_id: Uuid,
        owner: LeaseOwner,
        token: Uuid,
        now: Instant,
    ) -> Transition<()> {
        let cleanup = self.expire_agent(agent_id, now);
        let result = if cleanup.is_empty() {
            self.check(agent_id, owner, token)
        } else {
            Err(LeaseError::Expired)
        };
        Transition { result, cleanup }
    }
    /// Call only for commands already validated by ws_viewer. Mutate tracking and
    /// enqueue under the same integration lock; do not track a different owner.
    pub fn authorize_and_track(
        &mut self,
        agent_id: Uuid,
        owner: LeaseOwner,
        token: Uuid,
        cmd: &Value,
        now: Instant,
    ) -> Transition<()> {
        let mut transition = self.authorize(agent_id, owner, token, now);
        if transition.result.is_ok() {
            transition.result = self
                .leases
                .get_mut(&agent_id)
                .expect("authorized lease")
                .held
                .track(cmd);
        }
        transition
    }
    /// Extend from now (not from the prior deadline), clamping even enormous TTLs.
    pub fn heartbeat(
        &mut self,
        agent_id: Uuid,
        owner: LeaseOwner,
        token: Uuid,
        requested_ttl: Duration,
        now: Instant,
    ) -> Transition<LeaseGrant> {
        let auth = self.authorize(agent_id, owner, token, now);
        let result = auth.result.map(|()| {
            let lease = self.leases.get_mut(&agent_id).expect("authorized lease");
            lease.grant.expires_at = Self::deadline(now, requested_ttl);
            lease.grant
        });
        Transition {
            result,
            cleanup: auth.cleanup,
        }
    }
    pub fn release(
        &mut self,
        agent_id: Uuid,
        owner: LeaseOwner,
        token: Uuid,
        now: Instant,
    ) -> Transition<()> {
        let mut transition = self.authorize(agent_id, owner, token, now);
        if transition.result.is_ok() {
            transition
                .cleanup
                .extend(self.remove(agent_id, TeardownReason::Released));
        }
        transition
    }
    /// Tick this even when no viewers send input; cleanup is returned exactly once.
    pub fn expire(&mut self, now: Instant) -> Vec<LeaseCleanup> {
        let expired: Vec<_> = self
            .leases
            .iter()
            .filter(|(_, lease)| now >= lease.grant.expires_at)
            .map(|(&id, _)| id)
            .collect();
        expired
            .into_iter()
            .filter_map(|id| self.remove(id, TeardownReason::Expired))
            .collect()
    }
    pub fn revoke_viewer(&mut self, viewer_connection_id: Uuid) -> Vec<LeaseCleanup> {
        let agents: Vec<_> = self
            .leases
            .iter()
            .filter(|(_, lease)| lease.grant.owner.viewer_connection_id == viewer_connection_id)
            .map(|(&id, _)| id)
            .collect();
        agents
            .into_iter()
            .filter_map(|id| self.remove(id, TeardownReason::ViewerDisconnected))
            .collect()
    }
    /// Connection-fenced teardown: an old socket cannot revoke its replacement.
    pub fn revoke_agent(&mut self, agent_id: Uuid, agent_connection_id: Uuid) -> Vec<LeaseCleanup> {
        if self
            .leases
            .get(&agent_id)
            .is_some_and(|lease| lease.grant.owner.agent_connection_id == agent_connection_id)
        {
            self.remove(agent_id, TeardownReason::AgentDisconnected)
                .into_iter()
                .collect()
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> LeaseOwner {
        LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            agent_connection_id: Uuid::new_v4(),
        }
    }
    fn grant(
        state: &mut ControlSessions,
        agent: Uuid,
        owner: LeaseOwner,
        now: Instant,
    ) -> LeaseGrant {
        let acquired = state.acquire(agent, owner, DEFAULT_LEASE_TTL, now);
        assert!(acquired.cleanup.is_empty());
        acquired.result.unwrap()
    }
    fn track(
        state: &mut ControlSessions,
        agent: Uuid,
        owner: LeaseOwner,
        token: Uuid,
        cmd: Value,
        now: Instant,
    ) {
        let result = state.authorize_and_track(agent, owner, token, &cmd, now);
        assert!(result.cleanup.is_empty());
        assert_eq!(result.result, Ok(()));
    }

    #[test]
    fn acquire_is_exclusive_and_exact_owner_idempotent_without_renewal() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let first = grant(&mut state, agent, a, now);
        let again = state.acquire(agent, a, MAX_LEASE_TTL, now + Duration::from_secs(2));
        assert_eq!(again.result, Ok(first));
        let b = LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            ..a
        };
        assert_eq!(
            state.acquire(agent, b, DEFAULT_LEASE_TTL, now).result,
            Err(LeaseError::Conflict { owner: a })
        );
        assert_eq!(state.leases.len(), 1);
        assert_ne!(first.token, Uuid::nil());
        assert_eq!(first.token.get_version_num(), 4);
        assert!(!format!("{first:?}").contains(&first.token.to_string()));
    }

    #[test]
    fn all_identity_fields_and_token_are_required() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        for wrong in [
            LeaseOwner {
                viewer_connection_id: Uuid::new_v4(),
                ..a
            },
            LeaseOwner {
                user_id: Uuid::new_v4(),
                ..a
            },
            LeaseOwner {
                agent_connection_id: Uuid::new_v4(),
                ..a
            },
        ] {
            assert_eq!(
                state.authorize(agent, wrong, lease.token, now).result,
                Err(LeaseError::Mismatch)
            );
            assert_eq!(
                state.release(agent, wrong, lease.token, now).result,
                Err(LeaseError::Mismatch)
            );
            assert_eq!(
                state
                    .heartbeat(agent, wrong, lease.token, MAX_LEASE_TTL, now)
                    .result,
                Err(LeaseError::Mismatch)
            );
        }
        assert_eq!(
            state.authorize(agent, a, Uuid::new_v4(), now).result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state.authorize(Uuid::new_v4(), a, lease.token, now).result,
            Err(LeaseError::Missing)
        );
        assert_eq!(state.authorize(agent, a, lease.token, now).result, Ok(()));
    }

    #[test]
    fn exact_deadline_expires_and_idle_sweeps_remove_once() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        assert_eq!(lease.remaining(now), DEFAULT_LEASE_TTL);
        assert_eq!(
            lease.remaining(lease.expires_at + Duration::from_secs(1)),
            Duration::ZERO
        );
        assert!(state
            .expire(lease.expires_at - Duration::from_nanos(1))
            .is_empty());
        let cleanup = state.expire(lease.expires_at);
        assert_eq!(cleanup.len(), 1);
        assert_eq!(cleanup[0].reason, TeardownReason::Expired);
        assert!(state.expire(lease.expires_at).is_empty());
        assert!(state.leases.is_empty());
        assert_eq!(
            state
                .authorize(agent, a, lease.token, lease.expires_at)
                .result,
            Err(LeaseError::Missing)
        );
    }

    #[test]
    fn authorization_expiry_returns_cleanup_even_on_error() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"KeyDown", "key":"control"}),
            now,
        );
        let denied = state.authorize(agent, a, lease.token, lease.expires_at);
        assert_eq!(denied.result, Err(LeaseError::Expired));
        assert_eq!(
            denied.cleanup[0].commands,
            vec![json!({"type":"KeyUp", "key":"control"})]
        );
        assert!(state
            .release(agent, a, lease.token, lease.expires_at)
            .cleanup
            .is_empty());
    }

    #[test]
    fn heartbeat_is_bounded_from_now_and_cannot_resurrect_expired_lease() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let short = state.acquire(agent, a, Duration::ZERO, now).result.unwrap();
        assert_eq!(short.expires_at, now + MIN_LEASE_TTL);
        let at = now + Duration::from_millis(500);
        let renewed = state
            .heartbeat(agent, a, short.token, Duration::MAX, at)
            .result
            .unwrap();
        assert_eq!(renewed.expires_at, at + MAX_LEASE_TTL);
        assert_eq!(renewed.token, short.token);
        let again_at = at + Duration::from_secs(1);
        let again = state
            .heartbeat(agent, a, short.token, Duration::MAX, again_at)
            .result
            .unwrap();
        assert_eq!(again.expires_at, again_at + MAX_LEASE_TTL); // not prior deadline + TTL
        let expired = state.heartbeat(agent, a, short.token, DEFAULT_LEASE_TTL, again.expires_at);
        assert_eq!(expired.result, Err(LeaseError::Expired));
        assert_eq!(expired.cleanup.len(), 1);
        assert!(state.leases.is_empty());
    }

    #[test]
    fn expired_acquire_drains_predecessor_before_new_grant() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let first = grant(&mut state, agent, a, now);
        track(
            &mut state,
            agent,
            a,
            first.token,
            json!({"type":"MouseDown", "x":5, "y":6}),
            now,
        );
        let b = LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            ..a
        };
        let acquired = state.acquire(agent, b, DEFAULT_LEASE_TTL, first.expires_at);
        assert_eq!(acquired.cleanup.len(), 1);
        assert_eq!(acquired.cleanup[0].owner, a);
        assert_eq!(
            acquired.cleanup[0].commands,
            vec![json!({"type":"MouseUp", "button":"left", "x":5, "y":6})]
        );
        let successor = acquired.result.unwrap();
        assert_ne!(successor.token, first.token);
        assert_eq!(
            state
                .release(agent, a, first.token, first.expires_at)
                .result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state
                .heartbeat(agent, a, first.token, DEFAULT_LEASE_TTL, first.expires_at)
                .result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state
                .authorize(agent, b, successor.token, first.expires_at)
                .result,
            Ok(())
        );
    }

    #[test]
    fn release_drains_each_held_input_once_at_latest_position() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        for _ in 0..5 {
            track(
                &mut state,
                agent,
                a,
                lease.token,
                json!({"type":"KeyDown", "key":"shift"}),
                now,
            );
        }
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"KeyDown", "key":"alt"}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"KeyUp", "key":"alt"}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseDown", "button":"left", "x":1, "y":2}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseDown", "button":"right", "x":1, "y":2}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseMove", "x":30, "y":40}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseUp", "button":"right", "x":30, "y":40}),
            now,
        );
        let release = state.release(agent, a, lease.token, now);
        assert_eq!(release.result, Ok(()));
        assert_eq!(release.cleanup[0].reason, TeardownReason::Released);
        assert_eq!(
            release.cleanup[0].commands,
            vec![
                json!({"type":"KeyUp", "key":"shift"}),
                json!({"type":"MouseUp", "button":"left", "x":30, "y":40})
            ]
        );
        assert_eq!(
            state.release(agent, a, lease.token, now).result,
            Err(LeaseError::Missing)
        );
        assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
        assert!(state.expire(now + MAX_LEASE_TTL).is_empty());
    }

    #[test]
    fn viewer_disconnect_revokes_all_its_agents_but_not_other_viewers() {
        let mut state = ControlSessions::default();
        let now = Instant::now();
        let a = owner();
        let b = owner();
        let x = Uuid::new_v4();
        let y = Uuid::new_v4();
        let z = Uuid::new_v4();
        grant(&mut state, x, a, now);
        grant(&mut state, y, a, now);
        let b_grant = grant(&mut state, z, b, now);
        let revoked = state.revoke_viewer(a.viewer_connection_id);
        assert_eq!(revoked.len(), 2);
        assert!(revoked
            .iter()
            .all(|cleanup| cleanup.reason == TeardownReason::ViewerDisconnected));
        assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
        assert_eq!(state.authorize(z, b, b_grant.token, now).result, Ok(()));
    }

    #[test]
    fn reconnect_fences_old_agent_disconnect_and_old_viewer_token() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let first = grant(&mut state, agent, a, now);
        track(
            &mut state,
            agent,
            a,
            first.token,
            json!({"type":"KeyDown", "key":"meta"}),
            now,
        );
        let b = LeaseOwner {
            agent_connection_id: Uuid::new_v4(),
            viewer_connection_id: Uuid::new_v4(),
            ..a
        };
        assert_eq!(
            state.acquire(agent, b, DEFAULT_LEASE_TTL, now).result,
            Err(LeaseError::Conflict { owner: a })
        );
        let revoked = state.revoke_agent(agent, a.agent_connection_id);
        assert_eq!(revoked[0].owner.agent_connection_id, a.agent_connection_id);
        assert_eq!(revoked[0].reason, TeardownReason::AgentDisconnected);
        assert_eq!(
            revoked[0].commands,
            vec![json!({"type":"KeyUp", "key":"meta"})]
        );
        let successor = grant(&mut state, agent, b, now);
        assert!(state.revoke_agent(agent, a.agent_connection_id).is_empty());
        assert!(state.revoke_viewer(a.viewer_connection_id).is_empty());
        assert_eq!(
            state.authorize(agent, b, first.token, now).result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state.release(agent, a, first.token, now).result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state
                .heartbeat(agent, a, first.token, MAX_LEASE_TTL, now)
                .result,
            Err(LeaseError::Mismatch)
        );
        assert_eq!(
            state.authorize(agent, b, successor.token, now).result,
            Ok(())
        );
    }

    #[test]
    fn arbitrary_keys_buttons_and_invalid_coordinates_cannot_grow_held_state() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        for i in 0..5000 {
            let rejected = state.authorize_and_track(
                agent,
                a,
                lease.token,
                &json!({"type":"KeyDown", "key":format!("untrusted-{i}")}),
                now,
            );
            assert_eq!(rejected.result, Err(LeaseError::InvalidHeldInput));
        }
        for cmd in [
            json!({"type":"MouseDown", "button":"button999", "x":1,"y":2}),
            json!({"type":"MouseDown", "x":i64::MAX,"y":2}),
            json!({"type":"MouseDown", "x":1.5,"y":2}),
            json!({"type":"KeyDown", "key":null}),
        ] {
            assert_eq!(
                state
                    .authorize_and_track(agent, a, lease.token, &cmd, now)
                    .result,
                Err(LeaseError::InvalidHeldInput)
            );
        }
        assert_eq!(state.leases.len(), 1);
        assert!(state.release(agent, a, lease.token, now).cleanup[0]
            .commands
            .is_empty());
    }

    #[test]
    fn all_valid_held_keys_and_buttons_have_a_fixed_maximum_cleanup_size() {
        assert!(HELD_KEYS.len() <= 64);
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        for key in HELD_KEYS {
            track(
                &mut state,
                agent,
                a,
                lease.token,
                json!({"type":"KeyDown","key":key}),
                now,
            );
        }
        for button in BUTTONS {
            track(
                &mut state,
                agent,
                a,
                lease.token,
                json!({"type":"MouseDown","button":button,"x":0,"y":0}),
                now,
            );
        }
        assert_eq!(
            state.release(agent, a, lease.token, now).cleanup[0]
                .commands
                .len(),
            HELD_KEYS.len() + BUTTONS.len()
        );
    }

    #[test]
    fn unauthorized_commands_do_not_mutate_successor_tracking() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        let denied = state.authorize_and_track(
            agent,
            owner(),
            lease.token,
            &json!({"type":"KeyDown","key":"control"}),
            now,
        );
        assert_eq!(denied.result, Err(LeaseError::Mismatch));
        assert!(state.release(agent, a, lease.token, now).cleanup[0]
            .commands
            .is_empty());
    }

    #[test]
    fn mouse_button_commands_update_other_held_buttons_to_the_host_cursor() {
        let mut state = ControlSessions::default();
        let agent = Uuid::new_v4();
        let a = owner();
        let now = Instant::now();
        let lease = grant(&mut state, agent, a, now);
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseDown","button":"left","x":1,"y":2}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseDown","button":"right","x":50,"y":60}),
            now,
        );
        track(
            &mut state,
            agent,
            a,
            lease.token,
            json!({"type":"MouseUp","button":"right","x":70,"y":80}),
            now,
        );
        assert_eq!(
            state.release(agent, a, lease.token, now).cleanup[0].commands,
            vec![json!({"type":"MouseUp","button":"left","x":70,"y":80})]
        );
    }

    #[test]
    fn racing_viewers_under_the_integration_mutex_have_exactly_one_winner() {
        use std::sync::{Arc, Barrier, Mutex};
        let state = Arc::new(Mutex::new(ControlSessions::default()));
        let barrier = Arc::new(Barrier::new(2));
        let agent = Uuid::new_v4();
        let now = Instant::now();
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let state = state.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let viewer = owner();
                    barrier.wait();
                    let acquired =
                        state
                            .lock()
                            .unwrap()
                            .acquire(agent, viewer, DEFAULT_LEASE_TTL, now);
                    assert!(acquired.cleanup.is_empty());
                    acquired.result
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(LeaseError::Conflict { .. })))
                .count(),
            1
        );
        assert_eq!(state.lock().unwrap().leases.len(), 1);
    }
}
