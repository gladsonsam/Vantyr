//! Opt-in, privacy-minimal DNS event reporting from the worker to the controller.
//!
//! Default OFF. A worker emits nothing unless the operator supplies an
//! owner-private options file and a scoped bearer credential for the explicit
//! `report_dns_events` command. Reporting is a side channel: it never delays,
//! rewrites or blocks a DNS answer, and a controller outage leaves the resolver
//! completely unaffected.
//!
//! Transport is verified HTTPS (no proxy, no redirects, optional explicit local
//! CA, chain + hostname verification always on). Every batch, body, response,
//! retry and queue is bounded. The queue is volatile by design: no per-query
//! churn is written into the one durable policy bundle, and a restart declares
//! loss rather than claiming a guarantee that was never built.

use std::collections::VecDeque;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use hickory_server::net::xfer::Protocol;
use reqwest::header::AUTHORIZATION;
use reqwest::redirect::Policy as RedirectPolicy;
use reqwest::{Certificate, Client, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::controller::{read_private_file, CONTROLLER_AUDIENCE};

/// Explicit opt-in command. It never upgrades an existing credential.
pub const EVENT_COMMAND: &str = "report_dns_events";
pub const EVENT_KIND: &str = "dns";
pub const EVENT_PATH: &str = "/worker/network/dns/events";

/// Mirrors the accepted server caps in `dns_events_dto.rs`.
pub const MAX_EVENTS_PER_BATCH: usize = 256;
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_NAME_LEN: usize = 253;
pub const MAX_REASON_LEN: usize = 64;
pub const MAX_TEXT_LEN: usize = 200;
pub const MAX_ID_LEN: usize = 64;
/// Headroom for JSON escaping under the server's 256 KiB body cap.
const BATCH_BUDGET_BYTES: usize = MAX_REQUEST_BYTES - 16 * 1024;

const MAX_OPTIONS_BYTES: usize = 16 * 1024;
const MAX_BEARER_BYTES: usize = 128;
const MAX_QUEUE_CAPACITY: usize = 4096;
const MIN_FLUSH_SECS: u64 = 1;
const MAX_FLUSH_SECS: u64 = 3600;
const MIN_TIMEOUT_SECS: u64 = 1;
const MAX_TIMEOUT_SECS: u64 = 60;
const MIN_RESPONSE_BYTES: usize = 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_BACKOFF_SECS: u64 = 300;
/// One initial attempt plus exactly one bounded retry.
const MAX_ATTEMPTS: usize = 2;

const QUERY_TYPES: &[&str] = &[
    "A", "AAAA", "CNAME", "SOA", "TXT", "MX", "SRV", "NS", "PTR", "CAA", "SVCB", "HTTPS", "DNAME",
    "DS", "DNSKEY", "ANY",
];
const SECRET_MARKERS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "bearer ",
    "cookie",
    "credential",
    "private_key",
    "session_id",
];

