//! Pure planner and mock-executor behaviour across bounded topologies.
//! No controller, credential or network access is used.

use chrono::{DateTime, Utc};
use serde_json::json;
use vantyr_network_unifi::*;

fn identity() -> ControllerIdentity {
    ControllerIdentity {
        authority: "192.168.1.1".to_owned(),
        site_id: "site-a".to_owned(),
        application_version: Some("9.1.0".to_owned()),
        api_doc_version: API_DOC_VERSION.to_owned(),
    }
}

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn gateway(id: &str, ipv6: bool, overrides: Option<Vec<&str>>) -> NetworkObservation {
    let mut dhcp = json!({"mode": "SERVER"});
    if let Some(values) = overrides {
        dhcp["dnsServerIpAddressesOverride"] = json!(values);
    }
    let mut raw = json!({
        "id": id,
        "name": "Home",
        "management": "GATEWAY",
        "vlanId": 20,
        "enabled": true,
        "unrelatedFutureField": {"keep": 7},
        "ipv4Configuration": {"dhcpConfiguration": dhcp}
    });
    if ipv6 {
        raw["ipv6Configuration"] = json!({
            "interfaceType": "PREFIX_DELEGATION",
            "routerAdvertisement": {"priority": "MEDIUM"},
            "clientAddressAssignment": {"slaacEnabled": true}
        });
    }
    NetworkObservation::from_raw(raw)
}

fn switch_managed(id: &str, overrides: Option<Vec<&str>>) -> NetworkObservation {
    let mut dhcp = json!({"mode": "SERVER"});
    if let Some(values) = overrides {
        dhcp["dnsServerIpAddressesOverride"] = json!(values);
    }
    NetworkObservation::from_raw(json!({
        "id": id,
        "name": "Servers",
        "management": "SWITCH",
        "vlanId": 30,
        "enabled": true,
        "deviceId": "switch-1",
        "ipv4Configuration": {"dhcpConfiguration": dhcp}
    }))
}

fn inputs(networks: Vec<NetworkObservation>) -> SetupInputs {
    SetupInputs {
        identity: identity(),
        networks,
        workers: vec![WorkerEndpoint {
            label: "dns-1".to_owned(),
            ipv4: Some("10.0.0.10".parse().unwrap()),
            ipv6: Some("fd00::10".parse().unwrap()),
        }],
        dependency_evidence: DependencyEvidence {
            vantyr_dns_reachable: true,
            external_port_53_mapped_to_worker: true,
        },
        api_update_supported: true,
        operator_approved_dns_override: false,
        now: now(),
        ttl_secs: 600,
    }
}

#[test]
fn gateway_home_vlan_ready_apply_verify_idempotent_rollback() {
    let observation = gateway("n1", true, None);
    let plan = plan(&inputs(vec![observation.clone()])).unwrap();
    assert_eq!(plan.disposition, PlanDisposition::Ready);
    assert_eq!(plan.changes.len(), 2); // IPv4 + IPv6 only
    assert!(plan_integrity_holds(&plan));
    assert_eq!(plan.changes[0].field_path, IPV4_DNS_PATH);
    assert_eq!(plan.changes[1].field_path, IPV6_DNS_PATH);
    assert!(plan
        .dependencies
        .iter()
        .any(|dep| dep.name.contains("15353") && dep.satisfied));

    let mut controller = SimulatedController::new(identity(), vec![observation.raw.clone()]);
    assert_eq!(
        preview(&plan, &controller, now()).status,
        PreviewStatus::Applicable
    );
    assert_eq!(
        apply(&plan, &mut controller, now()).unwrap(),
        ApplyOutcome::Applied(plan.fingerprint.clone())
    );
    assert!(verify(&plan, &controller).verified);
    assert_eq!(
        apply(&plan, &mut controller, now()).unwrap(),
        ApplyOutcome::AlreadyApplied(plan.fingerprint.clone())
    );
    // The audit log records the idempotent no-op only once.
    assert_eq!(controller.audit.len(), 1);
    assert_eq!(plan.fingerprint, controller.audit[0].fingerprint);

    let rolled_back = rollback(&plan, &mut controller).unwrap();
    assert_eq!(rolled_back.restored, 2);
    assert!(!verify(&plan, &controller).verified);
    assert_eq!(
        controller.value("n1").unwrap()["unrelatedFutureField"]["keep"],
        7
    );
    assert_eq!(
        rollback(&plan, &mut controller).unwrap().already_at_before,
        2
    );
}

