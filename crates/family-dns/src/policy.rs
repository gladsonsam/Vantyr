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
use vantyr_network_filter::{FilterOutcome, FilterSnapshot, SourceKind};

use crate::config::{Config, HEARTBEAT_TTL_SECS};
use crate::observe::{DecisionObservation, ObservationLog};

/// Compact view of one combined policy+filter decision, returned to the query
/// handler. Household policy is authoritative: `allow` is false when either
/// the policy denies or an accepted list/selected service blocks.
#[derive(Clone, Debug)]
pub struct DecisionView {
    pub allow: bool,
    pub reason_code: String,
    pub policy_revision: u64,
    pub source: DecisionSource,
    pub identity: EffectiveIdentity,
    pub applied_rule: Option<String>,
    pub filter_blocked: bool,
    pub filter_source_id: Option<String>,
    pub filter_source_kind: Option<String>,
    pub filter_rule: Option<String>,
    pub filter_note: Option<String>,
    /// The one list-layer verdict from the evaluation above. Kept so the query
    /// handler can gate immutable list rewrites on `NoMatch` without evaluating
    /// the filter twice. It is never emitted on the wire, treated as a household
    /// grant, or reported as a block.
    pub(crate) filter_outcome: Option<FilterOutcome>,
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
        Self::with_policy(config.clone(), config.policy(Utc::now()), observe)
    }

    /// Build an evaluator from an already validated policy. Durable snapshots
    /// pass the stored policy so its original `published_at` survives restarts.
    pub fn with_policy(config: Config, policy: Policy, observe: ObservationLog) -> Self {
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
        self.decide(source, qname, qtype, None, None)
    }

    /// Evaluate a question with an immutable filter snapshot. The filter is
    /// consulted only after household policy has allowed the name.
    pub fn evaluate_with_filter(
        &self,
        source: IpAddr,
        qname: &Name,
        qtype: RecordType,
        filter: Option<&FilterSnapshot>,
    ) -> DecisionView {
        self.decide(source, qname, qtype, None, filter)
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
            None,
        )
    }

    /// Alias evaluation with the same filter snapshot as the original answer.
    pub fn evaluate_alias_with_filter(
        &self,
        source: IpAddr,
        target: &Name,
        qtype: RecordType,
        filter: Option<&FilterSnapshot>,
    ) -> DecisionView {
        self.decide(
            source,
            target,
            qtype,
            Some(target.to_string().to_ascii_lowercase()),
            filter,
        )
    }

    fn decide(
        &self,
        source: IpAddr,
        qname: &Name,
        qtype: RecordType,
        denied_alias_target: Option<String>,
        filter: Option<&FilterSnapshot>,
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
        let mut allow = decision.allow;
        let mut filter_blocked = false;
        let mut filter_source_id = None;
        let mut filter_source_kind = None;
        let mut filter_rule = None;
        let mut filter_note = None;
        // Household policy is authoritative. A list exception is a list-layer
        // signal only: it can never grant an allow against a policy deny, so
        // lists are consulted exclusively for names policy already allowed.
        let filter_outcome = if allow {
            filter.map(|snapshot| snapshot.evaluate(qname, qtype))
        } else {
            None
        };
        if let Some(FilterOutcome::Block { evidence }) = &filter_outcome {
            allow = false;
            filter_blocked = true;
            filter_source_id = Some(evidence.source_id.clone());
            filter_source_kind = Some(
                match evidence.source_kind {
                    SourceKind::List => "list",
                    SourceKind::Service => "service",
                }
                .to_owned(),
            );
            filter_rule = evidence.rule.clone();
            filter_note = Some(evidence.note.to_owned());
        }
        self.observe.push(DecisionObservation {
            at: now,
            source_ip: source,
            name,
            query_type: qtype,
            allow,
            policy_revision: decision.policy_revision,
            reason_code: decision.reason_code.clone(),
            source: decision.source,
            identity: decision.effective_identity.clone(),
            device_id,
            denied_alias_target: if allow { None } else { denied_alias_target },
            filter_blocked,
            filter_source_id: filter_source_id.clone(),
            filter_source_kind: filter_source_kind.clone(),
            filter_rule: filter_rule.clone(),
            filter_note: filter_note.clone(),
        });
        DecisionView {
            allow,
            reason_code: decision.reason_code,
            policy_revision: decision.policy_revision,
            source: decision.source,
            identity: decision.effective_identity,
            applied_rule: decision.applied_rule,
            filter_blocked,
            filter_source_id,
            filter_source_kind,
            filter_rule,
            filter_note,
            filter_outcome,
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
