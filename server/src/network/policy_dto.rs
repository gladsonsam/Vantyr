//! Typed request/response shapes and bounded validation for versioned network
//! policy. The stored model is the reused pure `vantyr_network_policy::Policy`;
//! this module never defines a second policy model.
//!
//! Caller-supplied `household_id`, `revision` and `published_at` are not fields
//! here at all (unknown fields are rejected): those are server-assigned from
//! the URL path, a monotonic household counter and the server clock. Person
//! rules and exception payloads are explicitly refused in this slice because
//! grants cannot be proven without verified-session integration.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use vantyr_network_policy::{Effect, Exception, PersonId, Policy, Rule, RuleMatcher};

use crate::error::{ApiError, ApiResult};

/// Only this schema version is stored or served. A stored row with any other
/// version is never served as if it were understood.
pub const POLICY_SCHEMA_VERSION: i32 = 1;

/// Whole canonical policy body cap (64 KiB), mirrored in migration 0077.
pub const MAX_POLICY_BYTES: usize = 64 * 1024;
/// Bounded history: keep the newest N revisions per household; pinned
/// (desired / current) revisions are never pruned. Rollback provenance does
/// not keep its source payload alive outside the history window.
pub const MAX_POLICY_HISTORY: i64 = 25;

pub const MAX_PROFILES: usize = 32;
pub const MAX_RULES: usize = 256;
pub const MAX_RULES_PER_PROFILE: usize = 128;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_REASON_LEN: usize = 200;
pub const MAX_TIMEZONE_LEN: usize = 64;
pub const MAX_DOMAIN_LEN: usize = 253;
/// `stale_after_secs` is bounded independently of event retention.
pub const MAX_STALE_SECS: u64 = 30 * 24 * 60 * 60;

/// The server-side maximum revision that fits the BIGINT storage column.
pub fn valid_revision(value: u64) -> bool {
    value >= 1 && value <= i64::MAX as u64
}

// ─── Requests ────────────────────────────────────────────────────────────────

/// The policy content a scoped admin may submit. `expected_revision` is an
/// optimistic-concurrency token, not a revision to accept from the caller.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDraft {
    pub baseline: Vec<Rule>,
    pub device_profiles: std::collections::BTreeMap<String, Vec<Rule>>,
    #[serde(default)]
    pub person_rules: std::collections::BTreeMap<PersonId, Vec<Rule>>,
    #[serde(default)]
    pub exceptions: Vec<Exception>,
    pub default_effect: Effect,
    pub timezone: String,
    pub stale_after_secs: u64,
    pub event_retention_secs: u64,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollbackBody {
    /// A historical revision in the SAME household whose content is copied.
    pub source_revision: u64,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredPolicyBody {
    /// A stored revision in the SAME household (not a caller revision claim).
    pub revision: u64,
}

/// Worker read request. The secret is only in the bearer header, never here.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadPolicyBody {
    pub audience: String,
    pub command: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
}

// ─── Responses ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct PublishResponse {
    pub revision: u64,
    pub body_sha256: String,
    /// A saved proposal is not applied anywhere; no applied/enforced flag.
    pub status: &'static str,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PolicyVersionMeta {
    pub household_id: Uuid,
    pub revision: i64,
    pub schema_version: i32,
    pub source_kind: String,
    pub rolled_back_from_revision: Option<i64>,
    pub published_at: DateTime<Utc>,
    pub published_by: Option<Uuid>,
    pub body_sha256: String,
    pub body_bytes: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DesiredPolicy {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub revision: i64,
    pub assigned_by: Option<Uuid>,
    pub assigned_at: DateTime<Utc>,
}

/// Worker retrieval result. `body_sha256` is a content digest of the exact
/// stored bytes, NOT a signature and NOT an enforcement/verification claim.
#[derive(Debug, Serialize)]
pub struct PolicyReadResponse {
    pub gateway_id: Uuid,
    pub revision: u64,
    pub original_published_at: DateTime<Utc>,
    pub schema_version: i32,
    pub policy: Policy,
    pub body_sha256: String,
}

// ─── Validation ──────────────────────────────────────────────────────────────

fn reject(message: &'static str) -> ApiError {
    ApiError::bad_request(message)
}

fn bounded_id(raw: &str, what: &'static str) -> ApiResult<()> {
    if raw.is_empty()
        || raw.len() > MAX_ID_LEN
        || raw.chars().any(char::is_control)
        || raw.chars().any(char::is_whitespace)
    {
        return Err(reject(what));
    }
    Ok(())
}

