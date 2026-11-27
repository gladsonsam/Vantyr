//! Explicit offline conversion of prior-shape persisted DNS bundles.
//!
//! This module is the ONLY place that understands the pre-single-contract
//! persisted `ManagementState` shape. It is a hand-run tool: the normal worker
//! stays strict-current-only and never calls into this module. There is no
//! runtime fallback, dual reader or on-load repair.
//!
//! The prior state carried `schema_version` and an optional outer `runtime`
//! beside a config with only `sources`/`catalog`/`selected_services`. The
//! current state requires `config.runtime` and rejects both outer fields. A
//! schema-1 state had no managed runtime, so its new runtime is taken from the
//! ACTUAL local config cache/deny values rather than asserted defaults. A
//! schema-2 state's managed runtime is carried across byte-for-byte.
//!
//! Every candidate must already carry all three generation counters. Missing
//! counters, a bad digest, an unsupported schema, an unknown field or a strict
//! current-bundle rejection all fail explicitly with the source file untouched.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::{DateTime, Utc};
use family_policy::{HouseholdId, Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vantyr_network_runtime::persistence::write_private_atomic;
use vantyr_network_runtime::{Persistable, TypedSnapshot, Validator, SNAPSHOT_SCHEMA};

use crate::bundle::{Bundle, BundleValidator};
use crate::config::{Config, DenyConfig};
use crate::controller::read_private_file;
use crate::filter::{FilterMaterial, MAX_FILTER_BUNDLE_BYTES};
use crate::management::{validate_state, ManagementState};
use crate::management_dto::{
    canonical_bytes, digest, is_digest, CacheSettingsDto, DenySettingsDto, ManagementConfig,
    RefreshAckDto, RuntimeSettingsDto, ServiceCatalogDto, SubscriptionSourceDto,
};

const ENVELOPE_KEYS: &[&str] = &[
    "schema",
    "household_id",
    "worker_id",
    "highwater",
    "policy",
    "saved_at",
];

/// Failure detail never includes bundle bytes, digests or connection data.
#[derive(Clone, Debug)]
pub struct ConvertError(String);

impl ConvertError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ConvertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConvertError {}

/// The prior desired-config body: the three fields that existed before the
/// single-contract shape. Field order is the canonical digest order.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PriorConfig {
    #[serde(default)]
    sources: Vec<SubscriptionSourceDto>,
    #[serde(default)]
    catalog: Option<ServiceCatalogDto>,
    #[serde(default)]
    selected_services: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PriorManagementState {
    config_version: u64,
    digest: String,
    config: PriorConfig,
    filter_identity: String,
    #[serde(default)]
    receipts: Vec<RefreshAckDto>,
    #[serde(default)]
    receipt_expiry: BTreeMap<String, DateTime<Utc>>,
    #[serde(default = "prior_schema_version")]
    schema_version: i32,
    #[serde(default)]
    runtime: Option<RuntimeSettingsDto>,
    #[serde(default)]
    applied_at: Option<DateTime<Utc>>,
    #[serde(default)]
    last_error: Option<String>,
}

fn prior_schema_version() -> i32 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PriorBundle {
    config: Config,
    policy: Policy,
    #[serde(default)]
    filter: Option<FilterMaterial>,
    #[serde(default)]
    generation: Option<u64>,
    #[serde(default)]
    policy_highwater: Option<u64>,
    #[serde(default)]
    filter_generation: Option<u64>,
    #[serde(default)]
    management: Option<PriorManagementState>,
}

type PriorEnvelope = TypedSnapshot<PriorBundle>;

/// A converted envelope plus the small, non-sensitive summary for operators.
#[derive(Clone, Debug)]
pub struct Converted {
    pub envelope: TypedSnapshot<Bundle>,
    pub source_schema: i32,
    pub source_config_version: u64,
}

fn check_exact_keys(value: &Value, expected: &[&str]) -> Result<(), ConvertError> {
    let Some(map) = value.as_object() else {
        return Err(ConvertError::new("persisted envelope is not a JSON object"));
    };
    if map.len() != expected.len() || expected.iter().any(|key| !map.contains_key(*key)) {
        return Err(ConvertError::new(
            "persisted envelope has missing or unknown fields",
        ));
    }
    Ok(())
}

/// The mirrored subset of the local config that was authoritative when no
/// managed runtime had ever been applied. Local-only cache fields stay in the
/// config; they are not invented here.
fn runtime_from_local(config: &Config) -> RuntimeSettingsDto {
    let cache = &config.cache;
    let deny = match &config.deny {
        DenyConfig::Nxdomain => DenySettingsDto::Nxdomain,
        DenyConfig::Refused => DenySettingsDto::Refused,
        DenyConfig::Sinkhole { ipv4, ipv6, ttl } => DenySettingsDto::Sinkhole {
            ipv4: ipv4.clone(),
            ipv6: ipv6.clone(),
            ttl_secs: *ttl,
        },
    };
    RuntimeSettingsDto {
        cache: CacheSettingsDto {
            enabled: cache.enabled,
            max_entries: cache.max_entries,
            positive_min_ttl_secs: cache.positive_min_ttl_secs,
            positive_max_ttl_secs: cache.positive_max_ttl_secs,
            negative_min_ttl_secs: cache.negative_min_ttl_secs,
            negative_max_ttl_secs: cache.negative_max_ttl_secs,
        },
        deny,
    }
}

/// Turn one prior management state into the strict current shape. The applied
/// version, digest, timestamp, receipts and identity are carried through; the
/// desired V+1 publish is deliberately NOT forged here.
fn convert_management(
    prior: &PriorManagementState,
    config: &Config,
) -> Result<ManagementState, ConvertError> {
    if prior.config_version == 0 || !is_digest(&prior.digest) {
        return Err(ConvertError::new(
            "prior management version or digest is malformed",
        ));
    }
    let runtime = match prior.schema_version {
        1 => {
            if prior.runtime.is_some() {
                return Err(ConvertError::new(
                    "schema 1 management state must not carry a managed runtime",
                ));
            }
            runtime_from_local(config)
        }
        2 => prior
            .runtime
            .clone()
            .ok_or_else(|| ConvertError::new("schema 2 state has no managed runtime"))?,
        _ => {
            return Err(ConvertError::new(
                "unsupported prior management schema version",
            ))
        }
    };
    let new_config = ManagementConfig {
        sources: prior.config.sources.clone(),
        catalog: prior.config.catalog.clone(),
        selected_services: prior.config.selected_services.clone(),
        runtime: runtime.clone(),
    };
    // For schema 2 the current ordered config produces exactly the canonical
    // bytes the prior digest was computed over. Schema 1 must be checked
    // against the three-field body only, because its new runtime comes from
    // local settings and is not part of that digest.
    let canonical = if prior.schema_version == 1 {
        serde_json::to_vec(&PriorConfig {
            sources: prior.config.sources.clone(),
            catalog: prior.config.catalog.clone(),
            selected_services: prior.config.selected_services.clone(),
        })
    } else {
        canonical_bytes(&new_config)
    }
    .map_err(|_| ConvertError::new("prior management config cannot be serialized"))?;
    if digest(&canonical) != prior.digest {
        return Err(ConvertError::new(
            "prior digest disagrees with its persisted config",
        ));
    }
    let state = ManagementState {
        config_version: prior.config_version,
        digest: prior.digest.clone(),
        config: new_config,
        filter_identity: prior.filter_identity.clone(),
        receipts: prior.receipts.clone(),
        receipt_expiry: prior.receipt_expiry.clone(),
        applied_at: prior.applied_at,
        last_error: prior.last_error.clone(),
    };
    validate_state(&state)
        .map_err(|_| ConvertError::new("converted management state is malformed"))?;
    Ok(state)
}

/// Run every strict check the worker applies to a current bundle and envelope,
/// without ever calling the counter-repair path.
fn validate_current(envelope: &TypedSnapshot<Bundle>) -> Result<(), ConvertError> {
    if envelope.schema != SNAPSHOT_SCHEMA {
        return Err(ConvertError::new(
            "converted envelope schema is unsupported",
        ));
    }
    let bundle = &envelope.policy;
    bundle
        .check()
        .map_err(|error| ConvertError::new(format!("converted bundle rejected: {error}")))?;
    BundleValidator
        .validate(bundle)
        .map_err(|error| ConvertError::new(format!("converted bundle unsupported: {error}")))?;
    if envelope.highwater != bundle.generation() {
        return Err(ConvertError::new(
            "converted envelope high-water mark disagrees with the bundle generation",
        ));
    }
    if envelope.household_id != bundle.household_id() {
        return Err(ConvertError::new(
            "converted envelope household disagrees with the bundle",
        ));
    }
    Ok(())
}

/// Deserialize, convert and strictly revalidate a prior-shape bundle in memory.
pub fn convert_bytes(bytes: &[u8]) -> Result<Converted, ConvertError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| ConvertError::new("persisted bundle is not valid JSON"))?;
    check_exact_keys(&value, ENVELOPE_KEYS)?;
    let prior: PriorEnvelope = serde_json::from_value(value)
        .map_err(|_| ConvertError::new("persisted bundle is not a recognized prior shape"))?;
    if prior.schema != SNAPSHOT_SCHEMA {
        return Err(ConvertError::new(
            "persisted envelope schema is unsupported",
        ));
    }
    let source =
        prior.policy.management.as_ref().ok_or_else(|| {
            ConvertError::new("persisted bundle has no management state to convert")
        })?;
    let source_schema = source.schema_version;
    let source_config_version = source.config_version;
    let (Some(generation), Some(policy_highwater), Some(filter_generation)) = (
        prior.policy.generation,
        prior.policy.policy_highwater,
        prior.policy.filter_generation,
    ) else {
        return Err(ConvertError::new(
            "persisted bundle has missing generation counters",
        ));
    };
    if generation == 0 || policy_highwater == 0 || policy_highwater != prior.policy.policy.revision
    {
        return Err(ConvertError::new(
            "persisted bundle counters are inconsistent",
        ));
    }
    if prior.highwater != generation {
        return Err(ConvertError::new(
            "persisted envelope high-water mark disagrees with the bundle generation",
        ));
    }
    let household = HouseholdId::from_str(&prior.policy.config.household_id)
        .map_err(|_| ConvertError::new("persisted bundle household is malformed"))?;
    if prior.household_id != household {
        return Err(ConvertError::new(
            "persisted envelope household disagrees with the bundle",
        ));
    }
    let management = convert_management(source, &prior.policy.config)?;
    let envelope = TypedSnapshot::<Bundle> {
        schema: prior.schema,
        household_id: prior.household_id,
        worker_id: prior.worker_id,
        highwater: prior.highwater,
        policy: Bundle {
            config: prior.policy.config,
            policy: prior.policy.policy,
            filter: prior.policy.filter,
            generation: Some(generation),
            policy_highwater: Some(policy_highwater),
            filter_generation: Some(filter_generation),
            management: Some(management),
        },
        saved_at: prior.saved_at,
    };
    validate_current(&envelope)?;
    Ok(Converted {
        envelope,
        source_schema,
        source_config_version,
    })
}

