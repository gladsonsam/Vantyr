//! Deterministic, I/O-free policy evaluation.
//!
//! Precedence (deliberately NOT "most permissive rule wins"):
//!
//! 1. Non-overridable household safety baseline (deny only).
//! 2. Valid, scoped, expiring authorized exception.
//! 3. Verified person-specific rules (only with an active verified session).
//! 4. Device default profile (also used for shared/unknown viewers).
//! 5. Household default effect.
//!
//! A stale effective snapshot fails closed for new allows; previously applied
//! denies remain the worker's last-known-good state.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, LocalResult, NaiveDateTime, TimeZone, Utc,
};
use chrono_tz::Tz;

use crate::model::*;

/// Everything the evaluator needs, assembled from durable records plus the
/// current instant. No network calls and no clock reads inside `evaluate`.
#[derive(Clone, Debug)]
pub struct EvaluationContext<'a> {
    pub now: DateTime<Utc>,
    pub device: &'a Device,
    /// `None` means no verified current person (TV, shared tablet, unknown).
    pub session: Option<&'a Session>,
    pub assignments: &'a [Assignment],
    pub connections: &'a [Connection],
    pub action: Action,
    pub heartbeat_ttl_secs: u64,
}

/// Resolve a wall-clock time in an IANA timezone to a UTC instant.
///
/// Defined DST behaviour:
/// - Spring-forward gap: a nonexistent time shifts forward to the first
///   existing minute (up to three hours). A window that collapses to zero
///   length is inactive.
/// - Fall-back fold: the start uses the FIRST occurrence and the end uses the
///   LAST occurrence, so the window covers both wall-clock passes. This is
///   deliberately the more restrictive interpretation for deny rules and
///   avoids an accidental permissive hour.
/// - An invalid timezone makes the schedule inactive; the host timezone is
///   never substituted.
fn resolve_local(tz: Tz, naive: NaiveDateTime, prefer_latest: bool) -> Option<DateTime<Utc>> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, second) => {
            Some(if prefer_latest { second } else { first }.with_timezone(&Utc))
        }
        LocalResult::None => {
            for minute in 1..=180 {
                let shifted = naive + ChronoDuration::minutes(minute);
                match tz.from_local_datetime(&shifted) {
                    LocalResult::Single(dt) => return Some(dt.with_timezone(&Utc)),
                    LocalResult::Ambiguous(first, second) => {
                        return Some(
                            if prefer_latest { second } else { first }.with_timezone(&Utc),
                        );
                    }
                    LocalResult::None => {}
                }
            }
            None
        }
    }
}

fn schedule_active(schedule: &Schedule, now: DateTime<Utc>) -> bool {
    let Ok(tz) = schedule.timezone.parse::<Tz>() else {
        return false;
    };
    let local = now.with_timezone(&tz);
    let weekday = local.weekday().num_days_from_monday() as u8;
    if !schedule.weekdays.contains(&weekday) {
        return false;
    }
    // Check today's window, plus yesterday's window when it spans midnight.
    let today = local.date_naive();
    let mut dates = vec![today];
    if schedule.end_minute <= schedule.start_minute {
        dates.push(today - ChronoDuration::days(1));
    }
    for date in dates {
        let start = date.and_hms_opt(0, 0, 0).and_then(|base| {
            base.checked_add_signed(ChronoDuration::minutes(schedule.start_minute as i64))
        });
        let mut end = date.and_hms_opt(0, 0, 0).and_then(|base| {
            base.checked_add_signed(ChronoDuration::minutes(schedule.end_minute as i64))
        });
        if schedule.end_minute <= schedule.start_minute {
            end = end.and_then(|e| e.checked_add_signed(ChronoDuration::days(1)));
        }
        let (Some(start), Some(end)) = (start, end) else {
            continue;
        };
        if let (Some(start_utc), Some(end_utc)) = (
            resolve_local(tz, start, false),
            resolve_local(tz, end, true),
        ) {
            if start_utc <= now && now < end_utc {
                return true;
            }
        }
    }
    false
}

