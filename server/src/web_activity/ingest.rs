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

/// `url_session` event: time spent on one page, categorized at write time.
pub async fn record_url_session(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
    let hostname = url_categorization::extract_hostname_from_url(url);
    let cat = url_categorization::categorize_url_now(pool, &hostname, url).await?;
    let category_id: Option<i64> = cat.as_ref().map(|(id, _)| *id);
    db::insert_url_session(pool, agent, v, &hostname, category_id).await
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
}