impl Converted {
    /// Serialize and prove the exact bytes round-trip through the strict
    /// current types before either check or apply reports success.
    pub fn to_bytes(&self) -> Result<Vec<u8>, ConvertError> {
        validate_current(&self.envelope)?;
        let bytes = serde_json::to_vec(&self.envelope)
            .map_err(|_| ConvertError::new("converted bundle cannot be serialized"))?;
        if bytes.len() as u64 > MAX_FILTER_BUNDLE_BYTES {
            return Err(ConvertError::new("converted bundle exceeds the byte limit"));
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ConvertError::new("converted bundle is not valid JSON"))?;
        check_exact_keys(&value, ENVELOPE_KEYS)?;
        let roundtrip: TypedSnapshot<Bundle> = serde_json::from_slice(&bytes)
            .map_err(|_| ConvertError::new("converted bundle is not a strict current shape"))?;
        validate_current(&roundtrip)?;
        Ok(bytes)
    }
}

fn read_bundle(path: &Path) -> Result<Vec<u8>, ConvertError> {
    read_private_file(path, MAX_FILTER_BUNDLE_BYTES as usize)
        .map_err(|error| ConvertError::new(format!("bundle cannot be read: {error}")))
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak")
}

/// Read-only dry run. Never creates, replaces or removes any file.
pub fn check_file(path: &Path) -> Result<Converted, ConvertError> {
    let original = read_bundle(path)?;
    let converted = convert_bytes(&original)?;
    let _ = converted.to_bytes()?;
    Ok(converted)
}

