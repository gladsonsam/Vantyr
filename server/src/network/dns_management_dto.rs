//! Typed shapes and strict validation for bounded DNS management.
//!
//! Everything a caller may send is listed here and every struct rejects
//! unknown fields. No request can set a household id, config version, digest
//! or timestamp: those are server-owned. The server validates URL *syntax*
//! only; it never resolves or fetches a URL. Provenance strings are operator
//! declarations, never a claim of a curated catalogue or licence compliance.

use std::net::IpAddr;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

/// Only this shape version is stored or served.
pub const CONFIG_SCHEMA_VERSION: i32 = 1;
/// Canonical config bytes cap (16 KiB), mirrored in migration 0079.
pub const MAX_CONFIG_BYTES: usize = 16 * 1024;
/// Admin PATCH / worker report body cap (32 KiB), applied as an axum layer.
pub const MAX_REQUEST_BYTES: usize = 32 * 1024;

pub const MAX_SOURCES: usize = 32;
pub const MAX_SOURCE_ID_LEN: usize = 64;
pub const MAX_URL_LEN: usize = 512;
pub const MAX_TEXT_LEN: usize = 256;
pub const MAX_FIELD_LEN: usize = 200;
pub const MAX_DOMAIN_LEN: usize = 253;
pub const MAX_SERVICES: usize = 64;
pub const MAX_SERVICE_DOMAINS: usize = 512;
pub const MIN_INTERVAL_SECS: u64 = 300;
pub const MAX_INTERVAL_SECS: u64 = 7 * 24 * 60 * 60;
pub const MIN_STALE_SECS: u64 = 60 * 60;
pub const MAX_STALE_SECS: u64 = 7 * 24 * 60 * 60;
pub const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_RULE_COUNT: u64 = 1_000_000;
pub const MAX_ERROR_LEN: usize = 200;
/// Keep the newest 16 deliveries per gateway plus fixed pins.
pub const DELIVERY_HISTORY: usize = 16;
pub const REFRESH_COOLDOWN_SECS: i64 = 60;
pub const REFRESH_TTL_SECS: i64 = 10 * 60;
/// A reported timestamp may be this old / this far ahead of the server clock.
pub const MAX_REPORT_AGE: ChronoDuration = ChronoDuration::minutes(5);
pub const MAX_FUTURE_SKEW: ChronoDuration = ChronoDuration::seconds(60);
// Historical content/apply times describe original age, not report freshness.
// Scheduling timestamps may span the accepted seven-day interval/backoff cap.
pub const MAX_SCHEDULE_FUTURE: ChronoDuration = ChronoDuration::days(7);

fn bad(message: &'static str) -> ApiError {
    ApiError::bad_request(message)
}

/// A present nullable PATCH field is `Some`: JSON null clears, omission keeps.
/// Mirrors the accepted inventory adapter without a new dependency.
fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// ─── Desired configuration ──────────────────────────────────────────────────

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
    /// Operator-declared licence identifier or URL. Never compliance-verified.
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
    /// Operator-declared licence. Never compliance-verified.
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

/// Exactly the settings the server is allowed to manage. Local socket, trust
/// (CA), upstream, cache path and local-file list settings are deliberately
/// absent: they stay with the worker's local configuration.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementConfig {
    #[serde(default)]
    pub sources: Vec<SubscriptionSourceDto>,
    /// An operator-declared catalogue. Absent is honest when no services are
    /// selected; the server never substitutes a bundled or fabricated feed.
    #[serde(default)]
    pub catalog: Option<ServiceCatalogDto>,
    #[serde(default)]
    pub selected_services: Vec<String>,
}

// ─── Admin mutation ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchBody {
    /// Server-owned monotonic version. 0 creates the first config; otherwise
    /// it must match the stored version exactly (CAS).
    pub expected_config_version: u64,
    pub operations: Vec<PatchOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum PatchOperation {
    AddList { source: SubscriptionSourceDto },
    RemoveList { id: String },
    SetList { id: String, patch: SourcePatchDto },
    SetCatalog { catalog: ServiceCatalogDto },
    SelectServices { ids: Vec<String> },
}

