//! Mock execution only. The simulated controller mutates in-memory JSON; no
//! live HTTP write method exists in the transport trait. Apply is atomic,
//! idempotent, rejects stale or expired plans, and rollback never overwrites a
//! field that changed to a value other than the one the plan proposed.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::{
    error::Error,
    model::{get_field, remove_field, set_field, BeforeValue},
    planner::{identity_matches, plan_integrity_holds, ControllerIdentity, SetupPlan},
};

#[derive(Clone, Debug)]
pub struct AuditRecord {
    pub fingerprint: String,
    pub action: &'static str,
    pub at: DateTime<Utc>,
    pub field_paths: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SimulatedController {
    pub identity: ControllerIdentity,
    pub networks: BTreeMap<String, Value>,
    pub audit: Vec<AuditRecord>,
}

impl SimulatedController {
    pub fn new(identity: ControllerIdentity, networks: Vec<Value>) -> Self {
        let mut map = BTreeMap::new();
        for network in networks {
            if let Some(id) = network.get("id").and_then(Value::as_str) {
                map.insert(id.to_owned(), network);
            }
        }
        Self {
            identity,
            networks: map,
            audit: Vec::new(),
        }
    }

    pub fn value(&self, network: &str) -> Option<&Value> {
        self.networks.get(network)
    }