/// Explicit apply. All parsing, digest validation and strict checks finish
/// before any write. The original bytes are retained in a sibling backup and
/// the target is replaced by an fsynced same-directory 0600 atomic rename.
pub fn apply_file(path: &Path) -> Result<Converted, ConvertError> {
    let original = read_bundle(path)?;
    let converted = convert_bytes(&original)?;
    let updated = converted.to_bytes()?;
    let backup = backup_path(path);
    match fs::symlink_metadata(&backup) {
        Ok(_) => {
            return Err(ConvertError::new(
                "a prior backup already exists; refusing to overwrite it",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ConvertError::new("backup path cannot be inspected")),
    }
    write_private_atomic(&backup, &original)
        .map_err(|error| ConvertError::new(format!("backup write failed: {error}")))?;
    write_private_atomic(path, &updated)
        .map_err(|error| ConvertError::new(format!("converted bundle write failed: {error}")))?;
    Ok(converted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOUSEHOLD: &str = "11111111-1111-4111-8111-111111111111";
    const PUBLISHED: &str = "2026-01-01T00:00:00Z";

    fn published() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(PUBLISHED)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// Synthetic prior-shape fixtures are built from the exact old structs,
    /// never copied from a real bundle or a host config. The local cache and
    /// deny values are deliberately non-default.
    fn sample_config() -> Config {
        let raw = serde_json::json!({
            "household_id": HOUSEHOLD,
            "policy_revision": 4,
            "policy_published_at": PUBLISHED,
            "cache": {
                "enabled": false,
                "max_entries": 777,
                "positive_min_ttl_secs": 10,
                "positive_max_ttl_secs": 20
            },
            "deny": { "mode": "sinkhole", "ipv4": "192.0.2.1", "ttl": 30 }
        });
        Config::parse(&serde_json::to_vec(&raw).unwrap()).unwrap()
    }

    fn prior_state(
        config: &Config,
        schema_version: i32,
        runtime: Option<RuntimeSettingsDto>,
    ) -> PriorManagementState {
        let _ = config;
        let base = PriorConfig {
            sources: Vec::new(),
            catalog: None,
            selected_services: Vec::new(),
        };
        let value = if schema_version == 1 {
            digest(&serde_json::to_vec(&base).unwrap())
        } else {
            digest(
                &canonical_bytes(&ManagementConfig {
                    sources: base.sources.clone(),
                    catalog: base.catalog.clone(),
                    selected_services: base.selected_services.clone(),
                    runtime: runtime.clone().unwrap(),
                })
                .unwrap(),
            )
        };
        PriorManagementState {
            config_version: 7,
            digest: value,
            config: base,
            filter_identity: "fixture".to_owned(),
            receipts: vec![RefreshAckDto {
                source_id: "src".to_owned(),
                refresh_seq: 1,
                config_version: 7,
            }],
            receipt_expiry: BTreeMap::new(),
            schema_version,
            runtime,
            applied_at: Some(published()),
            last_error: None,
        }
    }

    fn prior_envelope(
        config: &Config,
        management: PriorManagementState,
        filter: Option<FilterMaterial>,
    ) -> PriorEnvelope {
        let generation = 12u64;
        TypedSnapshot {
            schema: SNAPSHOT_SCHEMA,
            household_id: HouseholdId::from_str(HOUSEHOLD).unwrap(),
            worker_id: "fixture-worker".to_owned(),
            highwater: generation,
            policy: PriorBundle {
                config: config.clone(),
                policy: config.policy_at(published()),
                filter: filter.clone(),
                generation: Some(generation),
                policy_highwater: Some(config.policy_revision),
                filter_generation: Some(if filter.is_some() { 1 } else { 0 }),
                management: Some(management),
            },
            saved_at: published(),
        }
    }

    fn assert_strict_roundtrip(bytes: &[u8]) {
        let value: Value = serde_json::from_slice(bytes).unwrap();
        check_exact_keys(&value, ENVELOPE_KEYS).unwrap();
        let envelope: TypedSnapshot<Bundle> = serde_json::from_slice(bytes).unwrap();
        envelope.policy.check().unwrap();
        BundleValidator.validate(&envelope.policy).unwrap();
        let management = envelope.policy.management.as_ref().unwrap();
        assert!(management.config.runtime.cache.max_entries > 0);
        assert_eq!(
            value["policy"]["management"]["config"]["runtime"]["cache"]["max_entries"],
            json!(management.config.runtime.cache.max_entries)
        );
    }

    #[test]
    fn schema1_preserves_actual_local_runtime_and_applied_digest() {
        let config = sample_config();
        let state = prior_state(&config, 1, None);
        let expected_digest = state.digest.clone();
        let bytes = serde_json::to_vec(&prior_envelope(&config, state, None)).unwrap();

        let converted = convert_bytes(&bytes).unwrap();
        assert_eq!(converted.source_schema, 1);
        let applied = converted.envelope.policy.management.as_ref().unwrap();
        assert_eq!(applied.digest, expected_digest);
        assert_eq!(applied.config_version, 7);
        assert_eq!(applied.applied_at, Some(published()));
        assert_eq!(applied.receipts.len(), 1);
        assert_eq!(applied.config.runtime.cache.max_entries, 777);
        assert!(!applied.config.runtime.cache.enabled);
        assert_eq!(applied.config.runtime.cache.positive_min_ttl_secs, Some(10));
        assert_eq!(applied.config.runtime.cache.positive_max_ttl_secs, Some(20));
        assert_eq!(applied.config.runtime.cache.negative_min_ttl_secs, None);
        assert_eq!(
            applied.config.runtime.deny,
            DenySettingsDto::Sinkhole {
                ipv4: Some("192.0.2.1".to_owned()),
                ipv6: None,
                ttl_secs: 30,
            }
        );
        assert_ne!(applied.config.runtime.cache.max_entries, 4096);
        assert_eq!(converted.envelope.highwater, 12);
        assert_eq!(converted.envelope.policy.generation, Some(12));
        assert_eq!(converted.envelope.policy.filter_generation, Some(0));

        let output = converted.to_bytes().unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert!(value["policy"]["management"]
            .get("schema_version")
            .is_none());
        assert!(value["policy"]["management"].get("runtime").is_none());
        assert!(value["policy"]["management"]["config"]
            .get("runtime")
            .is_some());
        assert_strict_roundtrip(&output);
    }

    #[test]
    fn schema2_managed_runtime_is_preserved_exactly() {
        let config = sample_config();
        let runtime = RuntimeSettingsDto {
            cache: CacheSettingsDto {
                enabled: true,
                max_entries: 9000,
                positive_min_ttl_secs: Some(15),
                positive_max_ttl_secs: Some(60),
                negative_min_ttl_secs: None,
                negative_max_ttl_secs: None,
            },
            deny: DenySettingsDto::Refused,
        };
        let state = prior_state(&config, 2, Some(runtime.clone()));
        let expected_digest = state.digest.clone();
        let bytes = serde_json::to_vec(&prior_envelope(
            &config,
            state,
            Some(FilterMaterial::default()),
        ))
        .unwrap();

        let converted = convert_bytes(&bytes).unwrap();
        assert_eq!(converted.source_schema, 2);
        let applied = converted.envelope.policy.management.as_ref().unwrap();
        assert_eq!(applied.config.runtime, runtime);
        assert_eq!(applied.digest, expected_digest);
        assert_eq!(converted.envelope.policy.filter_generation, Some(1));
        assert!(converted.envelope.policy.filter.is_some());
        assert_strict_roundtrip(&converted.to_bytes().unwrap());
    }

    #[test]
    fn corrupted_and_unsupported_inputs_are_rejected() {
        let config = sample_config();
        let bytes = serde_json::to_vec(&prior_envelope(
            &config,
            prior_state(&config, 1, None),
            None,
        ))
        .unwrap();

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["policy"]["management"]["digest"] = json!("0".repeat(64));
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["future_field"] = json!(1);
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["policy"]["generation"] = Value::Null;
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["policy"]["management"]["schema_version"] = json!(3);
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["policy"]["management"]["runtime"] = json!({
            "cache": { "enabled": true, "max_entries": 4096 },
            "deny": { "mode": "nxdomain" }
        });
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["policy"]["management"]["future_field"] = json!(1);
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        let mut bad: Value = serde_json::from_slice(&bytes).unwrap();
        bad["highwater"] = json!(11);
        assert!(convert_bytes(&serde_json::to_vec(&bad).unwrap()).is_err());

        // An already-current bundle is not prior input and is refused.
        let converted = convert_bytes(&bytes).unwrap();
        assert!(convert_bytes(&converted.to_bytes().unwrap()).is_err());
    }

    fn temp_dir() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("dns-bundle-convert-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn check_is_read_only_and_apply_keeps_a_private_backup() {
        let dir = temp_dir();
        let path = dir.join("state.json");
        let backup = backup_path(&path);
        let config = sample_config();
        let original = serde_json::to_vec(&prior_envelope(
            &config,
            prior_state(&config, 1, None),
            None,
        ))
        .unwrap();
        write_private_atomic(&path, &original).unwrap();

        check_file(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!backup.exists());

        apply_file(&path).unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        let applied = fs::read(&path).unwrap();
        assert_ne!(applied, original);
        assert_strict_roundtrip(&applied);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_apply_leaves_the_source_untouched() {
        let dir = temp_dir();
        let path = dir.join("state.json");
        let config = sample_config();
        let mut bad: Value = serde_json::from_slice(
            &serde_json::to_vec(&prior_envelope(
                &config,
                prior_state(&config, 1, None),
                None,
            ))
            .unwrap(),
        )
        .unwrap();
        bad["policy"]["management"]["digest"] = json!("f".repeat(64));
        let bytes = serde_json::to_vec(&bad).unwrap();
        write_private_atomic(&path, &bytes).unwrap();

        assert!(apply_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(!backup_path(&path).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