// ─── Wire shapes (strict mirror of the server's `deny_unknown_fields` DTOs) ──

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventBatchBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub batch_id: Uuid,
    pub events: Vec<DnsEventDto>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DnsEventDto {
    pub event_id: Uuid,
    pub observed_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<Uuid>,
    pub name: String,
    pub query_type: String,
    pub protocol: String,
    pub allow: bool,
    pub reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub cache_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<FlagsDto>,
    pub filter_blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_alias_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FlagsDto {
    pub rd: bool,
    pub cd: bool,
    pub ra: bool,
    pub ad: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchAck {
    pub ok: bool,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub batch_id: Uuid,
    pub event_count: usize,
    pub inserted: usize,
    pub duplicates: usize,
    pub replayed: bool,
}

// ─── One final, per-query decision ───────────────────────────────────────────

/// The single decision recorded for ONE query, built after alias inspection and
/// response shaping. `queue_event` validates it before it can enter a batch so
/// an unsupported RR or a root/edge name can never poison other observations.
#[derive(Clone, Debug)]
pub struct FinalDecision {
    pub event_id: Uuid,
    pub observed_at: DateTime<Utc>,
    pub device_id: Option<Uuid>,
    pub name: String,
    pub query_type: String,
    pub protocol: String,
    pub allow: bool,
    pub reason_code: String,
    pub policy_revision: Option<u64>,
    pub applied_rule: Option<String>,
    pub filter_blocked: bool,
    pub filter_source_id: Option<String>,
    pub filter_source_kind: Option<String>,
    pub denied_alias_target: Option<String>,
    pub flags: FlagsDto,
}

/// Why one observation was not admitted. Counted only as bounded diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidEvent {
    RootOrEmptyName,
    UnsupportedQueryType,
    UnsupportedProtocol,
    UnboundedToken,
    UnsafeToken,
}

impl FinalDecision {
    /// Convert to the strict wire DTO after local validation. `upstream` is
    /// always absent: the maintained resolver does not expose the answering
    /// upstream, so inventing one would be dishonest. `cache_state = "unknown"`
    /// states that this layer cannot observe whether the maintained resolver
    /// cache served the query; claiming `bypass` on a cached answer would be
    /// false. No hit/miss is inferred.
    pub fn into_event(self) -> Result<DnsEventDto, InvalidEvent> {
        let name = self.name.trim().trim_end_matches('.').to_ascii_lowercase();
        if name.is_empty() || name.len() > MAX_NAME_LEN || !clean_name(&name) {
            return Err(InvalidEvent::RootOrEmptyName);
        }
        let query_type = self.query_type.trim().to_ascii_uppercase();
        if !QUERY_TYPES.contains(&query_type.as_str()) {
            return Err(InvalidEvent::UnsupportedQueryType);
        }
        if ![
            "udp", "tcp", "dot", "doh", "doq", "dnscrypt", "h3", "unknown",
        ]
        .contains(&self.protocol.as_str())
        {
            return Err(InvalidEvent::UnsupportedProtocol);
        }
        let reason = self.reason_code.trim();
        if reason.is_empty() || reason.len() > MAX_REASON_LEN || !safe_token(reason) {
            return Err(InvalidEvent::UnboundedToken);
        }
        let applied_rule = match self.applied_rule.as_deref() {
            Some(v) if !v.is_empty() && v.len() <= MAX_TEXT_LEN && safe_token(v) => {
                Some(v.trim().to_owned())
            }
            Some(_) => return Err(InvalidEvent::UnsafeToken),
            None => None,
        };
        let denied_alias_target = match self.denied_alias_target.as_deref() {
            Some(v) => {
                let target = v.trim().trim_end_matches('.').to_ascii_lowercase();
                if target.is_empty() || target.len() > MAX_NAME_LEN || !clean_name(&target) {
                    return Err(InvalidEvent::UnsafeToken);
                }
                Some(target)
            }
            None => None,
        };
        let bounded_id = |v: Option<String>| match v {
            Some(value) if !value.is_empty() && value.len() <= MAX_ID_LEN && safe_token(&value) => {
                Some(value)
            }
            Some(_) => None,
            None => None,
        };
        let filter_source_kind = match self.filter_source_kind.as_deref() {
            Some("list") => Some("list".to_owned()),
            Some("service") => Some("service".to_owned()),
            _ => None,
        };
        Ok(DnsEventDto {
            event_id: self.event_id,
            observed_at: self.observed_at,
            device_id: self.device_id,
            name,
            query_type,
            protocol: self.protocol,
            allow: self.allow,
            reason_code: reason.to_owned(),
            policy_revision: self.policy_revision,
            applied_rule,
            upstream: None,
            cache_state: "unknown".to_owned(),
            flags: Some(self.flags),
            filter_blocked: self.filter_blocked,
            filter_source_id: bounded_id(self.filter_source_id),
            filter_source_kind,
            denied_alias_target,
            correlation_id: None,
        })
    }
}

/// A domain-shaped, privacy-clean query name. Never a URL, path, credential or
/// control marker; mirrors the server's free-text guard.
fn clean_name(value: &str) -> bool {
    if value.chars().any(char::is_control) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("://")
        || lower.contains('@')
        || lower.contains('?')
        || lower.contains('#')
        || lower.contains("..")
        || SECRET_MARKERS.iter().any(|m| lower.contains(m))
    {
        return false;
    }
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

fn safe_token(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    !lower.contains("://")
        && !lower.contains('@')
        && !lower.contains('?')
        && !lower.contains('#')
        && !lower.contains("..")
        && !value.chars().any(char::is_control)
        && !SECRET_MARKERS.iter().any(|m| lower.contains(m))
}

/// Map hickory's transport enum onto the server's protocol allowlist. Encrypted
/// transports are only reachable through an injected listener, so an unknown
/// value degrades to `"unknown"` rather than a fabricated transport claim.
pub fn protocol_label(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Udp => "udp",
        Protocol::Tcp => "tcp",
        // This worker registers only UDP and TCP listeners. Any other
        // transport is reported as unknown rather than guessed.
        _ => "unknown",
    }
}

/// Map a DNS record type onto the server's allowlist. Anything unlisted is
/// reported as `None` so the caller can count and drop it individually.
pub fn query_type_label(qtype: hickory_server::proto::rr::RecordType) -> Option<&'static str> {
    use hickory_server::proto::rr::RecordType as R;
    Some(match qtype {
        R::A => "A",
        R::AAAA => "AAAA",
        R::CNAME => "CNAME",
        R::SOA => "SOA",
        R::TXT => "TXT",
        R::MX => "MX",
        R::SRV => "SRV",
        R::NS => "NS",
        R::PTR => "PTR",
        R::CAA => "CAA",
        R::SVCB => "SVCB",
        R::HTTPS => "HTTPS",
        R::DNAME => "DNAME",
        R::DS => "DS",
        R::DNSKEY => "DNSKEY",
        R::ANY => "ANY",
        _ => return None,
    })
}

