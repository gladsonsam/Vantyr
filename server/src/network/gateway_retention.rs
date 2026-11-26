//! Bounded retention for Vantyr Network gateway heartbeat reports.
//!
//! Reports are privacy-minimal observations, not an audit log: keep them only
//! briefly and only a bounded number per gateway. Both limits are configurable
//! but clamped to hard caps, so a bad operator setting can never turn this into
//! an unbounded store. The same policy is enforced on ingest (under the gateway
//! row lock), on reads (expired rows are hidden) and by the periodic prune.

use chrono::{DateTime, Duration as ChronoDuration, Utc};

pub const DEFAULT_MAX_AGE_DAYS: i64 = 7;
pub const DEFAULT_MAX_PER_GATEWAY: i64 = 1000;
pub const MIN_MAX_AGE_DAYS: i64 = 1;
pub const MIN_MAX_PER_GATEWAY: i64 = 1;
pub const HARD_MAX_AGE_DAYS: i64 = 30;
pub const HARD_MAX_PER_GATEWAY: i64 = 10_000;

const ENV_AGE_DAYS: &str = "VANTYR_GATEWAY_REPORT_DAYS";
const ENV_MAX_PER_GATEWAY: &str = "VANTYR_GATEWAY_REPORT_MAX";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GatewayReportRetention {
    pub max_age_days: i64,
    pub max_per_gateway: i64,
}

impl Default for GatewayReportRetention {
    fn default() -> Self {
        Self {
            max_age_days: DEFAULT_MAX_AGE_DAYS,
            max_per_gateway: DEFAULT_MAX_PER_GATEWAY,
        }
    }
}

/// Strict parser: rejects blanks, signs, non-numeric text, zero and anything
/// above the hard cap. Kept pure so invalid configuration is testable without
/// mutating process environment.
fn parse_bounded(raw: &str, min: i64, hard_max: i64, field: &str) -> Result<i64, String> {
    let t = raw.trim();
    let value: i64 = t
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
        "gateway report days",
    )
}

pub fn parse_max_per_gateway(raw: &str) -> Result<i64, String> {
    parse_bounded(
        raw,
        MIN_MAX_PER_GATEWAY,
        HARD_MAX_PER_GATEWAY,
        "gateway reports per gateway",
    )
}

impl GatewayReportRetention {
    /// Read operator overrides; an invalid value is ignored with a warning and
    /// the privacy-minimal default is used. Nothing can exceed the hard caps.
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let age = match std::env::var(ENV_AGE_DAYS) {
            Ok(raw) => match parse_max_age_days(&raw) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid gateway report retention; using default");
                    defaults.max_age_days
                }
            },
            Err(_) => defaults.max_age_days,
        };
        let max = match std::env::var(ENV_MAX_PER_GATEWAY) {
            Ok(raw) => match parse_max_per_gateway(&raw) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "invalid gateway report cap; using default");
                    defaults.max_per_gateway
                }
            },
            Err(_) => defaults.max_per_gateway,
        };
        Self {
            max_age_days: age,
            max_per_gateway: max,
        }
    }

    /// Defensive clamp for callers that construct a config directly.
    pub fn clamped(self) -> Self {
        Self {
            max_age_days: self.max_age_days.clamp(MIN_MAX_AGE_DAYS, HARD_MAX_AGE_DAYS),
            max_per_gateway: self
                .max_per_gateway
                .clamp(MIN_MAX_PER_GATEWAY, HARD_MAX_PER_GATEWAY),
        }
    }

    pub fn cutoff(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        now - ChronoDuration::days(self.max_age_days)
    }
}

/// Periodic sweep used by the existing retention task. Also prunes rows past
/// the count cap for idle gateways that receive no further heartbeats.
pub async fn prune_gateway_reports(pool: &sqlx::PgPool) -> anyhow::Result<u64> {
    let cfg = GatewayReportRetention::from_env().clamped();
    Ok(
        super::gateway_db::prune_all_reports(pool, cfg.cutoff(Utc::now()), cfg.max_per_gateway)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_privacy_minimal_and_within_hard_caps() {
        let cfg = GatewayReportRetention::default();
        assert_eq!(cfg.max_age_days, 7);
        assert_eq!(cfg.max_per_gateway, 1000);
        assert!(cfg.max_age_days <= HARD_MAX_AGE_DAYS);
        assert!(cfg.max_per_gateway <= HARD_MAX_PER_GATEWAY);
    }

    #[test]
    fn invalid_retention_config_is_rejected() {
        for bad in ["", "0", "-1", "abc", "31", "  31  ", "1.5"] {
            assert!(parse_max_age_days(bad).is_err(), "{bad} should be rejected");
        }
        for bad in ["", "0", "-5", "nope", "10001", "1e3"] {
            assert!(
                parse_max_per_gateway(bad).is_err(),
                "{bad} should be rejected"
            );
        }
        assert_eq!(parse_max_age_days(" 7 "), Ok(7));
        assert_eq!(parse_max_age_days("30"), Ok(HARD_MAX_AGE_DAYS));
        assert_eq!(parse_max_per_gateway("10000"), Ok(HARD_MAX_PER_GATEWAY));
    }

    #[test]
    fn direct_config_is_clamped_and_cutoff_is_bounded() {
        let cfg = GatewayReportRetention {
            max_age_days: 999,
            max_per_gateway: -4,
        }
        .clamped();
        assert_eq!(cfg.max_age_days, HARD_MAX_AGE_DAYS);
        assert_eq!(cfg.max_per_gateway, MIN_MAX_PER_GATEWAY);
        let now = Utc::now();
        assert!(cfg.cutoff(now) < now);
    }
}
