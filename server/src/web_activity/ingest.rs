//! Agent browsing events -> storage. Filters out omnibox typing and categorizes sessions
//! before they are written, so the db layer stays free of categorization logic.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use super::db;
use super::url_categorization;

/// `url` event: one completed navigation.
pub async fn record_url_visit(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
    db::insert_url(pool, agent, v).await
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
