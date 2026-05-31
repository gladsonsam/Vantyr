//! Admin backfill/re-categorization helpers for URL categorization.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::{auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<RecalcQuery>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let limit = q.limit.clamp(1, 500_000);
    let ip = audit_ip(&headers, addr);
    match db::enqueue_url_categorization_backfill_all(&s.db, limit).await {
        Ok(enqueued) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_categorization_recalc_url_visits",
                "ok",
                &serde_json::json!({ "limit": limit, "enqueued": enqueued }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "enqueued": enqueued })).into_response()
        }
        Err(e) => err500(e),
    }
}

/// Re-categorize recent URL sessions by re-applying override/UT1 matching.
pub async fn recalc_url_sessions(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<RecalcQuery>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let limit = q.limit.clamp(1, 500_000);
    let ip = audit_ip(&headers, addr);
    match db::recalc_url_sessions_categories(&s.db, limit).await {
        Ok(updated) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_categorization_recalc_url_sessions",
                "ok",
                &serde_json::json!({ "limit": limit, "updated": updated }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "updated": updated })).into_response()
        }
        Err(e) => err500(e),
    }
}
