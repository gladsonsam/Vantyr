//! Truthful status reporting. There is no "safe" badge: a stale or failed list
//! is reported as such even though last-known-good bytes are retained.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionStatus {
    NeverFetched,
    Fresh,
    Stale,
    Disabled,
    FailedWithLastGood,
}

impl SubscriptionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NeverFetched => "never_fetched",
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Disabled => "disabled",
            Self::FailedWithLastGood => "failed_with_last_good",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionReport {
    pub id: String,
    pub status: SubscriptionStatus,
    pub enabled: bool,
    /// Safe form of the URL: host, port and path only, never query/userinfo.
    pub url: String,
    pub title: String,
    pub publisher: String,
    pub license: String,
    pub interval_secs: u64,
    pub max_stale_secs: u64,
    pub checked_at: Option<DateTime<Utc>>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub content_updated_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub revision: u64,
    pub content_version: Option<String>,
    pub rule_count: Option<u64>,
    pub bytes: usize,
    pub failure_count: u64,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub stale: bool,
    pub next_due_at: Option<DateTime<Utc>>,
    pub cooldown_until: Option<DateTime<Utc>>,
}