    /// Test/operator simulation of a later, unrelated controller change.
    pub fn simulate_later_change(
        &mut self,
        network: &str,
        path: &str,
        value: Value,
    ) -> Result<(), Error> {
        let root = self
            .networks
            .get_mut(network)
            .ok_or_else(|| Error::InvalidPlan("network missing in simulated controller".into()))?;
        set_field(root, path, value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rejection {
    Expired,
    Stale,
    UnsupportedPlan,
    IdentityMismatch,
    MissingNetwork(String),
    Conflict(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Applicable,
    AlreadyApplied,
}

fn before_value(current: Option<&Value>) -> BeforeValue {
    match current {
        Some(value) => BeforeValue::Present(value.clone()),
        None => BeforeValue::Absent,
    }
}

fn precheck(
    plan: &SetupPlan,
    controller: &SimulatedController,
    now: DateTime<Utc>,
    check_expiry: bool,
) -> Result<State, Rejection> {
    if !plan_integrity_holds(plan) {
        return Err(Rejection::Stale);
    }
    if plan.disposition != crate::planner::PlanDisposition::Ready {
        return Err(Rejection::UnsupportedPlan);
    }
    if check_expiry && now >= plan.expires_at {
        return Err(Rejection::Expired);
    }
    if !identity_matches(plan, &controller.identity) {
        return Err(Rejection::IdentityMismatch);
    }
    let mut all_applied = true;
    for change in &plan.changes {
        let root = controller
            .networks
            .get(&change.network_id)
            .ok_or_else(|| Rejection::MissingNetwork(change.network_id.clone()))?;
        let current = get_field(root, change.field_path.as_str());
        if current == Some(&change.proposed) {
            // Idempotency: an already-applied field is not drift.
            continue;
        }
        all_applied = false;
        if before_value(current) != change.before {
            return Err(Rejection::Stale);
        }
    }
    Ok(if all_applied {
        State::AlreadyApplied
    } else {
        State::Applicable
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewStatus {
    Applicable,
    AlreadyApplied,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub status: PreviewStatus,
    pub issues: Vec<String>,
}

pub fn preview(plan: &SetupPlan, controller: &SimulatedController, now: DateTime<Utc>) -> Preview {
    match precheck(plan, controller, now, true) {
        Ok(State::Applicable) => Preview {
            status: PreviewStatus::Applicable,
            issues: Vec::new(),
        },
        Ok(State::AlreadyApplied) => Preview {
            status: PreviewStatus::AlreadyApplied,
            issues: Vec::new(),
        },
        Err(rejection) => Preview {
            status: PreviewStatus::Rejected,
            issues: vec![format!("{rejection:?}")],
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied(String),
    AlreadyApplied(String),
}

pub fn apply(
    plan: &SetupPlan,
    controller: &mut SimulatedController,
    now: DateTime<Utc>,
) -> Result<ApplyOutcome, Rejection> {
    match precheck(plan, controller, now, true)? {
        State::AlreadyApplied => Ok(ApplyOutcome::AlreadyApplied(plan.fingerprint.clone())),
        State::Applicable => {
            // Stage every change before committing so a failure cannot leave a
            // partially applied plan behind.
            let mut staged = controller.networks.clone();
            for change in &plan.changes {
                let root = staged
                    .get_mut(&change.network_id)
                    .ok_or_else(|| Rejection::MissingNetwork(change.network_id.clone()))?;
                set_field(root, change.field_path.as_str(), change.proposed.clone())
                    .map_err(|_| Rejection::Conflict(change.field_path.to_owned()))?;
            }
            controller.networks = staged;
            controller.audit.push(AuditRecord {
                fingerprint: plan.fingerprint.clone(),
                action: "apply",
                at: now,
                field_paths: plan.changes.iter().map(|c| c.field_path.to_owned()).collect(),
            });
            Ok(ApplyOutcome::Applied(plan.fingerprint.clone()))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldCheck {
    pub network_id: String,
    pub field_path: String,
    pub matches: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verification {
    pub verified: bool,
    pub checks: Vec<FieldCheck>,
}

pub fn verify(plan: &SetupPlan, controller: &SimulatedController) -> Verification {
    let checks: Vec<FieldCheck> = plan
        .changes
        .iter()
        .map(|change| {
            let matches = controller
                .networks
                .get(&change.network_id)
                .and_then(|root| get_field(root, change.field_path.as_str()))
                == Some(&change.proposed);
            FieldCheck {
                network_id: change.network_id.clone(),
                field_path: change.field_path.to_owned(),
                matches,
            }
        })
        .collect();
    Verification {
        verified: !checks.is_empty() && checks.iter().all(|check| check.matches),
        checks,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackOutcome {
    pub restored: usize,
    pub already_at_before: usize,
    pub skipped: Vec<String>,
    pub fingerprint: String,
}

/// Roll back only fields that still hold the proposed value. A field changed
/// to any other value is left untouched and the whole rollback is rejected.
pub fn rollback(
    plan: &SetupPlan,
    controller: &mut SimulatedController,
) -> Result<RollbackOutcome, Rejection> {
    if !plan_integrity_holds(plan) || !identity_matches(plan, &controller.identity) {
        return Err(Rejection::IdentityMismatch);
    }
    let mut decisions = Vec::new();
    for change in &plan.changes {
        let root = controller
            .networks
            .get(&change.network_id)
            .ok_or_else(|| Rejection::MissingNetwork(change.network_id.clone()))?;
        let current = get_field(root, change.field_path.as_str());
        if current == Some(&change.proposed) {
            decisions.push((change, true));
        } else if before_value(current) == change.before {
            decisions.push((change, false));
        } else {
            return Err(Rejection::Conflict(change.field_path.to_owned()));
        }
    }

    let mut staged = controller.networks.clone();
    let mut restored = 0;
    let mut already_at_before = 0;
    for (change, should_restore) in &decisions {
        if !should_restore {
            already_at_before += 1;
            continue;
        }
        let root = staged
            .get_mut(&change.network_id)
            .ok_or_else(|| Rejection::MissingNetwork(change.network_id.clone()))?;
        match &change.before {
            BeforeValue::Absent => {
                remove_field(root, change.field_path.as_str())
                    .map_err(|_| Rejection::Conflict(change.field_path.to_owned()))?;
            }
            BeforeValue::Present(value) => {
                set_field(root, change.field_path.as_str(), value.clone())
                    .map_err(|_| Rejection::Conflict(change.field_path.to_owned()))?;
            }
        }
        restored += 1;
    }
    controller.networks = staged;
    controller.audit.push(AuditRecord {
        fingerprint: plan.fingerprint.clone(),
        action: "rollback",
        at: Utc::now(),
        field_paths: decisions
            .iter()
            .map(|(change, _)| change.field_path.to_owned())
            .collect(),
    });
    Ok(RollbackOutcome {
        restored,
        already_at_before,
        skipped: Vec::new(),
        fingerprint: plan.fingerprint.clone(),
    })
}
