//! Optional, explicitly configured controller policy pull for Vantyr DNS.
//!
//! This is a **read-only** integration: the worker fetches the assigned
//! versioned policy over HTTPS with a scoped `read_policy` bearer and compiles
//! it into the same durable bundle the local config produces. There is no
//! acknowledgement endpoint, no canary and no claim that the controller knows
//! what this worker applied. "Available" below means the pull path works
//! locally, not that a server-side applied/enforced state exists.
//!
//! The controller origin, CA and credential path are static operator-supplied
//! startup inputs. No raw secret is accepted on the command line, and no
//! secret is renderable through `Debug` or present in an error or log line.
//! A failed pull (bad TLS, denied credential, integrity mismatch, unsupported
//! policy) leaves the last-known-good bundle and its answers untouched.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_policy::Policy;
use reqwest::header::AUTHORIZATION;
use reqwest::redirect::Policy as RedirectPolicy;
use reqwest::{Certificate, Client, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;
use vantyr_network_runtime::check_policy_shape;

use crate::compile::CompileError;
use crate::config::read_bounded;
use crate::server::DnsServer;

/// Mirrors the server's `POLICY_SCHEMA_VERSION`. Only this schema is served.
pub const CONTROLLER_POLICY_SCHEMA_VERSION: i32 = 1;
/// Mirrors the server's worker-audience and explicit read command. The worker
/// never substitutes `heartbeat` for a policy read.
pub const CONTROLLER_AUDIENCE: &str = "vantyr-gateway-worker";
pub const CONTROLLER_COMMAND: &str = "read_policy";
pub const CONTROLLER_KIND: &str = "dns";
pub const READ_PATH: &str = "/worker/network/policy/read";

const MAX_OPTIONS_BYTES: usize = 16 * 1024;
const MAX_BEARER_BYTES: usize = 128;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
const DEFAULT_BACKOFF_SECS: u64 = 5;
const DEFAULT_MAX_BACKOFF_SECS: u64 = 300;
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 10;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MIN_INTERVAL_SECS: u64 = 5;
const MAX_INTERVAL_SECS: u64 = 3600;
const MIN_TIMEOUT_SECS: u64 = 1;
const MAX_TIMEOUT_SECS: u64 = 60;
/// Only one policy pull is ever in flight per worker.
const MAX_IN_FLIGHT: usize = 1;

#[derive(Debug, Error)]
pub enum ControllerError {
    #[error("invalid controller configuration: {0}")]
    InvalidConfig(String),
    #[error("controller credential file is unreadable or not owner-private")]
    CredentialUnavailable,
    #[error("controller denied the scoped read credential (401/403)")]
    AuthDenied,
    #[error("no policy is assigned to this gateway")]
    MissingAssignment,
    #[error("controller read_policy returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("controller read_policy response was malformed")]
    Malformed(&'static str),
    #[error("controller read_policy response exceeded its byte limit")]
    LimitExceeded,
    #[error("controller policy failed verification: {0}")]
    Integrity(String),
    #[error("controller policy is not enforceable here: {0}")]
    Unsupported(String),
    #[error("controller revision {found} is older than the applied revision {highwater}")]
    StaleRevision { found: u64, highwater: u64 },
    #[error("controller policy content changed without a revision change at {0}")]
    SameRevisionConflict(u64),
    #[error("local bundle persistence failed: {0}")]
    Persistence(String),
    #[error("controller read_policy transport failed")]
    Transport,
}

impl From<CompileError> for ControllerError {
    fn from(error: CompileError) -> Self {
        match error {
            CompileError::Unsupported(detail) => Self::Unsupported(detail),
            CompileError::Invalid(detail) => Self::Integrity(detail),
        }
    }
}

/// Honest capability result. `available()` says only that this worker can pull
/// and locally apply a policy. Nothing here reports a controller ack, an
/// enforcement receipt or a canary result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SyncCapability {
    Unsupported(String),
    Unchanged { revision: u64 },
    AppliedLocally { revision: u64 },
}

impl SyncCapability {
    pub fn available(&self) -> bool {
        !matches!(self, Self::Unsupported(_))
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Unsupported(_) => "unsupported",
            Self::Unchanged { .. } => "unchanged",
            Self::AppliedLocally { .. } => "applied_locally",
        }
    }
}

// ─── Static operator options ─────────────────────────────────────────────────

