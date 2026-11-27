//! Opt-in server-backed authority for centrally issued proxy credentials.
//!
//! Worker half of the seam described in `docs/proxy-management-integration.md`.
//! Nothing here is constructed unless the operator explicitly opts in with
//! `--server-auth`; the ordinary bootstrap-only path is untouched.
//!
//! - [`RemoteCredentialStore`] pulls a hash-only authoritative credential set
//!   from the server over a scoped worker Bearer and exposes the plain
//!   [`CredentialStore`] the accepted `AuthState` already verifies against. A
//!   bounded TTL gate makes a stale cache fail closed.
//! - [`HttpEvidenceVerifier`] implements the accepted [`SessionEvidenceVerifier`]
//!   trait, calls the scoped server introspection endpoint for each receipt
//!   (single-use, consumed server-side), then applies the same local scope and
//!   assignment checks as the in-memory verifier. It never trusts a central
//!   claim that is not bound to the presented evidence digest.
//!
//! HTTP calls are made on a dedicated OS thread with its own runtime: the
//! verifier trait is synchronous and is called from the proxy's Tokio tasks, so
//! an in-thread `block_on` would panic. Production must use an `https://` base
//! URL; loopback tests use plain HTTP without changing host CA trust.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};
use family_policy::{Assignment, Assurance, PersonId, Session, SessionSource};
use rama::http::client::DefaultHttpWebClient;
use rama::http::service::client::HttpClientExt as _;
use rama::http::BodyExtractExt as _;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::credentials::{AuthoritativeCredential, CredentialStore, HouseholdKind};
use crate::session_evidence::{
    EvidenceExpectation, EvidenceFailure, SessionEvidenceVerifier, VerifiedIdentity,
    MAX_EVIDENCE_BYTES, SESSION_EVIDENCE_AUDIENCE,
};

/// Audience of a gateway worker Bearer, mirrored from the server.
pub const WORKER_AUDIENCE: &str = "vantyr-gateway-worker";
/// Explicit opt-in worker command for proxy sync / evidence introspection.
pub const COMMAND_INTROSPECT_PROXY: &str = "introspect_proxy";
/// Worker kind this authority is valid for.
pub const WORKER_KIND_PROXY: &str = "proxy";
/// Bounds on the authoritative cache lifetime. A stale cache denies every
/// request, so a revocation reaches every new request within one TTL.
pub const MIN_SYNC_TTL_SECS: u64 = 1;
pub const MAX_SYNC_TTL_SECS: u64 = 60;
pub const DEFAULT_SYNC_TTL_SECS: u64 = 5;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
struct SyncResponse {
    credentials: Vec<AuthoritativeCredential>,
    #[serde(default)]
    assignments: Vec<Assignment>,
}

#[derive(Debug, Deserialize)]
struct ProofResponse {
    valid: bool,
    session_id: Uuid,
    household_id: Uuid,
    device_id: Uuid,
    person_id: Option<PersonId>,
    binding_generation: u64,
    household_kind: HouseholdKind,
    command: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

struct HttpJob {
    url: String,
    bearer: String,
    body: String,
    reply: std::sync::mpsc::SyncSender<Result<(u16, Vec<u8>), String>>,
}

/// A cloneable, runtime-independent bridge to the scoped HTTP authority.
#[derive(Clone)]
struct HttpBridge {
    jobs: tokio::sync::mpsc::UnboundedSender<HttpJob>,
}

impl HttpBridge {
    fn new() -> Self {
        let (jobs, receiver) = tokio::sync::mpsc::unbounded_channel::<HttpJob>();
        std::thread::Builder::new()
            .name("vantyr-proxy-introspection".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("introspection runtime");
                runtime.block_on(async move {
                    let client = DefaultHttpWebClient::default();
                    let receiver = Arc::new(Mutex::new(receiver));
                    loop {
                        let receiver = Arc::clone(&receiver);
                        let job = tokio::task::spawn_blocking(move || {
                            let mut receiver = receiver.lock().expect("receiver lock");
                            receiver.blocking_recv()
                        })
                        .await
                        .expect("introspection job receiver");
                        let Some(job) = job else { break };
                        let result =
                            async {
                                let response = client
                                    .post(job.url.as_str())
                                    .header("authorization", job.bearer.as_str())
                                    .header("content-type", "application/json")
                                    .body(job.body)
                                    .send()
                                    .await
                                    .map_err(|error| {
                                        format!("introspection request failed: {error}")
                                    })?;
                                let status = response.status().as_u16();
                                let bytes = response.into_body().try_into_string().await.map_err(
                                    |error| format!("introspection body failed: {error}"),
                                )?;
                                Ok::<_, String>((status, bytes.into_bytes()))
                            }
                            .await;
                        let _ = job.reply.send(result);
                    }
                });
            })
            .expect("introspection thread");
        Self { jobs }
    }

    fn post(&self, url: &str, bearer: &str, body: String) -> Result<(u16, Vec<u8>)> {
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(1);
        self.jobs
            .send(HttpJob {
                url: url.to_string(),
                bearer: bearer.to_string(),
                body,
                reply: reply_tx,
            })
            .map_err(|_| anyhow::anyhow!("introspection authority is unavailable"))?;
        reply_rx
            .recv()
            .map_err(|_| anyhow::anyhow!("introspection authority stopped"))?
            .map_err(anyhow::Error::msg)
    }
}

