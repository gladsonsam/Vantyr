//! Bounded age + count retention for durable DNS observations.
//!
//! The same clamped policy is applied on every ingest (for the writing
//! household, under its row lock) and by the process-wide retention task for
//! households that go idle. There is no unbounded archive and no synthetic
//! count: rows are simply deleted past the age/count bounds.

use chrono::{DateTime, Duration as ChronoDuration, Utc};

pub const DEFAULT_MAX_AGE_DAYS: i64 = 7;
pub const DEFAULT_MAX_PER_HOUSEHOLD: i64 = 5_000;
pub const DEFAULT_MAX_BATCHES_PER_HOUSEHOLD: i64 = 1_000;
pub const MIN_MAX_AGE_DAYS: i64 = 1;
pub const MIN_MAX_PER_HOUSEHOLD: i64 = 1;
/// Matches the 30-day maximum observation age accepted at ingest.
pub const HARD_MAX_AGE_DAYS: i64 = 30;
pub const HARD_MAX_PER_HOUSEHOLD: i64 = 50_000;
pub const HARD_MAX_BATCHES_PER_HOUSEHOLD: i64 = 10_000;

const ENV_AGE_DAYS: &str = "VANTYR_DNS_EVENT_DAYS";
const ENV_MAX_PER_HOUSEHOLD: &str = "VANTYR_DNS_EVENT_MAX";
const ENV_MAX_BATCHES: &str = "VANTYR_DNS_EVENT_BATCH_MAX";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DnsEventRetention {
    pub max_age_days: i64,
    pub max_per_household: i64,
    pub max_batches_per_household: i64,
}

impl Default for DnsEventRetention {
    fn default() -> Self {
        Self {
            max_age_days: DEFAULT_MAX_AGE_DAYS,
            max_per_household: DEFAULT_MAX_PER_HOUSEHOLD,
            max_batches_per_household: DEFAULT_MAX_BATCHES_PER_HOUSEHOLD,
        }
    }
}

fn parse_bounded(raw: &str, min: i64, hard_max: i64, field: &str) -> Result<i64, String> {
    let value: i64 = raw
        .trim()
        .parse()
        .map_err(|_| format!("{field} must be an integer"))?;
    if !(min..=hard_max).contains(&value) {
        return Err(format!("{field} must be between {min} and {hard_max}"));
    }
    Ok(value)
}

pub fn parse_max_age_days(raw: &str) -> Result<i64, String> {
    parse_bounded(raw, MIN_MAX_AGE_DAYS, HARD_MAX_AGE_DAYS, "DNS event days")
}

pub fn parse_max_per_household(raw: &str) -> Result<i64, String> {
    parse_bounded(
        raw,
        MIN_MAX_PER_HOUSEHOLD,
        HARD_MAX_PER_HOUSEHOLD,
        "DNS events per household",
    )
}

pub fn parse_max_batches(raw: &str) -> Result<i64, String> {
    parse_bounded(
        raw,
        MIN_MAX_PER_HOUSEHOLD,
        HARD_MAX_BATCHES_PER_HOUSEHOLD,
        "DNS event batches per household",
    )
}

impl DnsEventRetention {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let read = |key: &str, parser: fn(&str) -> Result<i64, String>, fallback: i64| {
            match std::env::var(key) {
                Ok(raw) => match parser(&raw) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(error = %e, "invalid DNS event retention; using default");
                        fallback
                    }
                },
                Err(_) => fallback,
            }
        };
        Self {
            max_age_days: read(ENV_AGE_DAYS, parse_max_age_days, defaults.max_age_days),
            max_per_household: read(
                ENV_MAX_PER_HOUSEHOLD,
                parse_max_per_household,
                defaults.max_per_household,
            ),
            max_batches_per_household: read(
                ENV_MAX_BATCHES,
                parse_max_batches,
                defaults.max_batches_per_household,
            ),
        }
    }

    pub fn clamped(self) -> Self {
        Self {
            max_age_days: self.max_age_days.clamp(MIN_MAX_AGE_DAYS, HARD_MAX_AGE_DAYS),
            max_per_household: self
                .max_per_household
                .clamp(MIN_MAX_PER_HOUSEHOLD, HARD_MAX_PER_HOUSEHOLD),
            max_batches_per_household: self
                .max_batches_per_household
                .clamp(MIN_MAX_PER_HOUSEHOLD, HARD_MAX_BATCHES_PER_HOUSEHOLD),
        }
    }

    pub fn cutoff(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        now - ChronoDuration::days(self.max_age_days)
    }
}

/// Periodic age + count sweep used by `prune_auxiliary_retention` at startup and
/// on every retention tick, so idle households are pruned in production too.
pub async fn prune_dns_events(pool: &sqlx::PgPool) -> anyhow::Result<u64> {
    let cfg = DnsEventRetention::from_env().clamped();
    let now = Utc::now();
    let events =
        super::dns_events_db::prune_all_events(pool, cfg.cutoff(now), cfg.max_per_household)
            .await?;
    let batches = super::dns_events_db::prune_all_batches(
        pool,
        cfg.cutoff(now),
        cfg.max_batches_per_household,
    )
    .await?;
    Ok(events.saturating_add(batches))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_privacy_minimal_and_hard_capped() {
        let cfg = DnsEventRetention::default().clamped();
        assert_eq!(cfg.max_age_days, 7);
        assert_eq!(cfg.max_per_household, 5_000);
        assert_eq!(cfg.max_batches_per_household, 1_000);
        assert!(cfg.max_age_days <= HARD_MAX_AGE_DAYS);
        assert!(cfg.max_per_household <= HARD_MAX_PER_HOUSEHOLD);
        assert!(cfg.max_batches_per_household <= HARD_MAX_BATCHES_PER_HOUSEHOLD);
    }

    #[test]
    fn invalid_config_is_rejected_and_direct_config_is_clamped() {
        for bad in ["", "0", "-1", "nope", "31", "1.5"] {
            assert!(parse_max_age_days(bad).is_err(), "{bad}");
        }
        for bad in ["", "0", "-2", "nope", "50001"] {
            assert!(parse_max_per_household(bad).is_err(), "{bad}");
        }
        let cfg = DnsEventRetention {
            max_age_days: 999,
            max_per_household: -5,
            max_batches_per_household: 99_999,
        }
        .clamped();
        assert_eq!(cfg.max_age_days, HARD_MAX_AGE_DAYS);
        assert_eq!(cfg.max_per_household, MIN_MAX_PER_HOUSEHOLD);
        assert_eq!(
            cfg.max_batches_per_household,
            HARD_MAX_BATCHES_PER_HOUSEHOLD
        );
        assert!(cfg.cutoff(Utc::now()) < Utc::now());
    }
}