fn default_poll_interval() -> u64 {
    DEFAULT_POLL_INTERVAL_SECS
}
fn default_backoff() -> u64 {
    DEFAULT_BACKOFF_SECS
}
fn default_max_backoff() -> u64 {
    DEFAULT_MAX_BACKOFF_SECS
}
fn default_request_timeout() -> u64 {
    DEFAULT_REQUEST_TIMEOUT_SECS
}
fn default_max_response() -> usize {
    DEFAULT_MAX_RESPONSE_BYTES
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionsFile {
    controller_origin: String,
    #[serde(default)]
    ca_pem_path: Option<String>,
    credential_file: String,
    household_id: String,
    gateway_id: String,
    #[serde(default = "default_poll_interval")]
    poll_interval_secs: u64,
    #[serde(default = "default_backoff")]
    backoff_secs: u64,
    #[serde(default = "default_max_backoff")]
    max_backoff_secs: u64,
    #[serde(default = "default_request_timeout")]
    request_timeout_secs: u64,
    #[serde(default = "default_max_response")]
    max_response_bytes: usize,
}

/// Static startup options. Holds paths, never a secret. `Debug` is safe to log.
#[derive(Clone, Debug)]
pub struct ControllerOptions {
    origin: String,
    ca_pem_path: Option<PathBuf>,
    credential_path: PathBuf,
    household_id: Uuid,
    gateway_id: Uuid,
    poll_interval: Duration,
    backoff: Duration,
    max_backoff: Duration,
    request_timeout: Duration,
    max_response_bytes: usize,
}

impl ControllerOptions {
    /// Parse a bounded, owner-private options file. Bad TLS options, plain
    /// HTTP origins or unscoped identities fail before any listener starts.
    pub fn load(path: &Path) -> Result<Self, ControllerError> {
        let bytes =
            read_private_file(path, MAX_OPTIONS_BYTES).map_err(ControllerError::InvalidConfig)?;
        let raw: OptionsFile = serde_json::from_slice(&bytes).map_err(|_| {
            ControllerError::InvalidConfig("controller options are not valid JSON".into())
        })?;
        Self::from_file(raw)
    }

    fn from_file(raw: OptionsFile) -> Result<Self, ControllerError> {
        let parsed = Url::parse(&raw.controller_origin).map_err(|_| {
            ControllerError::InvalidConfig("controller_origin is not an absolute URL".into())
        })?;
        if parsed.scheme() != "https" {
            return Err(ControllerError::InvalidConfig(
                "controller_origin must use https; plain HTTP is never accepted".into(),
            ));
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ControllerError::InvalidConfig(
                "controller_origin must not carry userinfo, a query or a fragment".into(),
            ));
        }
        let path = parsed.path().trim_end_matches('/');
        if !path.is_empty() {
            return Err(ControllerError::InvalidConfig(
                "controller_origin must be an origin, not a path".into(),
            ));
        }
        let host = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| {
                ControllerError::InvalidConfig("controller_origin has no host".into())
            })?;
        let authority = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        let household_id = Uuid::parse_str(&raw.household_id)
            .map_err(|_| ControllerError::InvalidConfig("household_id is not a UUID".into()))?;
        let gateway_id = Uuid::parse_str(&raw.gateway_id)
            .map_err(|_| ControllerError::InvalidConfig("gateway_id is not a UUID".into()))?;
        let bounded_secs = |value: u64, lo: u64, hi: u64, what: &str| {
            if !(lo..=hi).contains(&value) {
                Err(ControllerError::InvalidConfig(format!(
                    "{what} must be {lo}..={hi} seconds"
                )))
            } else {
                Ok(Duration::from_secs(value))
            }
        };
        let poll_interval = bounded_secs(
            raw.poll_interval_secs,
            MIN_INTERVAL_SECS,
            MAX_INTERVAL_SECS,
            "poll_interval_secs",
        )?;
        let backoff = bounded_secs(raw.backoff_secs, 1, MAX_INTERVAL_SECS, "backoff_secs")?;
        let max_backoff = bounded_secs(
            raw.max_backoff_secs,
            1,
            MAX_INTERVAL_SECS,
            "max_backoff_secs",
        )?;
        if backoff > max_backoff {
            return Err(ControllerError::InvalidConfig(
                "backoff_secs exceeds max_backoff_secs".into(),
            ));
        }
        let request_timeout = bounded_secs(
            raw.request_timeout_secs,
            MIN_TIMEOUT_SECS,
            MAX_TIMEOUT_SECS,
            "request_timeout_secs",
        )?;
        if !(1024..=1024 * 1024).contains(&raw.max_response_bytes) {
            return Err(ControllerError::InvalidConfig(
                "max_response_bytes is outside 1024..=1048576".into(),
            ));
        }
        Ok(Self {
            origin: format!("https://{authority}"),
            ca_pem_path: raw.ca_pem_path.map(PathBuf::from),
            credential_path: PathBuf::from(raw.credential_file),
            household_id,
            gateway_id,
            poll_interval,
            backoff,
            max_backoff,
            request_timeout,
            max_response_bytes: raw.max_response_bytes,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn household_id(&self) -> Uuid {
        self.household_id
    }
    pub fn gateway_id(&self) -> Uuid {
        self.gateway_id
    }
    pub fn poll_interval(&self) -> Duration {
        self.poll_interval
    }
    pub fn backoff(&self) -> Duration {
        self.backoff
    }
    pub fn max_backoff(&self) -> Duration {
        self.max_backoff
    }
}

/// Read a small, owner-private file without following a symlink. Only static
/// operator inputs use this path; policy payloads arrive over verified TLS.
pub(crate) fn read_private_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| "file is missing or unreadable".to_owned())?;
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Err("file must be a regular, non-symlink file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // No group/other access of any kind; owner read is required. Owner
        // write is optional so a read-only mounted secret still works.
        let mode = meta.permissions().mode();
        if mode & 0o077 != 0 || mode & 0o400 == 0 {
            return Err("file must be owner-private (mode 0600)".to_owned());
        }
    }
    if meta.len() as usize > limit {
        return Err("file exceeds its byte limit".to_owned());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file: File = options
        .open(path)
        .map_err(|_| "file could not be opened".to_owned())?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "file could not be read".to_owned())?;
    if bytes.len() > limit {
        return Err("file exceeds its byte limit".to_owned());
    }
    Ok(bytes)
}