fn rule_active(rule: &Rule, ctx: &EvaluationContext<'_>) -> bool {
    rule.matcher.matches(&ctx.action)
        && rule
            .schedule
            .as_ref()
            .map_or(true, |schedule| schedule_active(schedule, ctx.now))
}

/// Within one layer a matching deny wins over a matching allow, so adding an
/// allow rule can never accidentally create a more permissive outcome.
fn pick<'a>(rules: &'a [Rule], ctx: &EvaluationContext<'_>) -> Option<&'a Rule> {
    let mut matching = rules.iter().filter(|rule| rule_active(rule, ctx));
    matching
        .clone()
        .find(|rule| rule.effect == Effect::Deny)
        .or_else(|| matching.next())
}

fn verified_person(ctx: &EvaluationContext<'_>) -> Option<PersonId> {
    let session = ctx.session?;
    if session.device_id != ctx.device.id || !session.valid_at(ctx.now) {
        return None;
    }
    // A profile selection or nearby phone is only an assertion: it must not
    // select person-specific or elevated rules on a shared device.
    if session.assurance != Assurance::Verified || session.source == SessionSource::ParentAssertion
    {
        return None;
    }
    let person = session.verified_person?;
    let assigned = ctx.assignments.iter().any(|assignment| {
        assignment.person_id == person && assignment.device_id == ctx.device.id && assignment.active
    });
    assigned.then_some(person)
}

fn effective_identity(ctx: &EvaluationContext<'_>, person: Option<PersonId>) -> EffectiveIdentity {
    if let Some(person) = person {
        EffectiveIdentity::VerifiedPerson(person)
    } else if ctx.device.shared || ctx.session.is_some() {
        // Shared device, or an assertion that is not strong enough to attribute.
        EffectiveIdentity::SharedDevice
    } else {
        EffectiveIdentity::Unknown
    }
}

fn enforcement_status(ctx: &EvaluationContext<'_>) -> BTreeMap<Capability, EnforcementStatus> {
    let relevant: BTreeSet<Capability> = match ctx.action.kind() {
        ActionKind::Dns => [Capability::DomainFiltering].into_iter().collect(),
        ActionKind::Http => [
            Capability::UrlFiltering,
            Capability::DecryptableHttps,
            Capability::DomainFiltering,
        ]
        .into_iter()
        .collect(),
        ActionKind::App => [Capability::AppRestrictions].into_iter().collect(),
        ActionKind::ScreenTime => [Capability::ScreenTimeSchedule].into_iter().collect(),
    };
    let any_online = ctx.connections.iter().any(|conn| {
        conn.device_id == ctx.device.id && conn.online_at(ctx.now, ctx.heartbeat_ttl_secs)
    });
    relevant
        .into_iter()
        .map(|capability| {
            let online = ctx.connections.iter().any(|conn| {
                conn.device_id == ctx.device.id
                    && conn.online_at(ctx.now, ctx.heartbeat_ttl_secs)
                    && conn.capabilities.contains(&capability)
            });
            let status = if online {
                EnforcementStatus::Enforced
            } else if !any_online {
                EnforcementStatus::Offline
            } else if ctx.device.capabilities.contains(&capability) {
                EnforcementStatus::Unknown
            } else {
                EnforcementStatus::Unsupported
            };
            (capability, status)
        })
        .collect()
}

fn decision(
    allow: bool,
    reason_code: &'static str,
    source: DecisionSource,
    rule: Option<&Rule>,
    ctx: &EvaluationContext<'_>,
    identity: EffectiveIdentity,
) -> Decision {
    Decision {
        allow,
        reason_code: reason_code.to_owned(),
        explanation: rule.map_or_else(|| reason_code.to_owned(), |r| r.reason.clone()),
        policy_revision: 0, // set by `evaluate` from the policy
        applied_rule: rule.map(|r| r.id.clone()),
        source,
        effective_identity: identity,
        enforcement: enforcement_status(ctx),
        evaluated_at: ctx.now,
    }
}

