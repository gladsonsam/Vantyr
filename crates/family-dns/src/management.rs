//! Optional, private DNS-management control-plane client.
//!
//! Default OFF. No listener is opened and no secret is accepted on the
//! command line. The operator supplies an owner-private options file plus a
//! scoped bearer credential with the two management commands only. All worker
//! requests use verified HTTPS with no proxy and no redirects. Status reports
//! are observations, not applied/enforced/verified claims.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::header::AUTHORIZATION;
use reqwest::redirect::Policy as RedirectPolicy;
use reqwest::{Certificate, Client, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::controller::{read_private_file, CONTROLLER_AUDIENCE};
use crate::management_dto::{
    is_digest, RefreshAckDto, WorkerReadBody, WorkerReadResponse, WorkerStatusBody,
};

/// Applied management state persisted in the ONE durable bundle. The desired
/// version/digest/config are independent of policy revision and both
/// generation counters. Only a successful full publish advances it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagementState {
    pub config_version: u64,
    pub digest: String,
    pub config: crate::management_dto::ManagementConfig,
    /// Identity of the material actually compiled from this config.
    pub filter_identity: String,
    /// Bounded per-gateway refresh receipts for the CURRENT config version.
    #[serde(default)]
    pub receipts: Vec<RefreshAckDto>,
    /// Server-owned expiry per `source:seq:version` token. Not sent on the
    /// wire; used to avoid reporting expired or stale acknowledgements.
    #[serde(default)]
    pub receipt_expiry: std::collections::BTreeMap<String, DateTime<Utc>>,
    #[serde(default)]
    pub applied_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// Server `MAX_SOURCES` also bounds refresh_ack in WorkerStatusBody.
pub const MAX_RECEIPTS: usize = 32;

pub fn receipt_key(id: &str, seq: u64, version: u64) -> String {
    format!("{id}:{seq}:{version}")
}

/// Structural checks used by bundle consistency on load and apply.
pub fn validate_state(state: &ManagementState) -> Result<(), ManagementError> {
    if state.config_version == 0 || !is_digest(&state.digest) {
        return Err(ManagementError::Integrity(
            "applied management version or digest is invalid".into(),
        ));
    }
    if state.filter_identity.len() > 64 || state.filter_identity.chars().any(|c| c.is_control()) {
        return Err(ManagementError::Integrity(
            "applied filter identity is malformed".into(),
        ));
    }
    if state.receipts.len() > MAX_RECEIPTS {
        return Err(ManagementError::Integrity(
            "management receipts exceed the bound".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for ack in &state.receipts {
        if ack.source_id.is_empty()
            || ack.refresh_seq == 0
            || ack.config_version == 0
            || ack.config_version > state.config_version
            || !seen.insert((ack.source_id.clone(), ack.refresh_seq, ack.config_version))
        {
            return Err(ManagementError::Integrity(
                "management receipt is invalid or duplicated".into(),
            ));
        }
    }
    Ok(())
}

pub const READ_PATH: &str = "/worker/network/dns-management/read";
pub const STATUS_PATH: &str = "/worker/network/dns/status";
pub const COMMAND_READ: &str = "read_dns_management";
pub const COMMAND_STATUS: &str = "report_dns_status";
const KIND: &str = "dns";
const MAX_OPTIONS_BYTES: usize = 16 * 1024;
const MAX_BEARER_BYTES: usize = 128;
const MIN_POLL_SECS: u64 = 5;
const MAX_POLL_SECS: u64 = 3600;
const MIN_RESPONSE_BYTES: usize = 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionsFile {
    origin: String,
    #[serde(default)]
    ca_pem_path: Option<String>,
    credential_file: String,
    household_id: String,
    gateway_id: String,
    #[serde(default = "default_poll")]
    poll_interval_secs: u64,
    #[serde(default = "default_timeout")]
    request_timeout_secs: u64,
    #[serde(default = "default_response")]
    max_response_bytes: usize,
}

fn default_poll() -> u64 {
    60
}
fn default_timeout() -> u64 {
    10
}
fn default_response() -> usize {
    32 * 1024
}

/// Static operator inputs. Never contains a secret itself.
#[derive(Clone, Debug)]
pub struct ManagementOptions {
    origin: String,
    ca_pem_path: Option<PathBuf>,
    credential_path: PathBuf,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    poll: Duration,
    timeout: Duration,
    max_response_bytes: usize,
}

impl ManagementOptions {
    pub fn load(path: &Path) -> Result<Self, ManagementError> {
        let bytes =
            read_private_file(path, MAX_OPTIONS_BYTES).map_err(ManagementError::InvalidConfig)?;
        let raw: OptionsFile = serde_json::from_slice(&bytes)
            .map_err(|_| ManagementError::InvalidConfig("options are not valid JSON".into()))?;
        let url = Url::parse(&raw.origin)
            .map_err(|_| ManagementError::InvalidConfig("origin is not an absolute URL".into()))?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().trim_end_matches('/').is_empty()
            || url.host_str().is_none()
        {
            return Err(ManagementError::InvalidConfig(
                "origin must be a bare https origin without userinfo, query or fragment".into(),
            ));
        }
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap()),
            None => url.host_str().unwrap().to_owned(),
        };
        let household_id = Uuid::parse_str(&raw.household_id)
            .map_err(|_| ManagementError::InvalidConfig("household_id is not a UUID".into()))?;
        let gateway_id = Uuid::parse_str(&raw.gateway_id)
            .map_err(|_| ManagementError::InvalidConfig("gateway_id is not a UUID".into()))?;
        if !(MIN_POLL_SECS..=MAX_POLL_SECS).contains(&raw.poll_interval_secs) {
            return Err(ManagementError::InvalidConfig(
                "poll_interval_secs out of range".into(),
            ));
        }
        if raw.request_timeout_secs == 0 || raw.request_timeout_secs > 60 {
            return Err(ManagementError::InvalidConfig(
                "request_timeout_secs out of range".into(),
            ));
        }
        if !(MIN_RESPONSE_BYTES..=MAX_RESPONSE_BYTES).contains(&raw.max_response_bytes) {
            return Err(ManagementError::InvalidConfig(
                "max_response_bytes out of range".into(),
            ));
        }
        Ok(Self {
            origin: format!("https://{authority}"),
            ca_pem_path: raw.ca_pem_path.map(PathBuf::from),
            credential_path: PathBuf::from(raw.credential_file),
            household_id,
            gateway_id,
            poll: Duration::from_secs(raw.poll_interval_secs),
            timeout: Duration::from_secs(raw.request_timeout_secs),
            max_response_bytes: raw.max_response_bytes,
        })
    }

    pub fn poll(&self) -> Duration {
        self.poll
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn max_response_bytes(&self) -> usize {
        self.max_response_bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagementError {
    InvalidConfig(String),
    CredentialUnavailable,
    AuthDenied,
    Transport,
    HttpStatus(u16),
    LimitExceeded,
    Malformed(&'static str),
    Integrity(String),
    StaleVersion { found: u64, highwater: u64 },
    Conflict(String),
}

impl fmt::Display for ManagementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(detail) => write!(f, "invalid management options: {detail}"),
            Self::CredentialUnavailable => write!(f, "management credential unavailable"),
            Self::AuthDenied => write!(f, "management credential denied"),
            Self::Transport => write!(f, "management transport failed"),
            Self::HttpStatus(code) => write!(f, "management HTTP status {code}"),
            Self::LimitExceeded => write!(f, "management response exceeded its byte limit"),
            Self::Malformed(part) => write!(f, "management response malformed: {part}"),
            Self::Integrity(detail) => write!(f, "management integrity failure: {detail}"),
            Self::StaleVersion { found, highwater } => {
                write!(
                    f,
                    "management version {found} is not newer than {highwater}"
                )
            }
            Self::Conflict(detail) => write!(f, "management conflict: {detail}"),
        }
    }
}
impl std::error::Error for ManagementError {}

#[derive(Clone)]
struct Bearer(SecretString);
impl fmt::Debug for Bearer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Bearer([REDACTED])")
    }
}
impl Bearer {
    fn load(path: &Path) -> Result<Self, ManagementError> {
        let bytes = read_private_file(path, MAX_BEARER_BYTES + 1)
            .map_err(|_| ManagementError::CredentialUnavailable)?;
        let value = std::str::from_utf8(&bytes)
            .map_err(|_| ManagementError::CredentialUnavailable)?
            .trim();
        let raw = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
            .unwrap_or(value);
        let (id, secret) = raw
            .split_once('.')
            .ok_or(ManagementError::CredentialUnavailable)?;
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
            return Err(ManagementError::CredentialUnavailable);
        }
        Ok(Self(SecretString::from(format!("Bearer {id}.{secret}"))))
    }
}

