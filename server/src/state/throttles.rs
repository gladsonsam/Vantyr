//! In-memory rate limits, cooldowns, and dedup windows. Each map is independent;
//! none is held while taking another lock.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use uuid::Uuid;

#[derive(Default)]
pub struct Throttles {
    /// Last Wake-on-LAN packet sent per agent.
    wol_last_wake: Mutex<HashMap<Uuid, Instant>>,
    /// Recent failed logins per rate-limit key (client IP or username).
    pub(crate) login_failures: Mutex<HashMap<String, Vec<Instant>>>,
    /// Per (`rule_id`, `agent_id`) last fire time for alert cooldowns.
    pub alert_match_cooldowns: Mutex<HashMap<(i64, Uuid), Instant>>,
    /// Idempotency for `POST .../software/collect`: (`agent_id`, key) → last use time.
    pub software_collect_dedup: Mutex<HashMap<(Uuid, String), Instant>>,
    /// Last time each (viewer, agent, action) triple was written to the audit log,
    /// so replaying a timeline records *that someone watched* without inserting a
    /// row per keyframe. See [`Self::should_audit_recall_access`].
    recall_audit_seen: Mutex<HashMap<RecallAuditKey, Instant>>,
}

/// How long one audited Recall view "covers". A viewer scrubbing continuously logs
/// one row per window rather than one per frame fetched.
const RECALL_AUDIT_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Cap on tracked triples, so the throttle map can't grow without bound on a large
/// fleet. Exceeding it prunes expired entries, then (worst case) clears.
const RECALL_AUDIT_MAX_TRACKED: usize = 4_096;

