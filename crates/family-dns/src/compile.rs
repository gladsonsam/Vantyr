//! Pure compilation of a controller-authored core `Policy` into the one DNS
//! `Config` the worker already knows how to bundle and serve.
//!
//! Nothing here performs I/O, talks to a controller or claims enforcement. The
//! source policy is reused, never re-modelled: transport, local zones,
//! upstreams, deny mode and the weak source-IP device map come from the local
//! config, while revision, publication time, baseline, profiles, timezone,
//! staleness and event retention come from the controller policy. A candidate
//! is rejected unless `Config::policy_at` reproduces the WHOLE source policy —
//! consistency is never weakened to allow a merely similar rule set.

use std::fmt;

use family_policy::{Effect, Policy, Rule, RuleMatcher};

use crate::config::{Config, MatchSpec, RuleSpec, ScheduleSpec};

/// Why a controller policy cannot be enforced by this DNS worker. These are
/// capability limits, not transport failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompileError {
    Unsupported(String),
    Invalid(String),
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(detail) => {
                write!(f, "DNS cannot enforce controller policy: {detail}")
            }
            Self::Invalid(detail) => write!(f, "compiled DNS config is invalid: {detail}"),
        }
    }
}

impl std::error::Error for CompileError {}

fn unsupported(detail: impl Into<String>) -> CompileError {
    CompileError::Unsupported(detail.into())
}

fn rule_spec(rule: &Rule) -> Result<RuleSpec, CompileError> {
    let matcher = match &rule.matcher {
        RuleMatcher::DomainSuffix(value) => MatchSpec::Suffix {
            value: value.clone(),
        },
        RuleMatcher::HostExact(value) => MatchSpec::Exact {
            value: value.clone(),
        },
        RuleMatcher::Any => MatchSpec::Any,
        // There is no verified classifier in this worker. Never drop or
        // reinterpret a category: refuse the whole policy instead.
        RuleMatcher::Category(_) => {
            return Err(unsupported("category matchers are not supported"));
        }
    };
    let schedule = rule.schedule.as_ref().map(|schedule| ScheduleSpec {
        weekdays: schedule.weekdays.clone(),
        start_minute: schedule.start_minute,
        end_minute: schedule.end_minute,
        timezone: schedule.timezone.clone(),
    });
    Ok(RuleSpec {
        id: Some(rule.id.clone()),
        effect: rule.effect,
        matcher,
        reason: Some(rule.reason.clone()),
        schedule,
    })
}

