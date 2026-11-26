//! Pure, deterministic scheduling decisions. This module computes due times;
//! the async worker in [`crate::worker`] performs the actual waits.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::backoff::{BackoffPolicy, BackoffPolicy as Policy};
use crate::clock::{SharedClock, SharedRng, SystemClock, SystemRng};

#[derive(Clone)]
pub struct RefreshScheduler {
    clock: SharedClock,
    rng: SharedRng,
    policy: Policy,
}

impl Default for RefreshScheduler {
    fn default() -> Self {
        Self::new(
            Arc::new(SystemClock),
            Arc::new(SystemRng::default()),
            BackoffPolicy::default(),
        )
    }
}

impl RefreshScheduler {
    pub fn new(clock: SharedClock, rng: SharedRng, policy: BackoffPolicy) -> Self {
        Self {
            clock,
            rng,
            policy,
        }
    }

    pub fn now(&self) -> DateTime<Utc> {
        self.clock.now()
    }

    /// A forced refresh ignores `next_due` but never the abuse cooldown; that
    /// is checked separately by the fetcher.
    pub fn is_due(&self, next_due: Option<DateTime<Utc>>, force: bool) -> bool {
        if force {
            return true;
        }
        match next_due {
            None => true,
            Some(due) => self.now() >= due,
        }
    }

    pub fn after_success(&self, interval: Duration) -> DateTime<Utc> {
        self.now()
            .checked_add_signed(chrono::Duration::from_std(interval).unwrap_or_else(|_| {
                chrono::Duration::from_std(Duration::from_secs(7 * 24 * 60 * 60)).unwrap()
            }))
            .unwrap_or_else(|| self.now())
    }

    pub fn after_failure(
        &self,
        attempt: u32,
        retry_after: Option<Duration>,
    ) -> (DateTime<Utc>, Duration) {
        let delay = self.policy.delay(attempt, retry_after, self.rng.as_ref());
        let until = self
            .now()
            .checked_add_signed(chrono::Duration::from_std(delay).unwrap_or_else(|_| {
                chrono::Duration::from_std(self.policy.max).unwrap()
            }))
            .unwrap_or_else(|| self.now());
        (until, delay)
    }

    pub fn is_stale(
        &self,
        last_check: Option<DateTime<Utc>>,
        max_stale: Duration,
    ) -> bool {
        match last_check {
            None => true,
            Some(at) => {
                self.now().signed_duration_since(at)
                    > chrono::Duration::from_std(max_stale).unwrap_or_else(|_| {
                        chrono::Duration::from_std(Duration::from_secs(7 * 24 * 60 * 60)).unwrap()
                    })
            }
        }
    }

    pub fn policy(&self) -> &BackoffPolicy {
        &self.policy
    }
}