// ─── Bounded concurrent queue ────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EventMetrics {
    pub emitted: u64,
    pub queued: usize,
    pub lost_queue: u64,
    pub invalid: u64,
    pub sent: u64,
    pub acked: u64,
    pub rejected: u64,
    pub dropped_retry: u64,
    pub restored_on_shutdown: u64,
}

/// A bounded FIFO queue with a declared loss strategy. When full it drops the
/// NEWEST observation (the oldest, most useful signal is retained) and counts
/// the loss. Pushes never await, so the query path cannot be blocked by a
/// controller outage or a slow HTTP client.
pub struct EventQueue {
    entries: Mutex<VecDeque<DnsEventDto>>,
    capacity: usize,
    emitted: AtomicU64,
    lost: AtomicU64,
    invalid: AtomicU64,
    sent: AtomicU64,
    acked: AtomicU64,
    rejected: AtomicU64,
    dropped_retry: AtomicU64,
    restored: AtomicU64,
}

impl EventQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
            capacity: capacity.clamp(1, MAX_QUEUE_CAPACITY),
            emitted: AtomicU64::new(0),
            lost: AtomicU64::new(0),
            invalid: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            dropped_retry: AtomicU64::new(0),
            restored: AtomicU64::new(0),
        }
    }

    /// Record one validated decision. Returns false only when the queue was
    /// full and the new observation was dropped (a counted, declared loss).
    pub fn push(&self, event: DnsEventDto) -> bool {
        self.emitted.fetch_add(1, Ordering::Relaxed);
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if entries.len() == self.capacity {
            // Drop the newest (incoming) observation and count it. The oldest
            // retained events are preserved; no concurrent writer is blocked.
            self.lost.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        entries.push_back(event);
        true
    }

    pub fn note_invalid(&self) {
        self.invalid.fetch_add(1, Ordering::Relaxed);
    }

    /// Remove up to `max` oldest events for one bounded batch.
    pub fn drain(&self, max: usize) -> Vec<DnsEventDto> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let take = max.min(entries.len());
        entries.drain(..take).collect()
    }

    /// Put an unacknowledged batch back at the FRONT in its original order.
    /// Concurrent queries that arrived meanwhile stay behind it and are not
    /// lost; IDs are unchanged, so a retry is still deduplicated by the server.
    pub fn reinstate(&self, events: Vec<DnsEventDto>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for event in events.into_iter().rev() {
            if entries.len() == self.capacity {
                entries.pop_back();
                self.lost.fetch_add(1, Ordering::Relaxed);
            }
            entries.push_front(event);
        }
        self.restored.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_sent(&self, count: u64) {
        self.sent.fetch_add(count, Ordering::Relaxed);
        self.acked.fetch_add(count, Ordering::Relaxed);
    }

    pub fn note_rejected(&self) {
        self.rejected.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_dropped(&self) {
        self.dropped_retry.fetch_add(1, Ordering::Relaxed);
    }

    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn metrics(&self) -> EventMetrics {
        EventMetrics {
            emitted: self.emitted.load(Ordering::Relaxed),
            queued: self.len(),
            lost_queue: self.lost.load(Ordering::Relaxed),
            invalid: self.invalid.load(Ordering::Relaxed),
            sent: self.sent.load(Ordering::Relaxed),
            acked: self.acked.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
            dropped_retry: self.dropped_retry.load(Ordering::Relaxed),
            restored_on_shutdown: self.restored.load(Ordering::Relaxed),
        }
    }
}

// ─── Static operator options ─────────────────────────────────────────────────

fn default_flush() -> u64 {
    5
}
fn default_timeout() -> u64 {
    10
}
fn default_response() -> usize {
    64 * 1024
}
fn default_batch() -> usize {
    256
}
fn default_queue() -> usize {
    1024
}
fn default_backoff() -> u64 {
    5
}
fn default_max_backoff() -> u64 {
    60
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionsFile {
    origin: String,
    #[serde(default)]
    ca_pem_path: Option<String>,
    credential_file: String,
    household_id: String,
    gateway_id: String,
    #[serde(default = "default_flush")]
    flush_interval_secs: u64,
    #[serde(default = "default_batch")]
    max_batch: usize,
    #[serde(default = "default_timeout")]
    request_timeout_secs: u64,
    #[serde(default = "default_response")]
    max_response_bytes: usize,
    #[serde(default = "default_queue")]
    queue_capacity: usize,
    #[serde(default = "default_backoff")]
    backoff_secs: u64,
    #[serde(default = "default_max_backoff")]
    max_backoff_secs: u64,
}

/// Static startup options. Holds paths, never a secret. `Debug` is safe to log.
#[derive(Clone, Debug)]
pub struct EventOptions {
    origin: String,
    ca_pem_path: Option<PathBuf>,
    credential_path: PathBuf,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    flush_interval: Duration,
    max_batch: usize,
    request_timeout: Duration,
    max_response_bytes: usize,
    queue_capacity: usize,
    backoff: Duration,
    max_backoff: Duration,
}

impl EventOptions {
    /// Parse a bounded, owner-private options file. Plain HTTP, userinfo,
    /// queries, fragments and path-bearing origins fail before any listener is
    /// started by the caller.
    pub fn load(path: &Path) -> Result<Self, EventError> {
        let bytes = read_private_file(path, MAX_OPTIONS_BYTES)
            .map_err(|_| EventError::CredentialUnavailable)?;
        let raw: OptionsFile = serde_json::from_slice(&bytes)
            .map_err(|_| EventError::InvalidConfig("options are not valid JSON".into()))?;
        Self::from_file(raw)
    }

    fn from_file(raw: OptionsFile) -> Result<Self, EventError> {
        let url = Url::parse(&raw.origin)
            .map_err(|_| EventError::InvalidConfig("origin is not an absolute URL".into()))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().trim_end_matches('/').is_empty()
            || url.host_str().is_none()
        {
            return Err(EventError::InvalidConfig(
                "origin must be a bare https origin without userinfo, query or fragment".into(),
            ));
        }
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap()),
            None => url.host_str().unwrap().to_owned(),
        };
        let household_id = Uuid::parse_str(&raw.household_id)
            .map_err(|_| EventError::InvalidConfig("household_id is not a UUID".into()))?;
        let gateway_id = Uuid::parse_str(&raw.gateway_id)
            .map_err(|_| EventError::InvalidConfig("gateway_id is not a UUID".into()))?;
        let bounded_secs = |value: u64, lo: u64, hi: u64, what: &str| {
            if !(lo..=hi).contains(&value) {
                Err(EventError::InvalidConfig(format!(
                    "{what} must be {lo}..={hi} seconds"
                )))
            } else {
                Ok(Duration::from_secs(value))
            }
        };
        let flush_interval = bounded_secs(
            raw.flush_interval_secs,
            MIN_FLUSH_SECS,
            MAX_FLUSH_SECS,
            "flush_interval_secs",
        )?;
        let request_timeout = bounded_secs(
            raw.request_timeout_secs,
            MIN_TIMEOUT_SECS,
            MAX_TIMEOUT_SECS,
            "request_timeout_secs",
        )?;
        let backoff = bounded_secs(raw.backoff_secs, 1, MAX_BACKOFF_SECS, "backoff_secs")?;
        let max_backoff = bounded_secs(
            raw.max_backoff_secs,
            1,
            MAX_BACKOFF_SECS,
            "max_backoff_secs",
        )?;
        if backoff > max_backoff {
            return Err(EventError::InvalidConfig(
                "backoff_secs exceeds max_backoff_secs".into(),
            ));
        }
        if !(1..=MAX_EVENTS_PER_BATCH).contains(&raw.max_batch) {
            return Err(EventError::InvalidConfig(
                "max_batch must be 1..=256".into(),
            ));
        }
        if !(1..=MAX_QUEUE_CAPACITY).contains(&raw.queue_capacity) {
            return Err(EventError::InvalidConfig(
                "queue_capacity must be 1..=4096".into(),
            ));
        }
        if !(MIN_RESPONSE_BYTES..=MAX_RESPONSE_BYTES).contains(&raw.max_response_bytes) {
            return Err(EventError::InvalidConfig(
                "max_response_bytes out of range".into(),
            ));
        }
        Ok(Self {
            origin: format!("https://{authority}"),
            ca_pem_path: raw.ca_pem_path.map(PathBuf::from),
            credential_path: PathBuf::from(raw.credential_file),
            household_id,
            gateway_id,
            flush_interval,
            max_batch: raw.max_batch,
            request_timeout,
            max_response_bytes: raw.max_response_bytes,
            queue_capacity: raw.queue_capacity,
            backoff,
            max_backoff,
        })
    }

    pub fn flush_interval(&self) -> Duration {
        self.flush_interval
    }
    pub fn max_batch(&self) -> usize {
        self.max_batch
    }
    pub fn queue_capacity(&self) -> usize {
        self.queue_capacity
    }
    pub fn backoff(&self) -> Duration {
        self.backoff
    }
    pub fn max_backoff(&self) -> Duration {
        self.max_backoff
    }
}

