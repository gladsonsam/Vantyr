//! The one durable payload: a complete, validated DNS configuration plus the
//! policy it produces. Both are written in a single atomic file, so a restart
//! cannot combine a new config with an old policy (or vice versa).
//!
//! `policy.published_at` is carried verbatim. It is the original publication
//! time, never refreshed by a worker restart, so an aged policy keeps failing
//! closed for new allows exactly as it did before the restart.

use std::str::FromStr;

use anyhow::Result;
use chrono::{DateTime, Utc};
use family_policy::{Effect, HouseholdId, Policy};
use serde::{Deserialize, Serialize};
use vantyr_network_runtime::{check_policy_shape, LkgError, Persistable, TypedLkgStore, Validator};

use crate::config::Config;

/// One validated config+policy pair. There is no second state file and no
/// independent policy payload: the bundle is the only thing the runtime
/// persists, loads and publishes.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Bundle {
    pub config: Config,
    pub policy: Policy,
}

impl Bundle {
    /// Validate the config and derive its policy with an explicit publication
    /// time. Used for first-run bootstrap and for reload candidates.
    pub fn build(config: &Config, published_at: DateTime<Utc>) -> Result<Self> {
        config.validate()?;
        let policy = config.policy_at(published_at);
        Self::new(config.clone(), policy)
    }

    /// Check that config and policy describe the same version and household.
    pub fn new(config: Config, policy: Policy) -> Result<Self> {
        consistency(&config, &policy).map_err(anyhow::Error::msg)?;
        Ok(Self { config, policy })
    }

    /// The original publication time of the policy in this bundle.
    pub fn published_at(&self) -> DateTime<Utc> {
        self.policy.published_at
    }

    pub fn revision(&self) -> u64 {
        self.policy.revision
    }
}

/// Shared consistency checks, used both on disk loads and on new candidates.
fn consistency(config: &Config, policy: &Policy) -> std::result::Result<(), LkgError> {
    config
        .validate()
        .map_err(|e| LkgError::Malformed(e.to_string()))?;
    check_policy_shape(policy)?;
    if policy.published_at > Utc::now() + chrono::Duration::seconds(60) {
        return Err(LkgError::Malformed(
            "policy publication time exceeds the permitted clock skew".into(),
        ));
    }
    if policy.revision == 0 || config.policy_revision != policy.revision {
        return Err(LkgError::RevisionMismatch);
    }
    let household = HouseholdId::from_str(&config.household_id)
        .map_err(|_| LkgError::Malformed("household_id is not a UUID".into()))?;
    if policy.household_id != household {
        return Err(LkgError::WrongHousehold);
    }
    if let Some(expected) = config.policy_published_at {
        if expected != policy.published_at {
            return Err(LkgError::Malformed(
                "policy publication time disagrees with config".into(),
            ));
        }
    }
    // DNS has no verified identity path: a persisted bundle must stay in the
    // fail-closed shape this worker can actually enforce.
    if policy.default_effect != Effect::Deny
        || !policy.person_rules.is_empty()
        || !policy.exceptions.is_empty()
    {
        return Err(LkgError::Unsupported(
            "DNS bundle must keep deny-by-default and no person/exception rules".into(),
        ));
    }
    if config.policy_at(policy.published_at) != *policy {
        return Err(LkgError::Malformed(
            "policy content disagrees with its DNS configuration".into(),
        ));
    }
    Ok(())
}

impl Persistable for Bundle {
    fn revision(&self) -> u64 {
        self.policy.revision
    }

    fn household_id(&self) -> HouseholdId {
        HouseholdId::from_str(&self.config.household_id)
            .expect("household_id validated when the bundle was built")
    }

    fn check(&self) -> std::result::Result<(), LkgError> {
        consistency(&self.config, &self.policy)
    }
}

/// Enforceability checks kept separate from payload shape so the store can run
/// the same validator on load and on apply without interpreting bundle fields.
#[derive(Clone, Copy, Default)]
pub struct BundleValidator;

impl Validator<Bundle> for BundleValidator {
    fn validate(&self, bundle: &Bundle) -> std::result::Result<(), String> {
        if bundle.policy.default_effect != Effect::Deny {
            return Err("DNS policy must deny by default".into());
        }
        Ok(())
    }
}

/// The only durable store the DNS worker uses.
pub type BundleStore = TypedLkgStore<Bundle, BundleValidator>;
