//! Policy-connected decision engine.
//!
//! Every query is evaluated with the accepted policy engine. DNS has no verified user identity: `session`, `assignments` and
//! person rules are always empty, so a source IP can only select a configured
//! device profile, never a person. Unknown sources receive the configured
//! restrictive default profile.

use std::net::IpAddr;

use chrono::Utc;
use family_policy::{
    evaluate, Action, Capability, Connection, ConnectionKind, ConnectionStatus, DecisionSource,
    EffectiveIdentity, EvaluationContext, Policy,
};
use hickory_server::proto::rr::{Name, RecordType};

use crate::config::{Config, HEARTBEAT_TTL_SECS};
use crate::observe::{DecisionObservation, ObservationLog};

/// Compact view of one policy decision, returned to the query handler.
#[derive(Clone, Debug)]
pub struct DecisionView {
    pub allow: bool,
    pub reason_code: String,
    pub policy_revision: u64,
    pub source: DecisionSource,
    pub identity: EffectiveIdentity,
    pub applied_rule: Option<String>,
}

/// Immutable, locked-once policy state. No mutex is held while a query is in
/// flight: all state here is read-only for the lifetime of the server.
pub struct PolicyEvaluator {
    config: Config,
    policy: Policy,
    observe: ObservationLog,
}

impl PolicyEvaluator {
    pub fn new(config: Config, observe: ObservationLog) -> Self {
        let policy = config.policy(Utc::now());
        Self {
            config,
            policy,
            observe,
        }
    }

    pub fn policy_revision(&self) -> u64 {
        self.policy.revision
    }

    /// Evaluate one DNS question and append exactly one bounded observation.
    pub fn evaluate(&self, source: IpAddr, qname: &Name, qtype: RecordType) -> DecisionView {
        self.decide(source, qname, qtype, None)
    }

    /// Evaluate an alias target found in an answer. The observation records
    /// the target so a CNAME-chain denial is distinguishable from a direct
    /// denial of the queried name.
    pub fn evaluate_alias(&self, source: IpAddr, target: &Name, qtype: RecordType) -> DecisionView {
        self.decide(
            source,
            target,
            qtype,
            Some(target.to_string().to_ascii_lowercase()),
        )
    }

    fn decide(
        &self,
        source: IpAddr,
        qname: &Name,
        qtype: RecordType,
        denied_alias_target: Option<String>,
    ) -> DecisionView {
        let now = Utc::now();
        let (device_id, device) = self.config.device_for(source);
        let connection = Connection {
            id: device.id,
            device_id: device.id,
            kind: ConnectionKind::Dns,
            enrolled_identity: None,
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
            last_seen: now,
            status: ConnectionStatus::Active,
        };
        let name = qname.to_string().to_ascii_lowercase();
        let context = EvaluationContext {
            now,
            device: &device,
            // DNS traffic is a network observation, not a verified session.
            session: None,
            assignments: &[],
            connections: &[connection],
            action: Action::DnsResolve { name: name.clone() },
            heartbeat_ttl_secs: HEARTBEAT_TTL_SECS,
        };
        let decision = evaluate(&self.policy, &context);
        self.observe.push(DecisionObservation {
            at: now,
            source_ip: source,
            name,
            query_type: qtype,
            allow: decision.allow,
            policy_revision: decision.policy_revision,
            reason_code: decision.reason_code.clone(),
            source: decision.source,
            identity: decision.effective_identity.clone(),
            device_id,
            denied_alias_target: if decision.allow {
                None
            } else {
                denied_alias_target
            },
        });
        DecisionView {
            allow: decision.allow,
            reason_code: decision.reason_code,
            policy_revision: decision.policy_revision,
            source: decision.source,
            identity: decision.effective_identity,
            applied_rule: decision.applied_rule,
        }
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const CONFIG: &str = r#"{
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 9,
        "profiles": {
            "adult": [
                { "effect": "allow", "match": { "type": "suffix", "value": "example" }, "reason": "adult allow" }
            ],
            "restricted": [
                { "effect": "deny", "match": { "type": "suffix", "value": "blocked.example" }, "reason": "restricted deny" }
            ]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "adult",
            "source_ips": ["127.0.0.2"]
        }]
    }"#;

    #[test]
    fn source_ip_cannot_select_a_person_and_unknown_uses_restrictive_default() {
        let observe = ObservationLog::default();
        let evaluator =
            PolicyEvaluator::new(Config::parse(CONFIG.as_bytes()).unwrap(), observe.clone());
        let mapped: IpAddr = "127.0.0.2".parse().unwrap();
        let unknown: IpAddr = "10.4.5.6".parse().unwrap();
        let name = Name::from_str("www.example.").unwrap();

        let allowed = evaluator.evaluate(mapped, &name, RecordType::A);
        assert!(allowed.allow, "the mapped device profile allows example");
        assert_eq!(allowed.source, DecisionSource::DeviceDefault);
        assert_eq!(allowed.policy_revision, 9);

        let denied = evaluator.evaluate(unknown, &name, RecordType::A);
        assert!(
            !denied.allow,
            "unknown source must use the restrictive default"
        );
        assert!(matches!(denied.identity, EffectiveIdentity::Unknown));
        assert_eq!(denied.reason_code, "household_default_deny");
        assert!(
            observe
                .snapshot()
                .iter()
                .any(|entry| entry.device_id.is_none() && !entry.allow),
            "unknown decision must be observable with no device identity"
        );
    }
}
