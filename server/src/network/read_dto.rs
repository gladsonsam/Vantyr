//! Typed DTOs, bounded validation and pure semantics for the network management
//! read-contract slice.
//!
//! Every response here is a read-only projection of rows that already exist.
//! No handler in this slice publishes, assigns, acknowledges or enforces
//! anything, and no worker credential is involved: the browser uses its normal
//! session cookie. `body_sha256` is a content digest of the exact stored bytes
//! (integrity only), never a signature, a verification claim or a secret.
//!
//! The core `vantyr_network_policy::Policy` model is reused directly; this
//! module never defines a second policy model or a patch protocol.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vantyr_network_policy::{Policy, Rule};

use crate::error::{ApiError, ApiResult};

use super::dto::NetworkAudit;
use super::policy_dto::{valid_revision, MAX_POLICY_BYTES, POLICY_SCHEMA_VERSION};

/// Hard cap on rule changes returned by one diff. A policy is already bounded
/// to 256 rules on each side, so 512 covers every possible added/removed/
/// changed combination; the cap and `omitted_changes` are still reported so a
/// truncated response is never mistaken for a complete one.
pub const MAX_DIFF_RULE_CHANGES: usize = 512;
/// There are only a handful of comparable policy settings; this is a guardrail.
pub const MAX_DIFF_SETTING_CHANGES: usize = 16;
/// Exact-match audit filters are bounded text, never parsed as a user UUID.
pub const MAX_AUDIT_FILTER_LEN: usize = 128;

// ─── Responses ───────────────────────────────────────────────────────────────

/// Immutable stored policy plus its immutable server metadata. `policy` is the
/// typed core model decoded from the exact bytes covered by `body_sha256`.
#[derive(Debug, Serialize)]
pub struct PolicyVersionView {
    pub household_id: Uuid,
    pub revision: u64,
    pub schema_version: i32,
    pub source_kind: String,
    pub rolled_back_from_revision: Option<i64>,
    pub published_at: DateTime<Utc>,
    pub published_by: Option<Uuid>,
    pub body_sha256: String,
    pub body_bytes: usize,
    pub policy: Policy,
}

/// Revision/time/digest provenance. Kept separate from `settings`/`rules` so a
/// rollback or a re-publish is not reported as a content change: only the
/// metadata describes *when* a body was stored and under which revision.
#[derive(Debug, Serialize)]
pub struct PolicyDiffProvenance {
    pub revision: u64,
    pub schema_version: i32,
    pub source_kind: String,
    pub rolled_back_from_revision: Option<i64>,
    pub published_at: DateTime<Utc>,
    pub body_sha256: String,
}

#[derive(Debug, Serialize)]
pub struct SettingChange {
    pub field: &'static str,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RuleChange {
    /// Profile name, or `baseline` for the non-overridable safety rules.
    pub scope: String,
    /// Core rule id (unique within a stored policy).
    pub id: String,
    /// One of `added`, `removed`, `changed`.
    pub change: &'static str,
    pub before: Option<Rule>,
    pub after: Option<Rule>,
}

#[derive(Debug, Serialize)]
pub struct PolicyDiffCounts {
    pub added_rules: usize,
    pub removed_rules: usize,
    pub changed_rules: usize,
    pub changed_settings: usize,
    pub total_rules_from: usize,
    pub total_rules_to: usize,
}

#[derive(Debug, Serialize)]
pub struct PolicyDiffResponse {
    pub household_id: Uuid,
    pub from: PolicyDiffProvenance,
    pub to: PolicyDiffProvenance,
    /// True only when settings or rule content changed, ignoring revision,
    /// published_at and digest provenance.
    pub content_changed: bool,
    pub settings: Vec<SettingChange>,
    pub rules: Vec<RuleChange>,
    pub counts: PolicyDiffCounts,
    /// Explicit truncation flag: never silently omit a change.
    pub truncated: bool,
    pub omitted_changes: usize,
}

/// Compatible extension of the existing household audit response: `rows` keeps
/// its old shape and ordering; the extra fields make paging safe under inserts.
#[derive(Debug, Serialize)]
pub struct AuditPage {
    pub rows: Vec<NetworkAudit>,
    pub total: i64,
    pub has_more: bool,
    pub next_offset: Option<i64>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct EnrollmentContext {
    pub household_id: Uuid,
    pub household_name: String,
    pub person_id: Uuid,
    pub person_display_name: String,
    pub binding_id: Uuid,
    pub generation: i64,
}

#[derive(Debug, Serialize)]
pub struct EnrollmentContextPage {
    pub contexts: Vec<EnrollmentContext>,
    pub count: usize,
    pub total: i64,
    pub has_more: bool,
    pub next_offset: Option<i64>,
}

// ─── Requests ────────────────────────────────────────────────────────────────

/// `?from_revision=N&to_revision=M`. Both are required and are parsed here so a
/// malformed value is a typed 400, not an extractor 422.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiffParams {
    pub from_revision: Option<String>,
    pub to_revision: Option<String>,
}

