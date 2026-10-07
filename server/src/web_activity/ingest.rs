//! Agent browsing events -> storage. Filters out omnibox typing and categorizes sessions
//! before they are written, so the db layer stays free of categorization logic.
//!
//! The raw frame is parsed once here into [`UrlVisit`] / [`UrlSessionEvent`],
//! leniently: a missing or wrongly-typed field yields the same default / `None`
//! the old `val["x"].as_str()` / `as_i64()` reads produced. The `db` functions
//! only bind the parsed values.

use anyhow::Result;
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use super::db;
use super::url_categorization;
use crate::lenient;

/// A `url` event: one completed navigation.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UrlVisit {
    #[serde(default, deserialize_with = "lenient::string")]
    pub url: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub browser: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub user: Option<String>,
}

impl UrlVisit {
    /// Parse a `url` frame exactly like the old inline extraction did.
    pub fn parse(v: &serde_json::Value) -> Self {
        let mut ev: Self = serde_json::from_value(v.clone()).unwrap_or_default();
        ev.user = lenient::trimmed_non_empty(ev.user);
        ev
    }
}

/// `url` event: one completed navigation.
pub async fn record_url_visit(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let ev = UrlVisit::parse(v);
    if !url_categorization::looks_like_complete_navigation_url(&ev.url) {
        return Ok(());
    }
    db::insert_url(pool, agent, &ev).await
}

/// A `url_session` event: time spent on one page.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UrlSessionEvent {
    #[serde(default, deserialize_with = "lenient::string")]
    pub url: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub browser: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub started_at_ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub ended_at_ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::i64_or_zero")]
    pub duration_ms: i64,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub user: Option<String>,
}

impl UrlSessionEvent {
    /// Parse a `url_session` frame exactly like the old inline extraction did.
    pub fn parse(v: &serde_json::Value) -> Self {
        let mut ev: Self = serde_json::from_value(v.clone()).unwrap_or_default();
        ev.duration_ms = ev.duration_ms.max(0);
        ev.user = lenient::trimmed_non_empty(ev.user);
        ev
    }
}

/// `url_session` event: time spent on one page, categorized at write time.
pub async fn record_url_session(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let ev = UrlSessionEvent::parse(v);
    if !url_categorization::looks_like_complete_navigation_url(&ev.url) {
        return Ok(());
    }
    let hostname = url_categorization::extract_hostname_from_url(&ev.url);
    let cat = url_categorization::categorize_url_now(pool, &hostname, &ev.url).await?;
    let category_id: Option<i64> = cat.as_ref().map(|(id, _)| *id);
    db::insert_url_session(pool, agent, &ev, &hostname, category_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_visit_parses_valid_input() {
        let ev = UrlVisit::parse(&json!({
            "type": "url",
            "url": "https://example.com/page",
            "title": "Example",
            "browser": "chrome",
            "ts": 1_700_000_000,
            "user": " alice ",
        }));
        assert_eq!(ev.url, "https://example.com/page");
        assert_eq!(ev.title.as_deref(), Some("Example"));
        assert_eq!(ev.browser.as_deref(), Some("chrome"));
        assert_eq!(ev.ts, Some(1_700_000_000));
        assert_eq!(ev.user.as_deref(), Some("alice"));
    }

    #[test]
    fn url_visit_missing_fields_yield_old_defaults() {
        let ev = UrlVisit::parse(&json!({ "type": "url" }));
        assert_eq!(ev.url, "");
        assert_eq!(ev.title, None);
        assert_eq!(ev.browser, None);
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn url_visit_wrong_types_yield_old_defaults() {
        let ev = UrlVisit::parse(&json!({
            "url": 42,
            "title": ["Example"],
            "browser": 1,
            "ts": "now",
            "user": "   ",
        }));
        assert_eq!(ev.url, "");
        assert_eq!(ev.title, None);
        assert_eq!(ev.browser, None);
        assert_eq!(ev.ts, None);
        // A whitespace-only user trims to nothing, like the old filter.
        assert_eq!(ev.user, None);
    }

    #[test]
    fn url_session_parses_valid_input() {
        let ev = UrlSessionEvent::parse(&json!({
            "type": "url_session",
            "url": "https://example.com/page",
            "title": "Example",
            "browser": "chrome",
            "started_at_ts": 1_700_000_000,
            "ended_at_ts": 1_700_000_060,
            "duration_ms": 60_000,
            "user": " alice ",
        }));
        assert_eq!(ev.url, "https://example.com/page");
        assert_eq!(ev.title.as_deref(), Some("Example"));
        assert_eq!(ev.browser.as_deref(), Some("chrome"));
        assert_eq!(ev.started_at_ts, Some(1_700_000_000));
        assert_eq!(ev.ended_at_ts, Some(1_700_000_060));
        assert_eq!(ev.duration_ms, 60_000);
        assert_eq!(ev.user.as_deref(), Some("alice"));
    }

    #[test]
    fn url_session_missing_fields_yield_old_defaults() {
        let ev = UrlSessionEvent::parse(&json!({ "type": "url_session" }));
        assert_eq!(ev.url, "");
        assert_eq!(ev.title, None);
        assert_eq!(ev.browser, None);
        assert_eq!(ev.started_at_ts, None);
        assert_eq!(ev.ended_at_ts, None);
        assert_eq!(ev.duration_ms, 0);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn url_session_wrong_types_yield_old_defaults() {
        let ev = UrlSessionEvent::parse(&json!({
            "url": ["https://example.com"],
            "title": 7,
            "browser": false,
            "started_at_ts": "then",
            "ended_at_ts": {},
            "duration_ms": "a minute",
            "user": 0,
        }));
        assert_eq!(ev.url, "");
        assert_eq!(ev.title, None);
        assert_eq!(ev.browser, None);
        assert_eq!(ev.started_at_ts, None);
        assert_eq!(ev.ended_at_ts, None);
        assert_eq!(ev.duration_ms, 0);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn url_session_negative_duration_is_clamped() {
        let ev = UrlSessionEvent::parse(&json!({ "duration_ms": -500 }));
        assert_eq!(ev.duration_ms, 0);
    }
}
