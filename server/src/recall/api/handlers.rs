//! Timeline, search, activity, coverage and day-narrative read endpoints.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::RequireOperator;
use crate::recall::db;
use crate::state::AppState;

use super::cursor::{filtered_page_context, next_cursor, page_context, ContextFilterQuery};
use super::{audit_recall, parse_range, AUDIT_DAY_VIEW, AUDIT_REPLAY, AUDIT_SEARCH, MAX_FRAMES};
use crate::http::audit_ip;
use crate::platform::audit;
use crate::recall::narrative::db as narrative_db;

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
    cursor: Option<String>,
    from: Option<String>,
    to: Option<String>,
    /// Restrict to one display (0-based). Omitted = every monitor, interleaved.
    monitor: Option<i32>,
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
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<Value>> {
    let ids = db::list_agents_with_screen_history(&s.db).await?;
    Ok(Json(serde_json::json!({ "agent_ids": ids })))
}

/// `GET /agents/:id/history/frames?from&to&limit&cursor` — oldest-first metadata.
/// Range bounds are inclusive; ordering is `(captured_at, id) ASC`. Follow
/// `next_cursor` until null. `complete` means no further rows in this range after
/// this page, not a guarantee of capture coverage or a database snapshot.
/// Omitted filters on continuation inherit the cursor; explicit changes are 400.
/// Existing default/capped limits (2000/5000) and frame fields are unchanged.
pub async fn history_frames(
    Path(id): Path<Uuid>,
    Query(q): Query<FramesQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let context = page_context(
        id,
        None,
        q.from,
        q.to,
        q.monitor,
        None,
        None,
        q.cursor.as_deref(),
    )
    .map_err(ApiError::bad_request)?;
    let from = context.from.expect("frame range has a lower bound");
    let to = context.to;
    let monitor = context.monitor;
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, MAX_FRAMES);
    let page = db::list_screen_frames_page(
        &s.db,
        id,
        from,
        to,
        monitor,
        limit,
        q.cursor.as_ref().map(|_| &context.position),
    )
    .await?;
    let next_cursor = next_cursor(context, page.next);
    Ok(Json(serde_json::json!({
        "from": from, "to": to, "monitor": monitor,
        "count": page.items.len(), "frames": page.items,
        "limit": limit, "has_more": next_cursor.is_some(),
        "complete": next_cursor.is_none(), "next_cursor": next_cursor,
    })))
}

#[derive(Debug, Deserialize)]
pub struct FrameAtQuery {
    at: Option<String>,
    monitor: Option<i32>,
}

/// `GET /agents/:id/history/frame?at=<rfc3339>` — the frame nearest that instant.
pub async fn history_frame_at(
    Path(id): Path<Uuid>,
    Query(q): Query<FrameAtQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let at = match q.at {
        None => Utc::now(),
        Some(s) => match DateTime::parse_from_rfc3339(s.trim()) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => return Err(ApiError::bad_request("invalid 'at' (expected RFC3339)")),
        },
    };
    let frame = db::screen_frame_at(&s.db, id, at, q.monitor).await?;
    Ok(Json(serde_json::json!({ "frame": frame })))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    #[serde(flatten)]
    filters: ContextFilterQuery,
    cursor: Option<String>,
    /// range (default, last day) or retained (all currently retained rows).
    scope: Option<String>,
    /// ranked (default) or newest.
    sort: Option<String>,
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    #[serde(default = "default_search_limit")]
    limit: i64,
}

const fn default_search_limit() -> i64 {
    100
}

