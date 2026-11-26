//! Bounded retention for BYOD enrollment attempt history.
//!
//! Mirrors the gateway-report retention shape: privacy-minimal defaults, hard
//! caps on operator overrides, and enforcement both on write (under the
//! household lock) and in a periodic sweep. There is no unbounded append.

use chrono::{DateTime, Duration as ChronoDuration, Utc};

pub const DEFAULT_MAX_AGE_DAYS: i64 = 7;
pub const DEFAULT_MAX_PER_HOUSEHOLD: i64 = 200;
pub const MIN_MAX_AGE_DAYS: i64 = 1;
pub const MIN_MAX_PER_HOUSEHOLD: i64 = 1;
pub const HARD_MAX_AGE_DAYS: i64 = 30;
pub const HARD_MAX_PER_HOUSEHOLD: i64 = 1000;

const ENV_AGE_DAYS: &str = "VANTYR_ENROLL_ATTEMPT_DAYS";
const ENV_MAX_PER_HOUSEHOLD: &str = "VANTYR_ENROLL_ATTEMPT_MAX";

/// Retired grant/session records are kept briefly for support, never forever.
pub const DEFAULT_RECORD_AGE_DAYS: i64 = 7;
pub const DEFAULT_RECORD_MAX_PER_HOUSEHOLD: i64 = 500;
pub const HARD_MAX_RECORD_AGE_DAYS: i64 = 30;
pub const HARD_MAX_RECORD_PER_HOUSEHOLD: i64 = 5000;
const ENV_RECORD_AGE_DAYS: &str = "VANTYR_ENROLL_RECORD_DAYS";
const ENV_RECORD_MAX_PER_HOUSEHOLD: &str = "VANTYR_ENROLL_RECORD_MAX";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttemptRetention {
    pub max_age_days: i64,
    pub max_per_household: i64,
}

impl Default for AttemptRetention {
    fn default() -> Self {
        Self {
            max_age_days: DEFAULT_MAX_AGE_DAYS,
            max_per_household: DEFAULT_MAX_PER_HOUSEHOLD,
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
    parse_bounded(
        raw,
        MIN_MAX_AGE_DAYS,
        HARD_MAX_AGE_DAYS,
        "enrollment attempt days",
    )
}

pub fn parse_max_per_household(raw: &str) -> Result<i64, String> {
    parse_bounded(
        raw,
        MIN_MAX_PER_HOUSEHOLD,
        HARD_MAX_PER_HOUSEHOLD,
        "enrollment attempts per household",
    )
}

impl AttemptRetention {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let age = match std::env::var(ENV_AGE_DAYS) {
            Ok(raw) => match parse_max_age_days(&raw) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid enrollment attempt retention; using default");
                    defaults.max_age_days
                }
            },
            Err(_) => defaults.max_age_days,
        };
        let max = match std::env::var(ENV_MAX_PER_HOUSEHOLD) {
            Ok(raw) => match parse_max_per_household(&raw) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid enrollment attempt cap; using default");
                    defaults.max_per_household
                }
            },
            Err(_) => defaults.max_per_household,
        };
        Self {
            max_age_days: age,
            max_per_household: max,
        }
    }

    pub fn clamped(self) -> Self {
        Self {
            max_age_days: self.max_age_days.clamp(MIN_MAX_AGE_DAYS, HARD_MAX_AGE_DAYS),
            max_per_household: self
                .max_per_household
                .clamp(MIN_MAX_PER_HOUSEHOLD, HARD_MAX_PER_HOUSEHOLD),
        }
    }

    pub fn cutoff(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        now - ChronoDuration::days(self.max_age_days)
    }
}

/// Periodic sweep; safe to call alongside the write-time pruning.
#[allow(dead_code)] // Available to the periodic retention task; writes also prune.
pub async fn prune_enrollment_attempts(pool: &sqlx::PgPool) -> anyhow::Result<u64> {
    let cfg = AttemptRetention::from_env().clamped();
    Ok(
        super::enroll_db::prune_all_attempts(pool, cfg.cutoff(Utc::now()), cfg.max_per_household)
            .await?,
    )
}

