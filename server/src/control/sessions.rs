//! Pure, exclusive remote-input leases. No I/O, authentication, or agent lookup.
//!
//! Integration must construct `LeaseOwner` from authenticated server-side connection
//! identities (never viewer JSON), verify the agent is currently connected, and hold
//! one mutex across authorization/tracking and ordered agent-channel enqueueing.
//! Deliver cleanup before a successor's input and ONLY to `owner.agent_connection_id`.
//! Do not look up just the latest sender by agent id: that would release a new session's
//! inputs after reconnect. Run `expire(Instant::now())` periodically, including while idle.
//!
//! Existing `viewer::ws` command shape/role/capability checks remain required. Use
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

// Mirrors `viewer::ws`'s SpecialKey whitelist. Fixed bitset: client strings are never stored.
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
            _ => {} // Other commands' shapes are checked by `viewer::ws`, not this module.
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
    /// Call only for commands already validated by `viewer::ws`. Mutate tracking and
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
mod tests;