/// `GET /agents/:id/history/search?q=&from&to&limit&cursor&scope&sort`.
/// Defaults: scope=range (last day), sort=ranked (rank/time/id DESC).
/// sort=newest uses time/id DESC. scope=retained removes the lower time bound
/// and rejects `from`; `to` still freezes the upper bound (default now).
/// Repeat `q` on every page; other omitted filters inherit the cursor.
/// Completeness is relative to currently retained, OCR-indexed matching rows.
pub async fn history_search(
    Path(id): Path<Uuid>,
    Query(q): Query<SearchQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let query = q.q.as_deref().map(str::trim).unwrap_or("");
    if query.len() > 4_096 {
        return Err(ApiError::bad_request(
            "search query 'q' is too long (maximum 4096 bytes)",
        ));
    }
    let context = filtered_page_context(
        id,
        Some(query),
        q.from,
        q.to,
        q.monitor,
        q.scope.as_deref(),
        q.sort.as_deref(),
        q.cursor.as_deref(),
        &q.filters,
    )
    .map_err(ApiError::bad_request)?;
    let filters = context.filters.clone();
    let from = context.from;
    let to = context.to;
    let monitor = context.monitor;
    let scope = context.scope.clone();
    let sort = context.sort.clone();
    // Always logged, never throttled: unlike replay volume, *what* was searched for
    // across someone's screen contents is exactly what an audit needs to show.
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        AUDIT_SEARCH,
        "ok",
        &serde_json::json!({ "role": user.role, "q": query, "filters": filters, "scope": scope, "sort": sort }),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, 500);
    let page = db::search_screen_frames_filtered_page(
        &s.db,
        id,
        query,
        from,
        to,
        monitor,
        limit,
        sort == "newest",
        q.cursor.as_ref().map(|_| &context.position),
        &filters,
    )
    .await?;
    let next_cursor = next_cursor(context, page.next);
    Ok(Json(serde_json::json!({
        "query": query, "from": from, "to": to, "filters": filters,
        "count": page.items.len(), "results": page.items,
        "monitor": monitor, "scope": scope, "sort": sort, "limit": limit,
        "has_more": next_cursor.is_some(), "complete": next_cursor.is_none(),
        "next_cursor": next_cursor,
    })))
}

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
    let points = db::screen_frame_activity(&s.db, id, from, to, q.monitor, bucket_secs).await?;
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
    let days = db::screen_frame_days(&s.db, id, from, to, tz.name()).await?;
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
    let monitors = db::screen_frame_monitors(&s.db, id, from, to).await?;
    Ok(Json(serde_json::json!({
        "from": from,
        "to": to,
        "monitors": monitors,
    })))
}

#[derive(Debug, Deserialize)]
pub struct DayQuery {
    /// `YYYY-MM-DD` (UTC). Defaults to today.
    day: Option<String>,
}

/// Parse the `day` param into `[start, end)` instants **in `tz`**, defaulting to
/// today in that zone.
///
/// The zone matters: a day is a local concept. Bucketing a UTC+8 user's activity by
/// UTC days would put their 08:00–16:00 into one summary and 16:00–midnight into the
/// next, and "today" would flip over at 08:00 local.
///
/// DST-safe: a local midnight that doesn't exist (spring-forward) resolves to the
/// first valid instant after the gap, and an ambiguous one (fall-back) to the earlier
/// of the two, so a range is always produced.
fn parse_day_in_tz(
    day: Option<String>,
    tz: chrono_tz::Tz,
) -> Result<(NaiveDate, DateTime<Utc>, DateTime<Utc>), &'static str> {
    let d = match day {
        None => Utc::now().with_timezone(&tz).date_naive(),
        Some(s) => NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map_err(|_| "invalid 'day' (expected YYYY-MM-DD)")?,
    };
    let start = local_midnight(d, tz).ok_or("invalid day")?;
    let end = d
        .succ_opt()
        .and_then(|next| local_midnight(next, tz))
        .ok_or("invalid day")?;
    Ok((d, start, end))
}

/// Midnight on `d` in `tz`, as a UTC instant. Resolves DST gaps forward and DST
/// overlaps to the earlier instant rather than failing.
fn local_midnight(d: NaiveDate, tz: chrono_tz::Tz) -> Option<DateTime<Utc>> {
    use chrono::offset::LocalResult;
    let naive = d.and_hms_opt(0, 0, 0)?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        LocalResult::Ambiguous(earlier, _) => Some(earlier.with_timezone(&Utc)),
        // Spring-forward gap: local midnight doesn't exist. Step forward in
        // 15-minute increments to the first instant that does.
        LocalResult::None => (1..=8).find_map(|i| {
            let shifted = naive + Duration::minutes(15 * i);
            tz.from_local_datetime(&shifted)
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
        }),
    }
}