/// Key identifying one viewer's access of one agent's Recall data for one action.
type RecallAuditKey = (Uuid, Uuid, &'static str);

/// Decide whether this access should be audited, updating `seen` in place.
///
/// Split out from [`Throttles::should_audit_recall_access`] so the throttle can be
/// tested without standing up a database pool. `now` is injected for the same reason.
fn recall_audit_decision(
    seen: &mut HashMap<RecallAuditKey, Instant>,
    key: RecallAuditKey,
    now: Instant,
) -> bool {
    if seen.len() >= RECALL_AUDIT_MAX_TRACKED {
        seen.retain(|_, at| now.duration_since(*at) < RECALL_AUDIT_WINDOW);
        if seen.len() >= RECALL_AUDIT_MAX_TRACKED {
            // Everything is live; drop the table rather than grow unbounded. Costs a
            // burst of duplicate audit rows, never a missing one.
            seen.clear();
        }
    }

    match seen.get(&key) {
        Some(at) if now.duration_since(*at) < RECALL_AUDIT_WINDOW => false,
        _ => {
            seen.insert(key, now);
            true
        }
    }
}

impl Throttles {
    /// Returns `Err(retry_after_secs)` when `WoL` for this agent is throttled.
    /// `min_interval` is [`Settings::wol_min_interval`](super::Settings::wol_min_interval);
    /// zero disables the throttle.
    pub fn wol_throttle_check(&self, agent_id: Uuid, min_interval: Duration) -> Result<(), u64> {
        if min_interval.is_zero() {
            return Ok(());
        }
        let map = self.wol_last_wake.lock();
        let now = Instant::now();
        if let Some(last) = map.get(&agent_id) {
            let elapsed = now.saturating_duration_since(*last);
            if elapsed < min_interval {
                let wait = min_interval
                    .checked_sub(elapsed)
                    .unwrap_or_default()
                    .as_secs()
                    .max(1);
                return Err(wait);
            }
        }
        Ok(())
    }

    pub fn wol_mark_sent(&self, agent_id: Uuid, min_interval: Duration) {
        if min_interval.is_zero() {
            return;
        }
        self.wol_last_wake.lock().insert(agent_id, Instant::now());
    }

    /// Whether this Recall access should produce an audit row.
    ///
    /// Watching someone's screen history is the most privacy-sensitive thing this
    /// product does, so it has to be on the record — but replaying an hour of
    /// timeline fetches hundreds of keyframe blobs, and a row per blob would bury
    /// the signal and hammer the DB. This collapses a continuous viewing session
    /// into one audit row per [`RECALL_AUDIT_WINDOW`], entirely in memory.
    ///
    /// Returns `true` the first time a (viewer, agent, action) triple is seen and
    /// then at most once per window. Deliberately fail-open on restart: a fresh
    /// process re-logs, which over-records rather than under-records.
    pub fn should_audit_recall_access(
        &self,
        user_id: Uuid,
        agent_id: Uuid,
        action: &'static str,
    ) -> bool {
        let mut seen = self.recall_audit_seen.lock();
        recall_audit_decision(&mut seen, (user_id, agent_id, action), Instant::now())
    }
}

#[cfg(test)]
mod recall_audit_tests {
    use super::*;

    const ACTION: &str = "recall_replay";

    fn key() -> RecallAuditKey {
        (Uuid::nil(), Uuid::nil(), ACTION)
    }

    #[test]
    fn first_access_is_audited() {
        let mut seen = HashMap::new();
        assert!(recall_audit_decision(&mut seen, key(), Instant::now()));
    }

    #[test]
    fn repeat_access_within_window_is_throttled() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        assert!(recall_audit_decision(&mut seen, key(), t0));
        // A replay fetches hundreds of blobs; none of them should add a row.
        for i in 1..500 {
            let t = t0 + Duration::from_millis(i * 100);
            assert!(
                !recall_audit_decision(&mut seen, key(), t),
                "blob fetch at +{i}00ms should not have been audited"
            );
        }
    }

    #[test]
    fn access_after_window_is_audited_again() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        assert!(recall_audit_decision(&mut seen, key(), t0));
        assert!(!recall_audit_decision(
            &mut seen,
            key(),
            t0 + RECALL_AUDIT_WINDOW - Duration::from_secs(1)
        ));
        assert!(recall_audit_decision(
            &mut seen,
            key(),
            t0 + RECALL_AUDIT_WINDOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn different_viewers_agents_and_actions_are_tracked_separately() {
        let mut seen = HashMap::new();
        let t = Instant::now();
        let (viewer_a, viewer_b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let (agent_a, agent_b) = (Uuid::from_u128(10), Uuid::from_u128(11));

        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, ACTION),
            t
        ));
        // A second operator watching the same agent must produce its own row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_b, agent_a, ACTION),
            t
        ));
        // Same operator, different agent: separate row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_b, ACTION),
            t
        ));
        // Same operator+agent, different action: separate row.
        assert!(recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, "recall_day_view"),
            t
        ));
        // ...and each is now throttled independently.
        assert!(!recall_audit_decision(
            &mut seen,
            (viewer_a, agent_a, ACTION),
            t
        ));
    }

    #[test]
    fn tracking_map_stays_bounded() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        // Far more distinct triples than the cap, all live.
        for i in 0..(RECALL_AUDIT_MAX_TRACKED as u128 * 2) {
            recall_audit_decision(&mut seen, (Uuid::from_u128(i), Uuid::nil(), ACTION), t0);
        }
        assert!(
            seen.len() <= RECALL_AUDIT_MAX_TRACKED,
            "throttle map grew past its cap: {}",
            seen.len()
        );
    }

    #[test]
    fn expired_entries_are_pruned_before_clearing() {
        let mut seen = HashMap::new();
        let t0 = Instant::now();
        for i in 0..RECALL_AUDIT_MAX_TRACKED as u128 {
            recall_audit_decision(&mut seen, (Uuid::from_u128(i), Uuid::nil(), ACTION), t0);
        }
        // Well past the window: the next call should prune rather than clear, and the
        // pruned map must still admit (and remember) the new access.
        let later = t0 + RECALL_AUDIT_WINDOW + Duration::from_secs(1);
        let fresh = (Uuid::from_u128(9_999_999), Uuid::nil(), ACTION);
        assert!(recall_audit_decision(&mut seen, fresh, later));
        assert!(!recall_audit_decision(&mut seen, fresh, later));
        assert_eq!(seen.len(), 1, "expired entries should have been pruned");
    }
}
