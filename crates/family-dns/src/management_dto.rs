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
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024;

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
pub struct WorkerReadResponse {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub config_version: u64,
    pub schema_version: Option<i32>,
    pub body_sha256: Option<String>,
    pub config: Option<ManagementConfig>,
    #[serde(default)]
    pub pending_refreshes: Vec<PendingRefreshView>,
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
}

/// Canonical bytes and digest, matching the server's ordered struct layout.
pub fn canonical_bytes(config: &ManagementConfig) -> Result<Vec<u8>, serde_json::Error> {
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
}
