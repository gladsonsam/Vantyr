//! Bounded, worker-local queue of Vantyr Network decision events.
//!
//! Each queue is bound to one immutable household. Records keep their source,
//! device, person, evidence quality and correlation id so a DNS decision, a
//! proxy decision and an agent event about the same visit can be joined by the
//! consumer instead of being counted as three visits. This queue never
//! aggregates, deduplicates or synthesises records.
//!
//! Bounds are configurable but validated on creation *and* on update: a hard
//! event count, a hard total byte count, a per-event byte limit, a time
//! retention window and a future-timestamp skew. The oldest records are
//! evicted first. Free-text fields that look like raw URLs, query strings,
//! credentials or bodies are rejected at ingest; nothing is scraped from the
//! network and no body/header is ever stored.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use vantyr_network_policy::store::MAX_NETWORK_EVENT_RETENTION_SECS;
use vantyr_network_policy::{Action, Event, HouseholdId};

/// Ceilings that config may not exceed; they keep "configurable" from turning
/// into unbounded memory growth.
pub const HARD_MAX_EVENTS: usize = 10_000;
pub const HARD_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const HARD_MAX_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_FUTURE_SKEW_SECS: u64 = 300;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventQueueConfig {
    pub max_events: usize,
    pub max_bytes: usize,
    pub max_event_bytes: usize,
    pub retention_secs: u64,
    pub max_future_skew_secs: u64,
}

impl Default for EventQueueConfig {
    fn default() -> Self {
        Self {
            max_events: 512,
            max_bytes: 2 * 1024 * 1024,
            max_event_bytes: 16 * 1024,
            retention_secs: 7 * 24 * 3600,
            max_future_skew_secs: 60,
        }
    }
}

