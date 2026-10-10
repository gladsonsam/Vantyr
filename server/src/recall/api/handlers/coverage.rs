//! Activity histogram, day coverage and monitor listings.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireOperator;
use crate::recall::api::{audit_recall, parse_range, AUDIT_REPLAY};
use crate::recall::db;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ActivityQuery {
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    #[serde(default = "default_buckets")]
    buckets: i64,
}

const fn default_buckets() -> i64 {
    120
}

/// `GET /agents/:id/history/activity?from&to&buckets=` — interactivity histogram
/// (keyframe count per time bucket) for the PostHog-style activity strip.
pub async fn history_activity(
    Path(id): Path<Uuid>,
    Query(q): Query<ActivityQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let (from, to) = parse_range(q.from, q.to).map_err(ApiError::bad_request)?;
    // Audited like the other read paths: this is derived from someone's screen
    // capture, and leaving one hole in the trail makes the whole trail unreliable.
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let buckets = q.buckets.clamp(10, 500);
    let span_secs = (to - from).num_seconds().max(1);
    let bucket_secs = (span_secs / buckets).max(1);
    let points =
        db::timeline::screen_frame_activity(&s.db, id, from, to, q.monitor, bucket_secs).await?;
    Ok(Json(serde_json::json!({
        "from": from,
        "to": to,
        "bucket_secs": bucket_secs,
        "points": points,
    })))
}

#[derive(Debug, Deserialize)]
pub struct DaysQuery {
    from: Option<String>,
    to: Option<String>,
}

/// `GET /agents/:id/history/days?from&to` — which local days have coverage.
///
/// Feeds the date picker's coverage heatmap so an operator can see where the
/// recorded days are instead of stepping through empty dates one at a time. Days are
/// bucketed in the agent's zone, matching `segments` / `day-summary`.
pub async fn history_days(
    Path(id): Path<Uuid>,
    Query(q): Query<DaysQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<Value>> {
    // Default to a generous window: this drives a calendar, not a scrubber, and the
    // partition-key predicate keeps Postgres pruning to the days that exist.
    let (from, to) = parse_range(
        q.from
            .or_else(|| Some((Utc::now() - Duration::days(90)).to_rfc3339())),
        q.to,
    )
    .map_err(ApiError::bad_request)?;
    let tz = s.agent_timezone(id).await;
    let days = db::timeline::screen_frame_days(&s.db, id, from, to, tz.name()).await?;
    Ok(Json(serde_json::json!({
        "from": from,
        "to": to,
        "timezone": tz.name(),
        "count": days.len(),
        "days": days,
    })))
}

/// `GET /agents/:id/history/monitors?from&to` — displays recorded in a range.
pub async fn history_monitors(
    Path(id): Path<Uuid>,
    Query(q): Query<DaysQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<Value>> {
    let (from, to) = parse_range(q.from, q.to).map_err(ApiError::bad_request)?;
    let monitors = db::timeline::screen_frame_monitors(&s.db, id, from, to).await?;
    Ok(Json(serde_json::json!({
        "from": from,
        "to": to,
        "monitors": monitors,
    })))
}