/// Evaluate one action against a policy snapshot. Pure: identical inputs give
/// identical outputs, independent of wall clock or host timezone.
pub fn evaluate(policy: &Policy, ctx: &EvaluationContext<'_>) -> Decision {
    let immediate = |code: &'static str, source: DecisionSource| Decision {
        allow: false,
        reason_code: code.to_owned(),
        explanation: code.to_owned(),
        policy_revision: policy.revision,
        applied_rule: None,
        source,
        effective_identity: EffectiveIdentity::Unknown,
        enforcement: enforcement_status(ctx),
        evaluated_at: ctx.now,
    };
    if policy.household_id != ctx.device.household_id {
        return immediate("household_mismatch", DecisionSource::HouseholdDefault);
    }

    let person = verified_person(ctx);
    let identity = effective_identity(ctx, person);

    let fail = |code: &'static str, source: DecisionSource, rule: Option<&Rule>| {
        let mut d = decision(false, code, source, rule, ctx, identity.clone());
        d.policy_revision = policy.revision;
        d
    };

    // 0. Stale snapshots keep denying but must not introduce new allows.
    let age = (ctx.now - policy.published_at).num_seconds().max(0) as u64;
    if age > policy.stale_after_secs
        && !policy
            .baseline
            .iter()
            .any(|rule| rule.effect == Effect::Deny && rule_active(rule, ctx))
    {
        return fail(
            "stale_policy_fail_closed",
            DecisionSource::StalePolicyFailClosed,
            None,
        );
    }

    // 1. Safety baseline is final and non-overridable.
    if let Some(rule) = policy
        .baseline
        .iter()
        .find(|rule| rule.effect == Effect::Deny && rule_active(rule, ctx))
    {
        return fail(
            "safety_baseline_deny",
            DecisionSource::SafetyBaseline,
            Some(rule),
        );
    }

    // 2. Scoped, authenticated, expiring exceptions.
    for exception in &policy.exceptions {
        if !exception.valid_at(ctx.now)
            || !exception.scope.matches(ctx.device.id, &ctx.action, person)
        {
            continue;
        }
        if let Some(rule) = pick(&exception.rules, ctx) {
            let mut d = decision(
                rule.effect == Effect::Allow,
                if rule.effect == Effect::Allow {
                    "exception_allow"
                } else {
                    "exception_deny"
                },
                DecisionSource::AuthorizedException,
                Some(rule),
                ctx,
                identity.clone(),
            );
            d.policy_revision = policy.revision;
            return d;
        }
    }

    // 3. Verified person rules. Asserted identities never reach this layer.
    if let Some(person) = person {
        if let Some(rules) = policy.person_rules.get(&person) {
            if let Some(rule) = pick(rules, ctx) {
                let mut d = decision(
                    rule.effect == Effect::Allow,
                    if rule.effect == Effect::Allow {
                        "verified_person_allow"
                    } else {
                        "verified_person_deny"
                    },
                    DecisionSource::VerifiedPerson,
                    Some(rule),
                    ctx,
                    identity,
                );
                d.policy_revision = policy.revision;
                return d;
            }
        }
    }

    // 4. Device default profile (this is the shared/TV/unknown path).
    if let Some(rules) = policy.device_profiles.get(&ctx.device.default_profile) {
        if let Some(rule) = pick(rules, ctx) {
            let mut d = decision(
                rule.effect == Effect::Allow,
                if rule.effect == Effect::Allow {
                    "device_profile_allow"
                } else {
                    "device_profile_deny"
                },
                DecisionSource::DeviceDefault,
                Some(rule),
                ctx,
                identity,
            );
            d.policy_revision = policy.revision;
            return d;
        }
    }

    // 5. Household default.
    let allow = policy.default_effect == Effect::Allow;
    let mut d = fail(
        if allow {
            "household_default_allow"
        } else {
            "household_default_deny"
        },
        DecisionSource::HouseholdDefault,
        None,
    );
    d.allow = allow;
    d
}