impl EventQueueConfig {
    /// The single validation path used for both initial config and updates.
    /// `0` retention is rejected: the server's "unlimited" convention is not
    /// reused for this layer.
    pub fn validate(&self) -> Result<(), EventError> {
        if self.max_events == 0 || self.max_events > HARD_MAX_EVENTS {
            return Err(EventError::InvalidConfig(format!(
                "max_events must be 1..={HARD_MAX_EVENTS}"
            )));
        }
        if self.max_bytes == 0 || self.max_bytes > HARD_MAX_BYTES {
            return Err(EventError::InvalidConfig(format!(
                "max_bytes must be 1..={HARD_MAX_BYTES}"
            )));
        }
        if self.max_event_bytes == 0
            || self.max_event_bytes > HARD_MAX_EVENT_BYTES.min(self.max_bytes)
        {
            return Err(EventError::InvalidConfig(format!(
                "max_event_bytes must be 1..={}",
                HARD_MAX_EVENT_BYTES.min(self.max_bytes)
            )));
        }
        if self.retention_secs == 0 || self.retention_secs > MAX_NETWORK_EVENT_RETENTION_SECS {
            return Err(EventError::InvalidConfig(format!(
                "retention_secs must be 1..={MAX_NETWORK_EVENT_RETENTION_SECS}"
            )));
        }
        if self.max_future_skew_secs > MAX_FUTURE_SKEW_SECS {
            return Err(EventError::InvalidConfig(format!(
                "max_future_skew_secs must be <= {MAX_FUTURE_SKEW_SECS}"
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EventError {
    InvalidConfig(String),
    WrongHousehold,
    TooLarge { bytes: usize, limit: usize },
    FutureTimestamp { seconds_ahead: i64, limit: u64 },
    SensitiveField(&'static str),
    EncodingFailed(String),
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(detail) => write!(f, "invalid event queue config: {detail}"),
            Self::WrongHousehold => write!(f, "event belongs to another household"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "event is {bytes} bytes, limit is {limit}")
            }
            Self::FutureTimestamp {
                seconds_ahead,
                limit,
            } => write!(f, "event is {seconds_ahead}s ahead, limit is {limit}s"),
            Self::SensitiveField(field) => write!(f, "sensitive value in {field}"),
            Self::EncodingFailed(detail) => write!(f, "event encoding failed: {detail}"),
        }
    }
}

impl std::error::Error for EventError {}

#[derive(Clone)]
struct StoredEvent {
    occurred_at: DateTime<Utc>,
    json: Vec<u8>,
}

struct QueueState {
    config: EventQueueConfig,
    entries: VecDeque<StoredEvent>,
    bytes: usize,
}

impl QueueState {
    fn prune_expired(&mut self, now: DateTime<Utc>) {
        let cutoff = now - ChronoDuration::seconds(self.config.retention_secs as i64);
        while let Some(front) = self.entries.front() {
            if front.occurred_at >= cutoff {
                break;
            }
            let removed = self.entries.pop_front().expect("front was checked");
            self.bytes -= removed.json.len();
        }
    }

    fn enforce_caps(&mut self) {
        while self.entries.len() > self.config.max_events || self.bytes > self.config.max_bytes {
            let removed = self.entries.pop_front().expect("caps require an entry");
            self.bytes -= removed.json.len();
        }
    }
}

/// One household's bounded event queue. The household is immutable; one mutex
/// covers the config and records so every ingest or config update is a single
/// atomic transition.
pub struct EventQueue {
    household_id: HouseholdId,
    state: Mutex<QueueState>,
}

impl EventQueue {
    pub fn new(household_id: HouseholdId, config: EventQueueConfig) -> Result<Self, EventError> {
        config.validate()?;
        Ok(Self {
            household_id,
            state: Mutex::new(QueueState {
                config,
                entries: VecDeque::new(),
                bytes: 0,
            }),
        })
    }

    /// Ingest one decision event. At most one bounded record is appended; on a
    /// validation failure nothing changes.
    pub fn ingest(
        &self,
        household_id: HouseholdId,
        event: Event,
        now: DateTime<Utc>,
    ) -> Result<(), EventError> {
        if household_id != self.household_id || event.household_id != self.household_id {
            return Err(EventError::WrongHousehold);
        }

        let mut state = self.state.lock().unwrap();
        let seconds_ahead = (event.occurred_at - now).num_seconds();
        let skew = state.config.max_future_skew_secs as i64;
        if seconds_ahead > skew {
            return Err(EventError::FutureTimestamp {
                seconds_ahead,
                limit: state.config.max_future_skew_secs,
            });
        }
        if let Some(field) = sensitive_field(&event) {
            return Err(EventError::SensitiveField(field));
        }
        let json =
            serde_json::to_vec(&event).map_err(|e| EventError::EncodingFailed(e.to_string()))?;
        if json.len() > state.config.max_event_bytes {
            return Err(EventError::TooLarge {
                bytes: json.len(),
                limit: state.config.max_event_bytes,
            });
        }

        state.prune_expired(now);
        state.entries.push_back(StoredEvent {
            occurred_at: event.occurred_at,
            json,
        });
        state.bytes += state.entries.back().expect("just pushed").json.len();
        state.enforce_caps();
        Ok(())
    }

    /// Replace the config through the same validation as `new`, then apply the
    /// new bounds immediately so tightening cannot leave an oversized queue.
    pub fn set_config(
        &self,
        config: EventQueueConfig,
        now: DateTime<Utc>,
    ) -> Result<(), EventError> {
        config.validate()?;
        let mut state = self.state.lock().unwrap();
        state.config = config;
        state.prune_expired(now);
        state.enforce_caps();
        Ok(())
    }

    /// Decoded records in oldest-to-newest order. No aggregation is performed.
    pub fn events(&self) -> Vec<Event> {
        self.state
            .lock()
            .unwrap()
            .entries
            .iter()
            .map(|stored| {
                serde_json::from_slice(&stored.json)
                    .expect("stored event was encoded by this queue")
            })
            .collect()
    }

    /// Current (count, byte) usage against the configured caps.
    pub fn stats(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap();
        (state.entries.len(), state.bytes)
    }
}

/// Conservative, typed-field scan. The event model has no body, header or
/// credential field; any free-text value resembling one is refused rather than
/// stored. This is not a URL parser and performs no network access.
fn sensitive_field(event: &Event) -> Option<&'static str> {
    let mut fields: Vec<(&'static str, &str)> = Vec::with_capacity(9);
    match &event.action {
        Action::DnsResolve { name } => fields.push(("action.name", name)),
        Action::HttpRequest { host, path } => {
            fields.push(("action.host", host));
            fields.push(("action.path", path));
        }
        Action::AppLaunch { exe } => fields.push(("action.exe", exe)),
        Action::ScreenTime => {}
    }
    if let Some(correlation) = event.correlation_id.as_deref() {
        fields.push(("correlation_id", correlation));
    }
    fields.push(("enforcing_component", &event.enforcing_component));
    fields.push(("decision.reason_code", &event.decision.reason_code));
    fields.push(("decision.explanation", &event.decision.explanation));
    if let Some(rule) = event.decision.applied_rule.as_deref() {
        fields.push(("decision.applied_rule", rule));
    }
    fields
        .into_iter()
        .find(|(_, value)| is_sensitive(value))
        .map(|(name, _)| name)
}

fn is_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("://") || lower.contains('@') || lower.contains('?') {
        return true;
    }
    const MARKERS: [&str; 12] = [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "authorization",
        "bearer ",
        "cookie",
        "credential",
        "private_key",
        "session_id",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use std::collections::BTreeMap;
    use uuid::Uuid;
    use vantyr_network_policy::{
        Decision, DecisionSource, EffectiveIdentity, EventSource, EvidenceQuality,
    };

    fn ts(s: &str) -> DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn household() -> HouseholdId {
        Uuid::new_v4()
    }

    fn decision(at: DateTime<Utc>) -> Decision {
        Decision {
            allow: false,
            reason_code: "network_default".into(),
            explanation: "no matching rule".into(),
            policy_revision: 1,
            applied_rule: None,
            source: DecisionSource::DeviceDefault,
            effective_identity: EffectiveIdentity::SharedDevice,
            enforcement: BTreeMap::new(),
            evaluated_at: at,
        }
    }

    fn event(
        h: HouseholdId,
        source: EventSource,
        at: DateTime<Utc>,
        correlation: &str,
        person: Option<Uuid>,
    ) -> Event {
        Event {
            id: Uuid::new_v4(),
            occurred_at: at,
            household_id: h,
            device_id: Uuid::new_v4(),
            person_id: person,
            source,
            action: Action::DnsResolve {
                name: "example.org".into(),
            },
            decision: decision(at),
            evidence: EvidenceQuality::NetworkOnly,
            correlation_id: Some(correlation.into()),
            enforcing_component: "vantyr-dns".into(),
        }
    }

    #[test]
    fn count_cap_evicts_oldest_first() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let config = EventQueueConfig {
            max_events: 2,
            max_bytes: 1024 * 1024,
            max_event_bytes: 64 * 1024,
            retention_secs: 3600,
            max_future_skew_secs: 60,
        };
        let queue = EventQueue::new(h, config).unwrap();
        for (index, source) in [EventSource::Dns, EventSource::Proxy, EventSource::Agent]
            .into_iter()
            .enumerate()
        {
            let at = now + ChronoDuration::seconds(index as i64);
            queue
                .ingest(h, event(h, source, at, &format!("c{index}"), None), at)
                .unwrap();
        }
        let events = queue.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].correlation_id.as_deref(), Some("c1"));
        assert_eq!(events[1].correlation_id.as_deref(), Some("c2"));
        assert_eq!(queue.stats().0, 2);
    }

    #[test]
    fn byte_caps_reject_oversize_event_and_evict_oldest() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let sample = event(h, EventSource::Dns, now, "c1", None);
        let base = serde_json::to_vec(&sample).unwrap().len();

        let config = EventQueueConfig {
            max_events: 100,
            max_bytes: base * 2,
            max_event_bytes: base + 100,
            retention_secs: 3600,
            max_future_skew_secs: 60,
        };
        let queue = EventQueue::new(h, config).unwrap();
        for index in 0..3 {
            let correlation = format!("c{index}");
            queue
                .ingest(h, event(h, EventSource::Dns, now, &correlation, None), now)
                .unwrap();
        }
        assert_eq!(queue.stats(), (2, base * 2));
        assert_eq!(queue.events()[0].correlation_id.as_deref(), Some("c1"));

        let too_big = EventQueueConfig {
            max_event_bytes: base - 1,
            ..EventQueueConfig::default()
        };
        let strict = EventQueue::new(h, too_big).unwrap();
        assert_eq!(
            strict.ingest(h, sample, now),
            Err(EventError::TooLarge {
                bytes: base,
                limit: base - 1
            })
        );
        assert_eq!(strict.stats(), (0, 0));
    }