#[test]
fn expired_and_stale_plans_are_rejected_before_any_write() {
    let observation = gateway("n1", false, None);
    let plan = plan(&inputs(vec![observation.clone()])).unwrap();
    let mut controller = SimulatedController::new(identity(), vec![observation.raw.clone()]);

    let expired_now = plan.expires_at;
    assert_eq!(
        apply(&plan, &mut controller, expired_now),
        Err(Rejection::Expired)
    );
    assert!(controller.audit.is_empty());

    controller
        .simulate_later_change("n1", IPV4_DNS_PATH, json!(["10.9.9.9"]))
        .unwrap();
    assert_eq!(apply(&plan, &mut controller, now()), Err(Rejection::Stale));
    assert_eq!(
        preview(&plan, &controller, now()).status,
        PreviewStatus::Rejected
    );
    assert!(controller.audit.is_empty());
}

#[test]
fn rollback_never_overwrites_a_later_unrelated_change() {
    let observation = gateway("n1", false, None);
    let plan = plan(&inputs(vec![observation.clone()])).unwrap();
    let mut controller = SimulatedController::new(identity(), vec![observation.raw.clone()]);
    apply(&plan, &mut controller, now()).unwrap();

    controller
        .simulate_later_change(
            "n1",
            "ipv4Configuration.dhcpConfiguration.domainName",
            json!("new.example"),
        )
        .unwrap();
    let rolled_back = rollback(&plan, &mut controller).unwrap();
    assert_eq!(rolled_back.restored, 1);
    assert_eq!(
        controller.value("n1").unwrap()["ipv4Configuration"]["dhcpConfiguration"]["domainName"],
        json!("new.example")
    );
    assert!(get_field(controller.value("n1").unwrap(), IPV4_DNS_PATH).is_none());

    // A conflicting later change to the planned field is never overwritten;
    // the whole rollback is rejected atomically.
    apply(&plan, &mut controller, now()).unwrap();
    controller
        .simulate_later_change("n1", IPV4_DNS_PATH, json!(["10.9.9.9"]))
        .unwrap();
    assert!(matches!(
        rollback(&plan, &mut controller),
        Err(Rejection::Conflict(_))
    ));
    assert_eq!(
        get_field(controller.value("n1").unwrap(), IPV4_DNS_PATH),
        Some(&json!(["10.9.9.9"]))
    );
}

#[test]
fn switch_with_existing_dns_is_manual_unless_operator_approves() {
    let observation = switch_managed("n2", Some(vec!["192.168.1.1"]));
    let mut input = inputs(vec![observation.clone()]);
    let blocked = plan(&input).unwrap();
    assert_eq!(blocked.disposition, PlanDisposition::NeedsManual);
    assert!(blocked.changes.is_empty());
    assert!(blocked
        .manual_steps
        .iter()
        .any(|step| step.contains("split DNS")));

    input.operator_approved_dns_override = true;
    let approved = plan(&input).unwrap();
    assert_eq!(approved.disposition, PlanDisposition::Ready);
    assert_eq!(approved.changes.len(), 1);
    assert_eq!(approved.changes[0].field_path, IPV4_DNS_PATH);
    assert_eq!(
        approved.changes[0].before,
        BeforeValue::Present(json!(["192.168.1.1"]))
    );

    let mut controller = SimulatedController::new(identity(), vec![observation.raw]);
    apply(&approved, &mut controller, now()).unwrap();
    assert!(verify(&approved, &controller).verified);
    let rollback = rollback(&approved, &mut controller).unwrap();
    assert_eq!(rollback.restored, 1);
    assert_eq!(
        get_field(controller.value("n2").unwrap(), IPV4_DNS_PATH),
        Some(&json!(["192.168.1.1"]))
    );
}

