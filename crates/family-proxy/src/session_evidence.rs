//! Verified session evidence and the server verifier seam.
//!
//! A proxy credential authenticates a *device binding*. Person-specific policy
//! requires a second, independently verifiable artifact: short-lived session
//! evidence issued by an authority that actually verified the current person
//! (OIDC-bound BYOD session, OS session or enrolled mobile identity). Evidence
//! is a bounded JSON payload whose digest is registered by the authority; the
//! worker recomputes SHA-256 and compares in constant time. It is never
//! accepted because of an IP address, a device label, a `Proxy-Authorization`
//! username or any unverified header claim.
//!
//! [`SessionEvidenceVerifier`] is the typed seam the server will implement
//! later. [`LocalEvidenceVerifier`] is a working in-memory authority used for
//! real library and loopback HTTP/CONNECT tests; [`NoEvidenceVerifier`] keeps
//! person attribution default-off. Nothing here contacts a server or claims
//! end-to-end authentication.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use family_policy::{Assignment, Assurance, PersonId, Session, SessionSource};
use rama::utils::bytes::ct::ct_eq_bytes;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vantyr_network_pki::metadata::sha256_hex;

use crate::credentials::{HouseholdKind, DIGEST_CHARS};

/// Fixed evidence schema. Unknown versions are rejected, never interpreted.
pub const EVIDENCE_SCHEMA: u32 = 1;
/// Only this audience is accepted for session evidence.
pub const SESSION_EVIDENCE_AUDIENCE: &str = "vantyr-proxy-session";
/// Commands a session receipt may be scoped to (must match the request).
pub const SESSION_COMMAND_CONNECT: &str = "proxy_connect";
pub const SESSION_COMMAND_HTTP: &str = "proxy_http";
/// Header carrying the UTF-8 JSON evidence payload on a proxy request.
pub const SESSION_EVIDENCE_HEADER: &str = "x-vantyr-session-evidence";
pub const MAX_EVIDENCE_BYTES: usize = 4096;
pub const MAX_NONCE_CHARS: usize = 64;
pub const MAX_CONSUMED_NONCES: usize = 4096;
pub const MAX_EVIDENCE_RETAINED: usize = 1024;

/// Bounded, structured evidence. `verified_person` is optional on purpose: a
/// shared device or an unknown viewer has no attributed person.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionEvidence {
    pub schema: u32,
    pub session_id: Uuid,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub verified_person: Option<PersonId>,
    pub binding_generation: u64,
    pub household_kind: HouseholdKind,
    pub audience: String,
    pub command: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub nonce: String,
}

impl SessionEvidence {
    /// Stable canonical bytes. serde_json and the struct field order define the
    /// wire shape; there is no custom parser or encoding.
    pub fn to_canonical_bytes(&self) -> Result<Vec<u8>, EvidenceFailure> {
        serde_json::to_vec(self).map_err(|_| EvidenceFailure::Malformed)
    }

    fn digest(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn shape_valid(&self) -> bool {
        self.schema == EVIDENCE_SCHEMA
            && self.audience == SESSION_EVIDENCE_AUDIENCE
            && (self.command == SESSION_COMMAND_CONNECT || self.command == SESSION_COMMAND_HTTP)
            && !self.nonce.is_empty()
            && self.nonce.len() <= MAX_NONCE_CHARS
            && self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && self.expires_at > self.issued_at
    }
}

/// Fixed bounded evidence failure codes. No secret, person or device value is
/// ever included in a code or its text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceFailure {
    Unsupported,
    Malformed,
    UnknownEvidence,
    InvalidDigest,
    Expired,
    Revoked,
    Replay,
    AudienceMismatch,
    CommandMismatch,
    HouseholdMismatch,
    DeviceMismatch,
    GenerationMismatch,
    KindMismatch,
    NoVerifiedPerson,
    NoAssignment,
    BoundExceeded,
}

