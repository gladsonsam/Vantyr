//! Injectable clock and RNG so scheduling/backoff tests are deterministic.
//! Production uses wall-clock time and a non-cryptographic jitter source;
//! neither is used for secrets.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Deterministic clock used by tests. `advance` moves time by an exact amount.
#[derive(Debug)]
pub struct TestClock {
    ticks: AtomicU64,
}

impl TestClock {
    pub fn new(epoch: DateTime<Utc>) -> Self {
        Self {
            ticks: AtomicU64::new(epoch.timestamp_millis().max(0) as u64),
        }
    }

    pub fn advance_ms(&self, millis: u64) {
        self.ticks.fetch_add(millis, Ordering::SeqCst);
    }

    pub fn now_dt(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(self.ticks.load(Ordering::SeqCst) as i64)
            .unwrap_or_else(|| DateTime::from_timestamp_millis(0).unwrap())
    }
}

impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        self.now_dt()
    }
}

pub trait Rng: Send + Sync {
    /// Uniform-ish jitter source. Never used for keys or tokens.
    fn next_u64(&self) -> u64;
}

/// Time/counter mixed jitter. Adequate because jitter only spreads retries;
/// it does not protect anything.
#[derive(Debug, Default)]
pub struct SystemRng {
    counter: AtomicU64,
}

impl Rng for SystemRng {
    fn next_u64(&self) -> u64 {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        t.rotate_left(17) ^ n.rotate_left(29) ^ 0x9E37_79B9_7F4A_7C15
    }
}

/// Fixed values make backoff deterministic in tests.
#[derive(Debug, Default)]
pub struct TestRng {
    values: std::sync::Mutex<Vec<u64>>,
}

impl TestRng {
    pub fn new(values: Vec<u64>) -> Self {
        Self {
            values: std::sync::Mutex::new(values),
        }
    }
}

impl Rng for TestRng {
    fn next_u64(&self) -> u64 {
        let mut values = self.values.lock().unwrap();
        if values.is_empty() {
            0
        } else {
            values.remove(0)
        }
    }
}

pub type SharedClock = Arc<dyn Clock>;
pub type SharedRng = Arc<dyn Rng>;
