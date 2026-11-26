//! Pure, capability-aware setup planner. It reads bounded observations and
//! emits before/proposed/rollback values plus explicit manual steps. It never
//! contacts a controller, never invents a write shape and never assumes DHCP,
//! VLAN, SSID, firewall or CA changes are needed.

use std::net::IpAddr;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::API_DOC_VERSION,
    error::Error,
    model::{BeforeValue, Management, NetworkObservation},
};

/// The worker's local default. DHCP can only advertise port 53; reaching the
/// worker requires an explicit deployment port mapping.
pub const WORKER_DEFAULT_PORT: u16 = 15353;
pub const ADVERTISED_DNS_PORT: u16 = 53;

const MAX_TTL_SECS: u64 = 86_400;
const MAX_DNS_SERVERS: usize = 4; // schema maxItems for both override fields

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerIdentity {
    pub authority: String,
    pub site_id: String,
    pub application_version: Option<String>,
    pub api_doc_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerEndpoint {
    pub label: String,
    pub ipv4: Option<IpAddr>,
    pub ipv6: Option<IpAddr>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEvidence {
    pub vantyr_dns_reachable: bool,
    pub external_port_53_mapped_to_worker: bool,
}

#[derive(Clone, Debug)]
pub struct SetupInputs {
    pub identity: ControllerIdentity,
    pub networks: Vec<NetworkObservation>,
    pub workers: Vec<WorkerEndpoint>,
    pub dependency_evidence: DependencyEvidence,
    /// False when the installed controller does not document network updates.
    /// No write shape is invented in that case.
    pub api_update_supported: bool,
    pub operator_approved_dns_override: bool,
    pub now: DateTime<Utc>,
    pub ttl_secs: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanDisposition {
    Ready,
    NeedsManual,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependency {
    pub name: String,
    pub satisfied: bool,
    pub evidence: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlannedChange {
    pub network_id: String,
    pub field_path: String,
    pub before: BeforeValue,
    pub proposed: Value,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SetupPlan {
    pub fingerprint: String,
    pub identity: ControllerIdentity,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub disposition: PlanDisposition,
    pub selected_network_ids: Vec<String>,
    pub changes: Vec<PlannedChange>,
    pub dependencies: Vec<Dependency>,
    pub manual_steps: Vec<String>,
    pub verification_steps: Vec<String>,
}

fn json_strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn before_of(current: &Option<Vec<String>>) -> BeforeValue {
    match current {
        Some(values) => BeforeValue::Present(json_strings(values)),
        None => BeforeValue::Absent,
    }
}

fn fingerprint_of(plan: &SetupPlan) -> String {
    let material = json!({
        "identity": plan.identity,
        "created_at": plan.created_at,
        "expires_at": plan.expires_at,
        "disposition": plan.disposition,
        "selected_network_ids": plan.selected_network_ids,
        "changes": plan.changes,
        "dependencies": plan.dependencies,
        "manual_steps": plan.manual_steps,
        "verification_steps": plan.verification_steps,
    });
    let bytes = serde_json::to_vec(&material).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

pub fn plan_integrity_holds(plan: &SetupPlan) -> bool {
    fingerprint_of(plan) == plan.fingerprint
}

/// Build a deterministic, bounded plan. Only the two documented DNS override
/// field paths may appear in `changes`.
pub fn plan(inputs: &SetupInputs) -> Result<SetupPlan, Error> {
    if inputs.ttl_secs == 0 || inputs.ttl_secs > MAX_TTL_SECS {
        return Err(Error::InvalidPlan(
            "plan TTL is outside the bounded range".into(),
        ));
    }
    if inputs.networks.is_empty() {
        return Err(Error::InvalidPlan("no networks were selected".into()));
    }
    let mut seen = std::collections::BTreeSet::new();
    for network in &inputs.networks {
        if !seen.insert(network.id.as_str()) {
            return Err(Error::InvalidPlan("duplicate selected network".into()));
        }
    }

    let ipv4: Vec<String> = inputs
        .workers
        .iter()
        .filter_map(|worker| worker.ipv4)
        .map(|ip| ip.to_string())
        .collect();
    let ipv6: Vec<String> = inputs
        .workers
        .iter()
        .filter_map(|worker| worker.ipv6)
        .map(|ip| ip.to_string())
        .collect();
    if ipv4.len() > MAX_DNS_SERVERS || ipv6.len() > MAX_DNS_SERVERS {
        return Err(Error::InvalidPlan(
            "more than four DNS servers for one address family".into(),
        ));
    }

    let mut changes = Vec::new();
    let mut per_network_manual: Vec<String> = Vec::new();
    let mut needs_manual = false;
    let unsupported = !inputs.api_update_supported;
    let mut unknown = false;

    for network in &inputs.networks {
        if !network.enabled {
            needs_manual = true;
            per_network_manual.push(format!(
                "network {} ({}) is disabled; enable it explicitly before planning DNS",
                network.name, network.id
            ));
            continue;
        }

        if !inputs.api_update_supported {
            per_network_manual.push(format!(
                "network {} ({}): the installed controller does not document network updates; no write shape is proposed",
                network.name, network.id
            ));
            continue;
        }

        match &network.management {
            Management::Unmanaged => {
                needs_manual = true;
                per_network_manual.push(format!(
                    "network {} ({}) is externally managed: the documented schema has no DNS override; configure DNS on the external DHCP server manually",
                    network.name, network.id
                ));
                continue;
            }
            Management::Unknown(raw) => {
                unknown = true;
                per_network_manual.push(format!(
                    "network {} ({}) reports unrecognized management '{}'; no write is proposed",
                    network.name, network.id, raw
                ));
                continue;
            }
            Management::Gateway | Management::Switch => {}
        }

        let is_gateway = matches!(network.management, Management::Gateway);

        // IPv4: only the SERVER DHCP mode advertises the override field.
        if let Some(path) = network.dns.ipv4_dns_path {
            if ipv4.is_empty() {
                needs_manual = true;
                per_network_manual.push(format!(
                    "network {} ({}) has no Vantyr IPv4 worker endpoint to advertise",
                    network.name, network.id
                ));
            } else {
                let existing = network.dns.ipv4_dns_overrides.clone().unwrap_or_default();
                if !existing.is_empty()
                    && existing != ipv4
                    && !inputs.operator_approved_dns_override
                {
                    needs_manual = true;
                    per_network_manual.push(format!(
                        "network {} ({}) already advertises DNS servers; split DNS is preserved until an operator explicitly approves replacement",
                        network.name, network.id
                    ));
                } else {
                    changes.push(PlannedChange {
                        network_id: network.id.clone(),
                        field_path: path.to_owned(),
                        before: before_of(&network.dns.ipv4_dns_overrides),
                        proposed: json_strings(&ipv4),
                        note: Some(
                            "Router DHCP stays the DHCP service; only this override field is proposed"
                                .to_owned(),
                        ),
                    });
                }
            }
        } else {
            needs_manual = true;
            per_network_manual.push(format!(
                "network {} ({}) uses DHCP relay or has no DHCP server: the documented DNS override is not available; configure the external DHCP service manually",
                network.name, network.id
            ));
        }

        // IPv6: gateway networks document an IPv6 override. Switch-managed
        // details do not, so IPv6 there is always a manual step.
        if is_gateway {
            if network.ipv6.configured {
                if !network.ipv6.shape_known {
                    unknown = true;
                    per_network_manual.push(format!(
                        "network {} ({}) has an unrecognized IPv6 interfaceType; no IPv6 write is proposed",
                        network.name, network.id
                    ));
                }
                if let Some(path) = network.ipv6.ipv6_dns_path {
                    if ipv6.is_empty() {
                        needs_manual = true;
                        per_network_manual.push(format!(
                            "network {} ({}) has no Vantyr IPv6 worker endpoint; verify IPv6 DNS/RA manually",
                            network.name, network.id
                        ));
                    } else {
                        let existing = network.ipv6.dns_overrides.clone().unwrap_or_default();
                        if !existing.is_empty()
                            && existing != ipv6
                            && !inputs.operator_approved_dns_override
                        {
                            needs_manual = true;
                            per_network_manual.push(format!(
                                "network {} ({}) already advertises IPv6 DNS servers; split DNS is preserved pending explicit approval",
                                network.name, network.id
                            ));
                        } else {
                            changes.push(PlannedChange {
                                network_id: network.id.clone(),
                                field_path: path.to_owned(),
                                before: before_of(&network.ipv6.dns_overrides),
                                proposed: json_strings(&ipv6),
                                note: Some("IPv6 RA/DHCPv6 settings are not modified".to_owned()),
                            });
                        }
                    }
                }
                per_network_manual.push(format!(
                    "network {} ({}) has IPv6 configured: verify router advertisement and DHCPv6 behaviour after any change",
                    network.name, network.id
                ));
            } else {
                per_network_manual.push(format!(
                    "network {} ({}) has no IPv6 configuration; no IPv6 change is proposed",
                    network.name, network.id
                ));
            }
        } else if network.ipv6.configured {
            needs_manual = true;
            per_network_manual.push(format!(
                "network {} ({}) is switch-managed with IPv6: switch details do not document an IPv6 DNS override; verify manually",
                network.name, network.id
            ));
        }
    }

    let dependencies = vec![
        Dependency {
            name: "Vantyr DNS workers reachable".to_owned(),
            satisfied: inputs.dependency_evidence.vantyr_dns_reachable,
            evidence: "operator-reported worker reachability; controller discovery cannot prove service health"
                .to_owned(),
        },
        Dependency {
            name: format!(
                "External UDP/{port} mapped to worker {worker_port}",
                port = ADVERTISED_DNS_PORT,
                worker_port = WORKER_DEFAULT_PORT
            ),
            satisfied: inputs.dependency_evidence.external_port_53_mapped_to_worker,
            evidence: "DHCP advertises port 53 only; a port-15353 worker is not reachable by clients without an explicit deployment mapping"
                .to_owned(),
        },
    ];
    if dependencies.iter().any(|dependency| !dependency.satisfied) {
        needs_manual = true;
    }

    let disposition = if unsupported {
        PlanDisposition::Unsupported
    } else if needs_manual {
        PlanDisposition::NeedsManual
    } else if unknown {
        PlanDisposition::Unknown
    } else {
        PlanDisposition::Ready
    };

    let mut manual_steps = per_network_manual;
    manual_steps.extend([
        "Router DHCP remains the DHCP service; no VLAN, SSID or firewall creation is assumed"
            .to_owned(),
        "Proxy routing and bypass-prevention remain explicit administrator steps".to_owned(),
        "Controller automation does not install a CA on BYOD devices".to_owned(),
        "Verify on one client before broader deployment".to_owned(),
    ]);
    let verification_steps = vec![
        "Re-read GET /v1/sites/{siteId}/networks/{networkId} and confirm only the planned override field changed"
            .to_owned(),
        "From a test client confirm the advertised resolver is the Vantyr worker and unrelated DNS fields are preserved"
            .to_owned(),
        "Where IPv6 is configured, verify router advertisement and DHCPv6 behaviour".to_owned(),
    ];

    let mut plan = SetupPlan {
        fingerprint: String::new(),
        identity: inputs.identity.clone(),
        created_at: inputs.now,
        expires_at: inputs
            .now
            .checked_add_signed(ChronoDuration::seconds(inputs.ttl_secs as i64))
            .ok_or_else(|| Error::InvalidPlan("plan expiry overflow".into()))?,
        disposition,
        selected_network_ids: inputs.networks.iter().map(|n| n.id.clone()).collect(),
        changes,
        dependencies,
        manual_steps,
        verification_steps,
    };
    plan.fingerprint = fingerprint_of(&plan);
    Ok(plan)
}

pub fn identity_matches(plan: &SetupPlan, identity: &ControllerIdentity) -> bool {
    plan.identity.authority == identity.authority
        && plan.identity.site_id == identity.site_id
        && plan.identity.application_version == identity.application_version
        && plan.identity.api_doc_version == identity.api_doc_version
        && plan.identity.api_doc_version == API_DOC_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ControllerIdentity {
        ControllerIdentity {
            authority: "192.168.1.1".to_owned(),
            site_id: "site-a".to_owned(),
            application_version: Some("9.1.0".to_owned()),
            api_doc_version: API_DOC_VERSION.to_owned(),
        }
    }

    #[test]
    fn fingerprint_changes_with_content() {
        let observation = NetworkObservation::from_raw(json!({
            "id": "n1", "name": "Home", "management": "GATEWAY", "vlanId": 20, "enabled": true,
            "ipv4Configuration": {"dhcpConfiguration": {"mode": "SERVER"}}
        }));
        let inputs = SetupInputs {
            identity: identity(),
            networks: vec![observation.clone()],
            workers: vec![WorkerEndpoint {
                label: "dns-1".to_owned(),
                ipv4: Some("10.0.0.10".parse().unwrap()),
                ipv6: None,
            }],
            dependency_evidence: DependencyEvidence {
                vantyr_dns_reachable: true,
                external_port_53_mapped_to_worker: true,
            },
            api_update_supported: true,
            operator_approved_dns_override: false,
            now: DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            ttl_secs: 600,
        };
        let first = plan(&inputs).unwrap();
        assert!(plan_integrity_holds(&first));
        let mut changed_observation = observation;
        changed_observation.name = "Renamed".to_owned();
        let mut second_inputs = inputs;
        second_inputs.networks = vec![changed_observation];
        let second = plan(&second_inputs).unwrap();
        assert_ne!(first.fingerprint, second.fingerprint);
    }
}