fn valid_domain(raw: &str) -> bool {
    if raw.is_empty()
        || raw.len() > MAX_DOMAIN_LEN
        || raw.starts_with('.')
        || raw.ends_with('.')
        || raw.chars().any(char::is_control)
        || raw.chars().any(char::is_whitespace)
    {
        return false;
    }
    raw.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn validate_matcher(matcher: &RuleMatcher) -> ApiResult<()> {
    match matcher {
        RuleMatcher::DomainSuffix(value) | RuleMatcher::HostExact(value) => {
            if valid_domain(value) {
                Ok(())
            } else {
                Err(reject("rule matcher must be a valid domain name"))
            }
        }
        // Category needs an external classifier and `Any` is unbounded: both
        // are refused explicitly rather than stored/silently ignored.
        RuleMatcher::Category(_) => Err(reject("category matchers are not supported")),
        RuleMatcher::Any => Err(reject("any matchers are not supported")),
    }
}

fn validate_schedule(schedule: &vantyr_network_policy::Schedule) -> ApiResult<()> {
    if schedule.weekdays.is_empty() || schedule.weekdays.len() > 7 {
        return Err(reject("schedule weekdays must contain 1..=7 days"));
    }
    let mut days = BTreeSet::new();
    for day in &schedule.weekdays {
        if *day > 6 || !days.insert(*day) {
            return Err(reject("schedule weekdays must be unique values 0..=6"));
        }
    }
    if schedule.start_minute > 1440 || schedule.end_minute > 1440 {
        return Err(reject("schedule minutes must be 0..=1440"));
    }
    if schedule.timezone.is_empty()
        || schedule.timezone.len() > MAX_TIMEZONE_LEN
        || schedule.timezone.chars().any(char::is_control)
        || schedule.timezone.parse::<chrono_tz::Tz>().is_err()
    {
        return Err(reject("schedule timezone must be an IANA timezone"));
    }
    Ok(())
}

fn validate_rule(
    rule: &Rule,
    baseline_only_deny: bool,
    seen_ids: &mut BTreeSet<String>,
) -> ApiResult<()> {
    bounded_id(&rule.id, "rule id must be 1..=64 non-blank chars")?;
    if !seen_ids.insert(rule.id.clone()) {
        return Err(reject("rule ids must be unique within a policy"));
    }
    if baseline_only_deny && rule.effect == Effect::Allow {
        return Err(reject("the safety baseline may only contain deny rules"));
    }
    if rule.reason.len() > MAX_REASON_LEN || rule.reason.chars().any(char::is_control) {
        return Err(reject("rule reason is unbounded or contains control chars"));
    }
    validate_matcher(&rule.matcher)?;
    if let Some(schedule) = &rule.schedule {
        validate_schedule(schedule)?;
    }
    Ok(())
}

/// Validate the whole draft and assemble the server-owned canonical Policy.
pub fn build_policy(
    draft: PolicyDraft,
    household_id: Uuid,
    revision: u64,
    published_at: DateTime<Utc>,
) -> ApiResult<Policy> {
    if draft.default_effect != Effect::Deny {
        return Err(reject("the household default effect must be deny"));
    }
    if !draft.person_rules.is_empty() || !draft.exceptions.is_empty() {
        // No verified-session integration exists in this slice, so any grant
        // carried by these fields cannot be proven. Refuse the payload whole.
        return Err(reject(
            "person rules and exceptions are not supported in this slice",
        ));
    }
    if draft.timezone.is_empty()
        || draft.timezone.len() > MAX_TIMEZONE_LEN
        || draft.timezone.chars().any(char::is_control)
        || draft.timezone.parse::<chrono_tz::Tz>().is_err()
    {
        return Err(reject("household timezone must be an IANA timezone"));
    }
    if draft.stale_after_secs == 0 || draft.stale_after_secs > MAX_STALE_SECS {
        return Err(reject("stale_after_secs is outside its bound"));
    }
    let event_max = vantyr_network_policy::store::MAX_NETWORK_EVENT_RETENTION_SECS;
    if draft.event_retention_secs == 0 || draft.event_retention_secs > event_max {
        return Err(reject("event_retention_secs is outside its bound"));
    }
    if let Some(expected) = draft.expected_revision {
        if !valid_revision(expected) {
            return Err(reject("expected_revision is outside its bound"));
        }
    }
    if draft.device_profiles.len() > MAX_PROFILES {
        return Err(reject("too many device profiles"));
    }
    let mut total_rules = draft.baseline.len();
    let mut seen_ids = BTreeSet::new();
    for rule in &draft.baseline {
        validate_rule(rule, true, &mut seen_ids)?;
    }
    for (profile, rules) in &draft.device_profiles {
        bounded_id(profile, "profile id must be 1..=64 non-blank chars")?;
        if !profile
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        {
            return Err(reject("profile id contains unsupported characters"));
        }
        if rules.len() > MAX_RULES_PER_PROFILE {
            return Err(reject("too many rules in a device profile"));
        }
        total_rules = total_rules.saturating_add(rules.len());
        if total_rules > MAX_RULES {
            return Err(reject("policy contains too many rules"));
        }
        for rule in rules {
            validate_rule(rule, false, &mut seen_ids)?;
        }
    }

    let policy = Policy {
        household_id,
        revision,
        baseline: draft.baseline,
        device_profiles: draft.device_profiles,
        // Explicitly empty: never inferred from a caller payload.
        person_rules: std::collections::BTreeMap::new(),
        exceptions: Vec::new(),
        default_effect: Effect::Deny,
        timezone: draft.timezone,
        stale_after_secs: draft.stale_after_secs,
        event_retention_secs: draft.event_retention_secs,
        published_at,
    };
    let bytes = canonical_bytes(&policy)?;
    if bytes.len() > MAX_POLICY_BYTES {
        return Err(reject("canonical policy exceeds 64 KiB"));
    }
    Ok(policy)
}

/// Deterministic canonical bytes of the typed Policy (BTreeMap order is
/// stable and serde emits struct fields in declaration order).
pub fn canonical_bytes(policy: &Policy) -> ApiResult<Vec<u8>> {
    serde_json::to_vec(policy).map_err(|e| ApiError::Internal(e.into()))
}

/// SHA-256 content digest of the exact stored bytes, via the maintained helper.
pub fn digest(bytes: &[u8]) -> String {
    crate::auth::secrets::sha256_hex_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vantyr_network_policy::RuleMatcher;

    fn draft() -> PolicyDraft {
        PolicyDraft {
            baseline: vec![],
            device_profiles: std::collections::BTreeMap::new(),
            person_rules: std::collections::BTreeMap::new(),
            exceptions: vec![],
            default_effect: Effect::Deny,
            timezone: "Australia/Sydney".into(),
            stale_after_secs: 3600,
            event_retention_secs: 86400,
            expected_revision: None,
        }
    }

    fn rule(id: &str, effect: Effect, matcher: RuleMatcher) -> Rule {
        Rule {
            id: id.into(),
            effect,
            matcher,
            schedule: None,
            reason: String::new(),
        }
    }

    #[test]
    fn valid_draft_builds_canonical_policy() {
        let mut d = draft();
        d.baseline.push(rule(
            "safety",
            Effect::Deny,
            RuleMatcher::DomainSuffix("malware.example".into()),
        ));
        let p = build_policy(d, Uuid::new_v4(), 1, Utc::now()).unwrap();
        assert_eq!(p.default_effect, Effect::Deny);
        assert!(p.person_rules.is_empty() && p.exceptions.is_empty());
        let bytes = canonical_bytes(&p).unwrap();
        assert!(!digest(&bytes).is_empty());
    }

    #[test]
    fn rejects_baseline_allow_bad_domains_and_unsupported_fields() {
        let mut d = draft();
        d.baseline.push(rule(
            "allow",
            Effect::Allow,
            RuleMatcher::HostExact("x.example".into()),
        ));
        assert!(build_policy(d, Uuid::new_v4(), 1, Utc::now()).is_err());

        let mut d = draft();
        d.baseline.push(rule(
            "bad",
            Effect::Deny,
            RuleMatcher::DomainSuffix("https://evil/test".into()),
        ));
        assert!(build_policy(d, Uuid::new_v4(), 1, Utc::now()).is_err());

        let mut d = draft();
        d.default_effect = Effect::Allow;
        assert!(build_policy(d, Uuid::new_v4(), 1, Utc::now()).is_err());

        // A non-empty person rule payload is refused, never silently ignored.
        let mut d = draft();
        let person = Uuid::new_v4();
        d.person_rules.insert(person, vec![]);
        assert!(build_policy(d, Uuid::new_v4(), 1, Utc::now()).is_err());
    }
}