impl DiffParams {
    pub fn revisions(&self) -> ApiResult<(u64, u64)> {
        let parse = |raw: Option<&String>, name: &'static str| -> ApiResult<u64> {
            let raw = raw.ok_or_else(|| ApiError::bad_request(format!("{name} is required")))?;
            let value = raw
                .parse::<u64>()
                .map_err(|_| ApiError::bad_request(format!("{name} must be a positive integer")))?;
            if !valid_revision(value) {
                return Err(ApiError::bad_request(format!(
                    "{name} is outside its bound"
                )));
            }
            Ok(value)
        };
        Ok((
            parse(self.from_revision.as_ref(), "from_revision")?,
            parse(self.to_revision.as_ref(), "to_revision")?,
        ))
    }
}

/// Compatible superset of `PageParams` used by `GET .../audit`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditQuery {
    pub action: Option<String>,
    pub actor: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

fn default_limit() -> i64 {
    50
}

#[derive(Debug, Clone)]
pub struct AuditFilters {
    pub action: Option<String>,
    pub actor: Option<String>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub limit: i64,
    pub offset: i64,
}

fn bounded_exact_text(raw: String, name: &'static str) -> ApiResult<String> {
    if raw.is_empty() || raw.len() > MAX_AUDIT_FILTER_LEN || raw.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "{name} must be 1..={MAX_AUDIT_FILTER_LEN} chars with no control characters"
        )));
    }
    Ok(raw)
}

impl AuditQuery {
    pub fn validate(self) -> ApiResult<AuditFilters> {
        if !(1..=1000).contains(&self.limit) {
            return Err(ApiError::bad_request("limit must be between 1 and 1000"));
        }
        if !(0..=100_000).contains(&self.offset) {
            return Err(ApiError::bad_request("offset must be between 0 and 100000"));
        }
        let parse_ts = |raw: String, name: &'static str| -> ApiResult<DateTime<Utc>> {
            DateTime::parse_from_rfc3339(&raw)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|_| ApiError::bad_request(format!("{name} must be an RFC3339 timestamp")))
        };
        let action = self
            .action
            .map(|v| bounded_exact_text(v, "action"))
            .transpose()?;
        let actor = self
            .actor
            .map(|v| bounded_exact_text(v, "actor"))
            .transpose()?;
        let from = self.from.map(|v| parse_ts(v, "from")).transpose()?;
        let to = self.to.map(|v| parse_ts(v, "to")).transpose()?;
        if let (Some(from), Some(to)) = (from, to) {
            if from > to {
                return Err(ApiError::bad_request("from must not be after to"));
            }
        }
        Ok(AuditFilters {
            action,
            actor,
            from,
            to,
            limit: self.limit,
            offset: self.offset,
        })
    }
}

// ─── Stored body validation / pure diff ─────────────────────────────────────

/// Metadata plus exact body bytes of one stored immutable policy row.
#[derive(Debug, sqlx::FromRow)]
pub struct StoredPolicyRow {
    pub household_id: Uuid,
    pub revision: i64,
    pub schema_version: i32,
    pub source_kind: String,
    pub rolled_back_from_revision: Option<i64>,
    pub published_at: DateTime<Utc>,
    pub published_by: Option<Uuid>,
    pub body_sha256: String,
    pub body: Vec<u8>,
}

fn unreadable() -> ApiError {
    ApiError::not_found("policy revision is not readable in this household")
}

/// Check schema, bounds, digest and model self-consistency before serving a
/// stored body. Anything inconsistent is an honest 404, never an accepted
/// policy: malformed stored data is not silently served as if it were valid.
pub fn decode_stored(row: &StoredPolicyRow) -> ApiResult<PolicyVersionView> {
    if row.schema_version != POLICY_SCHEMA_VERSION
        || row.body.is_empty()
        || row.body.len() > MAX_POLICY_BYTES
        || super::policy_dto::digest(&row.body) != row.body_sha256
    {
        return Err(unreadable());
    }
    let policy: Policy = serde_json::from_slice(&row.body).map_err(|_| unreadable())?;
    if policy.household_id != row.household_id || policy.revision != row.revision as u64 {
        return Err(unreadable());
    }
    Ok(PolicyVersionView {
        household_id: row.household_id,
        revision: row.revision as u64,
        schema_version: row.schema_version,
        source_kind: row.source_kind.clone(),
        rolled_back_from_revision: row.rolled_back_from_revision,
        published_at: row.published_at,
        published_by: row.published_by,
        body_sha256: row.body_sha256.clone(),
        body_bytes: row.body.len(),
        policy,
    })
}

