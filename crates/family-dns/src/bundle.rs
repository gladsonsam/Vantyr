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
use crate::filter::{validate_material_shape, FilterMaterial};
use crate::management::{validate_state, ManagementState};

/// One validated config+policy pair plus its self-contained filter material.
/// There is no second state file and no independent policy or filter payload:
/// the bundle is the only thing the runtime persists, loads and publishes.
/// `filter` is `None` for old bundles and for workers with no list settings.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Bundle {
    pub config: Config,
    pub policy: Policy,
    #[serde(default)]
    pub filter: Option<FilterMaterial>,
    /// Monotonic generation of the whole bundle, independent of the policy
    /// revision. Every durable commit (policy change OR list refresh) advances
    /// it. `Option` keeps a missing counter distinguishable from a valid value
    /// so the shape check can reject it instead of silently defaulting it.
    #[serde(default)]
    pub generation: Option<u64>,
    /// Highest policy revision ever applied. Distinct from `generation`.
    #[serde(default)]
    pub policy_highwater: Option<u64>,
    /// Generation of the applied filter material. Advances only when the
    /// compiled material content actually changes.
    #[serde(default)]
    pub filter_generation: Option<u64>,
    /// Operator-authorized remote management state. Independent of policy and
    /// both generation spaces; persisted in this same bundle.
    #[serde(default)]
    pub management: Option<ManagementState>,
}

impl Bundle {
    /// Assemble a candidate without the local-only consistency check. The
    /// worker calls `with_generation`/`with_management` and the store's own
    /// `check` validates the complete candidate before it is persisted.
    pub(crate) fn unchecked(
        config: Config,
        policy: Policy,
        filter: Option<FilterMaterial>,
        management: Option<ManagementState>,
    ) -> Self {
        Self {
            config,
            policy,
            filter,
            generation: None,
            policy_highwater: None,
            filter_generation: None,
            management,
        }
    }

    /// Validate the config and derive its policy with an explicit publication
    /// time. Kept for callers that do not use list filtering.
    pub fn build(config: &Config, published_at: DateTime<Utc>) -> Result<Self> {
        Self::build_with_filter(config, published_at, None)
    }

    /// Bootstrap/reload candidate with the validated list material actually
    /// applied. The material carries bytes and derivation metadata, not paths.
    pub fn build_with_filter(
        config: &Config,
        published_at: DateTime<Utc>,
        filter: Option<FilterMaterial>,
    ) -> Result<Self> {
        config.validate()?;
        let policy = config.policy_at(published_at);
        Self::new_with_filter(config.clone(), policy, filter)
    }

    /// Check that config and policy describe the same version and household.
    pub fn new(config: Config, policy: Policy) -> Result<Self> {
        Self::new_with_filter(config, policy, None)
    }

    pub fn new_with_filter(
        config: Config,
        policy: Policy,
        filter: Option<FilterMaterial>,
    ) -> Result<Self> {
        consistency(&config, &policy, filter.as_ref(), None).map_err(anyhow::Error::msg)?;
        let generation = policy.revision;
        let policy_highwater = policy.revision;
        let filter_generation = if filter.is_some() { 1 } else { 0 };
        Ok(Self {
            config,
            policy,
            filter,
            generation: Some(generation),
            policy_highwater: Some(policy_highwater),
            filter_generation: Some(filter_generation),
            management: None,
        })
    }

    /// The original publication time of the policy in this bundle.
    pub fn published_at(&self) -> DateTime<Utc> {
        self.policy.published_at
    }

    /// Policy revision — its own monotonic space, never changed by a refresh.
    pub fn revision(&self) -> u64 {
        self.policy.revision
    }

    /// Monotonic whole-bundle generation, including policy and list commits.
    pub fn generation(&self) -> u64 {
        self.generation
            .expect("bundle counters are present on every current-shape bundle")
    }

    pub fn policy_highwater(&self) -> u64 {
        self.policy_highwater
            .expect("bundle counters are present on every current-shape bundle")
    }

    pub fn filter_generation(&self) -> u64 {
        self.filter_generation
            .expect("bundle counters are present on every current-shape bundle")
    }

    /// Build a new candidate with the next whole-bundle generation. The policy
    /// revision and publication time are carried through untouched.
    pub fn with_generation(
        &self,
        generation: u64,
        filter_generation: u64,
    ) -> std::result::Result<Self, LkgError> {
        let mut candidate = self.clone();
        candidate.generation = Some(generation);
        candidate.filter_generation = Some(filter_generation);
        candidate
            .policy_highwater
            .get_or_insert(self.policy.revision);
        check_counters(&candidate)?;
        Ok(candidate)
    }

    /// Commit management state and/or receipts with the next whole-bundle
    /// generation. Policy revision, publication time and local fields are
    /// never touched by management commits.
    pub fn with_management(
        &self,
        generation: u64,
        filter_generation: u64,
        management: ManagementState,
    ) -> std::result::Result<Self, LkgError> {
        validate_state(&management).map_err(|error| LkgError::Malformed(error.to_string()))?;
        let mut candidate = self.clone();
        candidate.generation = Some(generation);
        candidate.filter_generation = Some(filter_generation);
        candidate.management = Some(management);
        check_counters(&candidate)?;
        Ok(candidate)
    }
}