/// Bounded retention for *retired* grants and verified sessions. Live rows are
/// never pruned by the count cap; only consumed/revoked/expired/ended records
/// are candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordRetention {
    pub max_age_days: i64,
    pub max_per_household: i64,
}

impl Default for RecordRetention {
    fn default() -> Self {
        Self {
            max_age_days: DEFAULT_RECORD_AGE_DAYS,
            max_per_household: DEFAULT_RECORD_MAX_PER_HOUSEHOLD,
        }
    }
}

impl RecordRetention {
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let age = match std::env::var(ENV_RECORD_AGE_DAYS) {
            Ok(raw) => match parse_bounded(
                &raw,
                MIN_MAX_AGE_DAYS,
                HARD_MAX_RECORD_AGE_DAYS,
                "enrollment record days",
            ) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid enrollment record retention; using default");
                    defaults.max_age_days
                }
            },
            Err(_) => defaults.max_age_days,
        };
        let max = match std::env::var(ENV_RECORD_MAX_PER_HOUSEHOLD) {
            Ok(raw) => match parse_bounded(
                &raw,
                MIN_MAX_PER_HOUSEHOLD,
                HARD_MAX_RECORD_PER_HOUSEHOLD,
                "enrollment records per household",
            ) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid enrollment record cap; using default");
                    defaults.max_per_household
                }
            },
            Err(_) => defaults.max_per_household,
        };
        Self {
            max_age_days: age,
            max_per_household: max,
        }
    }

    pub fn clamped(self) -> Self {
        Self {
            max_age_days: self
                .max_age_days
                .clamp(MIN_MAX_AGE_DAYS, HARD_MAX_RECORD_AGE_DAYS),
            max_per_household: self
                .max_per_household
                .clamp(MIN_MAX_PER_HOUSEHOLD, HARD_MAX_RECORD_PER_HOUSEHOLD),
        }
    }

    pub fn cutoff(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        now - ChronoDuration::days(self.max_age_days)
    }
}

#[allow(dead_code)] // Available to the periodic retention task; writes also prune.
pub async fn prune_enrollment_records(pool: &sqlx::PgPool) -> anyhow::Result<u64> {
    let cfg = RecordRetention::from_env().clamped();
    let now = Utc::now();
    Ok(
        super::enroll_db::prune_all_records(pool, cfg.cutoff(now), now, cfg.max_per_household)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_bounded() {
        let cfg = AttemptRetention::default().clamped();
        assert_eq!(cfg.max_age_days, 7);
        assert_eq!(cfg.max_per_household, 200);
        assert!(cfg.max_age_days <= HARD_MAX_AGE_DAYS);
        assert!(cfg.max_per_household <= HARD_MAX_PER_HOUSEHOLD);
    }

    #[test]
    fn invalid_config_is_rejected_and_direct_config_is_clamped() {
        for bad in ["", "0", "-1", "nope", "31", "1.5"] {
            assert!(parse_max_age_days(bad).is_err(), "{bad}");
        }
        for bad in ["", "0", "-2", "nope", "1001"] {
            assert!(parse_max_per_household(bad).is_err(), "{bad}");
        }
        let cfg = AttemptRetention {
            max_age_days: 999,
            max_per_household: -5,
        }
        .clamped();
        assert_eq!(cfg.max_age_days, HARD_MAX_AGE_DAYS);
        assert_eq!(cfg.max_per_household, MIN_MAX_PER_HOUSEHOLD);
        assert!(cfg.cutoff(Utc::now()) < Utc::now());
        let records = RecordRetention::default().clamped();
        assert_eq!(records.max_age_days, 7);
        assert_eq!(records.max_per_household, 500);
        assert!(
            RecordRetention {
                max_age_days: 999,
                max_per_household: -1,
            }
            .clamped()
            .max_age_days
                <= HARD_MAX_RECORD_AGE_DAYS
        );
    }
}