fn provenance(view: &PolicyVersionView) -> PolicyDiffProvenance {
    PolicyDiffProvenance {
        revision: view.revision,
        schema_version: view.schema_version,
        source_kind: view.source_kind.clone(),
        rolled_back_from_revision: view.rolled_back_from_revision,
        published_at: view.published_at,
        body_sha256: view.body_sha256.clone(),
    }
}

fn setting(
    field: &'static str,
    before: serde_json::Value,
    after: serde_json::Value,
) -> SettingChange {
    SettingChange {
        field,
        before,
        after,
    }
}

fn json<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn indexed_rules(policy: &Policy) -> BTreeMap<(String, String), &Rule> {
    let mut out = BTreeMap::new();
    for rule in &policy.baseline {
        out.insert(("baseline".to_string(), rule.id.clone()), rule);
    }
    for (profile, rules) in &policy.device_profiles {
        for rule in rules {
            out.insert((profile.clone(), rule.id.clone()), rule);
        }
    }
    out
}

/// Deterministic semantic diff of two already-decoded stored policies.
/// Revision, published_at and digest live only in `from`/`to` provenance; equal
/// bodies always produce an empty content diff even after a rollback.
pub fn build_diff(from: &PolicyVersionView, to: &PolicyVersionView) -> PolicyDiffResponse {
    let a = &from.policy;
    let b = &to.policy;

    let mut settings = Vec::new();
    macro_rules! compare {
        ($before:expr, $after:expr, $name:expr) => {{
            let before = json(&$before);
            let after = json(&$after);
            if before != after {
                settings.push(setting($name, before, after));
            }
        }};
    }
    compare!(a.default_effect, b.default_effect, "default_effect");
    compare!(a.timezone, b.timezone, "timezone");
    compare!(a.stale_after_secs, b.stale_after_secs, "stale_after_secs");
    compare!(
        a.event_retention_secs,
        b.event_retention_secs,
        "event_retention_secs"
    );
    compare!(a.person_rules, b.person_rules, "person_rules");
    compare!(a.exceptions, b.exceptions, "exceptions");

    let from_rules = indexed_rules(a);
    let to_rules = indexed_rules(b);
    let mut keys: BTreeSet<(String, String)> = BTreeSet::new();
    keys.extend(from_rules.keys().cloned());
    keys.extend(to_rules.keys().cloned());

    let mut rules = Vec::new();
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut changed = 0usize;
    for key in keys {
        let (scope, id) = key;
        match (
            from_rules.get(&(scope.clone(), id.clone())),
            to_rules.get(&(scope.clone(), id.clone())),
        ) {
            (Some(before), None) => {
                removed += 1;
                rules.push(RuleChange {
                    scope,
                    id,
                    change: "removed",
                    before: Some((*before).clone()),
                    after: None,
                });
            }
            (None, Some(after)) => {
                added += 1;
                rules.push(RuleChange {
                    scope,
                    id,
                    change: "added",
                    before: None,
                    after: Some((*after).clone()),
                });
            }
            (Some(before), Some(after)) if *before != *after => {
                changed += 1;
                rules.push(RuleChange {
                    scope,
                    id,
                    change: "changed",
                    before: Some((*before).clone()),
                    after: Some((*after).clone()),
                });
            }
            _ => {}
        }
    }

    let changed_settings = settings.len();
    let total_changes = changed_settings + added + removed + changed;
    let mut omitted_changes = 0usize;
    // settings first (small, stable), then rules; counts always describe the
    // full diff, and truncation is reported explicitly.
    if settings.len() > MAX_DIFF_SETTING_CHANGES {
        omitted_changes += settings.len() - MAX_DIFF_SETTING_CHANGES;
        settings.truncate(MAX_DIFF_SETTING_CHANGES);
    }
    if rules.len() > MAX_DIFF_RULE_CHANGES {
        omitted_changes += rules.len() - MAX_DIFF_RULE_CHANGES;
        rules.truncate(MAX_DIFF_RULE_CHANGES);
    }

    PolicyDiffResponse {
        household_id: from.household_id,
        from: provenance(from),
        to: provenance(to),
        content_changed: total_changes > 0,
        settings,
        rules,
        counts: PolicyDiffCounts {
            added_rules: added,
            removed_rules: removed,
            changed_rules: changed,
            changed_settings,
            total_rules_from: from_rules.len(),
            total_rules_to: to_rules.len(),
        },
        truncated: omitted_changes > 0,
        omitted_changes,
    }
}