#[derive(Debug, Error)]
pub enum EventError {
    #[error("invalid event reporting options: {0}")]
    InvalidConfig(String),
    #[error("event reporting credential is unreadable or not owner-private")]
    CredentialUnavailable,
    #[error("controller denied the scoped report_dns_events credential")]
    AuthDenied,
    #[error("event reporting transport failed")]
    Transport,
    #[error("event reporting returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("event reporting response exceeded its byte limit")]
    LimitExceeded,
    #[error("event reporting request body exceeded its byte limit")]
    BodyTooLarge,
    #[error("event reporting response was malformed")]
    Malformed,
    #[error("event reporting response failed verification: {0}")]
    Integrity(String),
}

#[derive(Clone)]
struct Bearer(SecretString);
impl fmt::Debug for Bearer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Bearer([REDACTED])")
    }
}
impl Bearer {
    fn load(path: &Path) -> Result<Self, EventError> {
        let bytes = read_private_file(path, MAX_BEARER_BYTES + 1)
            .map_err(|_| EventError::CredentialUnavailable)?;
        let value = std::str::from_utf8(&bytes)
            .map_err(|_| EventError::CredentialUnavailable)?
            .trim();
        let raw = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        let (id, secret) = raw
            .split_once('.')
            .ok_or(EventError::CredentialUnavailable)?;
        if value.is_empty()
            || value.len() > MAX_BEARER_BYTES
            || id.len() != 36
            || Uuid::parse_str(id).is_err()
            || secret.is_empty()
            || secret.len() > 43
            || !secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(EventError::CredentialUnavailable);
        }
        Ok(Self(SecretString::from(format!("Bearer {id}.{secret}"))))
    }
}

