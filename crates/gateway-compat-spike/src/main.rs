//! Executable compatibility proof for the family network backend.
//!
//! No host network configuration, no privileged ports, no live household
//! services. Run with `cargo run -p gateway-compat-spike`.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::str::FromStr;

use family_policy::{
    evaluate, Action, DecisionSource, Device, DeviceKind, Effect, EvaluationContext, Policy, Rule,
    RuleMatcher,
};
use family_proxy::DestinationPolicy;

fn main() {
    let now = chrono::Utc::now();
    let device = Device {
        id: uuid::Uuid::new_v4(),
        household_id: uuid::Uuid::new_v4(),
        label: "Lounge TV".into(),
        kind: DeviceKind::Tv,
        shared: true,
        default_profile: "household_tv".into(),
        capabilities: [family_policy::Capability::DomainFiltering]
            .into_iter()
            .collect(),
    };
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "household_tv".to_owned(),
        vec![Rule {
            id: "tv-ads".into(),
            effect: Effect::Deny,
            matcher: RuleMatcher::DomainSuffix("ads.example".into()),
            schedule: None,
            reason: "TV profile blocks ad domains without naming a viewer".into(),
        }],
    );
    let policy = Policy {
        household_id: device.household_id,
        revision: 1,
        baseline: vec![],
        device_profiles: profiles,
        person_rules: BTreeMap::new(),
        exceptions: vec![],
        default_effect: Effect::Allow,
        timezone: "UTC".into(),
        stale_after_secs: 3600,
        event_retention_secs: 7 * 24 * 3600,
        published_at: now,
    };
    let decision = evaluate(
        &policy,
        &EvaluationContext {
            now,
            device: &device,
            session: None,
            assignments: &[],
            connections: &[],
            action: Action::HttpRequest {
                host: "ads.example".into(),
                path: "/".into(),
            },
            heartbeat_ttl_secs: 90,
        },
    );
    assert!(!decision.allow);
    assert_eq!(decision.source, DecisionSource::DeviceDefault);
    assert_eq!(
        decision.effective_identity,
        family_policy::EffectiveIdentity::SharedDevice
    );

    let destination = DestinationPolicy {
        pinned_hosts: BTreeMap::from([(
            "approved.test".to_owned(),
            SocketAddr::from((Ipv4Addr::LOCALHOST, 18443)),
        )]),
    };
    assert!(destination.allows_host("approved.test", 18443));
    assert!(!destination.allows_host("169.254.169.254", 80));
    assert!(!destination.allows_socket(SocketAddr::from((
        std::net::IpAddr::from_str("10.0.0.1").unwrap(),
        443
    ))));

    println!(
        "family-policy: TV decision={} source={:?}",
        decision.reason_code, decision.source
    );
    println!("rama destination policy: hostname allowed, metadata/private literals denied");
    println!("hickory: DNS worker tests run with `cargo test -p family-dns`");
    println!("rama: CONNECT/egress tests run with `cargo test -p family-proxy`");
}