/// `GET /agents/:id/history/segments?day=YYYY-MM-DD` — activity segments for a day.
pub async fn history_segments(
    Path(id): Path<Uuid>,
    Query(q): Query<DayQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_DAY_VIEW,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let tz = s.agent_timezone(id).await;
    let (day, start, end) = parse_day_in_tz(q.day, tz).map_err(ApiError::bad_request)?;
    let segments = narrative_db::list_activity_segments(&s.db, id, start, end).await?;
    Ok(Json(serde_json::json!({
        "day": day.to_string(),
        "timezone": tz.name(),
        "count": segments.len(),
        "segments": segments,
    })))
}

/// `GET /agents/:id/history/day-summary?day=YYYY-MM-DD` — the AI/rule narrative + totals.
pub async fn history_day_summary(
    Path(id): Path<Uuid>,
    Query(q): Query<DayQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_DAY_VIEW,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let tz = s.agent_timezone(id).await;
    let (day, _start, _end) = parse_day_in_tz(q.day, tz).map_err(ApiError::bad_request)?;
    let summary = narrative_db::get_day_summary(&s.db, id, day).await?;
    Ok(Json(serde_json::json!({
        "day": day.to_string(),
        "timezone": tz.name(),
        "summary": summary,
    })))
}

/// `GET /agents/:id/history/text/:frame_id` — OCR text + word boxes for one frame.
///
/// Powers the selectable-text overlay: word boxes are normalized to 0..1 of the
/// frame, so the dashboard can position invisible spans over the replayed image at
/// whatever size it happens to be rendered.
pub async fn history_frame_text(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    // Reading the text off a frame is the same act as looking at it, so it shares
    // the replay audit action (and its throttle).
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    match db::screen_frame_text(&s.db, id, frame_id).await {
        Ok(Some(v)) => {
            ([(header::CACHE_CONTROL, "private, max-age=86400")], Json(v)).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "No such frame").into_response(),
        Err(e) => ApiError::from(e).into_response(),
    }
}

#[cfg(test)]
#[cfg(test)]
mod day_tests {
    use super::*;

    fn day(s: &str, tz: chrono_tz::Tz) -> (DateTime<Utc>, DateTime<Utc>) {
        let (_, start, end) = parse_day_in_tz(Some(s.to_string()), tz).unwrap();
        (start, end)
    }

    #[test]
    fn utc_day_is_midnight_to_midnight() {
        let (start, end) = day("2026-08-08", chrono_tz::UTC);
        assert_eq!(start.to_rfc3339(), "2026-08-08T00:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-08-09T00:00:00+00:00");
    }

    #[test]
    fn perth_day_starts_eight_hours_before_utc_midnight() {
        // The bug this fixes: a UTC+8 user's day used to run 08:00–08:00 UTC-shifted.
        let (start, end) = day("2026-08-08", chrono_tz::Australia::Perth);
        assert_eq!(start.to_rfc3339(), "2026-08-07T16:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-08-08T16:00:00+00:00");
        assert_eq!((end - start).num_hours(), 24);
    }

    #[test]
    fn western_zone_day_starts_after_utc_midnight() {
        let (start, end) = day("2026-08-08", chrono_tz::America::New_York);
        assert_eq!(start.to_rfc3339(), "2026-08-08T04:00:00+00:00");
        assert_eq!(end.to_rfc3339(), "2026-08-09T04:00:00+00:00");
    }

    #[test]
    fn spring_forward_day_is_23_hours_and_never_empty() {
        // US DST starts 2026-03-08; the local day is 23h long.
        let (start, end) = day("2026-03-08", chrono_tz::America::New_York);
        assert!(start < end, "range must be non-empty across a DST gap");
        assert_eq!((end - start).num_hours(), 23);
    }

    #[test]
    fn fall_back_day_is_25_hours() {
        // US DST ends 2026-11-01; the local day is 25h long.
        let (start, end) = day("2026-11-01", chrono_tz::America::New_York);
        assert_eq!((end - start).num_hours(), 25);
    }

    #[test]
    fn midnight_gap_zone_still_resolves() {
        // Lord Howe shifts by 30 minutes; exercise the gap-stepping path generally
        // by asserting every day of a DST-transition week produces a valid range.
        let tz = chrono_tz::Australia::Lord_Howe;
        for d in 1..=7 {
            let (start, end) = day(&format!("2026-10-0{d}"), tz);
            assert!(start < end, "2026-10-0{d} produced an empty range");
        }
    }

