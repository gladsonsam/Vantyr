//! Versioned policy publication with runtime acknowledgment.
//!
//! A UI/database save is only a *proposal*. Workers read `effective_policy()`,
//! which is the last policy acknowledged by a scoped gateway credential.
//! Dashboard admin privilege never substitutes for a worker credential.
//! Rollback is a NEW monotonic revision with prior content and is itself
//! propose-only until the same credential-based ack path applies it.
//!
//! This store is controller-side evidence only. Durable worker-local
//! last-known-good persistence (kept even when an ack cannot reach the
//! controller during an outage) is future work — see the implementation doc.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use chrono::{DateTime, Utc};

use crate::model::{Event, GatewayCommand, GatewayCredential, HouseholdId, Policy, Role};

/// Maximum retained network events. The existing `0 = unlimited` retention
/// convention is deliberately not reused for the network layer.
pub const MAX_NETWORK_EVENT_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthError {
    Forbidden,
    StaleRevision,
    WrongWorker,
    WrongHousehold,
    InvalidCredential,
    CanaryFailed,
    InvalidRetention,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Forbidden => write!(f, "independent network privilege required"),
            Self::StaleRevision => write!(f, "policy revision is not current"),
            Self::WrongWorker => write!(f, "credential or ack came from an unexpected worker"),
            Self::WrongHousehold => write!(f, "credential belongs to a different household"),
            Self::InvalidCredential => write!(
                f,
                "gateway credential is expired, revoked or lacks the command"
            ),
            Self::CanaryFailed => write!(
                f,
                "placeholder canary reported failure; keeping last-known-good"
            ),
            Self::InvalidRetention => write!(
                f,
                "network event retention must be 1..=MAX_NETWORK_EVENT_RETENTION_SECS"
            ),
        }
    }
}

impl std::error::Error for AuthError {}

/// A dashboard actor. The server currently carries only a role string in
/// `AuthUser` (no scopes); `NetworkAdmin` and `NetworkEvents` are new,
/// independently granted privileges, not aliases of admin/operator/viewer.
#[derive(Clone, Debug)]
pub struct Actor {
    pub id: uuid::Uuid,
    pub roles: BTreeSet<Role>,
}