/// A hash-only credential cache backed by a scoped server sync. The underlying
/// store is the accepted worker authority; the freshness gate is the only
/// addition and refuses to serve a stale set.
#[derive(Clone)]
pub struct RemoteCredentialStore {
    store: Arc<CredentialStore>,
    http: HttpBridge,
    sync_url: String,
    sync_body: String,
    bearer: String,
    ttl: Duration,
    last_sync: Arc<Mutex<Option<Instant>>>,
    assignments: Arc<Mutex<Arc<Vec<Assignment>>>>,
}

impl fmt::Debug for RemoteCredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteCredentialStore")
            .field("store", &self.store)
            .field("ttl_secs", &self.ttl.as_secs())
            .field("bearer", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl RemoteCredentialStore {
    pub fn new(
        base_url: &str,
        bearer: String,
        household_id: Uuid,
        gateway_id: Uuid,
        ttl_secs: u64,
    ) -> Result<Self> {
        let ttl_secs = ttl_secs.clamp(MIN_SYNC_TTL_SECS, MAX_SYNC_TTL_SECS);
        let last_sync: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let store =
            CredentialStore::new().with_freshness_gate(freshness_gate(&last_sync, ttl_secs));
        Ok(Self {
            store: Arc::new(store),
            http: HttpBridge::new(),
            sync_url: format!("{base_url}/worker/network/proxy/credentials/sync"),
            sync_body: json!({
                "audience": WORKER_AUDIENCE,
                "household_id": household_id,
                "gateway_id": gateway_id,
                "kind": WORKER_KIND_PROXY,
                "command": COMMAND_INTROSPECT_PROXY,
            })
            .to_string(),
            bearer,
            ttl: Duration::from_secs(ttl_secs),
            last_sync,
            assignments: Arc::new(Mutex::new(Arc::new(Vec::new()))),
        })
    }

    pub fn credential_store(&self) -> Arc<CredentialStore> {
        Arc::clone(&self.store)
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    /// Same fail-closed predicate shared with the evidence verifier, so both
    /// halves deny together while the authoritative cache is stale.
    #[allow(clippy::type_complexity)]
    pub fn fresh_gate(&self) -> Arc<dyn Fn() -> bool + Send + Sync> {
        freshness_gate(&self.last_sync, self.ttl.as_secs())
    }

    /// A snapshot of the authoritative active assignments. The worker still
    /// filters by person, device and `active` at verification time.
    pub fn assignments(&self) -> Arc<Vec<Assignment>> {
        Arc::clone(&self.assignments.lock().expect("assignment snapshot lock"))
    }

    /// Pull the authoritative hash-only set. On failure the previous cache is
    /// left in place and its freshness expires naturally, so the gate denies
    /// new requests instead of trusting a partial set.
    pub fn sync(&self) -> Result<usize> {
        let (status, bytes) =
            self.http
                .post(&self.sync_url, &self.bearer, self.sync_body.clone())?;
        if status != 200 {
            let hint = String::from_utf8_lossy(&bytes);
            let hint: String = hint.chars().take(200).collect();
            anyhow::bail!("proxy credential sync was denied ({status}): {hint}");
        }
        if bytes.len() > MAX_RESPONSE_BYTES {
            anyhow::bail!("proxy credential sync response is unbounded");
        }
        let parsed: SyncResponse = serde_json::from_slice(&bytes)?;
        let count = self.store.load_authoritative(parsed.credentials)?;
        *self.assignments.lock().expect("assignment snapshot lock") = Arc::new(parsed.assignments);
        *self.last_sync.lock().expect("sync clock lock") = Some(Instant::now());
        Ok(count)
    }
}

fn freshness_gate(
    last_sync: &Arc<Mutex<Option<Instant>>>,
    ttl_secs: u64,
) -> Arc<dyn Fn() -> bool + Send + Sync> {
    let last_sync = Arc::clone(last_sync);
    let ttl = Duration::from_secs(ttl_secs);
    Arc::new(move || {
        let value = last_sync.lock().ok().and_then(|value| *value);
        value.is_some_and(|at| at.elapsed() <= ttl)
    })
}

/// Server-backed implementation of the accepted evidence verifier seam.
pub struct HttpEvidenceVerifier {
    http: HttpBridge,
    introspect_url: String,
    bearer: String,
    household_id: Uuid,
    gateway_id: Uuid,
    fresh: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl fmt::Debug for HttpEvidenceVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpEvidenceVerifier")
            .field("household_id", &self.household_id)
            .field("gateway_id", &self.gateway_id)
            .field("bearer", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl HttpEvidenceVerifier {
    pub fn new(
        base_url: &str,
        bearer: String,
        household_id: Uuid,
        gateway_id: Uuid,
        fresh: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self> {
        Ok(Self {
            http: HttpBridge::new(),
            introspect_url: format!("{base_url}/worker/network/proxy/evidence/introspect"),
            bearer,
            household_id,
            gateway_id,
            fresh,
        })
    }
}

impl SessionEvidenceVerifier for HttpEvidenceVerifier {
    fn verify(
        &self,
        raw: &[u8],
        _now: DateTime<Utc>,
        expected: &EvidenceExpectation<'_>,
    ) -> Result<VerifiedIdentity, EvidenceFailure> {
        if !(self.fresh)() {
            return Err(EvidenceFailure::Unsupported);
        }
        if raw.is_empty() || raw.len() > MAX_EVIDENCE_BYTES {
            return Err(EvidenceFailure::Malformed);
        }
        let evidence = std::str::from_utf8(raw).map_err(|_| EvidenceFailure::Malformed)?;
        // Local shape check: the server independently verifies the digest of
        // these exact bytes, so a forged audience cannot pass here either.
        let shape: Value =
            serde_json::from_str(evidence).map_err(|_| EvidenceFailure::Malformed)?;
        if shape.get("audience").and_then(Value::as_str) != Some(SESSION_EVIDENCE_AUDIENCE) {
            return Err(EvidenceFailure::AudienceMismatch);
        }
        let body = json!({
            "audience": WORKER_AUDIENCE,
            "household_id": self.household_id,
            "gateway_id": self.gateway_id,
            "kind": WORKER_KIND_PROXY,
            "command": COMMAND_INTROSPECT_PROXY,
            "evidence": evidence,
        })
        .to_string();
        let (status, bytes) = self
            .http
            .post(&self.introspect_url, &self.bearer, body)
            .map_err(|_| EvidenceFailure::Unsupported)?;
        if status != 200 {
            return Err(EvidenceFailure::Unsupported);
        }
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(EvidenceFailure::BoundExceeded);
        }
        let proof: ProofResponse =
            serde_json::from_slice(&bytes).map_err(|_| EvidenceFailure::Malformed)?;
        if !proof.valid {
            return Err(EvidenceFailure::Unsupported);
        }
        // Every claim is checked against the worker's own authoritative scope.
        if proof.household_id != expected.household_id {
            return Err(EvidenceFailure::HouseholdMismatch);
        }
        if proof.device_id != expected.device_id {
            return Err(EvidenceFailure::DeviceMismatch);
        }
        if proof.binding_generation != expected.generation {
            return Err(EvidenceFailure::GenerationMismatch);
        }
        if proof.household_kind != expected.household_kind {
            return Err(EvidenceFailure::KindMismatch);
        }
        if proof.command != expected.command {
            return Err(EvidenceFailure::CommandMismatch);
        }
        if proof.session_id == Uuid::nil() || proof.expires_at <= proof.issued_at {
            return Err(EvidenceFailure::Malformed);
        }
        let person = proof.person_id;
        if proof.household_kind == HouseholdKind::Shared && person.is_some() {
            return Err(EvidenceFailure::KindMismatch);
        }
        let assignments: Vec<Assignment> = match person {
            Some(person) => expected
                .assignments
                .iter()
                .filter(|a| a.active && a.person_id == person && a.device_id == expected.device_id)
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        if person.is_some() && assignments.is_empty() {
            return Err(EvidenceFailure::NoAssignment);
        }
        Ok(VerifiedIdentity {
            session: Session {
                id: proof.session_id,
                device_id: proof.device_id,
                verified_person: person,
                source: SessionSource::ProxyCredential,
                assurance: Assurance::Verified,
                started_at: proof.issued_at,
                expires_at: proof.expires_at,
                revoked: false,
            },
            assignments,
            person,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{COMMAND_PROXY_CONNECT, DIGEST_CHARS};

    fn record(command: &str) -> AuthoritativeCredential {
        AuthoritativeCredential {
            id: Uuid::new_v4(),
            household_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            secret_hash: "a".repeat(DIGEST_CHARS),
            binding_generation: 1,
            household_kind: HouseholdKind::Personal,
            scopes: vec![command.to_string()],
            issued_at: Utc::now(),
            expires_at: Utc::now() + Duration::from_secs(3600),
            revoked_at: None,
        }
    }

    #[test]
    fn authoritative_load_is_hash_only_and_allowlisted() {
        let store = CredentialStore::new();
        assert_eq!(
            store
                .load_authoritative(vec![record(COMMAND_PROXY_CONNECT)])
                .unwrap(),
            1
        );
        assert!(store
            .load_authoritative(vec![record("admin_token")])
            .is_err());
        let mut bad = record(COMMAND_PROXY_CONNECT);
        bad.secret_hash = "not-a-digest".to_string();
        assert!(store.load_authoritative(vec![bad]).is_err());
    }

    #[test]
    fn freshness_gate_denies_until_a_sync_is_recorded() {
        let clock: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let gate = freshness_gate(&clock, 1);
        assert!(!gate(), "an authority that never synced must fail closed");
        *clock.lock().unwrap() = Some(Instant::now());
        assert!(gate());
        *clock.lock().unwrap() = Some(Instant::now() - Duration::from_secs(2));
        assert!(!gate(), "a stale authority must fail closed");
    }
}