/// Compile the controller policy onto the worker's local transport config.
/// The local config is never allowed to override policy content: it only
/// supplies listener, upstreams, local zones, deny mode and device/IP mapping.
pub fn compile(base: &Config, policy: &Policy) -> Result<Config, CompileError> {
    // DNS sees only a source IP. It cannot prove a person is present, so any
    // grant that depends on a verified session is refused, not silently
    // ignored.
    if !policy.person_rules.is_empty() {
        return Err(unsupported("person rules need a verified identity"));
    }
    if !policy.exceptions.is_empty() {
        return Err(unsupported("exceptions need a verified approver"));
    }
    if policy.default_effect != Effect::Deny {
        return Err(unsupported("the household default effect must be deny"));
    }
    if policy
        .baseline
        .iter()
        .any(|rule| rule.effect != Effect::Deny)
    {
        return Err(unsupported(
            "the safety baseline may only contain deny rules",
        ));
    }

    // A device/profile name is weak local evidence. If the controller policy
    // does not define every name a local template uses, this worker cannot
    // select a profile for that client; keep the old bundle instead.
    if !policy
        .device_profiles
        .contains_key(&base.default_device_profile)
    {
        return Err(unsupported(format!(
            "default profile '{}' is absent from the controller policy",
            base.default_device_profile
        )));
    }
    for device in &base.devices {
        if !policy.device_profiles.contains_key(&device.default_profile) {
            return Err(unsupported(format!(
                "device '{}' uses profile '{}' which is absent from the controller policy",
                device.id, device.default_profile
            )));
        }
    }

    let baseline = policy
        .baseline
        .iter()
        .map(rule_spec)
        .collect::<Result<Vec<_>, _>>()?;
    let mut profiles = std::collections::BTreeMap::new();
    for (name, rules) in &policy.device_profiles {
        let compiled = rules.iter().map(rule_spec).collect::<Result<Vec<_>, _>>()?;
        profiles.insert(name.clone(), compiled);
    }

    let candidate = Config {
        household_id: policy.household_id.to_string(),
        policy_revision: policy.revision,
        policy_published_at: Some(policy.published_at),
        timezone: policy.timezone.clone(),
        stale_after_secs: policy.stale_after_secs,
        event_retention_secs: Some(policy.event_retention_secs),
        // Preserved from the local, explicitly configured worker config.
        bind: base.bind.clone(),
        deny: base.deny.clone(),
        upstreams: base.upstreams.clone(),
        encrypted_upstreams: base.encrypted_upstreams.clone(),
        local_zones: base.local_zones.clone(),
        default_device_profile: base.default_device_profile.clone(),
        devices: base.devices.clone(),
        // Current local filtering settings travel with every other local
        // field. A controller pull must never revert a local filter change.
        filter: base.filter.clone(),
        baseline,
        profiles,
    };
    candidate
        .validate()
        .map_err(|error| CompileError::Invalid(error.to_string()))?;

    // The bundle validator requires this equality. Do the check here too so a
    // mismatch is reported as an unsupported policy before anything is built
    // or persisted, and so no future config shortcut can quietly drop fields.
    if candidate.policy_at(policy.published_at) != *policy {
        return Err(unsupported(
            "compiled config does not reproduce the controller policy exactly",
        ));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
    const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn base() -> Config {
        Config::parse(
            format!(
                r#"{{
                  "household_id": "{HOUSEHOLD}",
                  "policy_revision": 1,
                  "bind": {{ "address": "127.0.0.1", "port": 0 }},
                  "deny": {{ "mode": "refused" }},
                  "upstreams": ["127.0.0.1:5353"],
                  "local_zones": {{ "lab.example.": [] }},
                  "profiles": {{ "adult": [] }},
                  "default_device_profile": "adult",
                  "devices": [{{
                    "id": "{DEVICE}",
                    "default_profile": "adult",
                    "source_ips": ["127.0.0.2"]
                  }}]
                }}"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    fn sample_policy() -> Policy {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let mut profiles = BTreeMap::new();
        profiles.insert(
            "adult".to_owned(),
            vec![
                Rule {
                    id: "allow-example".into(),
                    effect: Effect::Allow,
                    matcher: RuleMatcher::DomainSuffix("example".into()),
                    schedule: Some(family_policy::Schedule {
                        weekdays: vec![0, 6],
                        start_minute: 540,
                        end_minute: 1020,
                        timezone: "Australia/Sydney".into(),
                    }),
                    reason: "weekday access".into(),
                },
                Rule {
                    id: "deny-everything".into(),
                    effect: Effect::Deny,
                    matcher: RuleMatcher::Any,
                    schedule: None,
                    reason: String::new(),
                },
            ],
        );
        Policy {
            household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
            revision: 4,
            baseline: vec![Rule {
                id: "safety".into(),
                effect: Effect::Deny,
                matcher: RuleMatcher::HostExact("bad.example".into()),
                schedule: None,
                reason: "safety baseline".into(),
            }],
            device_profiles: profiles,
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            default_effect: Effect::Deny,
            timezone: "Australia/Sydney".into(),
            stale_after_secs: 3600,
            event_retention_secs: 86_400,
            published_at: now,
        }
    }

    #[test]
    fn compiled_config_reproduces_the_whole_core_policy_and_keeps_local_transport() {
        let base = base();
        let policy = sample_policy();
        let compiled = compile(&base, &policy).unwrap();
        assert_eq!(compiled.policy_at(policy.published_at), policy);
        assert_eq!(compiled.bind.address, base.bind.address);
        assert_eq!(compiled.deny, base.deny);
        assert_eq!(compiled.upstreams, base.upstreams);
        assert_eq!(compiled.local_zones, base.local_zones);
        assert_eq!(compiled.devices, base.devices);
        assert_eq!(compiled.event_retention_secs, Some(86_400));
    }

    #[test]
    fn unverifiable_grants_and_category_rules_are_rejected_not_ignored() {
        let base = base();
        let mut policy = sample_policy();
        policy.person_rules.insert(Uuid::new_v4(), Vec::new());
        assert!(matches!(
            compile(&base, &policy),
            Err(CompileError::Unsupported(_))
        ));

        let mut policy = sample_policy();
        policy.exceptions.push(family_policy::Exception {
            id: "exception".into(),
            approver: Uuid::new_v4(),
            approved_at: policy.published_at,
            scope: family_policy::ExceptionScope::Device(Uuid::parse_str(DEVICE).unwrap()),
            rules: Vec::new(),
            expires_at: policy.published_at + chrono::Duration::hours(1),
            revoked_at: None,
        });
        assert!(matches!(
            compile(&base, &policy),
            Err(CompileError::Unsupported(_))
        ));

        let mut policy = sample_policy();
        if let Some(rules) = policy.device_profiles.get_mut("adult") {
            rules[0].matcher = RuleMatcher::Category("social".into());
        }
        assert!(matches!(
            compile(&base, &policy),
            Err(CompileError::Unsupported(_))
        ));
    }

    #[test]
    fn missing_local_profiles_are_unsupported_and_default_stays_deny() {
        let mut base = base();
        let mut policy = sample_policy();
        policy.device_profiles.remove("adult");
        assert!(matches!(
            compile(&base, &policy),
            Err(CompileError::Unsupported(_))
        ));

        let mut policy = sample_policy();
        policy.default_effect = Effect::Allow;
        assert!(matches!(
            compile(&base, &policy),
            Err(CompileError::Unsupported(_))
        ));

        base.default_device_profile = "missing".into();
        assert!(base.validate().is_err());
    }
}
