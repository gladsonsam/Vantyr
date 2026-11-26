//! Proxy client authentication against scoped, static config credentials.
//!
//! The credential is parsed by Rama's maintained typed header support and
//! compared with a maintained constant-time primitive. Header values and
//! tokens are never logged or rendered by `Debug`. A credential selects a
//! configured device (and an optional explicit static profile); it never
//! selects a person, and no source-address association is performed here.
//!
//! These are loopback bootstrap credentials, not a household identity system.
//! Repeated failures for one username are bounded by a small cooldown. The
//! opt-in centrally issued credential path ([`crate::credentials`]) and verified
//! session evidence ([`crate::session_evidence`]) are separate, default-off
//! additions: a credential binds a device; only independently verified evidence
//! can attribute a person. Neither infers identity from an address or label.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use family_policy::Assignment;
use rama::http::header::HeaderValue;
use rama::http::headers::{HeaderMapExt, ProxyAuthorization};
use rama::http::Request;
use rama::net::user::Basic;
use rama::utils::bytes::ct::ct_eq_bytes;
use uuid::Uuid;

use crate::config::Config;
use crate::credentials::{
    CredentialFailure, CredentialScope, CredentialStore, HouseholdKind, PresentedCredential,
    VerifiedCredential,
};
use crate::session_evidence::{
    EvidenceExpectation, EvidenceFailure, NoEvidenceVerifier, SessionEvidenceVerifier,
    VerifiedIdentity,
};

/// What an authenticated proxy client is bound to.
#[derive(Clone)]
pub struct AuthenticatedClient {
    pub id: Uuid,
    pub device_id: String,
    /// Explicit static profile mapping from config, if any. `None` means the
    /// device's own default profile applies.
    pub profile: Option<String>,
    token: Vec<u8>,
    /// Set only when a centrally issued credential authenticated this request.
    /// Bootstrap credentials never carry one.
    pub credential: Option<VerifiedCredential>,
    /// Set only when correctly scoped verifiable evidence was presented. A
    /// device binding alone never yields a verified person.
    pub verified: Option<VerifiedIdentity>,
}

impl fmt::Debug for AuthenticatedClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthenticatedClient")
            .field("id", &self.id)
            .field("device_id", &self.device_id)
            .field("profile", &self.profile)
            .field("token", &"<redacted>")
            .field("credential", &self.credential)
            .field("verified", &self.verified)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Invalid,
    Credential(CredentialFailure),
    Evidence(EvidenceFailure),
}

impl AuthError {
    /// Fixed bounded reason code. Never includes a secret or identity value.
    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "auth_missing",
            Self::Invalid => "auth_invalid",
            Self::Credential(failure) => failure.code(),
            Self::Evidence(failure) => failure.code(),
        }
    }
}

/// Bounded failure budget. Test code may shorten the cooldown; production
/// uses the conservative defaults.
#[derive(Clone, Copy, Debug)]
pub struct AuthPolicy {
    pub max_failures: u32,
    pub window: Duration,
    pub cooldown: Duration,
    pub max_tracked: usize,
}

