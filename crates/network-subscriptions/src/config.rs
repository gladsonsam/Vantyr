//! Operator configuration. Every bound is explicit and checked before any
//! socket is opened. Nothing here is discovered from the network.

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::url::ValidatedUrl;

/// Hard upper bounds. These are limits of the implementation, not tuning knobs.
pub const MAX_SOURCES: usize = 32;
pub const MAX_CANDIDATE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_AGGREGATE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_HEADER_BYTES: usize = 512;
pub const MAX_DIAGNOSTIC_BYTES: usize = 2048;
pub const MIN_INTERVAL_SECS: u64 = 5 * 60;
pub const MAX_INTERVAL_SECS: u64 = 7 * 24 * 60 * 60;
pub const DEFAULT_INTERVAL_SECS: u64 = 24 * 60 * 60;
pub const MIN_STALE_SECS: u64 = 60 * 60;
pub const MAX_STALE_SECS: u64 = MAX_INTERVAL_SECS;
pub const MAX_TIMEOUT_SECS: u64 = 60 * 60;
pub const MAX_RETRY_AFTER_SECS: u64 = 24 * 60 * 60;
pub const MAX_BACKOFF_SECS: u64 = MAX_INTERVAL_SECS;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TEXT_LEN: usize = 256;

/// How (or whether) a query string is accepted. The default is to reject all
/// queries. An explicit allowlist may contain only public, non-secret keys;
/// values are still bounded and checked for control characters.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryPolicy {
    Reject,
    AllowPublic { keys: Vec<String> },
}

impl Default for QueryPolicy {
    fn default() -> Self {
        Self::Reject
    }
}

/// Required operator-declared metadata. This crate never bundles a third-party
/// list or decides that a licence exists; the operator asserts the right to
/// fetch and use each source here.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceMetadata {
    pub title: String,
    pub publisher: String,
    /// Licence identifier or URL chosen by the operator.
    pub license: String,
}