// ─── Credential custody ──────────────────────────────────────────────────────

/// The full `Authorization` value, loaded from an owner-private file. It is
/// never `Debug`/`Display`-printable and never copied into an error.
#[derive(Clone)]
struct BearerCredential(SecretString);

impl fmt::Debug for BearerCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BearerCredential([REDACTED])")
    }
}

impl BearerCredential {
    fn load(path: &Path) -> Result<Self, ControllerError> {
        let bytes = read_private_file(path, MAX_BEARER_BYTES + 1)
            .map_err(|_| ControllerError::CredentialUnavailable)?;
        let value =
            std::str::from_utf8(&bytes).map_err(|_| ControllerError::CredentialUnavailable)?;
        let value = value.trim();
        let raw = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        if value.is_empty() || value.len() > MAX_BEARER_BYTES {
            return Err(ControllerError::CredentialUnavailable);
        }
        let (id, secret) = raw
            .split_once('.')
            .ok_or(ControllerError::CredentialUnavailable)?;
        if id.len() != 36
            || secret.is_empty()
            || secret.len() > 43
            || !secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || Uuid::parse_str(id).is_err()
        {
            return Err(ControllerError::CredentialUnavailable);
        }
        Ok(Self(SecretString::from(format!("Bearer {id}.{secret}"))))
    }
}

// ─── Wire contract ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
struct ReadPolicyRequest {
    audience: &'static str,
    command: &'static str,
    household_id: Uuid,
    gateway_id: Uuid,
    kind: &'static str,
}

/// Mirrors the accepted server response shape. `body_sha256` is a content
/// digest of the exact stored policy bytes, NOT a signature or enforcement
/// receipt.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyReadResponse {
    pub gateway_id: Uuid,
    pub revision: u64,
    pub original_published_at: DateTime<Utc>,
    pub schema_version: i32,
    pub policy: Policy,
    pub body_sha256: String,
}

