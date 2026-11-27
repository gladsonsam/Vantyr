//! Worker-side mirror of the Stage A DNS-management wire contract.
//!
//! Field order mirrors the server DTOs exactly because the server-owned
//! `body_sha256` is a digest of canonical serde bytes. Unknown fields are
//! rejected so a newer server cannot silently change the shape.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const CONFIG_SCHEMA_VERSION: i32 = 1;
/// Additive v2: v1 fields plus explicitly supported runtime settings. Old v1
/// workers reject the `config_v2` envelope field honestly; this worker accepts
/// both versions and never coerces a v1 body into v2 bytes.
pub const CONFIG_SCHEMA_VERSION_V2: i32 = 2;
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;
pub const MAX_CACHE_ENTRIES: u64 = 65_536;
pub const MAX_TTL_SECS: u32 = 86_400;
pub const MAX_IP_LEN: usize = 45;

fn default_true() -> bool {
    true
}
fn default_cache_entries() -> u64 {
    4096
}
fn default_sinkhole_ttl() -> u32 {
    60
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFormatDto {
    Hosts,
    Abp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMetadataDto {
    pub title: String,
    pub publisher: String,
    pub license: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionSourceDto {
    pub id: String,
    pub url: String,
    pub format: ListFormatDto,
    pub enabled: bool,
    #[serde(default)]
    pub interval_secs: Option<u64>,
    #[serde(default)]
    pub max_stale_secs: Option<u64>,
    pub metadata: SourceMetadataDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceDomainDto {
    Exact { value: String },
    Suffix { value: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceDto {
    pub id: String,
    pub label: String,
    pub version: String,
    pub domains: Vec<ServiceDomainDto>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceCatalogDto {
    pub version: String,
    #[serde(default)]
    pub services: Vec<ServiceDto>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementConfig {
    #[serde(default)]
    pub sources: Vec<SubscriptionSourceDto>,
    #[serde(default)]
    pub catalog: Option<ServiceCatalogDto>,
    #[serde(default)]
    pub selected_services: Vec<String>,
}

/// Bounded cache controls mirrored from the server DTO and mapped onto the
/// accepted local `CacheConfig` only for these fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CacheSettingsDto {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_cache_entries")]
    pub max_entries: u64,
    #[serde(default)]
    pub positive_min_ttl_secs: Option<u32>,
    #[serde(default)]
    pub positive_max_ttl_secs: Option<u32>,
    #[serde(default)]
    pub negative_min_ttl_secs: Option<u32>,
    #[serde(default)]
    pub negative_max_ttl_secs: Option<u32>,
}

impl Default for CacheSettingsDto {
    fn default() -> Self {
        Self {
            enabled: true,
            max_entries: 4096,
            positive_min_ttl_secs: None,
            positive_max_ttl_secs: None,
            negative_min_ttl_secs: None,
            negative_max_ttl_secs: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum DenySettingsDto {
    #[default]
    Nxdomain,
    Refused,
    Sinkhole {
        #[serde(default)]
        ipv4: Option<String>,
        #[serde(default)]
        ipv6: Option<String>,
        #[serde(default = "default_sinkhole_ttl")]
        ttl_secs: u32,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettingsDto {
    #[serde(default)]
    pub cache: CacheSettingsDto,
    #[serde(default)]
    pub deny: DenySettingsDto,
}

/// v2 desired config: same v1 field order plus one `runtime` object.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementConfigV2 {
    #[serde(default)]
    pub sources: Vec<SubscriptionSourceDto>,
    #[serde(default)]
    pub catalog: Option<ServiceCatalogDto>,
    #[serde(default)]
    pub selected_services: Vec<String>,
    #[serde(default)]
    pub runtime: RuntimeSettingsDto,
}

impl ManagementConfigV2 {
    pub fn base(&self) -> ManagementConfig {
        ManagementConfig {
            sources: self.sources.clone(),
            catalog: self.catalog.clone(),
            selected_services: self.selected_services.clone(),
        }
    }
}

/// One desired config value, selected strictly by `schema_version`.
#[derive(Clone, Debug)]
pub enum DesiredConfig {
    V1(ManagementConfig),
    V2(ManagementConfigV2),
}

impl DesiredConfig {
    pub fn sources(&self) -> &[SubscriptionSourceDto] {
        match self {
            Self::V1(config) => &config.sources,
            Self::V2(config) => &config.sources,
        }
    }
    pub fn runtime(&self) -> Option<&RuntimeSettingsDto> {
        match self {
            Self::V1(_) => None,
            Self::V2(config) => Some(&config.runtime),
        }
    }
    pub fn digest(&self) -> String {
        match self {
            Self::V1(config) => digest(&canonical_bytes(config).expect("config serializes")),
            Self::V2(config) => digest(&canonical_bytes_v2(config).expect("config serializes")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    NeverFetched,
    Fresh,
    Stale,
    Disabled,
    FailedWithLastGood,
    Unavailable,
    Quarantined,
}

impl DownloadState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NeverFetched => "never_fetched",
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Disabled => "disabled",
            Self::FailedWithLastGood => "failed_with_last_good",
            Self::Unavailable => "unavailable",
            Self::Quarantined => "quarantined",
        }
    }
}

impl std::str::FromStr for DownloadState {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "never_fetched" => Ok(Self::NeverFetched),
            "fresh" => Ok(Self::Fresh),
            "stale" => Ok(Self::Stale),
            "disabled" => Ok(Self::Disabled),
            "failed_with_last_good" => Ok(Self::FailedWithLastGood),
            "unavailable" => Ok(Self::Unavailable),
            "quarantined" => Ok(Self::Quarantined),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedStatusDto {
    pub config_version: u64,
    pub generation: u64,
    pub filter_generation: u64,
    pub filter_identity: String,
    #[serde(default)]
    pub applied_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceStatusDto {
    pub id: String,
    pub download: DownloadState,
    #[serde(default)]
    pub checked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub fetched_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub content_changed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub next_due_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub failure_count: u64,
    #[serde(default)]
    pub cooldown_until: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub bytes: u64,
    #[serde(default)]
    pub rule_count: Option<u64>,
    #[serde(default)]
    pub downloaded_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshAckDto {
    pub source_id: String,
    pub refresh_seq: u64,
    pub config_version: u64,
}

/// Truthful cache-clear ack: `cleared_at` is the worker clock at the actual
/// `clear_cache()` call. No entries count and no generation claim.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClearAckDto {
    pub clear_seq: u64,
    pub config_version: u64,
    pub cleared_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerReadBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingRefreshView {
    pub source_id: String,
    pub refresh_seq: u64,
    pub config_version: u64,
    /// Server-owned expiry; an expired or future-version token is ignored.
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PendingCacheClearView {
    pub clear_seq: u64,
    pub config_version: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerReadResponse {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub config_version: u64,
    pub schema_version: Option<i32>,
    pub body_sha256: Option<String>,
    pub config: Option<ManagementConfig>,
    /// Additive v2 config; omitted on a v1 read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_v2: Option<ManagementConfigV2>,
    #[serde(default)]
    pub pending_refreshes: Vec<PendingRefreshView>,
    /// Additive v2 cache-clear command.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_cache_clear: Vec<PendingCacheClearView>,
    pub server_time: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerStatusBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub report_id: Uuid,
    pub config_version: u64,
    pub body_sha256: String,
    pub reported_at: DateTime<Utc>,
    /// `null` is truthful when desired config exists but nothing was applied.
    #[serde(default)]
    pub applied: Option<AppliedStatusDto>,
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub refresh_ack: Vec<RefreshAckDto>,
    /// Additive v2; empty and omitted for a v1-only report.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clear_ack: Vec<ClearAckDto>,
}

/// Canonical bytes and digest, matching the server's ordered struct layout.
pub fn canonical_bytes(config: &ManagementConfig) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(config)
}

/// Canonical v2 bytes, matching the server's ordered struct layout exactly.
pub fn canonical_bytes_v2(config: &ManagementConfigV2) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(config)
}

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn is_digest(raw: &str) -> bool {
    raw.len() == 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const READ: &str = include_str!("../../../tests/network-contracts/dns-management-v1/read.json");
    const REPORT: &str =
        include_str!("../../../tests/network-contracts/dns-management-v1/report.json");

    #[test]
    fn shared_read_fixture_parses_verifies_digest_and_roundtrips() {
        let expected: Value = serde_json::from_str(READ).unwrap();
        let response: WorkerReadResponse = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(response.config_version, 1);
        assert_eq!(
            response.pending_refreshes[0].expires_at,
            DateTime::parse_from_rfc3339("2026-11-26T12:10:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
        let config = response.config.as_ref().unwrap();
        assert_eq!(
            digest(&canonical_bytes(config).unwrap()),
            response.body_sha256.as_deref().unwrap()
        );
        assert_eq!(serde_json::to_value(&response).unwrap(), expected);
    }

    #[test]
    fn shared_report_fixture_parses_and_roundtrips() {
        let expected: Value = serde_json::from_str(REPORT).unwrap();
        let report: WorkerStatusBody = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(report.refresh_ack.len(), 1);
        assert_eq!(report.applied.as_ref().unwrap().generation, 5);
        assert_eq!(serde_json::to_value(&report).unwrap(), expected);
    }

    #[test]
    fn strict_schema_rejects_missing_expiry_and_unknown_fields() {
        let mut value: Value = serde_json::from_str(READ).unwrap();
        value["pending_refreshes"][0]
            .as_object_mut()
            .unwrap()
            .remove("expires_at");
        assert!(serde_json::from_value::<WorkerReadResponse>(value).is_err());

        let mut value: Value = serde_json::from_str(REPORT).unwrap();
        value["future_field"] = json!(1);
        assert!(serde_json::from_value::<WorkerStatusBody>(value).is_err());
    }

    /// Same bytes and expected SHA as the Stage A canonical fixture.
    #[test]
    fn golden_fixture_matches_stage_a_digest() {
        let raw = r#"{"sources":[{"id":"a_list","url":"https://raw.githubusercontent.com/o/r/main/hosts.txt","format":"hosts","enabled":true,"interval_secs":3600,"max_stale_secs":null,"metadata":{"title":"List","publisher":"Publisher","license":"MIT"}},{"id":"z_list","url":"https://raw.githubusercontent.com/o/r/main/hosts.txt","format":"abp","enabled":true,"interval_secs":null,"max_stale_secs":null,"metadata":{"title":"List","publisher":"Publisher","license":"MIT"}}],"catalog":{"version":"operator-2026-11","services":[{"id":"a_service","label":"Service","version":"1","domains":[{"type":"suffix","value":"example.test"}],"source":null,"evidence":null,"license":"operator-declared"},{"id":"z_service","label":"Service","version":"1","domains":[{"type":"suffix","value":"example.test"}],"source":null,"evidence":null,"license":"operator-declared"}]},"selected_services":["a_service","z_service"]}"#;
        let config: ManagementConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(
            digest(&canonical_bytes(&config).unwrap()),
            "820a75626ccf71e9a30529b381dc7dd2dd5abc9209446c850b129acc2a2ea93e"
        );
    }

    const READ_V2: &str =
        include_str!("../../../tests/network-contracts/dns-management-v2/read.json");
    const REPORT_V2: &str =
        include_str!("../../../tests/network-contracts/dns-management-v2/report.json");

    #[test]
    fn shared_v2_read_fixture_parses_verifies_digest_and_roundtrips() {
        let expected: Value = serde_json::from_str(READ_V2).unwrap();
        let response: WorkerReadResponse = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(response.schema_version, Some(CONFIG_SCHEMA_VERSION_V2));
        assert!(response.config.is_none());
        let config = response.config_v2.as_ref().unwrap();
        assert_eq!(
            digest(&canonical_bytes_v2(config).unwrap()),
            response.body_sha256.as_deref().unwrap()
        );
        assert_eq!(response.pending_cache_clear.len(), 1);
        assert_eq!(serde_json::to_value(response).unwrap(), expected);
    }

    #[test]
    fn shared_v2_report_fixture_parses_and_roundtrips() {
        let expected: Value = serde_json::from_str(REPORT_V2).unwrap();
        let report: WorkerStatusBody = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(report.clear_ack.len(), 1);
        assert_eq!(serde_json::to_value(report).unwrap(), expected);
    }

    #[test]
    fn v1_parser_rejects_v2_body_and_v2_fields_are_unsupported() {
        let v2: Value = serde_json::from_str(READ_V2).unwrap();
        // A frozen v1 worker's strict parser cannot accept the additive body;
        // the read verifier then fails honestly without mutating last-known-good.
        assert!(serde_json::from_value::<ManagementConfig>(v2["config_v2"].clone()).is_err());
        let mut bad = v2["config_v2"].clone();
        bad["runtime"]["cache"]["serve_expired"] = json!(true);
        assert!(serde_json::from_value::<ManagementConfigV2>(bad).is_err());
    }

    #[test]
    fn v2_golden_digest_matches_server_fixture() {
        let v2: Value = serde_json::from_str(READ_V2).unwrap();
        let config: ManagementConfigV2 = serde_json::from_value(v2["config_v2"].clone()).unwrap();
        assert_eq!(
            digest(&canonical_bytes_v2(&config).unwrap()),
            "4652ce3244e14658db02de0c05520507d0d92619a434a6a455a8309f5dbb6d37"
        );
    }
}