impl PatchOperation {
    pub fn name(&self) -> &'static str {
        match self {
            Self::AddList { .. } => "add_list",
            Self::RemoveList { .. } => "remove_list",
            Self::SetList { .. } => "set_list",
            Self::SetCatalog { .. } => "set_catalog",
            Self::SelectServices { .. } => "select_services",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePatchDto {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub format: Option<ListFormatDto>,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// Absent = keep; explicit null = clear; value = set.
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub interval_secs: Option<Option<u64>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub max_stale_secs: Option<Option<u64>>,
    #[serde(default)]
    pub metadata: Option<SourceMetadataDto>,
}

// ─── Worker requests ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerReadBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
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
    /// SHA-256 of the worker's cached bytes. Never a raw ETag or URL.
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerStatusBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    /// Worker-generated idempotency id for this one report.
    pub report_id: Uuid,
    pub config_version: u64,
    pub body_sha256: String,
    pub reported_at: DateTime<Utc>,
    /// `null` is truthful when the worker has the desired config but has not
    /// applied any management version yet (e.g. a failed download/compile).
    #[serde(default)]
    pub applied: Option<AppliedStatusDto>,
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub refresh_ack: Vec<RefreshAckDto>,
}

// ─── Responses ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SupportedView {
    pub scheduled_fetch: bool,
    pub manual_refresh: bool,
    pub service_blocking: &'static str,
    /// Accepted worker support requires explicit operator opt-in. This says
    /// nothing about installation, application or verification on a gateway.
    pub worker_consumer: &'static str,
    pub safe_search: bool,
    pub statistics: bool,
    pub serve_stale: bool,
    pub cache_ttl_controls: bool,
    pub rate_limit: bool,
    pub retention_controls: bool,
    pub verified: bool,
}

