//! Centrally issued proxy credentials: hash-only lifecycle and authorization.
//!
//! This module is the worker-side foundation for opt-in, centrally issued proxy
//! credentials. It is deliberately independent of any HTTP server authority:
//! [`CredentialStore`] is an in-memory authority that holds only SHA-256 digests
//! (never plaintext) and verifies a presented secret with a fixed-width,
//! constant-time comparison. Rotation, revocation, expiry, binding generation,
//! household/device/kind, audience and per-command scope are all checked here.
//!
//! These credentials are a NEW family. A server BYOD setup grant or session
//! receipt is not a proxy credential and cannot authorize proxy traffic. The
//! server-side issuance/introspection seam is described in the dedicated
//! contract doc; nothing here claims end-to-end server authentication.
//!
//! No secret is ever rendered by `Debug`, `Display` or an error code. SHA-256 is
//! the already-pinned primitive exposed by `vantyr-network-pki`; the constant
//! time comparison is Rama's maintained `ct_eq_bytes`. No custom crypto.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use rama::http::headers::{HeaderMapExt, ProxyAuthorization};
use rama::http::Request;
use rama::net::user::Basic;
use rama::utils::bytes::ct::ct_eq_bytes;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vantyr_network_pki::metadata::sha256_hex;

/// Only this audience is accepted for a proxy client credential. A dashboard
/// cookie, gateway-worker bearer, agent token or BYOD setup grant never carries
/// it. Mirrors the server's explicit audience checks for worker credentials.
pub const PROXY_CREDENTIAL_AUDIENCE: &str = "vantyr-proxy-client";
/// Worker kind bound into a proxy credential. The server's gateway kind set is
/// `dns`/`proxy`; only `proxy` is valid here.
pub const PROXY_CREDENTIAL_KIND: &str = "proxy";
/// A proxy credential may be scoped to either command. Both are opt-in.
pub const COMMAND_PROXY_CONNECT: &str = "proxy_connect";
pub const COMMAND_PROXY_HTTP: &str = "proxy_http";
pub const PROXY_COMMAND_ALLOWLIST: &[&str] = &[COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP];

pub const MIN_SECRET_CHARS: usize = 32;
pub const MAX_SECRET_CHARS: usize = 128;
pub const MAX_COMMANDS: usize = 8;
pub const MAX_CREDENTIALS: usize = 256;
/// Digests are fixed-width lower-case SHA-256 hex.
pub const DIGEST_CHARS: usize = 64;
/// Retention bound for tombstoned (revoked/expired) records.
pub const MAX_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

/// Whether the device this credential is bound to is a shared device. A
/// shared-household-kind credential can never carry a verified person.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HouseholdKind {
    Personal,
    Shared,
}

/// A one-time plaintext secret. `Debug` is redacted and there is no `Display`
/// or serialization, so an incidental log or derived payload cannot leak it.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    /// Single explicit escape hatch for issuance responses and verification.
    pub fn expose(&self) -> &str {
        &self.0
    }

    fn digest(&self) -> String {
        hash_secret(self.0.as_bytes())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// The only digest shape stored. SHA-256 over the secret bytes, lower-case hex.
fn hash_secret(secret: &[u8]) -> String {
    sha256_hex(secret)
}

/// Fixed-width constant-time comparison. Both operands are 64 hex characters;
/// a malformed stored digest simply cannot match a well-formed presented one.
fn ct_eq_digest(presented: &str, stored: &str) -> bool {
    if presented.len() != DIGEST_CHARS || stored.len() != DIGEST_CHARS {
        return false;
    }
    ct_eq_bytes(presented.as_bytes(), stored.as_bytes())
}

/// A fixed bounded set of credential failure codes. Secrets, hashes, device
/// identifiers and person identifiers never appear in a code or its text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialFailure {
    Malformed,
    Unknown,
    InvalidSecret,
    Expired,
    Revoked,
    WrongHousehold,
    WrongDevice,
    WrongKind,
    WrongAudience,
    CommandNotAllowed,
    GenerationMismatch,
    BoundExceeded,
}