impl Actor {
    pub fn can_admin_network(&self) -> bool {
        self.roles.contains(&Role::NetworkAdmin)
    }
    pub fn can_read_events(&self) -> bool {
        self.roles.contains(&Role::NetworkEvents) || self.can_admin_network()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicationStatus {
    /// Saved in the dashboard; not enforced anywhere yet.
    Proposed,
    /// Acknowledged by a scoped worker credential.
    Applied,
    /// A new monotonic revision that restores prior content (still Proposed).
    RolledBack,
}

#[derive(Clone, Debug)]
pub struct PublishedPolicy {
    pub policy: Arc<Policy>,
    pub status: PublicationStatus,
    /// Only this worker's scoped credential can apply the proposal.
    pub expected_worker: String,
    pub acked_by: Option<String>,
    /// Placeholder until a real runtime canary is defined; never a substitute
    /// for actual verification.
    pub canary_ok: bool,
}

pub struct PolicyStore {
    current: RwLock<Arc<PublishedPolicy>>,
    applied: RwLock<Arc<Policy>>,
    events: Mutex<Vec<Event>>,
}

impl PolicyStore {
    pub fn new(initial: Policy) -> Result<Self, AuthError> {
        Self::check_retention(&initial)?;
        let initial = Arc::new(initial);
        Ok(Self {
            current: RwLock::new(Arc::new(PublishedPolicy {
                policy: initial.clone(),
                status: PublicationStatus::Applied,
                expected_worker: "bootstrap".to_owned(),
                acked_by: Some("bootstrap".to_owned()),
                canary_ok: true,
            })),
            applied: RwLock::new(initial),
            events: Mutex::new(Vec::new()),
        })
    }

    /// Save a proposal. Requires the independent `network_admin` grant, a
    /// strictly increasing revision and a bounded event retention.
    pub fn publish(
        &self,
        actor: &Actor,
        policy: Policy,
        expected_worker: &str,
    ) -> Result<u64, AuthError> {
        if !actor.can_admin_network() {
            return Err(AuthError::Forbidden);
        }
        Self::check_retention(&policy)?;
        let mut current = self.current.write().unwrap();
        if policy.revision <= current.policy.revision {
            return Err(AuthError::StaleRevision);
        }
        let revision = policy.revision;
        *current = Arc::new(PublishedPolicy {
            policy: Arc::new(policy),
            status: PublicationStatus::Proposed,
            expected_worker: expected_worker.to_owned(),
            acked_by: None,
            canary_ok: false,
        });
        Ok(revision)
    }

    /// Runtime acknowledgment. Requires a gateway credential scoped to this
    /// household and worker with `AckPolicy`, valid at `now`. A dashboard
    /// admin cannot impersonate a worker. Wrong worker/stale revision/failed
    /// canary are rejected; `canary_ok` is a placeholder boolean, not a claim
    /// that verification happened.
    pub fn ack(
        &self,
        credential: &GatewayCredential,
        now: DateTime<Utc>,
        revision: u64,
        worker: &str,
        canary_ok: bool,
    ) -> Result<(), AuthError> {
        let current = self.current.read().unwrap();
        let household = current.policy.household_id;
        validate_credential(
            credential,
            now,
            GatewayCommand::AckPolicy,
            Some(worker),
            household,
        )?;
        if current.expected_worker != worker {
            return Err(AuthError::WrongWorker);
        }
        if current.policy.revision != revision {
            return Err(AuthError::StaleRevision);
        }
        if !canary_ok {
            return Err(AuthError::CanaryFailed);
        }
        drop(current);
        Self::mark_applied(&self.current, &self.applied, revision, worker)
    }

    /// Restore prior content as a NEW monotonic revision. This is propose-only:
    /// it enters the same ack path as any other revision. No worker involvement
    /// here — the reported C1 issue is fixed.
    pub fn rollback(
        &self,
        actor: &Actor,
        now: DateTime<Utc>,
        expected_worker: &str,
    ) -> Result<u64, AuthError> {
        if !actor.can_admin_network() {
            return Err(AuthError::Forbidden);
        }
        let mut restored = self.applied.read().unwrap().as_ref().clone();
        let mut current = self.current.write().unwrap();
        restored.revision = current.policy.revision + 1;
        restored.published_at = now;
        Self::check_retention(&restored)?;
        let revision = restored.revision;
        *current = Arc::new(PublishedPolicy {
            policy: Arc::new(restored),
            status: PublicationStatus::RolledBack,
            expected_worker: expected_worker.to_owned(),
            acked_by: None,
            canary_ok: false,
        });
        Ok(revision)
    }

    /// What workers are told is effective: the last acknowledged snapshot.
    /// Durable worker-local LKG during an ack outage is not implemented here.
    pub fn effective_policy(&self) -> Arc<Policy> {
        self.applied.read().unwrap().clone()
    }

    pub fn current(&self) -> Arc<PublishedPolicy> {
        self.current.read().unwrap().clone()
    }

    /// Ingest a decision event. Requires a scoped `ReportDecision` gateway
    /// credential bound to the event's household — NOT an event-read grant.
    pub fn record_event(
        &self,
        credential: &GatewayCredential,
        now: DateTime<Utc>,
        household_id: HouseholdId,
        event: Event,
    ) -> Result<(), AuthError> {
        validate_credential(
            credential,
            now,
            GatewayCommand::ReportDecision,
            None,
            household_id,
        )?;
        if event.household_id != household_id {
            return Err(AuthError::WrongHousehold);
        }
        self.events.lock().unwrap().push(event);
        Ok(())
    }

    pub fn events(&self, actor: &Actor) -> Result<Vec<Event>, AuthError> {
        if !actor.can_read_events() {
            return Err(AuthError::Forbidden);
        }
        Ok(self.events.lock().unwrap().clone())
    }

    fn check_retention(policy: &Policy) -> Result<(), AuthError> {
        if policy.event_retention_secs == 0
            || policy.event_retention_secs > MAX_NETWORK_EVENT_RETENTION_SECS
        {
            return Err(AuthError::InvalidRetention);
        }
        Ok(())
    }

    fn mark_applied(
        current: &RwLock<Arc<PublishedPolicy>>,
        applied: &RwLock<Arc<Policy>>,
        revision: u64,
        worker: &str,
    ) -> Result<(), AuthError> {
        let snapshot = current.read().unwrap().clone();
        if snapshot.policy.revision != revision {
            return Err(AuthError::StaleRevision);
        }
        let policy = snapshot.policy.clone();
        *current.write().unwrap() = Arc::new(PublishedPolicy {
            policy: policy.clone(),
            status: PublicationStatus::Applied,
            expected_worker: snapshot.expected_worker.clone(),
            acked_by: Some(worker.to_owned()),
            canary_ok: true,
        });
        let mut applied = applied.write().unwrap();
        if revision >= applied.revision {
            *applied = policy;
        }
        Ok(())
    }
}

fn validate_credential(
    credential: &GatewayCredential,
    now: DateTime<Utc>,
    command: GatewayCommand,
    worker: Option<&str>,
    household_id: HouseholdId,
) -> Result<(), AuthError> {
    if credential.revoked_at.is_some() || now < credential.issued_at || now >= credential.expires_at
    {
        return Err(AuthError::InvalidCredential);
    }
    if !credential.allowed_commands.contains(&command) {
        return Err(AuthError::InvalidCredential);
    }
    if credential.household_id != household_id {
        return Err(AuthError::WrongHousehold);
    }
    if let Some(worker) = worker {
        if credential.gateway_id != worker {
            return Err(AuthError::WrongWorker);
        }
    }
    Ok(())
}