impl Default for SupportedView {
    fn default() -> Self {
        Self {
            scheduled_fetch: true,
            manual_refresh: true,
            service_blocking: "dns_domains",
            worker_consumer: "opt_in",
            safe_search: false,
            statistics: false,
            serve_stale: false,
            cache_ttl_controls: false,
            rate_limit: false,
            retention_controls: false,
            verified: false,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DesiredView {
    pub config_version: u64,
    pub schema_version: i32,
    pub body_sha256: String,
    pub config: ManagementConfig,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub updated_by: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct DeliveryView {
    pub gateway_id: Uuid,
    pub delivered_version: Option<u64>,
    pub delivered_sha256: Option<String>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub reported_version: Option<u64>,
    pub reported_sha256: Option<String>,
    pub reported_at: Option<DateTime<Utc>>,
    pub status_received_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct ManagementView {
    pub desired: Option<DesiredView>,
    pub delivery: Vec<DeliveryView>,
    pub supported: SupportedView,
}

#[derive(Debug, Serialize)]
pub struct PatchResult {
    pub changed: bool,
    #[serde(flatten)]
    pub view: ManagementView,
}

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub source_id: String,
    pub refresh_seq: u64,
    pub config_version: u64,
    pub expires_at: DateTime<Utc>,
    pub created: bool,
    pub cooldown_secs: i64,
}

#[derive(Debug, Serialize)]
pub struct PendingRefreshView {
    pub source_id: String,
    pub refresh_seq: u64,
    pub config_version: u64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct WorkerReadResponse {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: &'static str,
    pub config_version: u64,
    pub schema_version: Option<i32>,
    pub body_sha256: Option<String>,
    pub config: Option<ManagementConfig>,
    pub pending_refreshes: Vec<PendingRefreshView>,
    pub server_time: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct AppliedView {
    pub config_version: u64,
    pub body_sha256: String,
    pub generation: u64,
    pub filter_generation: u64,
    pub filter_identity: String,
    pub applied_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReportedStatusView {
    pub config_version: u64,
    pub body_sha256: String,
    pub report_id: Uuid,
    pub reported_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
    /// Null when the worker has not applied any management version.
    pub applied: Option<AppliedView>,
    pub sources: Vec<SourceStatusDto>,
}

#[derive(Debug, Serialize)]
pub struct GatewayStatusView {
    pub gateway_id: Uuid,
    pub delivered_version: Option<u64>,
    pub reported_version: Option<u64>,
    pub status: Option<ReportedStatusView>,
}

#[derive(Debug, Serialize)]
pub struct StatusView {
    pub desired_version: Option<u64>,
    pub gateways: Vec<GatewayStatusView>,
}

// ─── Validation ─────────────────────────────────────────────────────────────

pub fn validate_source_id(raw: &str) -> ApiResult<()> {
    if raw.is_empty()
        || raw.len() > MAX_SOURCE_ID_LEN
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(bad("source id must be 1..=64 chars of [A-Za-z0-9_-]"));
    }
    Ok(())
}

pub fn validate_domain(raw: &str) -> ApiResult<()> {
    if raw.is_empty()
        || raw.len() > MAX_DOMAIN_LEN
        || raw.starts_with('.')
        || raw.ends_with('.')
        || raw.contains('*')
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("domain must be a bounded, wildcard-free hostname"));
    }
    for label in raw.split('.') {
        if label.is_empty()
            || label.len() > 63
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || label.starts_with('-')
            || label.ends_with('-')
        {
            return Err(bad("domain contains an invalid label"));
        }
    }
    Ok(())
}

/// Conservative public-address check for literal hosts. Hostnames are not
/// resolved here: the worker's vetted resolver enforces this at fetch time.
pub fn is_public_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(o[0] == 0
                || o[0] == 10
                || o[0] == 127
                || o[0] >= 224
                || o[0] == 169 && o[1] == 254
                || o[0] == 172 && (16..=31).contains(&o[1])
                || o[0] == 192 && o[1] == 168
                || o[0] == 100 && (64..=127).contains(&o[1])
                || o[0] == 192 && o[1] == 0 && o[2] == 0
                || o[0] == 192 && o[1] == 0 && o[2] == 2
                || o[0] == 198 && (18..=19).contains(&o[1])
                || o[0] == 198 && o[1] == 51 && o[2] == 100
                || o[0] == 203 && o[1] == 0 && o[2] == 113)
        }
        IpAddr::V6(v6) => {
            if v6.is_unspecified() || v6.is_loopback() || v6.is_multicast() {
                return false;
            }
            let s = v6.segments();
            // unique-local, link-local, documentation prefix.
            !(s[0] & 0xfe00 == 0xfc00
                || s[0] & 0xffc0 == 0xfe80
                || s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}

/// Mirrors the worker's `ValidatedUrl::parse` under `QueryPolicy::Reject`.
/// Syntax only: no DNS lookup, no socket, no redirect.
pub fn validate_source_url(raw: &str) -> ApiResult<()> {
    if raw.is_empty()
        || raw.len() > MAX_URL_LEN
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("source url is empty, unbounded or malformed"));
    }
    let url = Url::parse(raw).map_err(|_| bad("source url is not a valid URL"))?;
    if url.scheme() != "https" {
        return Err(bad("only https:// source urls are allowed"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("userinfo in a source url is never allowed"));
    }
    if url.fragment().is_some() || url.query().is_some() {
        return Err(bad("source urls must not carry a query or fragment"));
    }
    let host = match url.host() {
        Some(Host::Domain(d)) => {
            validate_domain(d)?;
            d.to_ascii_lowercase()
        }
        Some(Host::Ipv4(ip)) if is_public_global(IpAddr::V4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) if is_public_global(IpAddr::V6(ip)) => ip.to_string(),
        _ => return Err(bad("source url host is not a public global address")),
    };
    // github.com serves an HTML viewer; parsing it as a list is dishonest.
    if host == "github.com" {
        return Err(bad(
            "github.com is an HTML viewer; use a raw.githubusercontent.com file url",
        ));
    }
    if host == "raw.githubusercontent.com" {
        let segments: Vec<&str> = url.path().split('/').filter(|p| !p.is_empty()).collect();
        if segments.len() < 4 {
            return Err(bad(
                "raw.githubusercontent.com urls must be /owner/repo/ref/path",
            ));
        }
    }
    Ok(())
}

fn validate_text(raw: &str, what: &'static str, max: usize) -> ApiResult<()> {
    if raw.trim().is_empty() || raw.len() > max || raw.chars().any(|c| c.is_control()) {
        return Err(bad(what));
    }
    Ok(())
}

fn validate_intervals(source: &SubscriptionSourceDto) -> ApiResult<()> {
    if let Some(interval) = source.interval_secs {
        if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&interval) {
            return Err(bad("interval_secs is outside 300..=604800"));
        }
    }
    if let Some(stale) = source.max_stale_secs {
        if !(MIN_STALE_SECS..=MAX_STALE_SECS).contains(&stale) {
            return Err(bad("max_stale_secs is outside 3600..=604800"));
        }
    }
    Ok(())
}

fn validate_source(source: &SubscriptionSourceDto) -> ApiResult<()> {
    validate_source_id(&source.id)?;
    validate_source_url(&source.url)?;
    validate_intervals(source)?;
    validate_text(
        &source.metadata.title,
        "source title is empty or unbounded",
        MAX_TEXT_LEN,
    )?;
    validate_text(
        &source.metadata.publisher,
        "source publisher is empty or unbounded",
        MAX_TEXT_LEN,
    )?;
    validate_text(
        &source.metadata.license,
        "source license is empty or unbounded",
        MAX_TEXT_LEN,
    )?;
    Ok(())
}

pub fn validate_config(config: &ManagementConfig) -> ApiResult<()> {
    if config.sources.len() > MAX_SOURCES {
        return Err(bad("too many subscription sources"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for source in &config.sources {
        validate_source(source)?;
        if !ids.insert(source.id.as_str()) {
            return Err(bad("duplicate subscription source id"));
        }
    }
    let Some(catalog) = &config.catalog else {
        if !config.selected_services.is_empty() {
            return Err(bad(
                "selected services require an operator-declared catalog",
            ));
        }
        return Ok(());
    };
    if catalog.services.len() > MAX_SERVICES {
        return Err(bad("catalog has more than 64 services"));
    }
    validate_text(
        &catalog.version,
        "catalog version is empty or unbounded",
        MAX_FIELD_LEN,
    )?;
    let mut service_ids = std::collections::BTreeSet::new();
    for service in &catalog.services {
        validate_source_id(&service.id)?;
        validate_text(
            &service.label,
            "service label is empty or unbounded",
            MAX_FIELD_LEN,
        )?;
        validate_text(
            &service.version,
            "service version is empty or unbounded",
            MAX_FIELD_LEN,
        )?;
        for value in [&service.source, &service.evidence, &service.license]
            .into_iter()
            .flatten()
        {
            if value.len() > MAX_FIELD_LEN || value.chars().any(|c| c.is_control()) {
                return Err(bad("service provenance field is unbounded or malformed"));
            }
        }
        if service.domains.is_empty() || service.domains.len() > MAX_SERVICE_DOMAINS {
            return Err(bad("service has 0 or more than 512 domains"));
        }
        for domain in &service.domains {
            let value = match domain {
                ServiceDomainDto::Exact { value } | ServiceDomainDto::Suffix { value } => value,
            };
            validate_domain(value)?;
        }
        if !service_ids.insert(service.id.as_str()) {
            return Err(bad("duplicate service id"));
        }
    }
    if config.selected_services.len() > MAX_SERVICES {
        return Err(bad("too many selected services"));
    }
    let mut selected = std::collections::BTreeSet::new();
    for id in &config.selected_services {
        validate_source_id(id)?;
        if !selected.insert(id.as_str()) {
            return Err(bad("duplicate selected service id"));
        }
        if !service_ids.contains(id.as_str()) {
            return Err(bad("selected service id is not in the catalog"));
        }
    }
    Ok(())
}

/// Deterministic server-owned ordering, so a caller cannot reorder bytes to
/// produce a different digest for the same logical config.
pub fn canonicalize(config: &mut ManagementConfig) {
    config.sources.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(catalog) = &mut config.catalog {
        catalog.services.sort_by(|a, b| a.id.cmp(&b.id));
    }
    config.selected_services.sort();
    config.selected_services.dedup();
}

pub fn canonical_bytes(config: &ManagementConfig) -> ApiResult<Vec<u8>> {
    serde_json::to_vec(config).map_err(|e| ApiError::Internal(e.into()))
}

pub fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn is_digest(raw: &str) -> bool {
    raw.len() == 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Untrusted worker error text: bounded, printable, and never a URL or a
/// credential-looking token. Workers must redact URLs before reporting.
pub fn sanitize_error(raw: Option<&str>) -> ApiResult<Option<String>> {
    let Some(value) = raw else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_ERROR_LEN || trimmed.chars().any(|c| c.is_control()) {
        return Err(bad("error text is unbounded or has control characters"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("://") || lower.contains("bearer ") || lower.contains("token=") {
        return Err(bad("error text must not contain a URL or credential"));
    }
    Ok(Some(trimmed.to_owned()))
}

fn bounded_time(
    value: DateTime<Utc>,
    now: DateTime<Utc>,
    max_age: ChronoDuration,
    max_future: ChronoDuration,
    what: &'static str,
) -> ApiResult<()> {
    if value > now + max_future || value < now - max_age {
        return Err(bad(what));
    }
    Ok(())
}

fn observed_time(
    value: DateTime<Utc>,
    now: DateTime<Utc>,
    future: ChronoDuration,
    what: &'static str,
) -> ApiResult<()> {
    if value < DateTime::<Utc>::UNIX_EPOCH || value > now + future {
        return Err(bad(what));
    }
    Ok(())
}

/// Validate the whole worker status body before any database work. Every
/// timestamp is bounded and every untrusted string is sanitized.
pub fn validate_worker_status(body: &WorkerStatusBody, now: DateTime<Utc>) -> ApiResult<()> {
    if body.config_version == 0 || body.config_version > i64::MAX as u64 {
        return Err(bad("config_version is outside the storage bound"));
    }
    if !is_digest(&body.body_sha256) {
        return Err(bad("body_sha256 must be 64 lowercase hex chars"));
    }
    bounded_time(
        body.reported_at,
        now,
        MAX_REPORT_AGE,
        MAX_FUTURE_SKEW,
        "reported_at is outside the report window",
    )?;
    if let Some(applied) = &body.applied {
        if applied.config_version == 0 || applied.config_version > body.config_version {
            return Err(bad("applied config_version is out of range"));
        }
        if applied.generation > i64::MAX as u64 || applied.filter_generation > i64::MAX as u64 {
            return Err(bad("generation is outside the storage bound"));
        }
        if applied.filter_identity.is_empty()
            || applied.filter_identity.len() > 64
            || applied.filter_identity.chars().any(|c| c.is_control())
        {
            return Err(bad("filter_identity is empty or unbounded"));
        }
        sanitize_error(applied.last_error.as_deref())?;
        if let Some(at) = applied.applied_at {
            observed_time(
                at,
                now,
                MAX_FUTURE_SKEW,
                "applied_at is outside the observation window",
            )?;
        }
    }
    if body.sources.len() > MAX_SOURCES {
        return Err(bad("too many reported sources"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for source in &body.sources {
        validate_source_id(&source.id)?;
        if !ids.insert(source.id.as_str()) {
            return Err(bad("duplicate reported source id"));
        }
        for at in [
            source.checked_at,
            source.fetched_at,
            source.content_changed_at,
        ]
        .into_iter()
        .flatten()
        {
            observed_time(
                at,
                now,
                MAX_FUTURE_SKEW,
                "source timestamp is outside the observation window",
            )?;
        }
        for at in [source.next_due_at, source.cooldown_until]
            .into_iter()
            .flatten()
        {
            observed_time(
                at,
                now,
                MAX_SCHEDULE_FUTURE + MAX_FUTURE_SKEW,
                "schedule timestamp is outside the supported interval/backoff window",
            )?;
        }
        sanitize_error(source.last_error.as_deref())?;
        if source.bytes > MAX_SOURCE_BYTES {
            return Err(bad("reported byte count is unbounded"));
        }
        if source.rule_count.is_some_and(|n| n > MAX_RULE_COUNT) {
            return Err(bad("reported rule count is unbounded"));
        }
        if let Some(digest) = &source.downloaded_sha256 {
            if !is_digest(digest) {
                return Err(bad("downloaded_sha256 must be 64 lowercase hex chars"));
            }
        }
    }
    if body.refresh_ack.len() > MAX_SOURCES {
        return Err(bad("too many refresh acknowledgements"));
    }
    for ack in &body.refresh_ack {
        validate_source_id(&ack.source_id)?;
        if ack.refresh_seq == 0
            || ack.config_version == 0
            || ack.refresh_seq > i64::MAX as u64
            || ack.config_version > i64::MAX as u64
        {
            return Err(bad("refresh ack token is out of range"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_policy_rejects_credentials_queries_private_and_viewer_pages() {
        for raw in [
            "http://example.com/hosts",
            "https://user:pass@example.com/hosts",
            "https://example.com/hosts?token=abc",
            "https://example.com/hosts#frag",
            "https://127.0.0.1/hosts",
            "https://10.0.0.1/hosts",
            "https://[::1]/hosts",
            "https://github.com/o/r/blob/main/hosts",
            "https://raw.githubusercontent.com/o/r",
            "https://example.com/\u{0001}hosts",
        ] {
            assert!(validate_source_url(raw).is_err(), "accepted {raw}");
        }
        assert!(
            validate_source_url("https://raw.githubusercontent.com/o/r/main/hosts.txt").is_ok()
        );
    }

    #[test]
    fn digests_and_error_sanitization_are_bounded() {
        let bytes = b"canonical";
        assert!(is_digest(&digest(bytes)));
        assert!(!is_digest("xyz"));
        assert!(sanitize_error(Some("https://example.com failed")).is_err());
        assert!(sanitize_error(Some("Bearer abc failed")).is_err());
        assert_eq!(
            sanitize_error(Some("  fetch failed  ")).unwrap().as_deref(),
            Some("fetch failed")
        );
    }

    /// Golden fixture for the worker's typed mirror. Field defaults, null
    /// handling and sort order must produce these exact canonical bytes.
    #[test]
    fn golden_canonical_bytes_pin_cross_crate_contract() {
        let source =
            |id: &str, format: ListFormatDto, interval: Option<u64>| SubscriptionSourceDto {
                id: id.into(),
                url: "https://raw.githubusercontent.com/o/r/main/hosts.txt".into(),
                format,
                enabled: true,
                interval_secs: interval,
                max_stale_secs: None,
                metadata: SourceMetadataDto {
                    title: "List".into(),
                    publisher: "Publisher".into(),
                    license: "MIT".into(),
                },
            };
        let service = |id: &str| ServiceDto {
            id: id.into(),
            label: "Service".into(),
            version: "1".into(),
            domains: vec![ServiceDomainDto::Suffix {
                value: "example.test".into(),
            }],
            source: None,
            evidence: None,
            license: Some("operator-declared".into()),
        };
        // Deliberately unsorted; canonicalize must sort sources, services and
        // selected ids and deduplicate the latter.
        let mut config = ManagementConfig {
            sources: vec![
                source("z_list", ListFormatDto::Abp, None),
                source("a_list", ListFormatDto::Hosts, Some(3600)),
            ],
            catalog: Some(ServiceCatalogDto {
                version: "operator-2026-11".into(),
                services: vec![service("z_service"), service("a_service")],
            }),
            selected_services: vec!["z_service".into(), "a_service".into(), "a_service".into()],
        };
        canonicalize(&mut config);
        let bytes = canonical_bytes(&config).unwrap();
        println!("GOLDEN_JSON {}", String::from_utf8(bytes.clone()).unwrap());
        println!("GOLDEN_SHA {}", digest(&bytes));
        assert_eq!(
            digest(&bytes),
            "820a75626ccf71e9a30529b381dc7dd2dd5abc9209446c850b129acc2a2ea93e"
        );
    }

    /// Shared fixtures bind the actual server envelope to the worker parser.
    /// Dates are intentionally fixed: content age is not report freshness.
    #[test]
    fn shared_wire_fixtures_match_server_serializer_and_validator() {
        let read: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/network-contracts/dns-management-v1/read.json"
        ))
        .unwrap();
        let config: ManagementConfig = serde_json::from_value(read["config"].clone()).unwrap();
        validate_config(&config).unwrap();
        assert_eq!(
            digest(&canonical_bytes(&config).unwrap()),
            read["body_sha256"]
        );
        let response = WorkerReadResponse {
            household_id: read["household_id"].as_str().unwrap().parse().unwrap(),
            gateway_id: read["gateway_id"].as_str().unwrap().parse().unwrap(),
            kind: "dns",
            config_version: 1,
            schema_version: Some(1),
            body_sha256: Some(read["body_sha256"].as_str().unwrap().to_owned()),
            config: Some(config),
            pending_refreshes: vec![PendingRefreshView {
                source_id: "list1".into(),
                refresh_seq: 1,
                config_version: 1,
                expires_at: "2026-11-26T12:10:00Z".parse().unwrap(),
            }],
            server_time: "2026-11-26T12:00:00Z".parse().unwrap(),
        };
        assert_eq!(serde_json::to_value(response).unwrap(), read);
        let report: WorkerStatusBody = serde_json::from_str(include_str!(
            "../../../tests/network-contracts/dns-management-v1/report.json"
        ))
        .unwrap();
        assert_eq!(report.body_sha256, read["body_sha256"]);
        validate_worker_status(&report, "2026-11-26T12:00:00Z".parse().unwrap()).unwrap();
    }

    #[test]
    fn config_validation_rejects_unknown_selected_service() {
        let mut config = ManagementConfig {
            catalog: Some(ServiceCatalogDto {
                version: "operator-1".into(),
                services: vec![],
            }),
            ..Default::default()
        };
        config.selected_services.push("missing".into());
        assert!(validate_config(&config).is_err());
    }
}