/// Bounded management client. One instance per worker.
pub struct ManagementClient {
    http: Client,
    read_url: Url,
    status_url: Url,
    credential: Bearer,
    household_id: Uuid,
    gateway_id: Uuid,
    max_response_bytes: usize,
}

impl fmt::Debug for ManagementClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ManagementClient")
            .field("read_url", &self.read_url.as_str())
            .field("status_url", &self.status_url.as_str())
            .field("credential", &self.credential)
            .field("household_id", &self.household_id)
            .field("gateway_id", &self.gateway_id)
            .finish()
    }
}

impl ManagementClient {
    pub fn new(options: &ManagementOptions) -> Result<Self, ManagementError> {
        let credential = Bearer::load(&options.credential_path)?;
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(RedirectPolicy::none())
            .connect_timeout(options.timeout)
            .timeout(options.timeout);
        if let Some(path) = &options.ca_pem_path {
            let pem = read_private_file(path, MAX_OPTIONS_BYTES)
                .map_err(|_| ManagementError::InvalidConfig("CA PEM unreadable".into()))?;
            let cert = Certificate::from_pem(&pem)
                .map_err(|_| ManagementError::InvalidConfig("CA PEM invalid".into()))?;
            builder = builder.tls_certs_merge([cert]);
        }
        let http = builder
            .build()
            .map_err(|_| ManagementError::InvalidConfig("client build failed".into()))?;
        let read_url = Url::parse(&format!("{}{}", options.origin, READ_PATH))
            .map_err(|_| ManagementError::InvalidConfig("read URL invalid".into()))?;
        let status_url = Url::parse(&format!("{}{}", options.origin, STATUS_PATH))
            .map_err(|_| ManagementError::InvalidConfig("status URL invalid".into()))?;
        Ok(Self {
            http,
            read_url,
            status_url,
            credential,
            household_id: options.household_id,
            gateway_id: options.gateway_id,
            max_response_bytes: options.max_response_bytes,
        })
    }