// ─── Bounded HTTPS client ────────────────────────────────────────────────────

pub struct EventClient {
    http: Client,
    url: Url,
    credential: Bearer,
    household_id: Uuid,
    gateway_id: Uuid,
    max_response_bytes: usize,
}

impl fmt::Debug for EventClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventClient")
            .field("url", &self.url.as_str())
            .field("credential", &self.credential)
            .field("household_id", &self.household_id)
            .field("gateway_id", &self.gateway_id)
            .finish()
    }
}

impl EventClient {
    pub fn new(options: &EventOptions) -> Result<Self, EventError> {
        let credential = Bearer::load(&options.credential_path)?;
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(RedirectPolicy::none())
            .connect_timeout(options.request_timeout)
            .timeout(options.request_timeout);
        if let Some(path) = &options.ca_pem_path {
            let pem = read_private_file(path, MAX_OPTIONS_BYTES)
                .map_err(|_| EventError::InvalidConfig("CA PEM unreadable".into()))?;
            let cert = Certificate::from_pem(&pem)
                .map_err(|_| EventError::InvalidConfig("CA PEM invalid".into()))?;
            builder = builder.tls_certs_merge([cert]);
        }
        let http = builder
            .build()
            .map_err(|_| EventError::InvalidConfig("client build failed".into()))?;
        let url = Url::parse(&format!("{}{}", options.origin, EVENT_PATH))
            .map_err(|_| EventError::InvalidConfig("report URL invalid".into()))?;
        Ok(Self {
            http,
            url,
            credential,
            household_id: options.household_id,
            gateway_id: options.gateway_id,
            max_response_bytes: options.max_response_bytes,
        })
    }

    pub fn household_id(&self) -> Uuid {
        self.household_id
    }
    pub fn gateway_id(&self) -> Uuid {
        self.gateway_id
    }

