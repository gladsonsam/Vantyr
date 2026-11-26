//! Bounded, in-process decision observations.
//!
//! This is a test/verification seam, not an event store: it keeps a small
//! bounded ring of what the resolver decided and why. Durable event retention
//! and controller integration belong to the runtime layer.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use family_policy::{DecisionSource, EffectiveIdentity};
use hickory_server::proto::rr::RecordType;

/// Hard cap on retained observations per server instance.
pub const MAX_OBSERVATIONS: usize = 256;

/// One honest decision record. `device_id` is `None` for an unknown source,
/// and `identity` reports what the policy engine actually concluded rather
/// than an inferred owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecisionObservation {
    pub at: DateTime<Utc>,
    pub source_ip: IpAddr,
    pub name: String,
    pub query_type: RecordType,
    pub allow: bool,
    pub policy_revision: u64,
    pub reason_code: String,
    pub source: DecisionSource,
    pub identity: EffectiveIdentity,
    pub device_id: Option<family_policy::DeviceId>,
    /// Set when the original name was allowed but an answer CNAME pointed at
    /// a denied name, so the response was replaced with a denial.
    pub denied_alias_target: Option<String>,
    /// True when household policy allowed the name but an accepted list or
    /// selected service blocked it. `allow` is the final combined answer.
    pub filter_blocked: bool,
    /// Source id of the list or selected service, when the filter blocked.
    /// A raw source URL and per-query URL history are never stored.
    pub filter_source_id: Option<String>,
    /// `"list"` or `"service"`; `None` when the filter did not block.
    pub filter_source_kind: Option<String>,
    /// Upstream-reported rule, when the backend exposes one (ABP). Hickory
    /// hosts/service lookups expose no matched entry, so this stays `None`.
    pub filter_rule: Option<String>,
    /// Why the backend could not expose a more specific rule.
    pub filter_note: Option<String>,
}

#[derive(Clone, Default)]
pub struct ObservationLog {
    entries: Arc<Mutex<VecDeque<DecisionObservation>>>,
}

impl ObservationLog {
    pub fn push(&self, observation: DecisionObservation) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if entries.len() == MAX_OBSERVATIONS {
            entries.pop_front();
        }
        entries.push_back(observation);
    }

    /// Newest-last snapshot of the bounded ring.
    pub fn snapshot(&self) -> Vec<DecisionObservation> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn observation(index: usize) -> DecisionObservation {
        DecisionObservation {
            at: Utc::now(),
            source_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            name: format!("name-{index}.example."),
            query_type: RecordType::A,
            allow: true,
            policy_revision: 1,
            reason_code: "test".to_owned(),
            source: DecisionSource::DeviceDefault,
            identity: EffectiveIdentity::Unknown,
            device_id: None,
            denied_alias_target: None,
            filter_blocked: false,
            filter_source_id: None,
            filter_source_kind: None,
            filter_rule: None,
            filter_note: None,
        }
    }

    #[test]
    fn log_is_bounded_and_preserves_order() {
        let log = ObservationLog::default();
        for i in 0..MAX_OBSERVATIONS + 10 {
            log.push(observation(i));
        }
        let entries = log.snapshot();
        assert_eq!(entries.len(), MAX_OBSERVATIONS);
        assert_eq!(entries[0].name, "name-10.example.");
        assert_eq!(
            entries[entries.len() - 1].name,
            format!("name-{}.example.", MAX_OBSERVATIONS + 9)
        );
        log.clear();
        assert!(log.snapshot().is_empty());
    }
}