/// Shared consistency checks, used both on disk loads and on new candidates.
fn consistency(
    config: &Config,
    policy: &Policy,
    filter: Option<&FilterMaterial>,
    management: Option<&ManagementState>,
) -> std::result::Result<(), LkgError> {
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
    check_filter_consistency(config, filter, management)?;
    Ok(())
}

/// Management state is validated for shape; its identity/material linkage is
/// checked by the coordinator before it is committed.
fn check_management_state(state: Option<&ManagementState>) -> std::result::Result<(), LkgError> {
    if let Some(state) = state {
        validate_state(state).map_err(|error| LkgError::Malformed(error.to_string()))?;
    }
    Ok(())
}

/// The bundle is authoritative for what was applied: enabled settings and
/// durable material must describe exactly the same sources and services. A
/// missing source file on disk is irrelevant here because no path is reread.
fn check_filter_consistency(
    config: &Config,
    filter: Option<&FilterMaterial>,
    management: Option<&ManagementState>,
) -> std::result::Result<(), LkgError> {
    let mut enabled = config.filter.enabled_source_ids();
    let mut selected = config.filter.selected_service_ids();
    if let Some(state) = management {
        enabled.extend(
            state
                .config
                .sources
                .iter()
                .filter(|source| source.enabled)
                .map(|source| source.id.clone()),
        );
        selected.extend(state.config.selected_services.iter().cloned());
        enabled.sort();
        enabled.dedup();
        selected.sort();
        selected.dedup();
    }
    match filter {
        None => {
            if !enabled.is_empty() || !selected.is_empty() {
                return Err(LkgError::Malformed(
                    "filter settings have no persisted material".into(),
                ));
            }
        }
        Some(material) => {
            validate_material_shape(material)
                .map_err(|error| LkgError::Malformed(error.to_string()))?;
            let stored_ids: Vec<String> =
                material.lists.iter().map(|list| list.id.clone()).collect();
            let local_version = config
                .filter
                .catalog
                .as_ref()
                .map(|catalog| catalog.version.clone())
                .unwrap_or_default();
            let managed_version = management
                .and_then(|state| state.config.catalog.as_ref())
                .map(|catalog| catalog.version.clone());
            let catalog_ok = material.derivation.catalog_version == local_version
                || managed_version
                    .as_deref()
                    .is_some_and(|version| version == material.derivation.catalog_version);
            if stored_ids != enabled
                || material.derivation.selected_services != selected
                || !catalog_ok
            {
                return Err(LkgError::Malformed(
                    "persisted filter material disagrees with local settings".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Internal consistency of the three independent counter spaces. Every
/// counter must be present and valid; a missing or partial set is rejected,
/// never repaired.
fn check_counters(bundle: &Bundle) -> std::result::Result<(), LkgError> {
    let (Some(generation), Some(policy_highwater), Some(filter_generation)) = (
        bundle.generation,
        bundle.policy_highwater,
        bundle.filter_generation,
    ) else {
        return Err(LkgError::Malformed(
            "bundle generation counters are missing".into(),
        ));
    };
    if generation == 0 || policy_highwater == 0 {
        return Err(LkgError::Malformed(
            "bundle/policy generation counters must be positive".into(),
        ));
    }
    if policy_highwater != bundle.policy.revision {
        return Err(LkgError::Malformed(
            "policy high-water mark disagrees with the policy revision".into(),
        ));
    }
    // Generations are independent spaces: a newly published policy revision
    // can exceed the current bundle generation, so no ordering is asserted
    // between them. Only per-space monotonicity (enforced by the store and the
    // worker) and the internal filter-generation bound are checked here.
    match bundle.filter {
        None if filter_generation != 0 => Err(LkgError::Malformed(
            "filter generation is set without filter material".into(),
        )),
        Some(_) if filter_generation == 0 => Err(LkgError::Malformed(
            "filter material has no filter generation".into(),
        )),
        Some(_) if filter_generation > generation => Err(LkgError::Malformed(
            "filter generation exceeds the bundle generation".into(),
        )),
        _ => Ok(()),
    }
}

impl Persistable for Bundle {
    /// The store's generic high-water mark is the whole-bundle generation,
    /// NOT the controller policy revision.
    fn revision(&self) -> u64 {
        self.generation()
    }

    fn household_id(&self) -> HouseholdId {
        HouseholdId::from_str(&self.config.household_id)
            .expect("household_id validated when the bundle was built")
    }

    fn check(&self) -> std::result::Result<(), LkgError> {
        check_counters(self)?;
        check_management_state(self.management.as_ref())?;
        consistency(
            &self.config,
            &self.policy,
            self.filter.as_ref(),
            self.management.as_ref(),
        )
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
        if let Some(material) = &bundle.filter {
            validate_material_shape(material).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

/// The only durable store the DNS worker uses.
pub type BundleStore = TypedLkgStore<Bundle, BundleValidator>;