/// SHA-256 over the same canonical serde bytes the server digests. This proves
/// content integrity only; authentication comes from verified TLS plus the
/// scoped bearer credential.
pub fn policy_digest(policy: &Policy) -> Result<String, ControllerError> {
    let bytes = serde_json::to_vec(policy)
        .map_err(|_| ControllerError::Integrity("policy could not be serialized".into()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

// ─── Client ──────────────────────────────────────────────────────────────────

/// Bounded HTTPS client for the one worker read route. Redirects are disabled
/// so an Authorization header can never be replayed to another origin.
pub struct ControllerClient {
    http: Client,
    url: Url,
    credential: BearerCredential,
    household_id: Uuid,
    gateway_id: Uuid,
    max_response_bytes: usize,
    in_flight: Semaphore,
}

impl fmt::Debug for ControllerClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ControllerClient")
            .field("url", &self.url.as_str())
            .field("credential", &self.credential)
            .field("household_id", &self.household_id)
            .field("gateway_id", &self.gateway_id)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

impl ControllerClient {
    /// Build the client from static options. An explicit local CA is added to
    /// the trust store; chain and hostname verification stay enabled and there
    /// is no "accept invalid certificates" path.
    pub fn new(options: &ControllerOptions) -> Result<Self, ControllerError> {
        let credential = BearerCredential::load(&options.credential_path)?;
        let mut builder = Client::builder()
            .timeout(options.request_timeout)
            .redirect(RedirectPolicy::none());
        if let Some(path) = &options.ca_pem_path {
            let pem = read_bounded(path).map_err(|_| {
                ControllerError::InvalidConfig("CA PEM file is unreadable or oversized".into())
            })?;
            let cert = Certificate::from_pem(&pem).map_err(|_| {
                ControllerError::InvalidConfig("CA PEM file is not a valid certificate".into())
            })?;
            builder = builder.tls_certs_merge([cert]);
        }
        let http = builder.build().map_err(|_| {
            ControllerError::InvalidConfig("HTTPS client could not be built".into())
        })?;
        let url = Url::parse(&format!("{}{}", options.origin, READ_PATH))
            .map_err(|_| ControllerError::InvalidConfig("request URL could not be built".into()))?;
        Ok(Self {
            http,
            url,
            credential,
            household_id: options.household_id,
            gateway_id: options.gateway_id,
            max_response_bytes: options.max_response_bytes,
            in_flight: Semaphore::new(MAX_IN_FLIGHT),
        })
    }

    /// One bounded POST. Errors never contain the bearer, the request body or
    /// a response body.
    pub async fn fetch(&self) -> Result<PolicyReadResponse, ControllerError> {
        let _permit = self
            .in_flight
            .acquire()
            .await
            .map_err(|_| ControllerError::Transport)?;
        let body = ReadPolicyRequest {
            audience: CONTROLLER_AUDIENCE,
            command: CONTROLLER_COMMAND,
            household_id: self.household_id,
            gateway_id: self.gateway_id,
            kind: CONTROLLER_KIND,
        };
        let mut response = self
            .http
            .post(self.url.clone())
            .header(AUTHORIZATION, self.credential.0.expose_secret())
            .json(&body)
            .send()
            .await
            .map_err(|_| ControllerError::Transport)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            // Expiry, revocation and missing scope are decided by the
            // controller. The worker does not infer them from local data.
            return Err(ControllerError::AuthDenied);
        }
        if status == StatusCode::NOT_FOUND {
            return Err(ControllerError::MissingAssignment);
        }
        if !status.is_success() {
            return Err(ControllerError::HttpStatus(status.as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ControllerError::Transport)?
        {
            if bytes.len().saturating_add(chunk.len()) > self.max_response_bytes {
                return Err(ControllerError::LimitExceeded);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ControllerError::Malformed("read_policy"))
    }

    /// Reject every outer/inner mismatch before a candidate is built or
    /// persisted. The digest is content integrity, never a signature.
    pub fn verify(&self, response: PolicyReadResponse) -> Result<Policy, ControllerError> {
        if response.schema_version != CONTROLLER_POLICY_SCHEMA_VERSION {
            return Err(ControllerError::Integrity(format!(
                "unsupported schema version {}",
                response.schema_version
            )));
        }
        if response.gateway_id != self.gateway_id {
            return Err(ControllerError::Integrity(
                "response names another gateway".into(),
            ));
        }
        if response.policy.household_id != self.household_id {
            return Err(ControllerError::Integrity(
                "policy belongs to another household".into(),
            ));
        }
        if response.revision == 0 || response.revision != response.policy.revision {
            return Err(ControllerError::Integrity(
                "outer revision disagrees with the policy revision".into(),
            ));
        }
        if response.original_published_at != response.policy.published_at {
            return Err(ControllerError::Integrity(
                "publication time was refreshed by the transport".into(),
            ));
        }
        let computed = policy_digest(&response.policy)?;
        if computed != response.body_sha256 {
            return Err(ControllerError::Integrity(
                "policy content digest does not match".into(),
            ));
        }
        check_policy_shape(&response.policy)
            .map_err(|error| ControllerError::Unsupported(error.to_string()))?;
        Ok(response.policy)
    }
}

/// Fetch, fully verify, compile and apply one controller policy. This is the
/// library entry point; the CLI calls it once at startup and optionally on a
/// bounded poll. No controller acknowledgement is attempted.
pub async fn sync_once(
    server: &DnsServer,
    client: &ControllerClient,
    now: DateTime<Utc>,
) -> Result<SyncCapability, ControllerError> {
    let policy = client.verify(client.fetch().await?)?;
    // No caller-supplied config basis: the server derives it from the CURRENT
    // active snapshot under its update lock.
    server.apply_controller_policy(&policy, now)
}

// ─── Bounded poll ────────────────────────────────────────────────────────────

/// A single cancellable poll loop. One pull is in flight at a time (the client
/// semaphore is the hard bound); failures back off exponentially up to a
/// configured ceiling. Stopping awaits the task, so no work survives shutdown.
pub struct ControllerPoller {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ControllerPoller {
    pub fn start(
        server: Arc<DnsServer>,
        client: Arc<ControllerClient>,
        options: ControllerOptions,
    ) -> Self {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let mut delay = options.poll_interval();
            loop {
                tokio::select! {
                    _ = task_cancel.cancelled() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
                let now = Utc::now();
                match sync_once(&server, &client, now).await {
                    Ok(SyncCapability::AppliedLocally { revision }) => {
                        tracing::info!(revision, "controller policy applied locally");
                        delay = options.poll_interval();
                    }
                    Ok(SyncCapability::Unchanged { .. }) => {
                        delay = options.poll_interval();
                    }
                    Ok(SyncCapability::Unsupported(detail)) => {
                        tracing::warn!(%detail, "controller policy unsupported; keeping last-known-good");
                        delay = backoff(delay, &options);
                    }
                    Err(error) => {
                        // Error Display never contains a credential or body.
                        tracing::warn!(%error, "controller pull failed; keeping last-known-good");
                        delay = backoff(delay, &options);
                    }
                }
            }
        });
        Self { cancel, task }
    }

    /// Cancel and join. No detached task or socket outlives this call.
    pub async fn stop(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

fn backoff(current: Duration, options: &ControllerOptions) -> Duration {
    let next = current.checked_mul(2).unwrap_or(options.max_backoff());
    next.min(options.max_backoff()).max(options.backoff())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_require_https_and_bounded_scopes() {
        let base = |origin: &str| OptionsFile {
            controller_origin: origin.into(),
            ca_pem_path: None,
            credential_file: "/tmp/cred".into(),
            household_id: "11111111-2222-3333-4444-555555555555".into(),
            gateway_id: "22222222-3333-4444-5555-666666666666".into(),
            poll_interval_secs: DEFAULT_POLL_INTERVAL_SECS,
            backoff_secs: DEFAULT_BACKOFF_SECS,
            max_backoff_secs: DEFAULT_MAX_BACKOFF_SECS,
            request_timeout_secs: DEFAULT_REQUEST_TIMEOUT_SECS,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        };
        assert!(ControllerOptions::from_file(base("http://127.0.0.1:8080")).is_err());
        assert!(ControllerOptions::from_file(base("https://127.0.0.1:8443/path")).is_err());
        assert!(ControllerOptions::from_file(base("https://user@127.0.0.1:8443")).is_err());
        assert!(ControllerOptions::from_file(base("https://127.0.0.1:8443?q=1")).is_err());
        let good = ControllerOptions::from_file(base("https://localhost:8443")).unwrap();
        assert_eq!(good.origin(), "https://localhost:8443");
        let mut short = base("https://localhost:8443");
        short.poll_interval_secs = 1;
        assert!(ControllerOptions::from_file(short).is_err());
    }

    #[test]
    fn digest_is_the_canonical_policy_bytes_sha256() {
        use chrono::TimeZone;
        use std::collections::BTreeMap;
        let policy = Policy {
            household_id: Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap(),
            revision: 3,
            baseline: Vec::new(),
            device_profiles: BTreeMap::new(),
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            default_effect: family_policy::Effect::Deny,
            timezone: "UTC".into(),
            stale_after_secs: 3600,
            event_retention_secs: 86_400,
            published_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        };
        let bytes = serde_json::to_vec(&policy).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let expected: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(policy_digest(&policy).unwrap(), expected);
        assert_eq!(expected.len(), 64);
    }

    #[test]
    fn credential_debug_never_contains_the_secret() {
        let cred = BearerCredential(SecretString::from("Bearer abc.def"));
        let debug = format!("{cred:?}");
        assert!(!debug.contains("abc.def"));
        assert!(debug.contains("REDACTED"));
    }
}
