//! Bounded `Retry-After` and exponential backoff with injectable RNG. No fetch
//! loop spins: every failure moves `next_due` into the future.

use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::clock::Rng;
use crate::config::{MAX_BACKOFF_SECS, MAX_RETRY_AFTER_SECS};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackoffPolicy {
    pub initial: Duration,
    pub max: Duration,
    pub max_retry_after: Duration,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(60),
            max: Duration::from_secs(MAX_BACKOFF_SECS),
            max_retry_after: Duration::from_secs(MAX_RETRY_AFTER_SECS),
        }
    }
}

impl BackoffPolicy {
    pub fn from_limits(max_backoff: Duration, max_retry_after: Duration) -> Self {
        Self {
            initial: Duration::from_secs(60),
            max: max_backoff,
            max_retry_after,
        }
    }

    /// Parse `Retry-After` as delta-seconds or an HTTP-date. Unparseable or
    /// negative values are ignored (treated as no hint), never trusted as a
    /// huge delay.
    pub fn parse_retry_after(&self, value: &str, now: DateTime<Utc>) -> Option<Duration> {
        let value = value.trim();
        if value.is_empty() || value.len() > 64 || value.bytes().any(|b| b.is_ascii_control()) {
            return None;
        }
        if let Ok(secs) = value.parse::<u64>() {
            let capped = secs.min(self.max_retry_after.as_secs());
            return Some(Duration::from_secs(capped));
        }
        if let Ok(date) = chrono::DateTime::parse_from_rfc2822(value) {
            let until = date.with_timezone(&Utc);
            let delta = until.signed_duration_since(now).num_milliseconds();
            if delta <= 0 {
                return Some(Duration::ZERO);
            }
            let millis = (delta as u64).min(self.max_retry_after.as_millis() as u64);
            return Some(Duration::from_millis(millis));
        }
        None
    }

    /// Exponential delay for `attempt` (0-based), floored by an explicit
    /// `Retry-After`, plus RNG jitter bounded to a quarter of the base delay.
    pub fn delay(&self, attempt: u32, retry_after: Option<Duration>, rng: &dyn Rng) -> Duration {
        let mut base = self.initial.min(self.max);
        for _ in 0..attempt.min(32) {
            base = base.checked_mul(2).unwrap_or(self.max).min(self.max);
        }
        let jitter_cap = (base.as_millis() / 4) as u64;
        let jitter = if jitter_cap == 0 {
            Duration::ZERO
        } else {
            Duration::from_millis(rng.next_u64() % (jitter_cap + 1))
        };
        // Never retry sooner than the exponential schedule, even if the
        // server asked for a shorter delay. A longer Retry-After wins.
        let floor = retry_after
            .map(|r| base.max(r.min(self.max_retry_after)))
            .unwrap_or(base);
        // A Retry-After may legitimately exceed the exponential cap, so the
        // overall ceiling is the larger of the two configured bounds.
        let ceiling = self.max.max(self.max_retry_after);
        floor.saturating_add(jitter).min(ceiling)
    }
}