impl EvidenceFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "evidence_unsupported",
            Self::Malformed => "evidence_malformed",
            Self::UnknownEvidence => "evidence_unknown",
            Self::InvalidDigest => "evidence_invalid_digest",
            Self::Expired => "evidence_expired",
            Self::Revoked => "evidence_revoked",
            Self::Replay => "evidence_replay",
            Self::AudienceMismatch => "evidence_audience_mismatch",
            Self::CommandMismatch => "evidence_command_mismatch",
            Self::HouseholdMismatch => "evidence_household_mismatch",
            Self::DeviceMismatch => "evidence_device_mismatch",
            Self::GenerationMismatch => "evidence_generation_mismatch",
            Self::KindMismatch => "evidence_kind_mismatch",
            Self::NoVerifiedPerson => "evidence_no_verified_person",
            Self::NoAssignment => "evidence_no_assignment",
            Self::BoundExceeded => "evidence_bound_exceeded",
        }
    }
}

impl fmt::Display for EvidenceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for EvidenceFailure {}

/// Everything the verifier must match against the already-authenticated
/// credential and the active assignment set. Source addresses and labels are
/// deliberately absent.
#[derive(Clone, Debug)]
pub struct EvidenceExpectation<'a> {
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub generation: u64,
    pub household_kind: HouseholdKind,
    pub command: &'a str,
    pub assignments: &'a [Assignment],
}

/// The typed output of successful verification: a policy-ready verified
/// session and only the active assignments that actually bind that person to
/// that device. On a personal device with no verified person, both are empty
/// and the device default applies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedIdentity {
    pub session: Session,
    pub assignments: Vec<Assignment>,
    pub person: Option<PersonId>,
}

/// Typed verifier interface. A server implementation may call an authoritative
/// introspection endpoint; it must apply the same scope checks and return the
/// same bounded failure codes. The worker never infers identity locally.
pub trait SessionEvidenceVerifier: Send + Sync + fmt::Debug {
    fn verify(
        &self,
        raw: &[u8],
        now: DateTime<Utc>,
        expected: &EvidenceExpectation<'_>,
    ) -> Result<VerifiedIdentity, EvidenceFailure>;
}

/// Default-off verifier. No evidence is accepted, so no person rules can ever
/// be selected through this path.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoEvidenceVerifier;

impl SessionEvidenceVerifier for NoEvidenceVerifier {
    fn verify(
        &self,
        _raw: &[u8],
        _now: DateTime<Utc>,
        _expected: &EvidenceExpectation<'_>,
    ) -> Result<VerifiedIdentity, EvidenceFailure> {
        Err(EvidenceFailure::Unsupported)
    }
}

#[derive(Clone)]
struct EvidenceEntry {
    digest: String,
    revoked: bool,
    issued_at: DateTime<Utc>,
}

impl fmt::Debug for EvidenceEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvidenceEntry")
            .field("digest", &"<redacted>")
            .field("revoked", &self.revoked)
            .field("issued_at", &self.issued_at)
            .finish()
    }
}

/// An in-memory authority for issued session evidence. It registers only the
/// digest, tracks consumed nonces for replay protection, and applies every
/// scope check at verification time. This is a real, independently testable
/// authority — not a stub and not a server claim.
#[derive(Clone)]
pub struct LocalEvidenceVerifier {
    entries: Arc<Mutex<BTreeMap<Uuid, EvidenceEntry>>>,
    consumed: Arc<Mutex<BTreeMap<String, DateTime<Utc>>>>,
}

impl Default for LocalEvidenceVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for LocalEvidenceVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entries = self.entries.lock().map(|m| m.len()).unwrap_or(0);
        let consumed = self.consumed.lock().map(|m| m.len()).unwrap_or(0);
        f.debug_struct("LocalEvidenceVerifier")
            .field("entries", &entries)
            .field("consumed_nonces", &consumed)
            .finish_non_exhaustive()
    }
}