    #[test]
    fn time_retention_prunes_expired_records() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let config = EventQueueConfig {
            retention_secs: 10,
            ..EventQueueConfig::default()
        };
        let queue = EventQueue::new(h, config).unwrap();
        let stale_at = now - ChronoDuration::seconds(100);
        queue
            .ingest(
                h,
                event(h, EventSource::Dns, stale_at, "stale", None),
                stale_at,
            )
            .unwrap();
        assert_eq!(queue.stats().0, 1);
        queue
            .ingest(h, event(h, EventSource::Dns, now, "fresh", None), now)
            .unwrap();
        let events = queue.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].correlation_id.as_deref(), Some("fresh"));
    }

    #[test]
    fn future_timestamps_are_rejected_and_skew_is_capped() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let queue = EventQueue::new(h, EventQueueConfig::default()).unwrap();
        assert_eq!(
            queue.ingest(
                h,
                event(
                    h,
                    EventSource::Dns,
                    now + ChronoDuration::seconds(61),
                    "future",
                    None
                ),
                now,
            ),
            Err(EventError::FutureTimestamp {
                seconds_ahead: 61,
                limit: 60
            })
        );
        queue
            .ingest(
                h,
                event(
                    h,
                    EventSource::Dns,
                    now + ChronoDuration::seconds(60),
                    "edge",
                    None,
                ),
                now,
            )
            .unwrap();
        assert_eq!(queue.events().len(), 1);
    }

    #[test]
    fn cross_household_events_are_rejected() {
        let h = household();
        let other = household();
        let now = ts("2026-11-26T10:00:00Z");
        let queue = EventQueue::new(h, EventQueueConfig::default()).unwrap();
        assert_eq!(
            queue.ingest(other, event(h, EventSource::Dns, now, "c", None), now),
            Err(EventError::WrongHousehold)
        );
        assert_eq!(
            queue.ingest(h, event(other, EventSource::Dns, now, "c", None), now),
            Err(EventError::WrongHousehold)
        );
        assert_eq!(queue.stats(), (0, 0));
    }

    #[test]
    fn raw_urls_and_credentials_are_rejected() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let queue = EventQueue::new(h, EventQueueConfig::default()).unwrap();

        let mut url = event(h, EventSource::Proxy, now, "c", None);
        url.action = Action::HttpRequest {
            host: "example.org".into(),
            path: "https://user:pass@example.org/x?token=abc".into(),
        };
        assert_eq!(
            queue.ingest(h, url, now),
            Err(EventError::SensitiveField("action.path"))
        );

        let mut credential = event(h, EventSource::Agent, now, "token=abc", None);
        credential.correlation_id = Some("token=abc".into());
        assert_eq!(
            queue.ingest(h, credential, now),
            Err(EventError::SensitiveField("correlation_id"))
        );
        assert_eq!(queue.stats(), (0, 0));
    }

    #[test]
    fn evidence_and_correlation_are_preserved_without_aggregation() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let person = Uuid::new_v4();
        let queue = EventQueue::new(h, EventQueueConfig::default()).unwrap();

        let proxy = event(h, EventSource::Proxy, now, "visit-42", Some(person));
        let expected = proxy.clone();
        queue.ingest(h, proxy, now).unwrap();
        assert_eq!(queue.events(), vec![expected.clone()]);

        for source in [EventSource::Dns, EventSource::Agent] {
            queue
                .ingest(h, event(h, source, now, "visit-42", Some(person)), now)
                .unwrap();
        }
        let events = queue.events();
        assert_eq!(events.len(), 3, "three sources stay three records");
        assert_eq!(events[0].source, EventSource::Proxy);
        assert_eq!(events[1].source, EventSource::Dns);
        assert_eq!(events[2].source, EventSource::Agent);
        assert!(events
            .iter()
            .all(|e| e.correlation_id.as_deref() == Some("visit-42")));
        assert!(events.iter().all(|e| e.person_id == Some(person)));
        assert_eq!(events[0].device_id, expected.device_id);
        assert_eq!(events[0].evidence, EvidenceQuality::NetworkOnly);
    }

    #[test]
    fn config_validation_is_identical_for_initial_and_update() {
        let h = household();
        let now = ts("2026-11-26T10:00:00Z");
        let mut bad = EventQueueConfig::default();
        bad.max_events = 0;
        assert!(matches!(
            EventQueue::new(h, bad.clone()),
            Err(EventError::InvalidConfig(_))
        ));
        bad.retention_secs = 0;
        assert!(matches!(
            EventQueue::new(h, bad.clone()),
            Err(EventError::InvalidConfig(_))
        ));

        let queue = EventQueue::new(h, EventQueueConfig::default()).unwrap();
        for index in 0..3 {
            queue
                .ingest(
                    h,
                    event(h, EventSource::Dns, now, &format!("c{index}"), None),
                    now,
                )
                .unwrap();
        }
        assert!(matches!(
            queue.set_config(bad, now),
            Err(EventError::InvalidConfig(_))
        ));
        assert_eq!(queue.stats().0, 3, "invalid update changed nothing");

        let tight = EventQueueConfig {
            max_events: 1,
            ..EventQueueConfig::default()
        };
        queue.set_config(tight, now).unwrap();
        assert_eq!(queue.events()[0].correlation_id.as_deref(), Some("c2"));
    }
}