    #[test]
    fn default_day_follows_the_zone_not_utc() {
        // Whatever "now" is, the defaulted day must equal today *in that zone*.
        let tz = chrono_tz::Pacific::Kiritimati; // UTC+14, maximally divergent.
        let (d, _, _) = parse_day_in_tz(None, tz).unwrap();
        assert_eq!(d, Utc::now().with_timezone(&tz).date_naive());
    }

    #[test]
    fn rejects_malformed_day() {
        assert!(parse_day_in_tz(Some("08/08/2026".into()), chrono_tz::UTC).is_err());
        assert!(parse_day_in_tz(Some("2026-13-01".into()), chrono_tz::UTC).is_err());
    }
}

#[cfg(test)]
#[cfg(test)]
mod context_handler_tests {
    use super::*;
    use crate::recall::context::test_support::{fixture, header};
    use axum::extract::FromRequestParts;
    async fn get(
        s: Arc<AppState>,
        id: Uuid,
        params: serde_json::Value,
        role: &str,
    ) -> (StatusCode, serde_json::Value) {
        let q: SearchQuery = serde_json::from_value(params).unwrap();
        let mut user = crate::state::agent_lifecycle::test_support::admin();
        user.role = role.into();
        // Run the role extractor too, so RBAC is exercised as the router would.
        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.extensions.insert(user);
        let r = match RequireOperator::from_request_parts(&mut parts, &()).await {
            Ok(operator) => history_search(
                Path(id),
                Query(q),
                State(s),
                operator,
                HeaderMap::new(),
                ConnectInfo("127.0.0.1:1234".parse().unwrap()),
            )
            .await
            .into_response(),
            Err(rejection) => rejection,
        };
        let status = r.status();
        let b = axum::body::to_bytes(r.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&b).unwrap())
    }
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL fixtures"]
    async fn recall_context_handler_filters_cursor_rbac_audit_and_bad_inputs() {
        let (s, id, _, _) = fixture().await;
        let at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let m = crate::recall::context::sanitize(&header(), Some(12), Some(9));
        for _ in 0..3 {
            db::insert_screen_frame(
                &s.db,
                id,
                at,
                0,
                100,
                100,
                0,
                "fixture.jpg",
                Some("needle"),
                None,
                Some(Uuid::new_v4()),
                &m,
            )
            .await
            .unwrap();
        }
        let params = serde_json::json!({"app":"EDITOR.EXE","title":"100%_done","url_host":"EXAMPLE.COM.","scope":"retained","limit":2});
        let (status, first) = get(s.clone(), id, params, "operator").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["query"], "");
        assert_eq!(first["sort"], "newest");
        assert_eq!(first["filters"]["url_host"], "example.com");
        assert_eq!(first["filters"]["app"], "editor.exe");
        assert_eq!(first["count"], 2);
        assert_eq!(first["has_more"], true);
        let next = first["next_cursor"].clone();
        let (status, last) = get(
            s.clone(),
            id,
            serde_json::json!({"cursor":next}),
            "operator",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(last["count"], 1);
        assert_eq!(last["complete"], true);
        assert_eq!(first["filters"], last["filters"]);
        assert_eq!(
            get(
                s.clone(),
                id,
                serde_json::json!({"cursor":next,"title":""}),
                "operator"
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(
                s.clone(),
                Uuid::new_v4(),
                serde_json::json!({"cursor":next}),
                "operator"
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(s.clone(), id, serde_json::json!({"q":"needle"}), "viewer")
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        for params in [
            serde_json::json!({}),
            serde_json::json!({"app":"editor","sort":"ranked"}),
            serde_json::json!({"context":"unknown","app":"editor"}),
            serde_json::json!({"url_host":"example.com:80"}),
            serde_json::json!({"title":"x".repeat(1025)}),
            serde_json::json!({"app_mode":"prefix"}),
            serde_json::json!({"title":"bad\ninput"}),
        ] {
            assert_eq!(
                get(s.clone(), id, params, "admin").await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let detail: serde_json::Value =
            sqlx::query_scalar("SELECT detail FROM audit_log WHERE action='recall_search' LIMIT 1")
                .fetch_one(&s.db)
                .await
                .unwrap();
        assert_eq!(detail["filters"]["app"], "editor.exe");
    }
}