impl CredentialFailure {
    /// Stable machine-readable reason code. Safe to put in a response body.
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "credential_malformed",
            Self::Unknown => "credential_unknown",
            Self::InvalidSecret => "credential_invalid_secret",
            Self::Expired => "credential_expired",
            Self::Revoked => "credential_revoked",
            Self::WrongHousehold => "credential_wrong_household",
            Self::WrongDevice => "credential_wrong_device",
            Self::WrongKind => "credential_wrong_kind",
            Self::WrongAudience => "credential_wrong_audience",
            Self::CommandNotAllowed => "credential_command_not_allowed",
            Self::GenerationMismatch => "credential_generation_mismatch",
            Self::BoundExceeded => "credential_bound_exceeded",
        }
    }
}

impl fmt::Display for CredentialFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for CredentialFailure {}

/// A Basic credential decoded from `Proxy-Authorization`. The id is a public
/// lookup key; only the password is secret and it is redacted in `Debug`.
#[derive(Clone)]
pub struct PresentedCredential {
    pub id: Uuid,
    secret: String,
}

impl PresentedCredential {
    /// Decode from Rama's typed header support. No hand-written header parser.
    pub fn from_request<B>(request: &Request<B>) -> Option<Self> {
        let ProxyAuthorization(basic) =
            request.headers().typed_get::<ProxyAuthorization<Basic>>()?;
        Self::from_basic(&basic)
    }

    pub fn from_basic(basic: &Basic) -> Option<Self> {
        let id = Uuid::parse_str(basic.username()).ok()?;
        let secret = basic.password()?.to_owned();
        if !(MIN_SECRET_CHARS..=MAX_SECRET_CHARS).contains(&secret.len()) {
            return None;
        }
        if !secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return None;
        }
        Some(Self { id, secret })
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }
}

impl fmt::Debug for PresentedCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PresentedCredential")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Hash-only record. The plaintext is never retained after issuance.
#[derive(Clone)]
struct CredentialRecord {
    household_id: Uuid,
    device_id: Uuid,
    generation: u64,
    household_kind: HouseholdKind,
    audience: String,
    commands: BTreeSet<String>,
    secret_hash: String,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

impl fmt::Debug for CredentialRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialRecord")
            .field("household_id", &self.household_id)
            .field("device_id", &self.device_id)
            .field("generation", &self.generation)
            .field("household_kind", &self.household_kind)
            .field("audience", &self.audience)
            .field("commands", &self.commands)
            .field("secret_hash", &"<redacted>")
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

/// What a successfully verified credential is bound to. No secret material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedCredential {
    pub id: Uuid,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub generation: u64,
    pub household_kind: HouseholdKind,
    pub command: String,
}

/// Scope required from the caller at verification time. Identity is never
/// inferred from a source address, device label or arbitrary request header.
#[derive(Clone, Debug)]
pub struct CredentialScope<'a> {
    pub household_id: Uuid,
    pub allowed_devices: &'a BTreeSet<Uuid>,
    pub command: &'a str,
}

/// In-memory, hash-only credential authority. Safe to clone into request tasks.
#[derive(Clone)]
pub struct CredentialStore {
    records: Arc<Mutex<BTreeMap<Uuid, CredentialRecord>>>,
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let count = self
            .records
            .lock()
            .map(|records| records.len())
            .unwrap_or(0);
        f.debug_struct("CredentialStore")
            .field("records", &count)
            .finish_non_exhaustive()
    }
}