#[test]
fn unmanaged_unknown_and_relay_networks_produce_no_writes() {
    let unmanaged = NetworkObservation::from_raw(json!({
        "id": "n3", "name": "Guest", "management": "UNMANAGED", "vlanId": 40, "enabled": true
    }));
    let unmanaged_plan = plan(&inputs(vec![unmanaged])).unwrap();
    assert_eq!(unmanaged_plan.disposition, PlanDisposition::NeedsManual);
    assert!(unmanaged_plan.changes.is_empty());
    assert!(unmanaged_plan
        .manual_steps
        .iter()
        .any(|step| step.contains("externally managed")));

    let unknown = NetworkObservation::from_raw(json!({
        "id": "n4", "name": "Odd", "management": "FUTURE_KIND", "vlanId": 41, "enabled": true
    }));
    let unknown_plan = plan(&inputs(vec![unknown])).unwrap();
    assert_eq!(unknown_plan.disposition, PlanDisposition::Unknown);
    assert!(unknown_plan.changes.is_empty());

    let relay = NetworkObservation::from_raw(json!({
        "id": "n5", "name": "Relay", "management": "GATEWAY", "vlanId": 50, "enabled": true,
        "ipv4Configuration": {"dhcpConfiguration": {"mode": "RELAY"}}
    }));
    let relay_plan = plan(&inputs(vec![relay])).unwrap();
    assert_eq!(relay_plan.disposition, PlanDisposition::NeedsManual);
    assert!(relay_plan.changes.is_empty());
}

#[test]
fn missing_dependencies_and_missing_ipv6_worker_block_a_ready_plan() {
    let observation = gateway("n1", true, None);
    let mut input = inputs(vec![observation]);
    input.dependency_evidence.external_port_53_mapped_to_worker = false;
    let blocked = plan(&input).unwrap();
    assert_eq!(blocked.disposition, PlanDisposition::NeedsManual);
    assert!(blocked
        .dependencies
        .iter()
        .any(|dep| !dep.satisfied && dep.name.contains("15353")));

    let mut input = inputs(vec![gateway("n1", true, None)]);
    input.workers[0].ipv6 = None;
    let partial = plan(&input).unwrap();
    assert_eq!(partial.disposition, PlanDisposition::NeedsManual);
    assert_eq!(partial.changes.len(), 1); // IPv4 only
    assert!(partial
        .manual_steps
        .iter()
        .any(|step| step.contains("IPv6")));
}

#[test]
fn dns_servers_come_only_from_declared_workers_and_are_bounded() {
    let observation = gateway("n1", false, None);
    let mut input = inputs(vec![observation]);
    input.workers = (0..5)
        .map(|i| WorkerEndpoint {
            label: format!("dns-{i}"),
            ipv4: Some(format!("10.0.0.{}", i + 10).parse().unwrap()),
            ipv6: None,
        })
        .collect();
    assert!(plan(&input).is_err());

    let mut input = inputs(vec![gateway("n1", false, None)]);
    input.workers.clear();
    let no_worker = plan(&input).unwrap();
    assert!(no_worker.changes.is_empty());
    assert_eq!(no_worker.disposition, PlanDisposition::NeedsManual);
}

#[test]
fn plans_from_different_observations_have_distinct_fingerprints() {
    let first = plan(&inputs(vec![gateway("n1", false, None)])).unwrap();
    let second = plan(&inputs(vec![gateway("n1", false, Some(vec!["10.0.0.10"]))])).unwrap();
    assert_ne!(first.fingerprint, second.fingerprint);
    assert!(plan_integrity_holds(&first));
    assert!(plan_integrity_holds(&second));
}

#[test]
fn unsupported_installed_api_never_proposes_a_write() {
    let observation = gateway("n1", false, None);
    let mut input = inputs(vec![observation]);
    input.api_update_supported = false;
    let plan = plan(&input).unwrap();
    assert_eq!(plan.disposition, PlanDisposition::Unsupported);
    assert!(plan.changes.is_empty());
    assert!(plan
        .manual_steps
        .iter()
        .any(|step| step.contains("does not document network updates")));
    let mut controller = SimulatedController::new(identity(), vec![]);
    assert_eq!(
        preview(&plan, &controller, now()).status,
        PreviewStatus::Rejected
    );
    assert_eq!(
        apply(&plan, &mut controller, now()),
        Err(Rejection::UnsupportedPlan)
    );
}

#[test]
fn identity_mismatch_is_rejected() {
    let observation = gateway("n1", false, None);
    let plan = plan(&inputs(vec![observation.clone()])).unwrap();
    let mut other_identity = identity();
    other_identity.site_id = "site-b".to_owned();
    let mut controller = SimulatedController::new(other_identity, vec![observation.raw]);
    assert_eq!(
        apply(&plan, &mut controller, now()),
        Err(Rejection::IdentityMismatch)
    );
}