    pub fn gateway_id(&self) -> Uuid {
        self.gateway_id
    }

    async fn post<B: serde::Serialize>(
        &self,
        url: &Url,
        body: &B,
    ) -> Result<Vec<u8>, ManagementError> {
        let response = self
            .http
            .post(url.clone())
            .header(AUTHORIZATION, self.credential.0.expose_secret())
            .json(body)
            .send()
            .await
            .map_err(|_| ManagementError::Transport)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(ManagementError::AuthDenied);
        }
        if !status.is_success() {
            return Err(ManagementError::HttpStatus(status.as_u16()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| ManagementError::Transport)?;
        if bytes.len() > self.max_response_bytes {
            return Err(ManagementError::LimitExceeded);
        }
        Ok(bytes.to_vec())
    }

    /// One bounded read. The response envelope is fully verified here.
    pub async fn read(&self) -> Result<WorkerReadResponse, ManagementError> {
        let body = WorkerReadBody {
            audience: CONTROLLER_AUDIENCE.to_owned(),
            command: COMMAND_READ.to_owned(),
            household_id: self.household_id,
            gateway_id: self.gateway_id,
            kind: KIND.to_owned(),
        };
        let bytes = self.post(&self.read_url, &body).await?;
        let response: WorkerReadResponse =
            serde_json::from_slice(&bytes).map_err(|_| ManagementError::Malformed("read"))?;
        self.verify_read(&response)?;
        Ok(response)
    }

    fn verify_read(&self, response: &WorkerReadResponse) -> Result<(), ManagementError> {
        if response.household_id != self.household_id
            || response.gateway_id != self.gateway_id
            || response.kind != KIND
        {
            return Err(ManagementError::Integrity(
                "response names another household, gateway or kind".into(),
            ));
        }
        if response.config_version == 0 {
            if response.schema_version.is_some()
                || response.body_sha256.is_some()
                || response.config.is_some()
            {
                return Err(ManagementError::Integrity(
                    "versionless response carried config fields".into(),
                ));
            }
            return Ok(());
        }
        let (Some(schema), Some(digest), Some(config)) = (
            response.schema_version,
            response.body_sha256.as_deref(),
            response.config.as_ref(),
        ) else {
            return Err(ManagementError::Integrity(
                "desired config is incomplete".into(),
            ));
        };
        if schema != crate::management_dto::CONFIG_SCHEMA_VERSION {
            return Err(ManagementError::Integrity(format!(
                "unsupported management schema {schema}"
            )));
        }
        if !crate::management_dto::is_digest(digest) {
            return Err(ManagementError::Integrity("digest is malformed".into()));
        }
        let computed = crate::management_dto::digest(
            &crate::management_dto::canonical_bytes(config)
                .map_err(|_| ManagementError::Integrity("config is not serializable".into()))?,
        );
        if computed != digest {
            return Err(ManagementError::Integrity(
                "management config digest does not match".into(),
            ));
        }
        Ok(())
    }

    /// Report one bounded observation. No applied/enforced/verified claim.
    pub async fn report(&self, body: &WorkerStatusBody) -> Result<(), ManagementError> {
        if body.household_id != self.household_id
            || body.gateway_id != self.gateway_id
            || body.kind != KIND
        {
            return Err(ManagementError::InvalidConfig(
                "status body has wrong identity".into(),
            ));
        }
        let _: serde_json::Value =
            serde_json::from_slice(&self.post(&self.status_url, body).await?)
                .map_err(|_| ManagementError::Malformed("status"))?;
        Ok(())
    }
}

/// Shared clock for report timestamps (injected in tests where needed).
pub fn now() -> DateTime<Utc> {
    Utc::now()
}

/// Arc alias used by the coordinator.
pub type SharedClient = Arc<ManagementClient>;
