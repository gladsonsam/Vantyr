//! Pure family-network policy model and evaluator (no I/O, no runtime).
//!
//! This crate owns the shared contracts for Household / Person / Device /
//! Assignment / Session / Connection / Policy / Decision / Event. Protocol
//! workers consume it; it never consumes them.

pub mod eval;
pub mod model;
pub mod store;

pub use eval::{evaluate, EvaluationContext};
pub use model::*;
pub use store::{Actor, AuthError, PolicyStore, PublicationStatus, PublishedPolicy};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::thread;
    use uuid::Uuid;

    fn ts(s: &str) -> DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn rule(id: &str, effect: Effect, suffix: &str) -> Rule {
        Rule {
            id: id.to_owned(),
            effect,
            matcher: RuleMatcher::DomainSuffix(suffix.to_owned()),
            schedule: None,
            reason: format!("{id} applied"),
        }
    }

    struct Fixture {
        household: Household,
        parent: Person,
        child: Person,
        pc: Device,
        tablet: Device,
        tv: Device,
        assignment: Assignment,
        dns: Connection,
        proxy: Connection,
    }

    fn fixture(now: chrono::DateTime<Utc>) -> Fixture {
        let household_id = Uuid::new_v4();
        let household = Household {
            id: household_id,
            name: "Test household".into(),
            timezone: "Australia/Sydney".into(),
        };
        let parent = Person {
            id: Uuid::new_v4(),
            household_id,
            display_name: "Parent".into(),
            login_links: vec!["oidc:parent".into()],
        };
        let child = Person {
            id: Uuid::new_v4(),
            household_id,
            display_name: "Child".into(),
            login_links: vec![],
        };
        let pc = Device {
            id: Uuid::new_v4(),
            household_id,
            label: "Shared Windows PC".into(),
            kind: DeviceKind::PersonalComputer,
            shared: true,
            default_profile: "family".into(),
            capabilities: [
                Capability::DomainFiltering,
                Capability::UrlFiltering,
                Capability::DecryptableHttps,
            ]
            .into_iter()
            .collect(),
        };
        let tablet = Device {
            id: Uuid::new_v4(),
            household_id,
            label: "Shared tablet".into(),
            kind: DeviceKind::Tablet,
            shared: true,
            default_profile: "family".into(),
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
        };
        let tv = Device {
            id: Uuid::new_v4(),
            household_id,
            label: "Lounge TV".into(),
            kind: DeviceKind::Tv,
            shared: true,
            default_profile: "household_tv".into(),
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
        };
        let assignment = Assignment {
            id: Uuid::new_v4(),
            person_id: parent.id,
            device_id: pc.id,
            role: AssignmentRole::Owner,
            active: true,
        };
        let dns = Connection {
            id: Uuid::new_v4(),
            device_id: pc.id,
            kind: ConnectionKind::Dns,
            enrolled_identity: None,
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
            last_seen: now,
            status: ConnectionStatus::Active,
        };
        let proxy = Connection {
            id: Uuid::new_v4(),
            device_id: pc.id,
            kind: ConnectionKind::Proxy,
            enrolled_identity: Some("proxy-credential-pc".into()),
            capabilities: [Capability::UrlFiltering, Capability::DecryptableHttps]
                .into_iter()
                .collect(),
            last_seen: now,
            status: ConnectionStatus::Active,
        };
        Fixture {
            household,
            parent,
            child,
            pc,
            tablet,
            tv,
            assignment,
            dns,
            proxy,
        }
    }

    fn policy(
        f: &Fixture,
        now: chrono::DateTime<Utc>,
        _extra: Vec<Rule>,
        exceptions: Vec<Exception>,
    ) -> Policy {
        let mut profiles = BTreeMap::new();
        profiles.insert(
            "family".to_owned(),
            vec![rule("family-deny-social", Effect::Deny, "social.example")],
        );
        profiles.insert(
            "household_tv".to_owned(),
            vec![rule("tv-deny-ads", Effect::Deny, "ads.example")],
        );
        let mut person_rules = BTreeMap::new();
        person_rules.insert(
            f.parent.id,
            vec![rule("parent-allow-social", Effect::Allow, "social.example")],
        );
        Policy {
            household_id: f.household.id,
            revision: 1,
            baseline: vec![rule("safety-malware", Effect::Deny, "malware.example")],
            device_profiles: profiles,
            person_rules,
            exceptions,
            default_effect: Effect::Deny,
            timezone: f.household.timezone.clone(),
            stale_after_secs: 3600,
            event_retention_secs: 7 * 24 * 3600,
            published_at: now,
        }
    }

    fn session(
        f: &Fixture,
        person: Option<PersonId>,
        source: SessionSource,
        assurance: Assurance,
        now: chrono::DateTime<Utc>,
    ) -> Session {
        Session {
            id: Uuid::new_v4(),
            device_id: f.pc.id,
            verified_person: person,
            source,
            assurance,
            started_at: now - chrono::Duration::minutes(1),
            expires_at: now + chrono::Duration::minutes(15),
            revoked: false,
        }
    }

    #[test]
    fn verified_pc_session_applies_person_rules_but_assertion_does_not() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let p = policy(&f, now, vec![], vec![]);
        let verified = session(
            &f,
            Some(f.parent.id),
            SessionSource::AgentOsUser,
            Assurance::Verified,
            now,
        );
        let asserted = session(
            &f,
            Some(f.parent.id),
            SessionSource::ParentAssertion,
            Assurance::Asserted,
            now,
        );
        let action = Action::HttpRequest {
            host: "www.social.example".into(),
            path: "/feed".into(),
        };

        let ctx_verified = EvaluationContext {
            now,
            device: &f.pc,
            session: Some(&verified),
            assignments: std::slice::from_ref(&f.assignment),
            connections: &[f.dns.clone(), f.proxy.clone()],
            action: action.clone(),
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx_verified);
        assert!(d.allow, "verified parent session should allow: {d:?}");
        assert_eq!(d.source, DecisionSource::VerifiedPerson);
        assert_eq!(
            d.effective_identity,
            EffectiveIdentity::VerifiedPerson(f.parent.id)
        );

        let ctx_asserted = EvaluationContext {
            now,
            device: &f.pc,
            session: Some(&asserted),
            assignments: std::slice::from_ref(&f.assignment),
            connections: &[f.dns.clone(), f.proxy.clone()],
            action: action.clone(),
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx_asserted);
        assert!(
            !d.allow,
            "a profile selection/assertion must not grant person rules"
        );
        assert_eq!(d.source, DecisionSource::DeviceDefault);
        assert_eq!(d.effective_identity, EffectiveIdentity::SharedDevice);
    }

    #[test]
    fn unknown_and_shared_devices_do_not_inherit_owner_rules() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let p = policy(&f, now, vec![], vec![]);
        let personal_pc = Device {
            shared: false,
            ..f.pc.clone()
        };
        let action = Action::HttpRequest {
            host: "www.social.example".into(),
            path: "/".into(),
        };
        let ctx = EvaluationContext {
            now,
            device: &personal_pc,
            session: None,
            assignments: std::slice::from_ref(&f.assignment),
            connections: std::slice::from_ref(&f.dns),
            action,
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert!(!d.allow);
        assert_eq!(d.source, DecisionSource::DeviceDefault);
        assert_eq!(d.effective_identity, EffectiveIdentity::Unknown);
        assert!(!matches!(
            d.effective_identity,
            EffectiveIdentity::VerifiedPerson(_)
        ));
    }

    #[test]
    fn tv_has_explicit_unknown_viewer_and_no_fabricated_person() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let p = policy(&f, now, vec![], vec![]);
        let tv_dns = Connection {
            id: Uuid::new_v4(),
            device_id: f.tv.id,
            kind: ConnectionKind::Dns,
            enrolled_identity: None,
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
            last_seen: now,
            status: ConnectionStatus::Active,
        };
        let ctx = EvaluationContext {
            now,
            device: &f.tv,
            session: None,
            assignments: &[],
            connections: &[tv_dns],
            action: Action::HttpRequest {
                host: "ads.example".into(),
                path: "/".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert!(!d.allow);
        assert_eq!(d.effective_identity, EffectiveIdentity::SharedDevice);
        assert_eq!(
            d.enforcement.get(&Capability::DomainFiltering),
            Some(&EnforcementStatus::Enforced)
        );
        assert_eq!(
            d.enforcement.get(&Capability::DecryptableHttps),
            Some(&EnforcementStatus::Unsupported)
        );
    }

    #[test]
    fn exception_expires_and_returns_to_device_default() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let exception = Exception {
            id: "parent-scoped-exception".into(),
            approver: f.parent.id,
            approved_at: now,
            scope: ExceptionScope::DeviceAction {
                device_id: f.tablet.id,
                action: ActionKind::Http,
            },
            rules: vec![rule(
                "exception-allow-social",
                Effect::Allow,
                "social.example",
            )],
            expires_at: now + chrono::Duration::minutes(30),
            revoked_at: None,
        };
        let p = policy(&f, now, vec![], vec![exception]);
        let action = Action::HttpRequest {
            host: "social.example".into(),
            path: "/".into(),
        };
        let during = now + chrono::Duration::minutes(10);
        let after = now + chrono::Duration::minutes(31);
        let ctx_during = EvaluationContext {
            now: during,
            device: &f.tablet,
            session: None,
            assignments: &[],
            connections: &[],
            action: action.clone(),
            heartbeat_ttl_secs: 90,
        };
        let ctx_after = EvaluationContext {
            now: after,
            device: &f.tablet,
            session: None,
            assignments: &[],
            connections: &[],
            action,
            heartbeat_ttl_secs: 90,
        };
        assert_eq!(
            evaluate(&p, &ctx_during).source,
            DecisionSource::AuthorizedException
        );
        let d = evaluate(&p, &ctx_after);
        assert!(!d.allow);
        assert_eq!(d.source, DecisionSource::DeviceDefault);
    }

    #[test]
    fn safety_baseline_is_non_overridable() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let exception = Exception {
            id: "bad-override".into(),
            approver: f.parent.id,
            approved_at: now,
            scope: ExceptionScope::Device(f.pc.id),
            rules: vec![rule("allow-everything", Effect::Allow, "example")],
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        };
        let p = policy(&f, now, vec![], vec![exception]);
        let ctx = EvaluationContext {
            now,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::DnsResolve {
                name: "cdn.malware.example".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert!(!d.allow);
        assert_eq!(d.source, DecisionSource::SafetyBaseline);
    }

    #[test]
    fn stale_snapshot_fails_closed_for_new_allows() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let mut p = policy(&f, now - chrono::Duration::hours(2), vec![], vec![]);
        p.default_effect = Effect::Allow;
        let ctx = EvaluationContext {
            now,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::HttpRequest {
                host: "example.org".into(),
                path: "/".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert!(!d.allow);
        assert_eq!(d.source, DecisionSource::StalePolicyFailClosed);
    }

    #[test]
    fn offline_connections_report_offline_instead_of_protected() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let p = policy(&f, now, vec![], vec![]);
        let offline_dns = Connection {
            last_seen: now - chrono::Duration::hours(1),
            ..f.dns.clone()
        };
        let ctx = EvaluationContext {
            now,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[offline_dns],
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert_eq!(
            d.enforcement.get(&Capability::DomainFiltering),
            Some(&EnforcementStatus::Offline)
        );
    }

    #[test]
    fn schedule_uses_declared_timezone() {
        let f = fixture(ts("2026-11-26T10:00:00Z"));
        let mut p = policy(&f, ts("2026-11-26T10:00:00Z"), vec![], vec![]);
        p.timezone = "Australia/Sydney".into();
        p.default_effect = Effect::Allow;
        p.device_profiles.insert(
            "family".into(),
            vec![Rule {
                id: "nightly".into(),
                effect: Effect::Deny,
                matcher: RuleMatcher::Any,
                schedule: Some(Schedule {
                    weekdays: vec![0, 1, 2, 3, 4, 5, 6],
                    start_minute: 21 * 60,
                    end_minute: 22 * 60,
                    timezone: "Australia/Sydney".into(),
                }),
                reason: "nightly window".into(),
            }],
        );
        let action = Action::DnsResolve {
            name: "example.org".into(),
        };
        // 2026-01-15 21:30 Sydney == 10:30Z — inside the Sydney window.
        let ctx_sydney = EvaluationContext {
            now: ts("2026-01-15T10:30:00Z"),
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: action.clone(),
            heartbeat_ttl_secs: 90,
        };
        assert_eq!(
            evaluate(&p, &ctx_sydney).source,
            DecisionSource::DeviceDefault
        );
        assert!(!evaluate(&p, &ctx_sydney).allow);
        // Same UTC instant is 10:30 in UTC, outside a 21:00-22:00 UTC window.
        let mut p_utc = p.clone();
        for rules in p_utc.device_profiles.values_mut() {
            for r in rules {
                if let Some(schedule) = r.schedule.as_mut() {
                    schedule.timezone = "UTC".into();
                }
            }
        }
        let ctx_utc = EvaluationContext {
            now: ts("2026-01-15T10:30:00Z"),
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action,
            heartbeat_ttl_secs: 90,
        };
        assert!(
            evaluate(&p_utc, &ctx_utc).allow,
            "UTC window should be inactive at 10:30Z"
        );
    }

    fn actor(f: &Fixture, roles: &[Role]) -> Actor {
        Actor {
            id: Uuid::new_v4(),
            household_id: f.household.id,
            roles: roles.iter().copied().collect(),
        }
    }

    fn credential(
        f: &Fixture,
        worker: &str,
        commands: &[GatewayCommand],
        now: DateTime<Utc>,
    ) -> GatewayCredential {
        GatewayCredential {
            id: Uuid::new_v4(),
            household_id: f.household.id,
            gateway_id: worker.to_owned(),
            secret_hash: "$argon2id$test".into(),
            issued_at: now - chrono::Duration::minutes(1),
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
            allowed_commands: commands.iter().copied().collect(),
        }
    }

    fn scheduled_policy(interval: &str, timezone: &str, at: DateTime<Utc>) -> (Fixture, Policy) {
        let f = fixture(at);
        let mut p = policy(&f, at, vec![], vec![]);
        p.default_effect = Effect::Allow;
        p.device_profiles.insert(
            "family".into(),
            vec![Rule {
                id: "window".into(),
                effect: Effect::Deny,
                matcher: RuleMatcher::Any,
                schedule: Some(Schedule {
                    weekdays: vec![0, 1, 2, 3, 4, 5, 6],
                    start_minute: interval.parse::<u32>().unwrap(),
                    end_minute: interval.parse::<u32>().unwrap() + 60,
                    timezone: timezone.into(),
                }),
                reason: "scheduled deny".into(),
            }],
        );
        (f, p)
    }

    #[test]
    fn fold_window_covers_both_occurrences_and_gap_window_is_inactive() {
        // Sydney falls back at 03:00 DST -> 02:00 AEST on 2026-04-05.
        // The 02:00-03:00 window covers BOTH 15:30Z and 16:30Z: the more
        // restrictive interpretation, so no accidental permissive hour.
        for instant in ["2026-04-04T15:30:00Z", "2026-04-04T16:30:00Z"] {
            let at = ts(instant);
            let (f, p) = scheduled_policy("120", "Australia/Sydney", at);
            let ctx = EvaluationContext {
                now: at,
                device: &f.pc,
                session: None,
                assignments: &[],
                connections: &[],
                action: Action::DnsResolve {
                    name: "example.org".into(),
                },
                heartbeat_ttl_secs: 90,
            };
            assert!(
                !evaluate(&p, &ctx).allow,
                "fold instant {instant} must stay denied"
            );
        }
        let at = ts("2026-04-04T17:30:00Z");
        let (f, p) = scheduled_policy("120", "Australia/Sydney", at);
        let ctx = EvaluationContext {
            now: at,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        assert!(
            evaluate(&p, &ctx).allow,
            "outside the fold window must be allowed"
        );

        // Sydney springs forward 02:00 -> 03:00 on 2026-10-04; 02:30 does not
        // exist, so start resolves to 03:00 and the window collapses to zero.
        let at = ts("2026-10-03T16:30:00Z");
        let (f, p) = scheduled_policy("120", "Australia/Sydney", at);
        let ctx = EvaluationContext {
            now: at,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        assert!(evaluate(&p, &ctx).allow, "gap window must not deny");

        let at = ts("2026-11-26T10:00:00Z");
        let (f, p) = scheduled_policy("120", "Mars/Olympus", at);
        let ctx = EvaluationContext {
            now: at,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        assert!(
            evaluate(&p, &ctx).allow,
            "invalid timezone must make schedule inactive"
        );
    }

    #[test]
    fn cross_household_policy_never_allows() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let mut p = policy(&f, now, vec![], vec![]);
        p.default_effect = Effect::Allow;
        p.household_id = Uuid::new_v4();
        let ctx = EvaluationContext {
            now,
            device: &f.pc,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            heartbeat_ttl_secs: 90,
        };
        let d = evaluate(&p, &ctx);
        assert!(!d.allow);
        assert_eq!(d.reason_code, "household_mismatch");
    }

    #[test]
    fn publish_needs_privilege_and_runtime_ack_is_credential_only() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let initial = policy(&f, now, vec![], vec![]);
        let store = PolicyStore::new(initial.clone()).unwrap();
        let viewer = actor(&f, &[Role::Viewer]);
        let admin = actor(&f, &[Role::NetworkAdmin]);
        let events_reader = actor(&f, &[Role::NetworkEvents]);
        let ack_cred = credential(&f, "dns-worker", &[GatewayCommand::AckPolicy], now);
        let wrong_worker = credential(&f, "other-worker", &[GatewayCommand::AckPolicy], now);
        let no_ack_command = credential(&f, "dns-worker", &[GatewayCommand::FetchPolicy], now);
        let expired = GatewayCredential {
            expires_at: now - chrono::Duration::seconds(1),
            ..ack_cred.clone()
        };
        let revoked = GatewayCredential {
            revoked_at: Some(now - chrono::Duration::seconds(1)),
            ..ack_cred.clone()
        };
        let wrong_household = GatewayCredential {
            household_id: Uuid::new_v4(),
            ..ack_cred.clone()
        };

        let mut proposed = initial.clone();
        proposed.revision = 2;
        assert_eq!(
            store.publish(&viewer, proposed.clone(), "dns-worker"),
            Err(AuthError::Forbidden)
        );
        assert_eq!(store.publish(&admin, proposed.clone(), "dns-worker"), Ok(2));
        assert_eq!(store.current().status, PublicationStatus::Proposed);
        assert_eq!(
            store.effective_policy().revision,
            1,
            "UI save alone is not enforcement"
        );

        assert_eq!(
            store.ack(&ack_cred, now, 2, "dns-worker", false),
            Err(AuthError::CanaryFailed)
        );
        assert_eq!(
            store.ack(&wrong_worker, now, 2, "dns-worker", true),
            Err(AuthError::WrongWorker)
        );
        assert_eq!(
            store.ack(&no_ack_command, now, 2, "dns-worker", true),
            Err(AuthError::InvalidCredential)
        );
        assert_eq!(
            store.ack(&expired, now, 2, "dns-worker", true),
            Err(AuthError::InvalidCredential)
        );
        assert_eq!(
            store.ack(&revoked, now, 2, "dns-worker", true),
            Err(AuthError::InvalidCredential)
        );
        assert_eq!(
            store.ack(&wrong_household, now, 2, "dns-worker", true),
            Err(AuthError::WrongHousehold)
        );
        assert_eq!(
            store.ack(&ack_cred, now, 1, "dns-worker", true),
            Err(AuthError::StaleRevision)
        );
        assert_eq!(
            store.effective_policy().revision,
            1,
            "no bad ack may become effective"
        );
        store.ack(&ack_cred, now, 2, "dns-worker", true).unwrap();
        assert_eq!(store.effective_policy().revision, 2);

        // C1: rollback is propose-only; it cannot apply without the ack path.
        let rolled = store
            .rollback(&admin, now + chrono::Duration::minutes(2), "dns-worker")
            .unwrap();
        assert!(rolled > 2);
        assert_eq!(store.current().status, PublicationStatus::RolledBack);
        assert_eq!(
            store.effective_policy().revision,
            2,
            "rollback must not self-apply"
        );
        store
            .ack(&ack_cred, now, rolled, "dns-worker", true)
            .unwrap();
        assert_eq!(store.effective_policy().revision, rolled);

        let event = Event {
            id: Uuid::new_v4(),
            occurred_at: now,
            household_id: f.household.id,
            device_id: f.pc.id,
            person_id: None,
            source: EventSource::Dns,
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            decision: evaluate(
                &initial,
                &EvaluationContext {
                    now,
                    device: &f.pc,
                    session: None,
                    assignments: &[],
                    connections: &[],
                    action: Action::DnsResolve {
                        name: "example.org".into(),
                    },
                    heartbeat_ttl_secs: 90,
                },
            ),
            evidence: EvidenceQuality::NetworkOnly,
            correlation_id: None,
            enforcing_component: "dns-worker".into(),
        };
        let report_cred = credential(&f, "dns-worker", &[GatewayCommand::ReportDecision], now);
        assert_eq!(
            store.record_event(&report_cred, now, f.household.id, event.clone()),
            Ok(())
        );
        assert_eq!(
            store.record_event(&ack_cred, now, f.household.id, event.clone()),
            Err(AuthError::InvalidCredential)
        );
        assert_eq!(
            store.record_event(&report_cred, now, Uuid::new_v4(), event),
            Err(AuthError::WrongHousehold)
        );
        assert_eq!(store.events(&events_reader).unwrap().len(), 1);
        assert!(store.events(&viewer).is_err());
    }

    #[test]
    fn network_retention_is_bounded_at_bootstrap_and_publish() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let _ = &f.child;
        let mut unlimited = policy(&f, now, vec![], vec![]);
        unlimited.event_retention_secs = 0; // the server's "unlimited" convention
        assert_eq!(
            PolicyStore::new(unlimited.clone()).err(),
            Some(AuthError::InvalidRetention)
        );
        let store = PolicyStore::new(policy(&f, now, vec![], vec![])).unwrap();
        unlimited.revision = 2;
        let admin = actor(&f, &[Role::NetworkAdmin]);
        assert_eq!(
            store.publish(&admin, unlimited, "dns-worker"),
            Err(AuthError::InvalidRetention)
        );
    }

    #[test]
    fn concurrent_readers_see_complete_monotonic_revisions() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let store = Arc::new(PolicyStore::new(policy(&f, now, vec![], vec![])).unwrap());
        let admin = actor(&f, &[Role::NetworkAdmin]);
        let writer_store = store.clone();
        let ack_cred = credential(&f, "test-worker", &[GatewayCommand::AckPolicy], now);
        let writer = thread::spawn(move || {
            for revision in 2..=20 {
                let mut next = policy(&f, now, vec![], vec![]);
                next.revision = revision;
                writer_store.publish(&admin, next, "test-worker").unwrap();
                writer_store
                    .ack(&ack_cred, now, revision, "test-worker", true)
                    .unwrap();
            }
        });
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let s = store.clone();
                thread::spawn(move || {
                    let mut last = 0;
                    for _ in 0..200 {
                        let revision = s.effective_policy().revision;
                        assert!(revision >= last, "policy revision went backwards");
                        last = revision;
                    }
                })
            })
            .collect();
        writer.join().unwrap();
        for r in readers {
            r.join().unwrap();
        }
        assert_eq!(store.effective_policy().revision, 20);
    }

    #[test]
    fn household_scoped_grants_events_and_policies_are_isolated() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let other = fixture(now);
        let store = PolicyStore::new(policy(&f, now, vec![], vec![])).unwrap();
        let foreign_admin = actor(&other, &[Role::NetworkAdmin]);
        let foreign_reader = actor(&other, &[Role::NetworkEvents]);

        let mut foreign_policy = policy(&f, now, vec![], vec![]);
        foreign_policy.revision = 2;
        foreign_policy.household_id = other.household.id;
        assert_eq!(
            store.publish(
                &actor(&f, &[Role::NetworkAdmin]),
                foreign_policy,
                "dns-worker"
            ),
            Err(AuthError::WrongHousehold)
        );
        let mut own_policy = policy(&f, now, vec![], vec![]);
        own_policy.revision = 2;
        assert_eq!(
            store.publish(&foreign_admin, own_policy, "dns-worker"),
            Err(AuthError::WrongHousehold)
        );

        let own_cred = credential(&f, "dns-worker", &[GatewayCommand::ReportDecision], now);
        let foreign_cred = credential(&other, "dns-worker", &[GatewayCommand::ReportDecision], now);
        let mut event = decision_event(&f, now);
        event.household_id = other.household.id;
        assert_eq!(
            store.record_event(&own_cred, now, other.household.id, event.clone()),
            Err(AuthError::WrongHousehold)
        );
        assert_eq!(
            store.record_event(&foreign_cred, now, other.household.id, event),
            Err(AuthError::WrongHousehold)
        );

        store
            .record_event(&own_cred, now, f.household.id, decision_event(&f, now))
            .unwrap();
        assert_eq!(
            store.events(&foreign_reader).err(),
            Some(AuthError::WrongHousehold)
        );
    }

    #[test]
    fn rollback_revision_overflow_is_explicit() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let mut max = policy(&f, now, vec![], vec![]);
        max.revision = u64::MAX;
        let store = PolicyStore::new(max).unwrap();
        assert_eq!(
            store
                .rollback(&actor(&f, &[Role::NetworkAdmin]), now, "dns-worker")
                .err(),
            Some(AuthError::RevisionOverflow)
        );
    }

    #[test]
    fn overlapping_publish_and_ack_keep_current_and_applied_consistent() {
        let now = ts("2026-11-26T10:00:00Z");
        let f = fixture(now);
        let store = Arc::new(PolicyStore::new(policy(&f, now, vec![], vec![])).unwrap());
        let admin = actor(&f, &[Role::NetworkAdmin]);
        let ack_cred = credential(&f, "race-worker", &[GatewayCommand::AckPolicy], now);
        let writer_store = store.clone();
        let writer = thread::spawn(move || {
            for revision in 2..=200 {
                let mut next = policy(&f, now, vec![], vec![]);
                next.revision = revision;
                writer_store
                    .publish(&admin, next, "race-worker")
                    .unwrap_or_else(|e| panic!("publish {revision}: {e:?}"));
                writer_store
                    .ack(&ack_cred, now, revision, "race-worker", true)
                    .unwrap_or_else(|e| panic!("ack {revision}: {e:?}"));
            }
        });
        let readers: Vec<_> = (0..3)
            .map(|_| {
                let s = store.clone();
                thread::spawn(move || {
                    for _ in 0..500 {
                        let (current, applied) = s.snapshot();
                        assert!(
                            applied.revision <= current.policy.revision,
                            "applied newer than current"
                        );
                        if current.status == PublicationStatus::Applied {
                            assert_eq!(applied.revision, current.policy.revision);
                            if current.policy.revision > 1 {
                                assert_eq!(current.expected_worker, "race-worker");
                            }
                        }
                    }
                })
            })
            .collect();
        writer.join().unwrap();
        for reader in readers {
            reader.join().unwrap();
        }
        assert_eq!(store.effective_policy().revision, 200);
    }

    fn decision_event(f: &Fixture, now: DateTime<Utc>) -> Event {
        Event {
            id: Uuid::new_v4(),
            occurred_at: now,
            household_id: f.household.id,
            device_id: f.pc.id,
            person_id: None,
            source: EventSource::Dns,
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            decision: evaluate(
                &policy(f, now, vec![], vec![]),
                &EvaluationContext {
                    now,
                    device: &f.pc,
                    session: None,
                    assignments: &[],
                    connections: &[],
                    action: Action::DnsResolve {
                        name: "example.org".into(),
                    },
                    heartbeat_ttl_secs: 90,
                },
            ),
            evidence: EvidenceQuality::NetworkOnly,
            correlation_id: None,
            enforcing_component: "dns-worker".into(),
        }
    }
}
