//! Admin backfill/re-categorization helpers for URL categorization.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use super::db;
use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;

#[derive(Debug, Deserialize)]
pub struct RecalcQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}

const fn default_limit() -> i64 {
    50_000
}

/// Re-enqueue uncategorized URL visits for categorization (global).
pub async fn recalc_url_visits(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<RecalcQuery>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let limit = q.limit.clamp(1, 500_000);
    let ip = audit_ip(&headers, addr);
    let enqueued = db::queue::enqueue_url_categorization_backfill_all(&s.db, limit).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_categorization_recalc_url_visits",
        "ok",
        &serde_json::json!({ "limit": limit, "enqueued": enqueued }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "enqueued": enqueued })))
}

/// Re-categorize recent URL sessions by re-applying override/UT1 matching.
pub async fn recalc_url_sessions(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<RecalcQuery>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let limit = q.limit.clamp(1, 500_000);
    let ip = audit_ip(&headers, addr);
    let updated = super::engine::recategorize_recent_sessions(&s.db, limit).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_categorization_recalc_url_sessions",
        "ok",
        &serde_json::json!({ "limit": limit, "updated": updated }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "updated": updated })))
}