// ─── Pure validation tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use vantyr_network_policy::{Effect, RuleMatcher};

    fn view(revision: u64, timezone: &str) -> PolicyVersionView {
        let epoch = Utc.timestamp_opt(0, 0).unwrap();
        PolicyVersionView {
            household_id: Uuid::nil(),
            revision,
            schema_version: POLICY_SCHEMA_VERSION,
            source_kind: "publish".into(),
            rolled_back_from_revision: None,
            published_at: epoch,
            published_by: None,
            body_sha256: "0".repeat(64),
            body_bytes: 2,
            policy: Policy {
                household_id: Uuid::nil(),
                revision,
                baseline: vec![],
                device_profiles: BTreeMap::new(),
                person_rules: BTreeMap::new(),
                exceptions: vec![],
                default_effect: Effect::Deny,
                timezone: timezone.into(),
                stale_after_secs: 3600,
                event_retention_secs: 86400,
                published_at: epoch,
            },
        }
    }

    #[test]
    fn diff_ignores_server_provenance() {
        let from = view(1, "Australia/Sydney");
        let mut to = view(7, "Australia/Sydney");
        to.source_kind = "rollback".into();
        to.rolled_back_from_revision = Some(1);
        to.published_at = Utc.timestamp_opt(500, 0).unwrap();
        let diff = build_diff(&from, &to);
        assert!(!diff.content_changed);
        assert!(diff.rules.is_empty() && diff.settings.is_empty());
        assert_eq!(diff.from.revision, 1);
        assert_eq!(diff.to.revision, 7);
        assert_eq!(diff.to.published_at, to.published_at);
    }

    #[test]
    fn diff_reports_added_removed_changed_rules_and_settings() {
        let mut from = view(1, "Australia/Sydney");
        let rule = |id: &str, domain: &str| Rule {
            id: id.into(),
            effect: Effect::Deny,
            matcher: RuleMatcher::DomainSuffix(domain.into()),
            schedule: None,
            reason: String::new(),
        };
        from.policy.baseline = vec![rule("keep", "a.example"), rule("gone", "b.example")];
        let mut to = view(2, "UTC");
        to.policy.baseline = vec![rule("keep", "changed.example"), rule("new", "c.example")];
        to.policy.stale_after_secs = 7200;

        let diff = build_diff(&from, &to);
        assert!(diff.content_changed);
        assert_eq!(diff.counts.added_rules, 1);
        assert_eq!(diff.counts.removed_rules, 1);
        assert_eq!(diff.counts.changed_rules, 1);
        assert_eq!(diff.counts.changed_settings, 2);
        assert_eq!(diff.counts.total_rules_from, 2);
        assert_eq!(diff.counts.total_rules_to, 2);
        assert_eq!(diff.rules.len(), 3);
        assert!(diff.settings.iter().any(|s| s.field == "timezone"));
        assert!(diff.settings.iter().any(|s| s.field == "stale_after_secs"));
        assert!(!diff.truncated && diff.omitted_changes == 0);
    }

    #[test]
    fn audit_filters_are_exact_bounded_and_rfc3339() {
        let query = AuditQuery {
            action: Some("network_policy_publish".into()),
            actor: Some("not-a-uuid".into()),
            from: Some("2026-01-01T00:00:00Z".into()),
            to: Some("2026-01-02T00:00:00+10:00".into()),
            limit: 10,
            offset: 0,
        };
        let filters = query.validate().unwrap();
        assert_eq!(filters.actor.as_deref(), Some("not-a-uuid"));
        assert!(filters.from.is_some() && filters.to.is_some());

        let bad = AuditQuery {
            action: Some("x".repeat(MAX_AUDIT_FILTER_LEN + 1)),
            actor: None,
            from: None,
            to: None,
            limit: 10,
            offset: 0,
        };
        assert!(bad.validate().is_err());
        let bad = AuditQuery {
            action: None,
            actor: None,
            from: Some("yesterday".into()),
            to: None,
            limit: 10,
            offset: 0,
        };
        assert!(bad.validate().is_err());
        let bad = AuditQuery {
            action: None,
            actor: None,
            from: Some("2026-01-02T00:00:00Z".into()),
            to: Some("2026-01-01T00:00:00Z".into()),
            limit: 10,
            offset: 0,
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn diff_params_reject_malformed_bounds() {
        let params = DiffParams {
            from_revision: Some("0".into()),
            to_revision: Some("2".into()),
        };
        assert!(params.revisions().is_err());
        let params = DiffParams {
            from_revision: Some("1".into()),
            to_revision: Some("nope".into()),
        };
        assert!(params.revisions().is_err());
        let params = DiffParams {
            from_revision: Some("1".into()),
            to_revision: None,
        };
        assert!(params.revisions().is_err());
        let params = DiffParams {
            from_revision: Some("1".into()),
            to_revision: Some("2".into()),
        };
        assert_eq!(params.revisions().unwrap(), (1, 2));
    }
}