impl LocalEvidenceVerifier {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(BTreeMap::new())),
            consumed: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// Issue evidence from an authority that verified the person. Only the
    /// digest is registered; the canonical JSON is returned once to the caller.
    pub fn issue(&self, evidence: &SessionEvidence) -> Result<Vec<u8>, EvidenceFailure> {
        if !evidence.shape_valid() {
            return Err(EvidenceFailure::Malformed);
        }
        let bytes = evidence.to_canonical_bytes()?;
        if bytes.len() > MAX_EVIDENCE_BYTES {
            return Err(EvidenceFailure::Malformed);
        }
        let mut entries = self.entries.lock().expect("evidence entry lock");
        if entries.len() >= MAX_EVIDENCE_RETAINED && !entries.contains_key(&evidence.session_id) {
            return Err(EvidenceFailure::BoundExceeded);
        }
        entries.insert(
            evidence.session_id,
            EvidenceEntry {
                digest: SessionEvidence::digest(&bytes),
                revoked: false,
                issued_at: evidence.issued_at,
            },
        );
        Ok(bytes)
    }

    /// Revoke issued evidence by session id. A revoked receipt cannot be replayed.
    pub fn revoke(&self, session_id: Uuid) -> bool {
        let mut entries = self.entries.lock().expect("evidence entry lock");
        let Some(entry) = entries.get_mut(&session_id) else {
            return false;
        };
        if entry.revoked {
            false
        } else {
            entry.revoked = true;
            true
        }
    }

    /// Drop stale evidence and consumed nonces. Keeps bounded even under a
    /// long-running worker with many sign-outs.
    pub fn prune(&self, now: DateTime<Utc>, retention_secs: u64) {
        let cutoff = now - chrono::Duration::seconds(retention_secs.min(30 * 24 * 60 * 60) as i64);
        {
            let mut entries = self.entries.lock().expect("evidence entry lock");
            entries.retain(|_, entry| entry.issued_at >= cutoff);
        }
        let mut consumed = self.consumed.lock().expect("evidence nonce lock");
        consumed.retain(|_, at| *at >= cutoff);
        while consumed.len() > MAX_CONSUMED_NONCES {
            let Some(oldest) = consumed.keys().next().cloned() else {
                break;
            };
            consumed.remove(&oldest);
        }
    }
}

