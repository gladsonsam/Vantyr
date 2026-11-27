//! Agent browsing events -> storage. Filters out omnibox typing and categorizes
//! sessions before they are written, so the `db` layer stays free of
//! categorization logic.
//!
//! The frame is parsed once with the strict shared contract; a missing or
//! wrongly-typed field rejects the whole event before any database mutation.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use super::db;
use super::url_categorization;
pub use vantyr_protocol::telemetry::{UrlSessionEvent, UrlVisit};

/// `url` event: one completed navigation.
pub async fn record_url_visit(
    pool: &PgPool,
    agent: Uuid,
    ev: &UrlVisit,
) -> Result<()> {
    if !url_categorization::looks_like_complete_navigation_url(&ev.url) {
        return Ok(());
    }
    db::insert_url(pool, agent, ev).await
}

/// `url_session` event: time spent on one page, categorized at write time.
pub async fn record_url_session(
    pool: &PgPool,
    agent: Uuid,
    ev: &UrlSessionEvent,
) -> Result<()> {
    if !url_categorization::looks_like_complete_navigation_url(&ev.url) {
        return Ok(());
    }
    let hostname = url_categorization::extract_hostname_from_url(&ev.url);
    let cat = url_categorization::categorize_url_now(pool, &hostname, &ev.url).await?;
    let category_id: Option<i64> = cat.as_ref().map(|(id, _)| *id);
    db::insert_url_session(pool, agent, ev, &hostname, category_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_visits_and_sessions_parse() {
        let visit = UrlVisit::parse(&json!({
            "type": "url", "url": "https://example.com/page", "title": "Example",
            "browser": "chrome", "ts": 1_700_000_000, "user": " alice "
        }))
        .unwrap();
        assert_eq!(visit.url, "https://example.com/page");
        assert_eq!(visit.user.as_deref(), Some("alice"));
        let session = UrlSessionEvent::parse(&json!({
            "type": "url_session", "url": "https://example.com/page", "title": null,
            "browser": "chrome", "started_at_ts": 1, "ended_at_ts": 2,
            "duration_ms": 1000, "user": null
        }))
        .unwrap();
        assert_eq!(session.duration_ms, 1000);
        assert_eq!(session.title, None);
    }

    #[test]
    fn missing_and_wrong_typed_fields_are_rejected() {
        assert!(UrlVisit::parse(&json!({"type":"url"})).is_err());
        assert!(UrlVisit::parse(&json!({
            "url": 42, "title": ["Example"], "browser": 1, "ts": "now", "user": "   "
        }))
        .is_err());
        assert!(UrlSessionEvent::parse(&json!({"type":"url_session"})).is_err());
        assert!(UrlSessionEvent::parse(&json!({
            "url": ["https://example.com"], "started_at_ts": "then",
            "ended_at_ts": {}, "duration_ms": "a minute"
        }))
        .is_err());
    }

    #[test]
    fn negative_duration_is_clamped_after_a_strict_parse() {
        let ev = UrlSessionEvent::parse(&json!({
            "url": "u", "title": null, "browser": null,
            "started_at_ts": 1, "ended_at_ts": 2, "duration_ms": -500, "user": null
        }))
        .unwrap();
        assert_eq!(ev.duration_ms, 0);
    }
}