    /// One bounded POST. A non-2xx result never carries a body or credential.
    pub async fn send(&self, batch: &EventBatchBody) -> Result<BatchAck, EventError> {
        let bytes = serde_json::to_vec(batch).map_err(|_| EventError::Malformed)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(EventError::BodyTooLarge);
        }
        let mut response = self
            .http
            .post(self.url.clone())
            .header(AUTHORIZATION, self.credential.0.expose_secret())
            .header("content-type", "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| EventError::Transport)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(EventError::AuthDenied);
        }
        if !status.is_success() {
            return Err(EventError::HttpStatus(status.as_u16()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| EventError::Transport)? {
            if body.len().saturating_add(chunk.len()) > self.max_response_bytes {
                return Err(EventError::LimitExceeded);
            }
            body.extend_from_slice(&chunk);
        }
        let ack: BatchAck = serde_json::from_slice(&body).map_err(|_| EventError::Malformed)?;
        if !ack.ok
            || ack.household_id != self.household_id
            || ack.gateway_id != self.gateway_id
            || ack.batch_id != batch.batch_id
        {
            return Err(EventError::Integrity(
                "acknowledgement names another household, gateway or batch".into(),
            ));
        }
        if ack.event_count != batch.events.len()
            || ack.inserted > ack.event_count
            || ack.duplicates > ack.event_count
            || ack.inserted + ack.duplicates != batch.events.len()
            || (ack.replayed && ack.inserted != 0)
        {
            return Err(EventError::Integrity(
                "acknowledgement counts disagree with the batch".into(),
            ));
        }
        Ok(ack)
    }
}

/// Split drained events into batches bounded by both count and encoded bytes.
fn build_batches(events: Vec<DnsEventDto>, max_batch: usize) -> Vec<Vec<DnsEventDto>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut budget = BATCH_BUDGET_BYTES;
    for event in events {
        let cost = serde_json::to_vec(&event)
            .map(|bytes| bytes.len() + 1)
            .unwrap_or(MAX_REQUEST_BYTES);
        if !current.is_empty() && (current.len() >= max_batch || cost > budget) {
            batches.push(std::mem::take(&mut current));
            budget = BATCH_BUDGET_BYTES;
        }
        budget = budget.saturating_sub(cost);
        current.push(event);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

// ─── Cancellable reporting worker ────────────────────────────────────────────

/// One bounded, cancellable reporter. The queue and client are shared `Arc`s;
/// the task keeps `Weak` ownership only through the caller's server handle so
/// shutdown cannot leave a detached request in flight.
pub struct EventWorker {
    queue: Arc<EventQueue>,
    client: Arc<EventClient>,
    max_batch: usize,
    flush_interval: Duration,
    backoff: Duration,
    max_backoff: Duration,
    cancel: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl EventWorker {
    pub fn new(options: &EventOptions, queue: Arc<EventQueue>, client: Arc<EventClient>) -> Self {
        Self {
            queue,
            client,
            max_batch: options.max_batch(),
            flush_interval: options.flush_interval(),
            backoff: options.backoff(),
            max_backoff: options.max_backoff(),
            cancel: CancellationToken::new(),
            task: Mutex::new(None),
        }
    }

    pub fn queue(&self) -> Arc<EventQueue> {
        Arc::clone(&self.queue)
    }

    /// Truthful operator-facing status. These are counters for THIS process
    /// only: the queue is volatile, so losses from a previous run are unknown
    /// and are never guessed or carried forward as a fake guarantee.
    pub fn metrics(&self) -> EventMetrics {
        self.queue.metrics()
    }

    pub fn start(self: &Arc<Self>) {
        if self.task.lock().unwrap().is_some() {
            return;
        }
        let cancel = self.cancel.clone();
        let worker = Arc::clone(self);
        tracing::info!(
            command = EVENT_COMMAND,
            "DNS event reporting enabled; queue is volatile, prior-run losses are unknown"
        );
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(worker.flush_interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = timer.tick() => {
                        let m = worker.metrics();
                        tracing::info!(
                            emitted = m.emitted,
                            queued = m.queued,
                            lost_queue = m.lost_queue,
                            invalid = m.invalid,
                            sent = m.sent,
                            acked = m.acked,
                            rejected = m.rejected,
                            dropped_retry = m.dropped_retry,
                            restored_on_shutdown = m.restored_on_shutdown,
                            prior_run_losses_unknown = true,
                            "DNS event reporter status"
                        );
                        worker.flush_once().await;
                    }
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    /// Cancel, restore unacknowledged work and join. No task or socket outlives
    /// this call; restored events are counted, not silently discarded.
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let m = self.metrics();
        tracing::info!(
            emitted = m.emitted,
            queued = m.queued,
            lost_queue = m.lost_queue,
            invalid = m.invalid,
            sent = m.sent,
            acked = m.acked,
            rejected = m.rejected,
            dropped_retry = m.dropped_retry,
            restored_on_shutdown = m.restored_on_shutdown,
            prior_run_losses_unknown = true,
            "DNS event reporter stopped; volatile queue discarded"
        );
    }

    /// One drain -> send -> acknowledge cycle. A full success removes exactly
    /// the drained batch; a permanent rejection or exhausted retry is counted
    /// and dropped. DNS queries are never touched by this path.
    async fn flush_once(&self) {
        let events = self.queue.drain(self.max_batch);
        if events.is_empty() {
            return;
        }
        let mut pending = build_batches(events, self.max_batch);
        while let Some(batch) = pending.first().cloned() {
            let batch_id = Uuid::new_v4();
            let body = EventBatchBody {
                audience: CONTROLLER_AUDIENCE.to_owned(),
                command: EVENT_COMMAND.to_owned(),
                household_id: self.client.household_id(),
                gateway_id: self.client.gateway_id(),
                kind: EVENT_KIND.to_owned(),
                batch_id,
                events: batch.clone(),
            };
            let mut delay = self.backoff;
            let mut outcome = None;
            for attempt in 0..MAX_ATTEMPTS {
                match self.client.send(&body).await {
                    Ok(_ack) => {
                        outcome = Some(true);
                        break;
                    }
                    Err(EventError::AuthDenied) => {
                        outcome = Some(false);
                        break;
                    }
                    // 429 and 5xx (including 503) are transient and get the
                    // one bounded retry; all other 4xx are terminal.
                    Err(EventError::HttpStatus(code)) if code == 429 || code >= 500 => {
                        if attempt + 1 >= MAX_ATTEMPTS {
                            break;
                        }
                        tokio::select! {
                            _ = self.cancel.cancelled() => {
                                self.queue.reinstate(batch.clone());
                                return;
                            }
                            _ = tokio::time::sleep(delay) => {}
                        }
                        delay = delay
                            .checked_mul(2)
                            .unwrap_or(self.max_backoff)
                            .min(self.max_backoff);
                    }
                    Err(EventError::HttpStatus(_)) => {
                        outcome = Some(false);
                        break;
                    }
                    Err(EventError::Integrity(_))
                    | Err(EventError::Malformed)
                    | Err(EventError::BodyTooLarge) => {
                        outcome = Some(false);
                        break;
                    }
                    Err(_) if attempt + 1 < MAX_ATTEMPTS => {
                        tokio::select! {
                            _ = self.cancel.cancelled() => {
                                self.queue.reinstate(batch.clone());
                                return;
                            }
                            _ = tokio::time::sleep(delay) => {}
                        }
                        delay = delay
                            .checked_mul(2)
                            .unwrap_or(self.max_backoff)
                            .min(self.max_backoff);
                    }
                    Err(_) => break,
                }
            }
            match outcome {
                Some(true) => self.queue.note_sent(batch.len() as u64),
                Some(false) => self.queue.note_rejected(),
                None => {
                    // One retry was spent; the batch is truly dropped and the
                    // counter says so. It is not left in the queue under a
                    // different label.
                    self.queue.note_dropped();
                }
            }
            pending.remove(0);
            if self.cancel.is_cancelled() {
                for rest in pending.drain(..) {
                    self.queue.reinstate(rest);
                }
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn event(id: u32, name: &str) -> DnsEventDto {
        DnsEventDto {
            event_id: Uuid::from_u128(id as u128),
            observed_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            device_id: None,
            name: name.to_owned(),
            query_type: "A".to_owned(),
            protocol: "udp".to_owned(),
            allow: true,
            reason_code: "policy".to_owned(),
            policy_revision: Some(1),
            applied_rule: None,
            upstream: None,
            cache_state: "unknown".to_owned(),
            flags: Some(FlagsDto {
                rd: true,
                cd: false,
                ra: false,
                ad: false,
            }),
            filter_blocked: false,
            filter_source_id: None,
            filter_source_kind: None,
            denied_alias_target: None,
            correlation_id: None,
        }
    }

    #[test]
    fn queue_drops_newest_and_counts_loss() {
        let queue = EventQueue::new(2);
        assert!(queue.push(event(1, "a.test")));
        assert!(queue.push(event(2, "b.test")));
        assert!(!queue.push(event(3, "c.test")));
        let drained = queue.drain(2);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].name, "a.test");
        assert_eq!(drained[1].name, "b.test");
        assert_eq!(queue.metrics().lost_queue, 1);
        assert_eq!(queue.metrics().emitted, 3);
    }

    #[test]
    fn reinstate_preserves_id_order_and_does_not_lose_concurrent_push() {
        let queue = EventQueue::new(4);
        queue.push(event(1, "a.test"));
        queue.push(event(2, "b.test"));
        let batch = queue.drain(2);
        queue.push(event(3, "c.test"));
        queue.reinstate(batch);
        let all = queue.drain(4);
        assert_eq!(
            all.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["a.test", "b.test", "c.test"]
        );
        assert_eq!(queue.metrics().restored_on_shutdown, 1);
    }

    #[test]
    fn final_decision_drops_bad_names_and_rr_without_fabrication() {
        let base = FinalDecision {
            event_id: Uuid::from_u128(9),
            observed_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            device_id: None,
            name: "Example.COM.".to_owned(),
            query_type: "A".to_owned(),
            protocol: "udp".to_owned(),
            allow: true,
            reason_code: "policy".to_owned(),
            policy_revision: Some(4),
            applied_rule: None,
            filter_blocked: false,
            filter_source_id: None,
            filter_source_kind: None,
            denied_alias_target: None,
            flags: FlagsDto::default(),
        };
        let good = base.clone().into_event().unwrap();
        assert_eq!(good.name, "example.com");
        assert_eq!(good.cache_state, "unknown");
        assert!(good.upstream.is_none());
        assert!(base.clone().into_event().is_ok());
        assert_eq!(
            FinalDecision {
                name: ".".to_owned(),
                ..base.clone()
            }
            .into_event()
            .unwrap_err(),
            InvalidEvent::RootOrEmptyName
        );
        assert_eq!(
            FinalDecision {
                name: "https://x".to_owned(),
                ..base.clone()
            }
            .into_event()
            .unwrap_err(),
            InvalidEvent::RootOrEmptyName
        );
        assert_eq!(
            FinalDecision {
                query_type: "SSHFP".to_owned(),
                ..base.clone()
            }
            .into_event()
            .unwrap_err(),
            InvalidEvent::UnsupportedQueryType
        );
    }

    #[test]
    fn shared_report_fixture_parses_with_unknown_cache_state() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/network-contracts/dns-events-v1/report.json"
        ))
        .unwrap();
        let batch: EventBatchBody = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(batch.events[0].cache_state, "unknown");
        assert_eq!(batch.events[0].upstream, None);
        // The worker omits None optionals; compare after dropping explicit
        // nulls from the shared fixture so the wire shapes stay bound.
        let mut expected = fixture;
        if let Some(events) = expected.get_mut("events").and_then(|v| v.as_array_mut()) {
            for event in events {
                if let Some(object) = event.as_object_mut() {
                    object.retain(|_, value| !value.is_null());
                }
            }
        }
        assert_eq!(serde_json::to_value(&batch).unwrap(), expected);
    }

    #[test]
    fn wire_dto_rejects_unknown_fields() {
        let raw = serde_json::json!({
            "event_id": Uuid::from_u128(1).to_string(),
            "observed_at": "2023-11-14T22:13:20Z",
            "device_id": null,
            "name": "a.test",
            "query_type": "A",
            "protocol": "udp",
            "allow": true,
            "reason_code": "policy",
            "cache_state": "unknown",
            "filter_blocked": false,
            "surprise": 1
        });
        assert!(serde_json::from_value::<DnsEventDto>(raw).is_err());
    }

    #[test]
    fn options_require_bare_https_and_bounded_scopes() {
        let base = |origin: &str| OptionsFile {
            origin: origin.into(),
            ca_pem_path: None,
            credential_file: "/tmp/cred".into(),
            household_id: "11111111-2222-3333-4444-555555555555".into(),
            gateway_id: "22222222-3333-4444-5555-666666666666".into(),
            flush_interval_secs: 5,
            max_batch: 256,
            request_timeout_secs: 10,
            max_response_bytes: default_response(),
            queue_capacity: 1024,
            backoff_secs: 5,
            max_backoff_secs: 60,
        };
        assert!(EventOptions::from_file(base("http://127.0.0.1:8080")).is_err());
        assert!(EventOptions::from_file(base("https://127.0.0.1:8443/path")).is_err());
        assert!(EventOptions::from_file(base("https://user@127.0.0.1:8443")).is_err());
        assert!(EventOptions::from_file(base("https://127.0.0.1:8443?q=1")).is_err());
        let mut bad = base("https://localhost:8443");
        bad.max_batch = 257;
        assert!(EventOptions::from_file(bad).is_err());
        assert!(EventOptions::from_file(base("https://localhost:8443")).is_ok());
    }

    #[test]
    fn batches_respect_count_and_byte_bounds() {
        let events: Vec<_> = (0..600).map(|i| event(i, "a.test")).collect();
        let batches = build_batches(events, MAX_EVENTS_PER_BATCH);
        assert_eq!(batches.len(), 3);
        assert!(batches.iter().all(|b| b.len() <= MAX_EVENTS_PER_BATCH));
        for batch in &batches {
            let bytes = serde_json::to_vec(&EventBatchBody {
                audience: CONTROLLER_AUDIENCE.to_owned(),
                command: EVENT_COMMAND.to_owned(),
                household_id: Uuid::nil(),
                gateway_id: Uuid::nil(),
                kind: EVENT_KIND.to_owned(),
                batch_id: Uuid::nil(),
                events: batch.clone(),
            })
            .unwrap();
            assert!(bytes.len() <= MAX_REQUEST_BYTES);
        }
    }
}