impl SessionEvidenceVerifier for LocalEvidenceVerifier {
    fn verify(
        &self,
        raw: &[u8],
        now: DateTime<Utc>,
        expected: &EvidenceExpectation<'_>,
    ) -> Result<VerifiedIdentity, EvidenceFailure> {
        if raw.is_empty() || raw.len() > MAX_EVIDENCE_BYTES {
            return Err(EvidenceFailure::Malformed);
        }
        let evidence: SessionEvidence =
            serde_json::from_slice(raw).map_err(|_| EvidenceFailure::Malformed)?;
        if !evidence.shape_valid() {
            return Err(EvidenceFailure::Malformed);
        }
        // Constant-time digest comparison for both known and unknown ids.
        let computed = SessionEvidence::digest(raw);
        let entries = self.entries.lock().expect("evidence entry lock");
        let dummy = "0".repeat(DIGEST_CHARS);
        let entry = entries.get(&evidence.session_id);
        let stored = entry.map(|e| e.digest.as_str()).unwrap_or(&dummy);
        let matched = stored.len() == DIGEST_CHARS
            && computed.len() == DIGEST_CHARS
            && ct_eq_bytes(computed.as_bytes(), stored.as_bytes());
        let Some(entry) = entry else {
            return Err(EvidenceFailure::UnknownEvidence);
        };
        if !matched {
            return Err(EvidenceFailure::InvalidDigest);
        }
        if entry.revoked {
            return Err(EvidenceFailure::Revoked);
        }
        if now >= evidence.expires_at || now < evidence.issued_at {
            return Err(EvidenceFailure::Expired);
        }
        if evidence.household_id != expected.household_id {
            return Err(EvidenceFailure::HouseholdMismatch);
        }
        if evidence.device_id != expected.device_id {
            return Err(EvidenceFailure::DeviceMismatch);
        }
        if evidence.binding_generation != expected.generation {
            return Err(EvidenceFailure::GenerationMismatch);
        }
        if evidence.household_kind != expected.household_kind {
            return Err(EvidenceFailure::KindMismatch);
        }
        if evidence.audience != SESSION_EVIDENCE_AUDIENCE {
            return Err(EvidenceFailure::AudienceMismatch);
        }
        if evidence.command != expected.command {
            return Err(EvidenceFailure::CommandMismatch);
        }
        // A shared-household-kind credential can never attribute a person, and
        // asserted/parent-assertion evidence is not represented here at all.
        if evidence.household_kind == HouseholdKind::Shared && evidence.verified_person.is_some() {
            return Err(EvidenceFailure::KindMismatch);
        }
        let person = evidence.verified_person;
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
        drop(entries);

        // Single-use nonce: a replayed receipt cannot establish a second
        // session even if its digest is still registered.
        {
            let mut consumed = self.consumed.lock().expect("evidence nonce lock");
            if consumed.contains_key(&evidence.nonce) {
                return Err(EvidenceFailure::Replay);
            }
            consumed.insert(evidence.nonce.clone(), now);
            while consumed.len() > MAX_CONSUMED_NONCES {
                let Some(oldest) = consumed.keys().next().cloned() else {
                    break;
                };
                consumed.remove(&oldest);
            }
        }

        Ok(VerifiedIdentity {
            session: Session {
                id: evidence.session_id,
                device_id: evidence.device_id,
                verified_person: person,
                source: SessionSource::ProxyCredential,
                assurance: Assurance::Verified,
                started_at: evidence.issued_at,
                expires_at: evidence.expires_at,
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
    use family_policy::{AssignmentRole, DeviceId, HouseholdId};

    const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
    const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const PERSON: &str = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-27T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn evidence(person: Option<Uuid>, command: &str, nonce: &str) -> SessionEvidence {
        SessionEvidence {
            schema: EVIDENCE_SCHEMA,
            session_id: Uuid::new_v4(),
            household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
            device_id: Uuid::parse_str(DEVICE).unwrap(),
            verified_person: person,
            binding_generation: 3,
            household_kind: HouseholdKind::Personal,
            audience: SESSION_EVIDENCE_AUDIENCE.to_owned(),
            command: command.to_owned(),
            issued_at: now(),
            expires_at: now() + chrono::Duration::minutes(10),
            nonce: nonce.to_owned(),
        }
    }

    fn assignment() -> Assignment {
        Assignment {
            id: Uuid::new_v4(),
            person_id: Uuid::parse_str(PERSON).unwrap(),
            device_id: Uuid::parse_str(DEVICE).unwrap(),
            role: AssignmentRole::Member,
            active: true,
        }
    }

    fn expectation<'a>(command: &'a str, assignments: &'a [Assignment]) -> EvidenceExpectation<'a> {
        EvidenceExpectation {
            household_id: HouseholdId::parse_str(HOUSEHOLD).unwrap(),
            device_id: DeviceId::parse_str(DEVICE).unwrap(),
            generation: 3,
            household_kind: HouseholdKind::Personal,
            command,
            assignments,
        }
    }

    #[test]
    fn verified_evidence_yields_a_policy_ready_session() {
        let verifier = LocalEvidenceVerifier::new();
        let ev = evidence(
            Some(Uuid::parse_str(PERSON).unwrap()),
            SESSION_COMMAND_CONNECT,
            "nonce-1",
        );
        let raw = verifier.issue(&ev).unwrap();
        let assignments = [assignment()];
        let verified = verifier
            .verify(
                &raw,
                now(),
                &expectation(SESSION_COMMAND_CONNECT, &assignments),
            )
            .unwrap();
        assert_eq!(verified.person, Some(Uuid::parse_str(PERSON).unwrap()));
        assert_eq!(verified.session.source, SessionSource::ProxyCredential);
        assert_eq!(verified.session.assurance, Assurance::Verified);
        assert!(verified.session.valid_at(now()));
        assert_eq!(verified.assignments.len(), 1);
    }

    #[test]
    fn replay_revocation_and_expiry_are_rejected() {
        let verifier = LocalEvidenceVerifier::new();
        let ev = evidence(
            Some(Uuid::parse_str(PERSON).unwrap()),
            SESSION_COMMAND_HTTP,
            "nonce-2",
        );
        let raw = verifier.issue(&ev).unwrap();
        let assignments = [assignment()];
        let exp = expectation(SESSION_COMMAND_HTTP, &assignments);
        assert!(verifier.verify(&raw, now(), &exp).is_ok());
        assert_eq!(
            verifier.verify(&raw, now(), &exp),
            Err(EvidenceFailure::Replay),
            "a second use of the same nonce must fail"
        );

        let ev2 = evidence(
            Some(Uuid::parse_str(PERSON).unwrap()),
            SESSION_COMMAND_HTTP,
            "nonce-3",
        );
        let raw2 = verifier.issue(&ev2).unwrap();
        assert!(verifier.revoke(ev2.session_id));
        assert_eq!(
            verifier.verify(&raw2, now(), &exp),
            Err(EvidenceFailure::Revoked)
        );

        let ev3 = evidence(None, SESSION_COMMAND_HTTP, "nonce-4");
        let raw3 = verifier.issue(&ev3).unwrap();
        assert_eq!(
            verifier.verify(&raw3, ev3.expires_at, &exp),
            Err(EvidenceFailure::Expired)
        );
    }

    #[test]
    fn tampered_unscoped_and_unassigned_evidence_are_rejected() {
        let verifier = LocalEvidenceVerifier::new();
        let person = Some(Uuid::parse_str(PERSON).unwrap());
        let ev = evidence(person, SESSION_COMMAND_CONNECT, "nonce-5");
        let raw = verifier.issue(&ev).unwrap();
        let assignments = [assignment()];

        let mut tampered = raw.clone();
        if let Some(last) = tampered.last_mut() {
            *last = if *last == b'0' { b'1' } else { b'0' };
        }
        assert!(matches!(
            verifier.verify(
                &tampered,
                now(),
                &expectation(SESSION_COMMAND_CONNECT, &assignments)
            ),
            Err(EvidenceFailure::Malformed | EvidenceFailure::InvalidDigest)
        ));
        assert_eq!(
            verifier.verify(
                &raw,
                now(),
                &expectation(SESSION_COMMAND_HTTP, &assignments)
            ),
            Err(EvidenceFailure::CommandMismatch)
        );
        let wrong_household = EvidenceExpectation {
            household_id: Uuid::new_v4(),
            ..expectation(SESSION_COMMAND_CONNECT, &assignments)
        };
        assert_eq!(
            verifier.verify(&raw, now(), &wrong_household),
            Err(EvidenceFailure::HouseholdMismatch)
        );
        let wrong_generation = EvidenceExpectation {
            generation: 4,
            ..expectation(SESSION_COMMAND_CONNECT, &assignments)
        };
        assert_eq!(
            verifier.verify(&raw, now(), &wrong_generation),
            Err(EvidenceFailure::GenerationMismatch)
        );
        assert_eq!(
            verifier.verify(&raw, now(), &expectation(SESSION_COMMAND_CONNECT, &[])),
            Err(EvidenceFailure::NoAssignment)
        );

        let unknown = LocalEvidenceVerifier::new();
        assert_eq!(
            unknown.verify(
                &raw,
                now(),
                &expectation(SESSION_COMMAND_CONNECT, &assignments)
            ),
            Err(EvidenceFailure::UnknownEvidence)
        );
    }

    #[test]
    fn shared_kind_and_default_off_never_attribute_a_person() {
        let verifier = LocalEvidenceVerifier::new();
        let mut ev = evidence(
            Some(Uuid::parse_str(PERSON).unwrap()),
            SESSION_COMMAND_CONNECT,
            "nonce-6",
        );
        ev.household_kind = HouseholdKind::Shared;
        let raw = verifier.issue(&ev).unwrap();
        let assignments = [assignment()];
        let mut exp = expectation(SESSION_COMMAND_CONNECT, &assignments);
        exp.household_kind = HouseholdKind::Shared;
        assert_eq!(
            verifier.verify(&raw, now(), &exp),
            Err(EvidenceFailure::KindMismatch),
            "a shared device must not attribute a verified person"
        );

        let off = NoEvidenceVerifier;
        let no_person = evidence(None, SESSION_COMMAND_CONNECT, "nonce-7");
        let raw = verifier.issue(&no_person).unwrap();
        assert_eq!(
            off.verify(&raw, now(), &expectation(SESSION_COMMAND_CONNECT, &[])),
            Err(EvidenceFailure::Unsupported)
        );
    }

    #[test]
    fn debug_and_codes_never_embed_secrets_or_identities() {
        let verifier = LocalEvidenceVerifier::new();
        let ev = evidence(
            Some(Uuid::parse_str(PERSON).unwrap()),
            SESSION_COMMAND_CONNECT,
            "nonce-8",
        );
        let raw = verifier.issue(&ev).unwrap();
        let digest = SessionEvidence::digest(&raw);
        assert!(!format!("{verifier:?}").contains(&digest));
        assert!(!format!("{:?}", EvidenceFailure::Replay).contains(PERSON));
        assert!(!format!("{ev:?}").contains(&digest));
    }
}
