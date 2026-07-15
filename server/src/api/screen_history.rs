//! Screen-history ("Recall") REST endpoints: frame-range (timelapse/scrub), the
//! frame nearest a timestamp, and the JPEG blob for one frame.
//!
//! All endpoints are operator-gated for now. Phase 4 will add agent→user ownership
//! so self-review users can see only their own machine.

use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::{auth, db, state::AppState};

use super::helpers::err500;

/// Hard cap on frames returned in one range query (keeps the scrubber payload bounded).
const MAX_FRAMES: i64 = 5_000;

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "Forbidden" })),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

fn parse_range(
    from: Option<String>,
    to: Option<String>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), &'static str> {
    let now = Utc::now();
    let end = match to {
        None => now,
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'to' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    let start = match from {
        None => end - Duration::days(1),
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'from' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    if start > end {
        return Err("'from' must be <= 'to'");
    }
    Ok((start, end))
}

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
    from: Option<String>,
    to: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

const fn default_limit() -> i64 {
    2_000
}

/// `GET /agents/history/devices` — ids of agents that have recorded at least one
/// screen-history frame, for filtering the Recall device picker.
pub async fn history_devices(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    match db::list_agents_with_screen_history(&s.db).await {
        Ok(ids) => Json(serde_json::json!({ "agent_ids": ids })).into_response(),
        Err(e) => err500(e),
    }
}

/// `GET /agents/:id/history/frames?from&to&limit` — frame metadata over a range (timelapse/scrub).
pub async fn history_frames(
    Path(id): Path<Uuid>,
    Query(q): Query<FramesQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    let limit = q.limit.clamp(1, MAX_FRAMES);
    match db::list_screen_frames(&s.db, id, from, to, limit).await {
        Ok(frames) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "count": frames.len(),
            "frames": frames,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct FrameAtQuery {
    at: Option<String>,
}

/// `GET /agents/:id/history/frame?at=<rfc3339>` — the frame nearest that instant.
pub async fn history_frame_at(
    Path(id): Path<Uuid>,
    Query(q): Query<FrameAtQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let at = match q.at {
        None => Utc::now(),
        Some(s) => match DateTime::parse_from_rfc3339(s.trim()) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => return bad_request("invalid 'at' (expected RFC3339)"),
        },
    };
    match db::screen_frame_at(&s.db, id, at).await {
        Ok(frame) => Json(serde_json::json!({ "frame": frame })).into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
    #[serde(default = "default_search_limit")]
    limit: i64,
}

const fn default_search_limit() -> i64 {
    100
}

/// `GET /agents/:id/history/search?q=&from&to&limit` — ranked OCR full-text search.
pub async fn history_search(
    Path(id): Path<Uuid>,
    Query(q): Query<SearchQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let query = q.q.as_deref().map(str::trim).unwrap_or("");
    if query.is_empty() {
        return bad_request("missing search query 'q'");
    }
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    let limit = q.limit.clamp(1, 500);
    match db::search_screen_frames(&s.db, id, query, from, to, limit).await {
        Ok(results) => Json(serde_json::json!({
            "query": query,
            "from": from,
            "to": to,
            "count": results.len(),
            "results": results,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct ActivityQuery {
    from: Option<String>,
    to: Option<String>,
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
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    let buckets = q.buckets.clamp(10, 500);
    let span_secs = (to - from).num_seconds().max(1);
    let bucket_secs = (span_secs / buckets).max(1);
    match db::screen_frame_activity(&s.db, id, from, to, bucket_secs).await {
        Ok(points) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "bucket_secs": bucket_secs,
            "points": points,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct DayQuery {
    /// `YYYY-MM-DD` (UTC). Defaults to today.
    day: Option<String>,
}

/// Parse the `day` param (UTC) into [start, end) instants, defaulting to today.
fn parse_day(day: Option<String>) -> Result<(NaiveDate, DateTime<Utc>, DateTime<Utc>), &'static str> {
    let d = match day {
        None => Utc::now().date_naive(),
        Some(s) => NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map_err(|_| "invalid 'day' (expected YYYY-MM-DD)")?,
    };
    let start = Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).ok_or("invalid day")?);
    Ok((d, start, start + Duration::days(1)))
}

/// `GET /agents/:id/history/segments?day=YYYY-MM-DD` — activity segments for a day.
pub async fn history_segments(
    Path(id): Path<Uuid>,
    Query(q): Query<DayQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let (day, start, end) = match parse_day(q.day) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match db::list_activity_segments(&s.db, id, start, end).await {
        Ok(segments) => Json(serde_json::json!({
            "day": day.to_string(),
            "count": segments.len(),
            "segments": segments,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// `GET /agents/:id/history/day-summary?day=YYYY-MM-DD` — the AI/rule narrative + totals.
pub async fn history_day_summary(
    Path(id): Path<Uuid>,
    Query(q): Query<DayQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let (day, _start, _end) = match parse_day(q.day) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match db::get_day_summary(&s.db, id, day).await {
        Ok(summary) => Json(serde_json::json!({
            "day": day.to_string(),
            "summary": summary,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// `GET /agents/:id/history/blob/:frame_id` — the JPEG bytes for one frame.
pub async fn history_blob(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let blob_ref = match db::screen_frame_blob_ref(&s.db, id, frame_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "No such frame").into_response();
        }
        Err(e) => return err500(e),
    };

    // blob_ref is a server-generated relative path (<agent>/<day>/<uuid>.jpg). Reject
    // anything with traversal components as defense-in-depth before touching the FS.
    if blob_ref.contains("..") {
        return (StatusCode::BAD_REQUEST, "Bad blob reference").into_response();
    }
    let path = s.screen_history_dir.join(&blob_ref);
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "private, max-age=86400"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => {
            // Orphaned row (blob dir was pruned but the DB partition drop failed) —
            // clean it up so it stops showing up in listings and 404ing on repeat access.
            if let Err(e) = db::delete_orphaned_screen_frame(&s.db, id, frame_id).await {
                tracing::warn!(error = %e, %id, frame_id, "failed to delete orphaned screen_frames row");
            }
            (StatusCode::NOT_FOUND, "Frame blob missing").into_response()
        }
    }
}