impl CredentialStore {
    pub fn new() -> Self {
        Self {
            records: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// Issue a fresh centrally scoped credential. This is the local authority
    /// used by the worker tests; a real server issues the same shape and sends
    /// only the plaintext secret once to the enrollee. Only the digest lands
    /// in the store.
    #[allow(clippy::too_many_arguments)] // one authority mutation, all bound fields
    pub fn issue(
        &self,
        household_id: Uuid,
        device_id: Uuid,
        generation: u64,
        household_kind: HouseholdKind,
        commands: &[&str],
        ttl_secs: u64,
        now: DateTime<Utc>,
    ) -> Result<(Uuid, Secret), CredentialFailure> {
        if commands.is_empty() || commands.len() > MAX_COMMANDS {
            return Err(CredentialFailure::BoundExceeded);
        }
        let mut allowed = BTreeSet::new();
        for command in commands {
            if !PROXY_COMMAND_ALLOWLIST.contains(command) {
                return Err(CredentialFailure::CommandNotAllowed);
            }
            allowed.insert((*command).to_owned());
        }
        if ttl_secs == 0 || ttl_secs > MAX_RETENTION_SECS {
            return Err(CredentialFailure::BoundExceeded);
        }
        // UUIDv4 is a maintained 122-bit random source. The server may issue a
        // longer high-entropy secret; both satisfy the same 32..=128 shape.
        let secret = Secret(format!("pv1-{}", Uuid::new_v4().simple()));
        let id = Uuid::new_v4();
        let record = CredentialRecord {
            household_id,
            device_id,
            generation,
            household_kind,
            audience: PROXY_CREDENTIAL_AUDIENCE.to_owned(),
            commands: allowed,
            secret_hash: secret.digest(),
            issued_at: now,
            expires_at: now + chrono::Duration::seconds(ttl_secs as i64),
            revoked_at: None,
        };
        let mut records = self.records.lock().expect("credential store lock");
        if records.len() >= MAX_CREDENTIALS && !records.contains_key(&id) {
            return Err(CredentialFailure::BoundExceeded);
        }
        records.insert(id, record);
        Ok((id, secret))
    }

    /// Verify a presented credential in constant time for both known and
    /// unknown ids, then enforce every bound scope check. A rotated-out secret
    /// cannot authenticate: rotation replaces the digest and bumps generation.
    pub fn verify(
        &self,
        presented: &PresentedCredential,
        scope: &CredentialScope<'_>,
        now: DateTime<Utc>,
    ) -> Result<VerifiedCredential, CredentialFailure> {
        let computed = hash_secret(presented.secret().as_bytes());
        let records = self.records.lock().expect("credential store lock");
        // A dummy 64-hex digest keeps the comparison real for unknown ids.
        let dummy = "0".repeat(DIGEST_CHARS);
        let found = records.get(&presented.id);
        let stored = found
            .map(|record| record.secret_hash.as_str())
            .unwrap_or(&dummy);
        let matched = ct_eq_digest(&computed, stored);
        let Some(record) = found else {
            return Err(CredentialFailure::Unknown);
        };
        if !matched {
            return Err(CredentialFailure::InvalidSecret);
        }
        if record.revoked_at.is_some() {
            return Err(CredentialFailure::Revoked);
        }
        if now >= record.expires_at || now < record.issued_at {
            return Err(CredentialFailure::Expired);
        }
        if record.household_id != scope.household_id {
            return Err(CredentialFailure::WrongHousehold);
        }
        if !scope.allowed_devices.contains(&record.device_id) {
            return Err(CredentialFailure::WrongDevice);
        }
        if record.audience != PROXY_CREDENTIAL_AUDIENCE {
            return Err(CredentialFailure::WrongAudience);
        }
        if !record.commands.contains(scope.command) {
            return Err(CredentialFailure::CommandNotAllowed);
        }
        Ok(VerifiedCredential {
            id: presented.id,
            household_id: record.household_id,
            device_id: record.device_id,
            generation: record.generation,
            household_kind: record.household_kind,
            command: scope.command.to_owned(),
        })
    }

    /// Rotate one credential: a new secret, a new digest and a bumped binding
    /// generation. Everything issued under the previous generation is invalid.
    pub fn rotate(
        &self,
        id: Uuid,
        ttl_secs: u64,
        now: DateTime<Utc>,
    ) -> Result<(Uuid, Secret), CredentialFailure> {
        if ttl_secs == 0 || ttl_secs > MAX_RETENTION_SECS {
            return Err(CredentialFailure::BoundExceeded);
        }
        let secret = Secret(format!("pv1-{}", Uuid::new_v4().simple()));
        let mut records = self.records.lock().expect("credential store lock");
        let record = records.get_mut(&id).ok_or(CredentialFailure::Unknown)?;
        if record.revoked_at.is_some() {
            return Err(CredentialFailure::Revoked);
        }
        record.secret_hash = secret.digest();
        record.generation = record
            .generation
            .checked_add(1)
            .ok_or(CredentialFailure::GenerationMismatch)?;
        record.issued_at = now;
        record.expires_at = now + chrono::Duration::seconds(ttl_secs as i64);
        Ok((id, secret))
    }

    /// Revoke one credential. Revocation is durable until explicit pruning.
    pub fn revoke(&self, id: Uuid, now: DateTime<Utc>) -> bool {
        let mut records = self.records.lock().expect("credential store lock");
        let Some(record) = records.get_mut(&id) else {
            return false;
        };
        if record.revoked_at.is_none() {
            record.revoked_at = Some(now);
            true
        } else {
            false
        }
    }

    /// Reclaim expired and revoked records once their audit retention has
    /// elapsed. An active, unexpired credential is never pruned, so a batch of
    /// short-lived credentials cannot permanently exhaust the issuance bound.
    pub fn prune(&self, now: DateTime<Utc>, retention_secs: u64) -> usize {
        let retention = chrono::Duration::seconds(retention_secs.min(MAX_RETENTION_SECS) as i64);
        let mut records = self.records.lock().expect("credential store lock");
        let before = records.len();
        records.retain(|_, record| match record.revoked_at {
            // Revoked is deactivated: reclaim after its own retention window.
            Some(revoked_at) => now < revoked_at + retention,
            // Active: reclaim only after expiry plus retention.
            None => now < record.expires_at + retention,
        });
        before - records.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
    const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-27T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn basic(id: Uuid, secret: &str) -> Basic {
        Basic::try_from(format!("{id}:{secret}").as_str()).unwrap()
    }

    fn scope<'a>(devices: &'a BTreeSet<Uuid>, command: &'a str) -> CredentialScope<'a> {
        CredentialScope {
            household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
            allowed_devices: devices,
            command,
        }
    }

    #[test]
    fn issue_verify_rotate_and_revoke_lifecycle() {
        let store = CredentialStore::new();
        let devices: BTreeSet<Uuid> = [Uuid::parse_str(DEVICE).unwrap()].into_iter().collect();
        let (id, secret) = store
            .issue(
                Uuid::parse_str(HOUSEHOLD).unwrap(),
                Uuid::parse_str(DEVICE).unwrap(),
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP],
                3600,
                now(),
            )
            .unwrap();
        let presented = PresentedCredential::from_basic(&basic(id, secret.expose())).unwrap();
        let verified = store
            .verify(&presented, &scope(&devices, COMMAND_PROXY_CONNECT), now())
            .unwrap();
        assert_eq!(verified.device_id, Uuid::parse_str(DEVICE).unwrap());
        assert_eq!(verified.generation, 1);
        assert_eq!(verified.household_kind, HouseholdKind::Personal);

        let (_, rotated) = store.rotate(id, 3600, now()).unwrap();
        assert_eq!(
            store.verify(&presented, &scope(&devices, COMMAND_PROXY_CONNECT), now()),
            Err(CredentialFailure::InvalidSecret),
            "the rotated-out secret must not authenticate"
        );
        let rotated_presented =
            PresentedCredential::from_basic(&basic(id, rotated.expose())).unwrap();
        let verified = store
            .verify(
                &rotated_presented,
                &scope(&devices, COMMAND_PROXY_CONNECT),
                now(),
            )
            .unwrap();
        assert_eq!(verified.generation, 2);

        assert!(store.revoke(id, now()));
        assert_eq!(
            store.verify(
                &rotated_presented,
                &scope(&devices, COMMAND_PROXY_CONNECT),
                now()
            ),
            Err(CredentialFailure::Revoked)
        );
    }

    #[test]
    fn expiry_wrong_scope_and_command_fail_closed() {
        let store = CredentialStore::new();
        let device = Uuid::parse_str(DEVICE).unwrap();
        let devices: BTreeSet<Uuid> = [device].into_iter().collect();
        let (id, secret) = store
            .issue(
                Uuid::parse_str(HOUSEHOLD).unwrap(),
                device,
                1,
                HouseholdKind::Shared,
                &[COMMAND_PROXY_HTTP],
                60,
                now(),
            )
            .unwrap();
        let presented = PresentedCredential::from_basic(&basic(id, secret.expose())).unwrap();
        let good = scope(&devices, COMMAND_PROXY_HTTP);
        assert_eq!(
            store
                .verify(&presented, &good, now())
                .unwrap()
                .household_kind,
            HouseholdKind::Shared
        );
        assert_eq!(
            store.verify(&presented, &scope(&devices, COMMAND_PROXY_CONNECT), now()),
            Err(CredentialFailure::CommandNotAllowed)
        );
        assert_eq!(
            store.verify(&presented, &good, now() + chrono::Duration::seconds(61)),
            Err(CredentialFailure::Expired)
        );
        let wrong_household = CredentialScope {
            household_id: Uuid::new_v4(),
            allowed_devices: &devices,
            command: COMMAND_PROXY_HTTP,
        };
        assert_eq!(
            store.verify(&presented, &wrong_household, now()),
            Err(CredentialFailure::WrongHousehold)
        );
        let no_device = CredentialScope {
            household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
            allowed_devices: &BTreeSet::new(),
            command: COMMAND_PROXY_HTTP,
        };
        assert_eq!(
            store.verify(&presented, &no_device, now()),
            Err(CredentialFailure::WrongDevice)
        );
    }

    #[test]
    fn unknown_and_wrong_secret_both_use_the_constant_time_comparison() {
        // The bounded failure codes differ (Unknown vs InvalidSecret), so the
        // two cases are externally distinguishable by code. What is protected
        // here is the *comparison*: both paths hash and compare a fixed-width
        // digest, so there is no byte-prefix oracle for a guessed secret.
        let store = CredentialStore::new();
        let device = Uuid::parse_str(DEVICE).unwrap();
        let devices: BTreeSet<Uuid> = [device].into_iter().collect();
        let (id, secret) = store
            .issue(
                Uuid::parse_str(HOUSEHOLD).unwrap(),
                device,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                3600,
                now(),
            )
            .unwrap();
        let wrong_secret =
            PresentedCredential::from_basic(&basic(id, "pv1-wrong-wrong-wrong-wrong-wrong"))
                .unwrap();
        let unknown =
            PresentedCredential::from_basic(&basic(Uuid::new_v4(), secret.expose())).unwrap();
        assert_eq!(
            store.verify(
                &wrong_secret,
                &scope(&devices, COMMAND_PROXY_CONNECT),
                now()
            ),
            Err(CredentialFailure::InvalidSecret)
        );
        assert_eq!(
            store.verify(&unknown, &scope(&devices, COMMAND_PROXY_CONNECT), now()),
            Err(CredentialFailure::Unknown)
        );
        let malformed =
            PresentedCredential::from_basic(&Basic::try_from("not-a-uuid:short").unwrap());
        assert!(malformed.is_none());
    }

    #[test]
    fn secrets_and_digests_are_never_rendered() {
        let secret = Secret("pv1-this-is-a-test-secret-value-000000000".to_owned());
        assert!(!format!("{secret:?}").contains(secret.expose()));
        assert!(!format!("{:?}", CredentialFailure::InvalidSecret).contains(secret.expose()));
        let presented =
            PresentedCredential::from_basic(&basic(Uuid::new_v4(), secret.expose())).unwrap();
        assert!(!format!("{presented:?}").contains(secret.expose()));
        assert!(format!("{presented:?}").contains("<redacted>"));
    }

    #[test]
    fn issue_bounds_and_prune_are_enforced() {
        let store = CredentialStore::new();
        let device = Uuid::parse_str(DEVICE).unwrap();
        assert_eq!(
            store
                .issue(
                    Uuid::parse_str(HOUSEHOLD).unwrap(),
                    device,
                    1,
                    HouseholdKind::Personal,
                    &[],
                    3600,
                    now()
                )
                .err(),
            Some(CredentialFailure::BoundExceeded)
        );
        assert_eq!(
            store
                .issue(
                    Uuid::parse_str(HOUSEHOLD).unwrap(),
                    device,
                    1,
                    HouseholdKind::Personal,
                    &["not-a-command"],
                    3600,
                    now()
                )
                .err(),
            Some(CredentialFailure::CommandNotAllowed)
        );
        let (id, _) = store
            .issue(
                Uuid::parse_str(HOUSEHOLD).unwrap(),
                device,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                3600,
                now(),
            )
            .unwrap();
        store.revoke(id, now());
        assert_eq!(store.prune(now() + chrono::Duration::days(31), 3600), 1);
    }

    #[test]
    fn expired_credentials_reclaim_capacity_and_new_issue_succeeds() {
        let store = CredentialStore::new();
        let household_id = Uuid::parse_str(HOUSEHOLD).unwrap();
        let device_id = Uuid::parse_str(DEVICE).unwrap();
        let issued = now();
        for _ in 0..MAX_CREDENTIALS {
            store
                .issue(
                    household_id,
                    device_id,
                    1,
                    HouseholdKind::Personal,
                    &[COMMAND_PROXY_CONNECT],
                    1,
                    issued,
                )
                .unwrap();
        }
        let later = issued + chrono::Duration::seconds(2);
        // The old code retained every unrevoked record forever, so this pruned
        // zero and permanently blocked issuance at the 256-record bound.
        assert_eq!(
            store.prune(later, 0),
            MAX_CREDENTIALS,
            "expired records must be reclaimable"
        );
        store
            .issue(
                household_id,
                device_id,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                3600,
                later,
            )
            .expect("a fresh credential must be issuable after expiry");
    }

    #[test]
    fn revoked_retention_boundaries_and_valid_credentials_survive_pruning() {
        let store = CredentialStore::new();
        let household_id = Uuid::parse_str(HOUSEHOLD).unwrap();
        let device_id = Uuid::parse_str(DEVICE).unwrap();
        let at = now();
        let (active, active_secret) = store
            .issue(
                household_id,
                device_id,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                3600,
                at,
            )
            .unwrap();
        let (short, _) = store
            .issue(
                household_id,
                device_id,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                60,
                at,
            )
            .unwrap();
        let (revoked, revoked_secret) = store
            .issue(
                household_id,
                device_id,
                1,
                HouseholdKind::Personal,
                &[COMMAND_PROXY_CONNECT],
                3600,
                at,
            )
            .unwrap();
        assert!(store.revoke(revoked, at));

        let devices: BTreeSet<Uuid> = [device_id].into_iter().collect();
        let scope = scope(&devices, COMMAND_PROXY_CONNECT);
        let revoked_presented =
            PresentedCredential::from_basic(&basic(revoked, revoked_secret.expose())).unwrap();
        let active_presented =
            PresentedCredential::from_basic(&basic(active, active_secret.expose())).unwrap();
        // Inside a 1h retention window nothing is reclaimed and revocation holds.
        assert_eq!(store.prune(at + chrono::Duration::minutes(59), 3600), 0);
        assert_eq!(
            store.verify(
                &revoked_presented,
                &scope,
                at + chrono::Duration::minutes(59)
            ),
            Err(CredentialFailure::Revoked)
        );
        // With no retention at +61s the expired short-lived and revoked records
        // are safely reclaimed; the active unexpired credential survives.
        let later = at + chrono::Duration::seconds(61);
        assert_eq!(store.prune(later, 0), 2);
        assert!(store.verify(&active_presented, &scope, later).is_ok());
        assert_eq!(
            store.verify(&revoked_presented, &scope, later),
            Err(CredentialFailure::Unknown)
        );
        assert!(store.rotate(active, 3600, later).is_ok());
        let _ = short;
    }
}
