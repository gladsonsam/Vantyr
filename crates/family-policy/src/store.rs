//! Versioned policy publication with runtime acknowledgment.
//!
//! A UI/database save is only a *proposal*. Workers read `effective_policy()`,
//! which is the last policy acknowledged by a scoped gateway credential.
//! Dashboard admin privilege never substitutes for a worker credential.
//! Rollback is a NEW monotonic revision with prior content and is itself
//! propose-only until the same credential-based ack path applies it.
//!
//! All policy state lives behind ONE lock so publish / ack / rollback are
//! single atomic transitions: a concurrent newer publish cannot be clobbered
//! by a stale ack, and `current` and `applied` are always consistent.
//! This is controller-side evidence only; durable worker-local last-known-good
//! persistence during an ack outage is future work (see the implementation doc).

use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use crate::model::{Event, GatewayCommand, GatewayCredential, HouseholdId, Policy, Role};

/// Maximum retained network events. The existing `0 = unlimited` retention
/// convention is deliberately not reused for the network layer.
pub const MAX_NETWORK_EVENT_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthError {
    Forbidden,
    StaleRevision,
    RevisionOverflow,
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
            Self::RevisionOverflow => write!(f, "policy revision counter overflowed"),
            Self::WrongWorker => write!(f, "credential or ack came from an unexpected worker"),
            Self::WrongHousehold => write!(
                f,
                "actor, credential or event belongs to a different household"
            ),
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
/// The household is explicit so a grant in household A cannot read household B.
#[derive(Clone, Debug)]
pub struct Actor {
    pub id: uuid::Uuid,
    pub household_id: HouseholdId,
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

#[derive(Clone, Debug)]
struct StoreState {
    household_id: HouseholdId,
    current: Arc<PublishedPolicy>,
    applied: Arc<Policy>,
}

pub struct PolicyStore {
    /// One lock for both fields: every transition is atomic and consistent.
    state: RwLock<StoreState>,
    events: Mutex<Vec<Event>>,
}

impl PolicyStore {
    pub fn new(initial: Policy) -> Result<Self, AuthError> {
        Self::check_retention(&initial)?;
        let household_id = initial.household_id;
        let initial = Arc::new(initial);
        Ok(Self {
            state: RwLock::new(StoreState {
                household_id,
                current: Arc::new(PublishedPolicy {
                    policy: initial.clone(),
                    status: PublicationStatus::Applied,
                    expected_worker: "bootstrap".to_owned(),
                    acked_by: Some("bootstrap".to_owned()),
                    canary_ok: true,
                }),
                applied: initial,
            }),
            events: Mutex::new(Vec::new()),
        })
    }

    /// Save a proposal. Requires an admin actor of this household, a strictly
    /// increasing revision, an unchanged household and bounded retention.
    pub fn publish(
        &self,
        actor: &Actor,
        policy: Policy,
        expected_worker: &str,
    ) -> Result<u64, AuthError> {
        let mut state = self.state.write().unwrap();
        if !actor.can_admin_network() {
            return Err(AuthError::Forbidden);
        }
        if actor.household_id != state.household_id || policy.household_id != state.household_id {
            return Err(AuthError::WrongHousehold);
        }
        Self::check_retention(&policy)?;
        if policy.revision <= state.current.policy.revision {
            return Err(AuthError::StaleRevision);
        }
        let revision = policy.revision;
        state.current = Arc::new(PublishedPolicy {
            policy: Arc::new(policy),
            status: PublicationStatus::Proposed,
            expected_worker: expected_worker.to_owned(),
            acked_by: None,
            canary_ok: false,
        });
        Ok(revision)
    }

    /// Runtime acknowledgment. Authentication, worker/revision binding,
    /// canary placeholder and the current -> applied transition happen under
    /// ONE write lock, so a concurrent publish cannot be clobbered and the
    /// credential is validated against the very snapshot being applied.
    pub fn ack(
        &self,
        credential: &GatewayCredential,
        now: DateTime<Utc>,
        revision: u64,
        worker: &str,
        canary_ok: bool,
    ) -> Result<(), AuthError> {
        let mut state = self.state.write().unwrap();
        validate_credential(
            credential,
            now,
            GatewayCommand::AckPolicy,
            Some(worker),
            state.household_id,
        )?;
        if state.current.expected_worker != worker {
            return Err(AuthError::WrongWorker);
        }
        if state.current.policy.revision != revision {
            return Err(AuthError::StaleRevision);
        }
        if !matches!(
            state.current.status,
            PublicationStatus::Proposed | PublicationStatus::RolledBack
        ) {
            return Err(AuthError::StaleRevision);
        }
        if !canary_ok {
            return Err(AuthError::CanaryFailed);
        }
        let policy = state.current.policy.clone();
        let expected_worker = state.current.expected_worker.clone();
        state.current = Arc::new(PublishedPolicy {
            policy: policy.clone(),
            status: PublicationStatus::Applied,
            expected_worker,
            acked_by: Some(worker.to_owned()),
            canary_ok: true,
        });
        state.applied = policy;
        Ok(())
    }

    /// Restore prior content as a NEW monotonic revision. This is propose-only:
    /// it enters the same ack path as any other revision. Takes the write lock
    /// before reading `applied` so the restored snapshot is consistent, and
    /// rejects revision overflow explicitly.
    pub fn rollback(
        &self,
        actor: &Actor,
        now: DateTime<Utc>,
        expected_worker: &str,
    ) -> Result<u64, AuthError> {
        let mut state = self.state.write().unwrap();
        if !actor.can_admin_network() {
            return Err(AuthError::Forbidden);
        }
        if actor.household_id != state.household_id {
            return Err(AuthError::WrongHousehold);
        }
        let restored = state.applied.as_ref().clone();
        let revision = state
            .current
            .policy
            .revision
            .checked_add(1)
            .ok_or(AuthError::RevisionOverflow)?;
        let mut restored = restored;
        restored.revision = revision;
        restored.published_at = now;
        Self::check_retention(&restored)?;
        state.current = Arc::new(PublishedPolicy {
            policy: Arc::new(restored),
            status: PublicationStatus::RolledBack,
            expected_worker: expected_worker.to_owned(),
            acked_by: None,
            canary_ok: false,
        });
        Ok(revision)
    }

    /// Controller-side effective snapshot: last acknowledged policy with a
    /// passing placeholder canary. Worker-local LKG is not implemented here.
    pub fn effective_policy(&self) -> Arc<Policy> {
        self.state.read().unwrap().applied.clone()
    }

    pub fn current(&self) -> Arc<PublishedPolicy> {
        self.state.read().unwrap().current.clone()
    }

    /// Atomic read of both fields under one lock, for consistent runtime status.
    pub fn snapshot(&self) -> (Arc<PublishedPolicy>, Arc<Policy>) {
        let state = self.state.read().unwrap();
        (state.current.clone(), state.applied.clone())
    }

    /// Ingest a decision event. Requires a scoped `ReportDecision` credential
    /// bound to this store's immutable household — NOT an event-read grant.
    /// Events older than the effective retention are pruned on ingest.
    /// Count enforcement remains a later slice.
    pub fn record_event(
        &self,
        credential: &GatewayCredential,
        now: DateTime<Utc>,
        household_id: HouseholdId,
        event: Event,
    ) -> Result<(), AuthError> {
        let state = self.state.read().unwrap();
        validate_credential(
            credential,
            now,
            GatewayCommand::ReportDecision,
            None,
            state.household_id,
        )?;
        if household_id != state.household_id || event.household_id != state.household_id {
            return Err(AuthError::WrongHousehold);
        }
        let retention = state.applied.event_retention_secs;
        drop(state);
        let mut events = self.events.lock().unwrap();
        let cutoff = now - ChronoDuration::seconds(retention.min(i64::MAX as u64) as i64);
        events.retain(|stored| stored.occurred_at >= cutoff);
        events.push(event);
        Ok(())
    }

    pub fn events(&self, actor: &Actor) -> Result<Vec<Event>, AuthError> {
        let state = self.state.read().unwrap();
        if !actor.can_read_events() {
            return Err(AuthError::Forbidden);
        }
        if actor.household_id != state.household_id {
            return Err(AuthError::WrongHousehold);
        }
        drop(state);
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