impl SourceMetadata {
    pub fn validate(&self) -> Result<(), Error> {
        for (field, value) in [
            ("title", &self.title),
            ("publisher", &self.publisher),
            ("license", &self.license),
        ] {
            if value.trim().is_empty() || value.len() > MAX_TEXT_LEN {
                return Err(Error::InvalidConfig(format!(
                    "source metadata {field} must be non-empty and <= {MAX_TEXT_LEN} bytes"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    pub max_sources: usize,
    pub max_candidate_bytes: u64,
    pub max_aggregate_bytes: u64,
    pub max_snapshot_bytes: u64,
    pub max_header_bytes: usize,
    pub max_diagnostic_bytes: usize,
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
    pub min_interval_secs: u64,
    pub max_interval_secs: u64,
    pub default_interval_secs: u64,
    pub max_stale_secs: u64,
    pub max_concurrency: usize,
    pub max_retry_after_secs: u64,
    pub max_backoff_secs: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_sources: MAX_SOURCES,
            max_candidate_bytes: MAX_CANDIDATE_BYTES,
            max_aggregate_bytes: MAX_AGGREGATE_BYTES,
            max_snapshot_bytes: MAX_SNAPSHOT_BYTES,
            max_header_bytes: MAX_HEADER_BYTES,
            max_diagnostic_bytes: MAX_DIAGNOSTIC_BYTES,
            connect_timeout_secs: 10,
            request_timeout_secs: 60,
            min_interval_secs: MIN_INTERVAL_SECS,
            max_interval_secs: MAX_INTERVAL_SECS,
            default_interval_secs: DEFAULT_INTERVAL_SECS,
            max_stale_secs: 3 * 24 * 60 * 60,
            max_concurrency: 4,
            max_retry_after_secs: MAX_RETRY_AFTER_SECS,
            max_backoff_secs: MAX_BACKOFF_SECS,
        }
    }
}

impl Limits {
    pub fn validate(&self) -> Result<(), Error> {
        let bad = |field: &str, msg: &str| {
            Error::InvalidConfig(format!("limits.{field}: {msg}"))
        };
        if self.max_sources == 0 || self.max_sources > MAX_SOURCES {
            return Err(bad("max_sources", "must be 1..=32"));
        }
        if self.max_candidate_bytes == 0 || self.max_candidate_bytes > MAX_CANDIDATE_BYTES {
            return Err(bad("max_candidate_bytes", "must be 1..=8 MiB"));
        }
        if self.max_aggregate_bytes == 0 || self.max_aggregate_bytes > MAX_AGGREGATE_BYTES {
            return Err(bad("max_aggregate_bytes", "must be 1..=8 MiB"));
        }
        if self.max_snapshot_bytes == 0 || self.max_snapshot_bytes > MAX_SNAPSHOT_BYTES {
            return Err(bad("max_snapshot_bytes", "must be 1..=16 MiB"));
        }
        if self.max_header_bytes == 0 || self.max_header_bytes > MAX_HEADER_BYTES {
            return Err(bad("max_header_bytes", "must be 1..=512"));
        }
        if self.max_diagnostic_bytes == 0 || self.max_diagnostic_bytes > MAX_DIAGNOSTIC_BYTES {
            return Err(bad("max_diagnostic_bytes", "must be 1..=2048"));
        }
        if self.connect_timeout_secs == 0 || self.connect_timeout_secs > MAX_TIMEOUT_SECS {
            return Err(bad("connect_timeout_secs", "outside 1..=3600"));
        }
        if self.request_timeout_secs == 0 || self.request_timeout_secs > MAX_TIMEOUT_SECS {
            return Err(bad("request_timeout_secs", "outside 1..=3600"));
        }
        if self.connect_timeout_secs > self.request_timeout_secs {
            return Err(bad("connect_timeout_secs", "must not exceed request timeout"));
        }
        if self.min_interval_secs != MIN_INTERVAL_SECS
            || self.max_interval_secs > MAX_INTERVAL_SECS
            || self.min_interval_secs >= self.max_interval_secs
        {
            return Err(bad("interval", "must be 300..=604800 and min < max"));
        }
        if self.default_interval_secs < self.min_interval_secs
            || self.default_interval_secs > self.max_interval_secs
        {
            return Err(bad("default_interval_secs", "outside min/max interval"));
        }
        if self.max_stale_secs < MIN_STALE_SECS || self.max_stale_secs > MAX_STALE_SECS {
            return Err(bad("max_stale_secs", "outside 3600..=604800"));
        }
        if self.max_concurrency == 0 || self.max_concurrency > MAX_SOURCES {
            return Err(bad("max_concurrency", "must be 1..=32"));
        }
        if self.max_retry_after_secs == 0 || self.max_retry_after_secs > MAX_RETRY_AFTER_SECS {
            return Err(bad("max_retry_after_secs", "outside 1..=86400"));
        }
        if self.max_backoff_secs == 0 || self.max_backoff_secs > MAX_BACKOFF_SECS {
            return Err(bad("max_backoff_secs", "outside 1..=604800"));
        }
        Ok(())
    }

    pub fn connect_timeout(&self) -> Duration {
        Duration::from_secs(self.connect_timeout_secs)
    }
    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.request_timeout_secs)
    }
    pub fn interval(&self, secs: u64) -> Result<Duration, Error> {
        if secs < self.min_interval_secs || secs > self.max_interval_secs {
            return Err(Error::InvalidConfig(format!(
                "interval {secs}s outside {}=..={}s",
                self.min_interval_secs, self.max_interval_secs
            )));
        }
        Ok(Duration::from_secs(secs))
    }
}

/// One operator-declared subscription. The URL is stored as text here so the
/// config can be (de)serialized; [`SubscriptionConfig::validate`] turns it into
/// a [`ValidatedUrl`] before anything can reach the network.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionSource {
    /// Stable, filesystem-safe identity used as the cache filename.
    pub id: String,
    pub url: String,
    pub enabled: bool,
    /// Pull frequency in seconds; `None` uses the configured default (24 h).
    pub interval_secs: Option<u64>,
    /// Report `Stale` when no successful check happened within this many
    /// seconds; `None` uses the configured default.
    pub max_stale_secs: Option<u64>,
    pub metadata: SourceMetadata,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedSource {
    pub id: String,
    pub url: ValidatedUrl,
    pub enabled: bool,
    pub interval: Duration,
    pub max_stale: Duration,
    pub metadata: SourceMetadata,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionConfig {
    pub sources: Vec<SubscriptionSource>,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub query_policy: QueryPolicy,
}

impl Default for SubscriptionConfig {
    fn default() -> Self {
        Self {
            sources: Vec::new(),
            limits: Limits::default(),
            query_policy: QueryPolicy::Reject,
        }
    }
}

impl SubscriptionConfig {
    pub fn validate(&self) -> Result<(Limits, Vec<ValidatedSource>), Error> {
        self.limits.validate()?;
        if self.sources.len() > self.limits.max_sources {
            return Err(Error::InvalidConfig(format!(
                "{} sources exceed the limit of {}",
                self.sources.len(),
                self.limits.max_sources
            )));
        }
        let mut ids = HashSet::new();
        let mut validated = Vec::with_capacity(self.sources.len());
        for source in &self.sources {
            validate_id(&source.id)?;
            if !ids.insert(source.id.as_str()) {
                return Err(Error::InvalidConfig(format!(
                    "duplicate source id {}",
                    source.id
                )));
            }
            source.metadata.validate()?;
            let url = ValidatedUrl::parse(&source.url, &self.query_policy, self.limits.max_header_bytes)?;
            let interval = self
                .limits
                .interval(source.interval_secs.unwrap_or(self.limits.default_interval_secs))?;
            let stale_secs = source
                .max_stale_secs
                .unwrap_or(self.limits.max_stale_secs);
            if stale_secs < MIN_STALE_SECS || stale_secs > self.limits.max_stale_secs {
                return Err(Error::InvalidConfig(format!(
                    "source {} max_stale_secs outside {MIN_STALE_SECS}..={}",
                    source.id, self.limits.max_stale_secs
                )));
            }
            validated.push(ValidatedSource {
                id: source.id.clone(),
                url,
                enabled: source.enabled,
                interval,
                max_stale: Duration::from_secs(stale_secs),
                metadata: source.metadata.clone(),
            });
        }
        Ok((self.limits.clone(), validated))
    }
}

/// File-safe identity. A source id is never a path component beyond one file
/// name, so traversal and separator characters are rejected outright.
pub fn validate_id(id: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        return Err(Error::InvalidConfig(format!(
            "source id must be 1..={MAX_ID_LEN} bytes"
        )));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::InvalidConfig(
            "source id may contain only [A-Za-z0-9_-]".into(),
        ));
    }
    Ok(())
}