impl Default for AuthPolicy {
    fn default() -> Self {
        Self {
            max_failures: 8,
            window: Duration::from_secs(60),
            cooldown: Duration::from_secs(30),
            max_tracked: 1024,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Attempt {
    failures: u32,
    window_start: Instant,
    blocked_until: Option<Instant>,
}

/// Constant-time verifier keyed by the public Basic username. Only the token
/// is secret; the username is an identifier used for lookup.
#[derive(Clone, Debug)]
pub struct AuthState {
    clients: BTreeMap<String, AuthenticatedClient>,
    /// Fixed dummy token so an unknown username still performs a real
    /// constant-time comparison instead of an early return.
    dummy_token: [u8; 32],
    policy: AuthPolicy,
    attempts: Arc<Mutex<BTreeMap<String, Attempt>>>,
    /// Centrally issued credential authority. `None` keeps bootstrap-only mode.
    credentials: Option<Arc<CredentialStore>>,
    /// Typed evidence verifier; the default verifier denies all evidence.
    evidence: Arc<dyn SessionEvidenceVerifier>,
    session_auth_enabled: bool,
    household_id: Uuid,
    device_kinds: BTreeMap<Uuid, HouseholdKind>,
    assignments: Arc<Vec<Assignment>>,
}

impl AuthState {
    pub fn new(config: &Config) -> Self {
        Self::with_policy(config, AuthPolicy::default())
    }

    pub fn with_policy(config: &Config, policy: AuthPolicy) -> Self {
        let clients = config
            .clients
            .iter()
            .map(|client| {
                (
                    client.id.clone(),
                    AuthenticatedClient {
                        id: Uuid::parse_str(&client.id).expect("client id validated"),
                        device_id: client.device_id.clone(),
                        profile: client.profile.clone(),
                        token: client.token.as_bytes().to_vec(),
                        credential: None,
                        verified: None,
                    },
                )
            })
            .collect();
        let household_id = Uuid::parse_str(&config.household_id).expect("household id validated");
        let device_kinds = config
            .devices
            .iter()
            .map(|device| {
                (
                    Uuid::parse_str(&device.id).expect("device id validated"),
                    if device.shared {
                        HouseholdKind::Shared
                    } else {
                        HouseholdKind::Personal
                    },
                )
            })
            .collect();
        Self {
            clients,
            dummy_token: [0x5a; 32],
            policy,
            attempts: Arc::new(Mutex::new(BTreeMap::new())),
            credentials: None,
            evidence: Arc::new(NoEvidenceVerifier),
            session_auth_enabled: false,
            household_id,
            device_kinds,
            assignments: Arc::new(Vec::new()),
        }
    }

    /// Opt-in constructor for the centrally issued credential + verified session
    /// path. The ordinary `new`/`with_policy` constructors never reach it, so
    /// existing deployments keep bootstrap-only behaviour.
    pub fn with_session_auth(
        config: &Config,
        policy: AuthPolicy,
        credentials: Arc<CredentialStore>,
        evidence: Arc<dyn SessionEvidenceVerifier>,
        assignments: Vec<Assignment>,
    ) -> Self {
        let mut state = Self::with_policy(config, policy);
        state.credentials = Some(credentials);
        state.evidence = evidence;
        state.session_auth_enabled = true;
        state.assignments = Arc::new(assignments);
        state
    }

    /// Authenticate a request with optional verified session evidence.
    ///
    /// Bootstrap credentials keep their existing behaviour. Otherwise a
    /// centrally issued credential authenticates a device binding; if evidence
    /// is supplied it must verify against the exact household, device, binding
    /// generation, household-kind, audience, command and an active assignment.
    /// Invalid evidence denies the whole request rather than falling back to a
    /// person-bearing identity.
    pub fn authenticate_with_session<B>(
        &self,
        request: &Request<B>,
        evidence_raw: Option<&str>,
        command: &str,
        now: DateTime<Utc>,
    ) -> Result<AuthenticatedClient, AuthError> {
        let presented = PresentedCredential::from_request(request);
        let bootstrap = presented
            .as_ref()
            .is_some_and(|p| self.clients.contains_key(&p.id.to_string()));
        if bootstrap {
            return self.authenticate(request).cloned();
        }
        if !self.session_auth_enabled {
            return Err(AuthError::Missing);
        }
        let presented = presented.ok_or(AuthError::Missing)?;
        let store = self.credentials.as_ref().ok_or(AuthError::Missing)?;
        // Centrally issued credentials share the same bounded failure/cooldown
        // tracker as bootstrap credentials, keyed by the public credential id.
        let username = presented.id.to_string();
        if self.blocked(&username) {
            return Err(AuthError::Invalid);
        }
        let allowed_devices: BTreeSet<Uuid> = self.device_kinds.keys().copied().collect();
        let scope = CredentialScope {
            household_id: self.household_id,
            allowed_devices: &allowed_devices,
            command,
        };
        let credential = match store.verify(&presented, &scope, now) {
            Ok(credential) => credential,
            Err(failure) => {
                self.record_failure(&username);
                return Err(AuthError::Credential(failure));
            }
        };
        // The authority-issued kind must match the configured device: a shared
        // device can never be treated as a personal one by a stale credential.
        if self.device_kinds.get(&credential.device_id) != Some(&credential.household_kind) {
            self.record_failure(&username);
            return Err(AuthError::Credential(CredentialFailure::WrongKind));
        }
        let verified = match evidence_raw {
            Some(raw) => {
                let expectation = EvidenceExpectation {
                    household_id: self.household_id,
                    device_id: credential.device_id,
                    generation: credential.generation,
                    household_kind: credential.household_kind,
                    command,
                    assignments: &self.assignments,
                };
                match self.evidence.verify(raw.as_bytes(), now, &expectation) {
                    Ok(verified) => Some(verified),
                    Err(failure) => {
                        self.record_failure(&username);
                        return Err(AuthError::Evidence(failure));
                    }
                }
            }
            None => None,
        };
        self.attempts
            .lock()
            .expect("auth attempt lock")
            .remove(&username);
        Ok(AuthenticatedClient {
            id: credential.id,
            device_id: credential.device_id.to_string(),
            profile: None,
            token: Vec::new(),
            credential: Some(credential),
            verified,
        })
    }

    /// Authenticate a request from its `Proxy-Authorization` header.
    pub fn authenticate<B>(&self, request: &Request<B>) -> Result<&AuthenticatedClient, AuthError> {
        let Some(ProxyAuthorization(basic)) =
            request.headers().typed_get::<ProxyAuthorization<Basic>>()
        else {
            return Err(AuthError::Missing);
        };
        let username = basic.username().to_owned();
        if self.blocked(&username) {
            return Err(AuthError::Invalid);
        }
        match self.verify(basic) {
            Ok(client) => {
                self.attempts
                    .lock()
                    .expect("auth attempt lock")
                    .remove(&username);
                Ok(client)
            }
            Err(error) => {
                self.record_failure(&username);
                Err(error)
            }
        }
    }

    /// Verify an already decoded Basic credential. Kept separate so tests can
    /// exercise constant-time rejection without constructing wire requests.
    pub fn verify(&self, basic: Basic) -> Result<&AuthenticatedClient, AuthError> {
        let username = basic.username();
        let presented = basic.password().unwrap_or("").as_bytes();
        let client = self.clients.get(username);
        let expected = client
            .map(|c| c.token.as_slice())
            .unwrap_or(&self.dummy_token);
        let matched = ct_eq_bytes(presented, expected);
        // The username lookup is public information: check the token in
        // constant time for both known and unknown users, then bind the result.
        match client {
            Some(client) if matched => Ok(client),
            _ => Err(AuthError::Invalid),
        }
    }

    /// Shared cooldown gate for bootstrap and centrally issued credentials.
    fn blocked(&self, username: &str) -> bool {
        let mut attempts = self.attempts.lock().expect("auth attempt lock");
        let now = Instant::now();
        self.prune(&mut attempts, now);
        attempts
            .get(username)
            .and_then(|attempt| attempt.blocked_until)
            .is_some_and(|until| until > now)
    }

    fn prune(&self, attempts: &mut BTreeMap<String, Attempt>, now: Instant) {
        attempts.retain(|_, attempt| {
            attempt.blocked_until.is_some_and(|until| until > now)
                || now.duration_since(attempt.window_start) < self.policy.window
        });
        while attempts.len() > self.policy.max_tracked {
            let Some(oldest) = attempts.keys().next().cloned() else {
                break;
            };
            attempts.remove(&oldest);
        }
    }

    fn record_failure(&self, username: &str) {
        let mut attempts = self.attempts.lock().expect("auth attempt lock");
        let now = Instant::now();
        self.prune(&mut attempts, now);
        let entry = attempts.entry(username.to_owned()).or_insert(Attempt {
            failures: 0,
            window_start: now,
            blocked_until: None,
        });
        if now.duration_since(entry.window_start) >= self.policy.window {
            entry.failures = 0;
            entry.window_start = now;
        }
        entry.failures += 1;
        if entry.failures >= self.policy.max_failures {
            entry.blocked_until = Some(now + self.policy.cooldown);
        }
    }
}

/// Build a `407 Proxy Authentication Required` response. The challenge never
/// includes credential material.
pub fn proxy_authentication_required() -> rama::http::Response {
    let mut response = rama::http::Response::new(rama::http::Body::empty());
    *response.status_mut() = rama::http::StatusCode::PROXY_AUTHENTICATION_REQUIRED;
    response.headers_mut().insert(
        rama::http::header::PROXY_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"Vantyr Proxy\", charset=\"UTF-8\""),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use rama::http::header::PROXY_AUTHORIZATION;
    use rama::http::Request;

    const TOKEN: &str = "vantyr-proxy-bootstrap-token-0001";
    const VALID: &str = r#"{
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 1,
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "vantyr-proxy-bootstrap-token-0001",
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        }],
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "restricted"
        }]
    }"#;

    fn request(token: &str) -> Request<()> {
        let credential = format!("22222222-3333-4444-5555-666666666666:{token}");
        let encoded = rama::net::user::Basic::try_from(credential.as_str()).unwrap();
        let mut request = Request::new(());
        request
            .headers_mut()
            .typed_insert(ProxyAuthorization(encoded));
        request
    }

    #[test]
    fn accepts_only_the_exact_basic_token() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::new(&config);
        let good =
            Basic::try_from(format!("22222222-3333-4444-5555-666666666666:{TOKEN}").as_str())
                .unwrap();
        let bad =
            Basic::try_from(format!("22222222-3333-4444-5555-666666666666:{TOKEN} ").as_str())
                .unwrap();
        let unknown =
            Basic::try_from("22222222-3333-4444-5555-666666666666:wrong-token-value-long-enough")
                .unwrap();
        let missing_user = Basic::try_from(format!("deadbeef:{TOKEN}").as_str()).unwrap();
        assert_eq!(
            auth.verify(good).unwrap().device_id,
            config.clients[0].device_id
        );
        assert_eq!(auth.verify(bad).unwrap_err(), AuthError::Invalid);
        assert_eq!(auth.verify(unknown).unwrap_err(), AuthError::Invalid);
        assert_eq!(auth.verify(missing_user).unwrap_err(), AuthError::Invalid);
    }

    #[test]
    fn missing_header_is_distinct_from_invalid_credentials() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::new(&config);
        let mut request = Request::new(());
        assert_eq!(auth.authenticate(&request).unwrap_err(), AuthError::Missing);
        request.headers_mut().insert(
            PROXY_AUTHORIZATION,
            HeaderValue::from_static("Basic bm90LWEtdG9rZW4="),
        );
        assert_eq!(auth.authenticate(&request).unwrap_err(), AuthError::Invalid);
        let challenge = proxy_authentication_required();
        assert_eq!(
            challenge.status(),
            rama::http::StatusCode::PROXY_AUTHENTICATION_REQUIRED
        );
        let header = challenge
            .headers()
            .get(rama::http::header::PROXY_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(header.starts_with("Basic realm=\"Vantyr Proxy\""));
        assert!(!header.contains(TOKEN));
    }

    #[test]
    fn repeated_failures_trigger_a_bounded_cooldown() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::with_policy(
            &config,
            AuthPolicy {
                max_failures: 2,
                window: Duration::from_secs(60),
                cooldown: Duration::from_millis(80),
                max_tracked: 8,
            },
        );
        let wrong = request("wrong-token-value-long-enough-for-the-policy");
        assert_eq!(auth.authenticate(&wrong).unwrap_err(), AuthError::Invalid);
        assert_eq!(auth.authenticate(&wrong).unwrap_err(), AuthError::Invalid);
        let good = request(TOKEN);
        assert_eq!(
            auth.authenticate(&good).unwrap_err(),
            AuthError::Invalid,
            "third attempt is blocked by the cooldown"
        );
        std::thread::sleep(Duration::from_millis(120));
        assert!(auth.authenticate(&good).is_ok(), "cooldown must expire");
    }

    #[test]
    fn secrets_are_never_rendered_in_debug() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let auth = AuthState::new(&config);
        let client = auth
            .verify(
                Basic::try_from(format!("22222222-3333-4444-5555-666666666666:{TOKEN}").as_str())
                    .unwrap(),
            )
            .unwrap();
        assert!(!format!("{config:?}").contains(TOKEN));
        assert!(!format!("{auth:?}").contains(TOKEN));
        assert!(!format!("{client:?}").contains(TOKEN));
        assert!(format!("{client:?}").contains("<redacted>"));
    }

    #[test]
    fn central_credential_failures_share_the_bounded_cooldown() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let store = Arc::new(CredentialStore::new());
        let (id, secret) = store
            .issue(
                Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap(),
                Uuid::parse_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap(),
                1,
                HouseholdKind::Shared, // the VALID device has shared=true by default
                &[crate::credentials::COMMAND_PROXY_HTTP],
                3600,
                Utc::now(),
            )
            .unwrap();
        let auth = AuthState::with_session_auth(
            &config,
            AuthPolicy {
                max_failures: 2,
                window: Duration::from_secs(60),
                cooldown: Duration::from_millis(80),
                max_tracked: 8,
            },
            store,
            Arc::new(NoEvidenceVerifier),
            vec![],
        );
        let request = |secret: &str| {
            let mut request = Request::new(());
            let basic = Basic::try_from(format!("{id}:{secret}").as_str()).unwrap();
            request
                .headers_mut()
                .typed_insert(ProxyAuthorization(basic));
            request
        };
        let wrong = request("pv1-wrong-wrong-wrong-wrong-wrong");
        for _ in 0..2 {
            assert_eq!(
                auth.authenticate_with_session(
                    &wrong,
                    None,
                    crate::credentials::COMMAND_PROXY_HTTP,
                    Utc::now(),
                )
                .unwrap_err(),
                AuthError::Credential(CredentialFailure::InvalidSecret)
            );
        }
        let good = request(secret.expose());
        assert_eq!(
            auth.authenticate_with_session(
                &good,
                None,
                crate::credentials::COMMAND_PROXY_HTTP,
                Utc::now(),
            )
            .unwrap_err(),
            AuthError::Invalid,
            "a valid secret is still blocked while the cooldown is active"
        );
        std::thread::sleep(Duration::from_millis(120));
        assert!(auth
            .authenticate_with_session(
                &good,
                None,
                crate::credentials::COMMAND_PROXY_HTTP,
                Utc::now(),
            )
            .is_ok());
    }
}
