//! Screen-history ("Recall") REST endpoints: frame-range (timelapse/scrub), the
//! frame nearest a timestamp, and the JPEG blob for one frame.
//!
//! All endpoints are operator-gated for now. Phase 4 will add agent→user ownership
//! so self-review users can see only their own machine.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::agent_lifecycle::{spawn_blocking_ingestion, IngestionLease};
use crate::{auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

// ── Audit actions ─────────────────────────────────────────────────────────────
//
// Replaying someone's screen history is the most privacy-sensitive capability in
// the product, so every distinct kind of access is recorded against the operator
// who performed it. Volume-heavy actions (frame listing, blob fetches) are
// throttled to one row per viewing window by `should_audit_recall_access`;
// searches are always logged individually because the *query text* is the part an
// investigation actually needs.

/// Timeline replay: listing frames, scrubbing, or fetching keyframe images.
const AUDIT_REPLAY: &str = "recall_replay";
/// OCR full-text search over an agent's captured screens.
const AUDIT_SEARCH: &str = "recall_search";
/// Reading the derived day narrative / activity segments.
const AUDIT_DAY_VIEW: &str = "recall_day_view";

/// Record a Recall access, collapsing continuous viewing into one row per window.
async fn audit_recall(
    s: &Arc<AppState>,
    user: &auth::AuthUser,
    agent_id: Uuid,
    action: &'static str,
    ip: Option<&str>,
) {
    if !s.should_audit_recall_access(user.user_id, agent_id, action) {
        return;
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(agent_id),
        action,
        "ok",
        &serde_json::json!({ "role": user.role }),
        ip,
    )
    .await;
}

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

/// Versioned, URL-safe cursor. Bound to the device, query and effective filters;
/// it freezes default time bounds across requests. This is not a DB snapshot.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryCursor {
    version: u8,
    agent_id: Uuid,
    query: Option<String>,
    from: Option<DateTime<Utc>>,
    to: DateTime<Utc>,
    monitor: Option<i32>,
    scope: String,
    sort: String,
    position: db::ScreenFramePosition,
    #[serde(default)]
    filters: crate::recall_context::Filters,
}

fn decode_cursor(raw: Option<&str>) -> Result<Option<HistoryCursor>, &'static str> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.len() > 65_536 {
        return Err("invalid cursor");
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| "invalid cursor")?;
    let c: HistoryCursor = serde_json::from_slice(&bytes).map_err(|_| "invalid cursor")?;
    if !matches!(c.version, 1 | 2)
        || c.filters.validate().is_err()
        || (c.version == 1 && c.filters.active())
        || c.position.id <= 0
        || c.from
            .is_some_and(|from| from > c.to || c.position.captured_at < from)
        || c.position.captured_at > c.to
        || c.monitor.is_some_and(|m| m < 0)
        || !matches!(c.scope.as_str(), "range" | "retained")
        || (c.scope == "range") != c.from.is_some()
        || match c.query.as_ref() {
            None => {
                c.sort != "oldest"
                    || c.scope != "range"
                    || c.position.rank.is_some()
                    || c.filters.active()
            }
            Some(q) => {
                q.len() > 4096
                    || (q.is_empty()
                        && (c.version != 2
                            || !c.filters.active()
                            || c.sort != "newest"
                            || c.position.rank != Some(0.0)))
                    || q.trim() != q
                    || !matches!(c.sort.as_str(), "ranked" | "newest")
                    || !c.position.rank.is_some_and(|r| r.is_finite() && r >= 0.0)
            }
        }
    {
        return Err("invalid cursor");
    }
    Ok(Some(c))
}

#[allow(clippy::too_many_arguments)]
fn page_context(
    agent_id: Uuid,
    query: Option<&str>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    scope: Option<&str>,
    sort: Option<&str>,
    raw_cursor: Option<&str>,
) -> Result<HistoryCursor, &'static str> {
    filtered_page_context(
        agent_id,
        query,
        from,
        to,
        monitor,
        scope,
        sort,
        raw_cursor,
        &ContextFilterQuery::default(),
    )
}

#[derive(Debug, Default, Deserialize)]
struct ContextFilterQuery {
    app: Option<String>,
    app_mode: Option<String>,
    title: Option<String>,
    url_host: Option<String>,
    context: Option<String>,
}
impl ContextFilterQuery {
    fn resolve(
        &self,
        previous: Option<&crate::recall_context::Filters>,
    ) -> Result<crate::recall_context::Filters, &'static str> {
        let mut f = previous.cloned().unwrap_or_default();
        if let Some(app) = &self.app {
            f.app = (!app.trim().is_empty()).then(|| app.trim().to_ascii_lowercase());
        }
        if let Some(mode) = &self.app_mode {
            f.app_mode = mode.clone();
        }
        if let Some(title) = &self.title {
            f.title = (!title.trim().is_empty()).then(|| title.trim().to_owned());
        }
        if let Some(host) = &self.url_host {
            f.url_host = if host.trim().is_empty() {
                None
            } else {
                Some(crate::recall_context::normalize_host(host.trim())?)
            };
        }
        if let Some(context) = &self.context {
            f.context = context.clone();
        }
        if self.app_mode.is_some() && f.app.is_none() {
            return Err("app_mode requires app");
        }
        f.validate()?;
        if previous.is_some_and(|old| old != &f) {
            return Err("cursor does not match context filters");
        }
        Ok(f)
    }
}
#[allow(clippy::too_many_arguments)]
fn filtered_page_context(
    agent_id: Uuid,
    query: Option<&str>,
    from: Option<String>,
    to: Option<String>,
    monitor: Option<i32>,
    scope: Option<&str>,
    sort: Option<&str>,
    raw_cursor: Option<&str>,
    requested: &ContextFilterQuery,
) -> Result<HistoryCursor, &'static str> {
    let cursor = decode_cursor(raw_cursor)?;
    let filters = requested.resolve(cursor.as_ref().map(|c| &c.filters))?;
    if query == Some("") && !filters.active() {
        return Err("missing search query or context filters");
    }
    let scope = scope
        .or_else(|| cursor.as_ref().map(|c| c.scope.as_str()))
        .unwrap_or("range");
    let sort = sort
        .or_else(|| cursor.as_ref().map(|c| c.sort.as_str()))
        .unwrap_or(if query == Some("") {
            "newest"
        } else if query.is_some() {
            "ranked"
        } else {
            "oldest"
        });
    if !matches!(scope, "range" | "retained") || (query.is_none() && scope != "range") {
        return Err("invalid 'scope' (expected range or retained)");
    }
    if (query == Some("") && sort != "newest")
        || (query.is_some() && !matches!(sort, "ranked" | "newest"))
        || (query.is_none() && sort != "oldest")
    {
        return Err("invalid 'sort' (expected ranked or newest)");
    }
    if monitor.is_some_and(|m| m < 0) {
        return Err("invalid 'monitor' (must be non-negative)");
    }
    if scope == "retained" && from.is_some() {
        return Err("'from' is incompatible with scope=retained");
    }
    let from = from.or_else(|| cursor.as_ref().and_then(|c| c.from.map(|v| v.to_rfc3339())));
    let to = to.or_else(|| cursor.as_ref().map(|c| c.to.to_rfc3339()));
    let (start, end) = parse_range(from, to)?;
    let from = if scope == "retained" {
        None
    } else {
        Some(start)
    };
    let monitor = monitor.or_else(|| cursor.as_ref().and_then(|c| c.monitor));
    if let Some(c) = cursor.as_ref() {
        if c.agent_id != agent_id
            || c.query.as_deref() != query
            || c.from != from
            || c.to != end
            || c.monitor != monitor
            || c.scope != scope
            || c.sort != sort
        {
            return Err("cursor does not match request filters");
        }
        return Ok(cursor.expect("validated cursor"));
    }
    Ok(HistoryCursor {
        version: 2,
        filters,
        agent_id,
        query: query.map(str::to_owned),
        from,
        to: end,
        monitor,
        scope: scope.to_owned(),
        sort: sort.to_owned(),
        // Placeholder on first page; only used after replacement with a DB position.
        position: db::ScreenFramePosition {
            captured_at: start,
            id: 0,
            rank: None,
        },
    })
}

fn next_cursor(
    mut context: HistoryCursor,
    position: Option<db::ScreenFramePosition>,
) -> Option<String> {
    position.map(|position| {
        context.position = position;
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&context).expect("serializable history cursor"))
    })
}

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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let context = match page_context(
        id,
        None,
        q.from,
        q.to,
        q.monitor,
        None,
        None,
        q.cursor.as_deref(),
    ) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
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
    match db::list_screen_frames_page(
        &s.db,
        id,
        from,
        to,
        monitor,
        limit,
        q.cursor.as_ref().map(|_| &context.position),
    )
    .await
    {
        Ok(page) => {
            let next_cursor = next_cursor(context, page.next);
            Json(serde_json::json!({
                "from": from, "to": to, "monitor": monitor,
                "count": page.items.len(), "frames": page.items,
                "limit": limit, "has_more": next_cursor.is_some(),
                "complete": next_cursor.is_none(), "next_cursor": next_cursor,
            }))
            .into_response()
        }
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
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
            Err(_) => return bad_request("invalid 'at' (expected RFC3339)"),
        },
    };
    match db::screen_frame_at(&s.db, id, at, q.monitor).await {
        Ok(frame) => Json(serde_json::json!({ "frame": frame })).into_response(),
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let query = q.q.as_deref().map(str::trim).unwrap_or("");
    if query.len() > 4_096 {
        return bad_request("search query 'q' is too long (maximum 4096 bytes)");
    }
    let context = match filtered_page_context(
        id,
        Some(query),
        q.from,
        q.to,
        q.monitor,
        q.scope.as_deref(),
        q.sort.as_deref(),
        q.cursor.as_deref(),
        &q.filters,
    ) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    let filters = context.filters.clone();
    let from = context.from;
    let to = context.to;
    let monitor = context.monitor;
    let scope = context.scope.clone();
    let sort = context.sort.clone();
    // Always logged, never throttled: unlike replay volume, *what* was searched for
    // across someone's screen contents is exactly what an audit needs to show.
    db::insert_audit_log_traced(
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
    match db::search_screen_frames_filtered_page(
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
    .await
    {
        Ok(page) => {
            let next_cursor = next_cursor(context, page.next);
            Json(serde_json::json!({
                "query": query, "from": from, "to": to, "filters": filters,
                "count": page.items.len(), "results": page.items,
                "monitor": monitor, "scope": scope, "sort": sort, "limit": limit,
                "has_more": next_cursor.is_some(), "complete": next_cursor.is_none(),
                "next_cursor": next_cursor,
            }))
            .into_response()
        }
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
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
    match db::screen_frame_activity(&s.db, id, from, to, q.monitor, bucket_secs).await {
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
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    // Default to a generous window: this drives a calendar, not a scrubber, and the
    // partition-key predicate keeps Postgres pruning to the days that exist.
    let (from, to) = match parse_range(
        q.from
            .or_else(|| Some((Utc::now() - Duration::days(90)).to_rfc3339())),
        q.to,
    ) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    let tz = s.agent_timezone(id).await;
    match db::screen_frame_days(&s.db, id, from, to, tz.name()).await {
        Ok(days) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "timezone": tz.name(),
            "count": days.len(),
            "days": days,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// `GET /agents/:id/history/monitors?from&to` — displays recorded in a range.
pub async fn history_monitors(
    Path(id): Path<Uuid>,
    Query(q): Query<DaysQuery>,
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
    match db::screen_frame_monitors(&s.db, id, from, to).await {
        Ok(monitors) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "monitors": monitors,
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_DAY_VIEW,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let tz = s.agent_timezone(id).await;
    let (day, start, end) = match parse_day_in_tz(q.day, tz) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match db::list_activity_segments(&s.db, id, start, end).await {
        Ok(segments) => Json(serde_json::json!({
            "day": day.to_string(),
            "timezone": tz.name(),
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
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_DAY_VIEW,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let tz = s.agent_timezone(id).await;
    let (day, _start, _end) = match parse_day_in_tz(q.day, tz) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    match db::get_day_summary(&s.db, id, day).await {
        Ok(summary) => Json(serde_json::json!({
            "day": day.to_string(),
            "timezone": tz.name(),
            "summary": summary,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

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

// ── Capture settings administration ───────────────────────────────────────────

/// Operator-supplied capture settings. Every field optional: omitted means "leave
/// as-is" globally, or "inherit the global value" for a per-agent override.
#[derive(Debug, Default, Deserialize, serde::Serialize)]
pub struct RecallSettingsBody {
    enabled: Option<bool>,
    interval_ms: Option<i32>,
    hot_interval_ms: Option<i32>,
    jpeg_quality: Option<i16>,
    max_dim: Option<i32>,
    dedup_hamming: Option<i16>,
    keyframe_max_gap_ms: Option<i32>,
    ocr: Option<bool>,
}

/// Validate ranges before hitting the DB, so an out-of-range value returns a useful
/// 400 rather than a 500 from a CHECK constraint violation.
fn validate_settings(b: &RecallSettingsBody) -> Result<db::RecallSettingsPatch, &'static str> {
    fn in_range<T: PartialOrd + Copy>(
        v: Option<T>,
        lo: T,
        hi: T,
        msg: &'static str,
    ) -> Result<Option<T>, &'static str> {
        match v {
            Some(x) if x < lo || x > hi => Err(msg),
            other => Ok(other),
        }
    }

    Ok(db::RecallSettingsPatch {
        enabled: b.enabled,
        interval_ms: in_range(
            b.interval_ms,
            1_000,
            3_600_000,
            "interval_ms must be 1000–3600000",
        )?,
        hot_interval_ms: in_range(
            b.hot_interval_ms,
            1_000,
            3_600_000,
            "hot_interval_ms must be 1000–3600000",
        )?,
        jpeg_quality: in_range(b.jpeg_quality, 1, 100, "jpeg_quality must be 1–100")?,
        // 0 is the documented "don't downscale" sentinel, so it bypasses the range.
        max_dim: match b.max_dim {
            Some(0) | None => b.max_dim,
            Some(x) if (320..=7680).contains(&x) => Some(x),
            Some(_) => return Err("max_dim must be 0 (no downscale) or 320–7680"),
        },
        dedup_hamming: in_range(b.dedup_hamming, 0, 64, "dedup_hamming must be 0–64")?,
        keyframe_max_gap_ms: in_range(
            b.keyframe_max_gap_ms,
            10_000,
            86_400_000,
            "keyframe_max_gap_ms must be 10000–86400000",
        )?,
        ocr: b.ocr,
    })
}

/// `GET /settings/recall` — global capture settings.
pub async fn recall_settings_get(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    match db::get_recall_settings_global(&s.db).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err500(e),
    }
}

/// `PUT /settings/recall` — change global capture settings (admin only).
///
/// Admin-gated: this controls how much every machine in the fleet records, and
/// includes the kill switch.
pub async fn recall_settings_put(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RecallSettingsBody>,
) -> Response {
    if !user.is_admin() {
        return forbidden();
    }
    let patch = match validate_settings(&body) {
        Ok(p) => p,
        Err(msg) => return bad_request(msg),
    };
    if let Err(e) = db::set_recall_settings_global(&s.db, &patch).await {
        return err500(e);
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "recall_settings_global",
        "ok",
        &serde_json::to_value(&body).unwrap_or_else(|_| serde_json::json!({})),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::ws_agent::push_recall_settings_to_all_connected(&s).await;
    recall_settings_get(State(s.clone()), Extension(user)).await
}

/// `GET /agents/:id/history/settings` — what this agent runs with, and why.
///
/// Returns all three layers: `effective` (what the agent is actually told),
/// `override` (the per-agent row, `null` when there is none, with `null` fields for
/// the tunables it doesn't override) and `global` (the fleet default). A settings UI
/// needs the distinction — otherwise every inherited value looks like a deliberate
/// per-agent choice, and clearing one field is indistinguishable from setting it.
pub async fn agent_recall_settings_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    let effective = match db::effective_recall_settings(&s.db, id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let overridden = match db::get_recall_settings_agent_override(&s.db, id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let global = match db::get_recall_settings_global(&s.db).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    Json(serde_json::json!({
        "effective": effective,
        "override": overridden,
        "global": global,
    }))
    .into_response()
}

/// `PUT /agents/:id/history/settings` — per-agent override (admin only).
///
/// Omitted fields become NULL, i.e. that field inherits the global value again.
pub async fn agent_recall_settings_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RecallSettingsBody>,
) -> Response {
    if !user.is_admin() {
        return forbidden();
    }
    let patch = match validate_settings(&body) {
        Ok(p) => p,
        Err(msg) => return bad_request(msg),
    };
    if let Err(e) = db::set_recall_settings_agent(&s.db, id, &patch).await {
        return err500(e);
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "recall_settings_agent",
        "ok",
        &serde_json::to_value(&body).unwrap_or_else(|_| serde_json::json!({})),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::ws_agent::push_recall_settings_to_agent(&s, id).await;
    agent_recall_settings_get(Path(id), State(s.clone()), Extension(user)).await
}

/// `DELETE /agents/:id/history/settings` — drop the override, inherit global again.
pub async fn agent_recall_settings_delete(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_admin() {
        return forbidden();
    }
    if let Err(e) = db::clear_recall_settings_agent(&s.db, id).await {
        return err500(e);
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "recall_settings_agent_clear",
        "ok",
        &serde_json::json!({}),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    crate::ws_agent::push_recall_settings_to_agent(&s, id).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// `GET /agents/:id/history/text/:frame_id` — OCR text + word boxes for one frame.
///
/// Powers the selectable-text overlay: word boxes are normalized to 0..1 of the
/// frame, so the dashboard can position invisible spans over the replayed image at
/// whatever size it happens to be rendered.
pub async fn history_frame_text(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
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
        Err(e) => err500(e),
    }
}

/// Widths the thumbnail endpoint will actually produce, smallest first.
///
/// A requested width snaps to the nearest of these rather than being honoured
/// literally: each distinct width is a cached file on disk, so accepting arbitrary
/// values would let a caller fill the blob store with near-identical renders.
const THUMB_WIDTHS: [u32; 3] = [160, 320, 640];

/// Snap a requested width to a cacheable bucket.
fn snap_thumb_width(requested: u32) -> u32 {
    *THUMB_WIDTHS
        .iter()
        .min_by_key(|w| w.abs_diff(requested))
        .unwrap_or(&THUMB_WIDTHS[0])
}

/// Cache location for a `width`-wide render of `blob_ref`.
///
/// Deliberately nested *inside* the frame's own day directory
/// (`<agent>/<YYYYMMDD>/thumb-<w>/<uuid>.jpg`): retention drops whole day dirs
/// recursively, so thumbnails expire with their source frame without retention
/// needing to know they exist.
fn thumb_path(root: &std::path::Path, blob_ref: &str, width: u32) -> Option<std::path::PathBuf> {
    let rel = std::path::Path::new(blob_ref);
    let file = rel.file_name()?;
    // A bare filename has an empty parent, which would place the thumbnail at the
    // blob-store root — outside any day directory, so retention would never reap it.
    // Refuse instead; the caller falls back to serving full size.
    let dir = rel.parent().filter(|d| !d.as_os_str().is_empty())?;
    Some(root.join(dir).join(format!("thumb-{width}")).join(file))
}

/// Decode `jpeg`, downscale to `width` (preserving aspect), re-encode as JPEG.
///
/// CPU-bound, so callers run it on the blocking pool. Frames narrower than `width`
/// are returned untouched rather than upscaled — a smaller file than asked for is
/// always fine for a thumbnail, and re-encoding would only lose quality.
fn render_thumb(jpeg: &[u8], width: u32) -> anyhow::Result<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    use image::ImageEncoder;

    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)?;
    if img.width() <= width {
        return Ok(jpeg.to_vec());
    }
    let height = ((img.height() as u64 * width as u64) / img.width().max(1) as u64).max(1) as u32;
    let small = image::imageops::resize(
        &img.to_rgb8(),
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 70).write_image(
        small.as_raw(),
        small.width(),
        small.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

/// Serve a cached thumbnail of `full` at `width`, rendering and caching it on first
/// request. Falls back to the full-size bytes if anything about the render fails —
/// a filmstrip cell showing a heavy image beats one showing an error.
async fn thumb_response(
    root: &std::path::Path,
    blob_ref: &str,
    width: u32,
    full: Vec<u8>,
    lease: &IngestionLease,
) -> Vec<u8> {
    let Some(path) = thumb_path(root, blob_ref, width) else {
        return full;
    };
    let root = root.to_path_buf();
    let full = Arc::new(full);
    let original = full.clone();
    let rendered = match spawn_blocking_ingestion(lease, move || {
        // All filesystem operations own the lease, including cache hits. A
        // cancelled request cannot release it while a cache read is still active.
        if crate::recall_blob::check_path(&root, &path, true).is_err() {
            return Ok(original.as_ref().clone());
        }
        if let Ok(cached) = std::fs::read(&path) {
            return Ok(cached);
        }
        let rendered = render_thumb(&original, width)?;
        // Cache creation and writing share the blocking worker's owned lease.
        // Cancelling the HTTP request cannot let deletion overtake either write.
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_ok() {
                let _ = std::fs::write(&path, &rendered);
            }
        }
        Ok::<_, anyhow::Error>(rendered)
    })
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, blob_ref, width, "thumbnail render failed");
            return full.as_ref().clone();
        }
        Err(e) => {
            tracing::warn!(error = %e, "thumbnail render task panicked");
            return full.as_ref().clone();
        }
    };
    rendered
}

#[derive(Debug, Deserialize)]
pub struct BlobQuery {
    /// Requested width in px; snapped to a cacheable bucket. Omitted = full size.
    w: Option<u32>,
}

/// `GET /agents/:id/history/blob/:frame_id?w=` — the JPEG bytes for one frame.
///
/// `w` returns a cached downscale instead of the stored keyframe. The filmstrip,
/// scrubber previews and search results each render dozens of frames at once, and
/// fetching full keyframes for them costs megabytes per interaction.
pub async fn history_blob(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    Query(bq): Query<BlobQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return forbidden();
    }
    // Throttled: one replay row per viewing window, not one per keyframe rendered.
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    // Acquire before the row lookup: after deletion the row is absent, while a
    // request already holding the lease finishes caching before deletion cleans up.
    let lease = Arc::new(s.agent_lifecycle.for_agent(id).read_owned().await);
    let blob_ref = match db::screen_frame_blob_ref(&s.db, id, frame_id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "No such frame").into_response();
        }
        Err(e) => return err500(e),
    };

    if crate::recall_blob::blob_path(&s.screen_history_dir, id, &blob_ref).is_none() {
        return (StatusCode::BAD_REQUEST, "Bad blob reference").into_response();
    }
    let root = s.screen_history_dir.clone();
    let reference = blob_ref.clone();
    // Keep the lifecycle lease in the blocking worker too: request cancellation
    // must not let device deletion overtake a still-running filesystem operation.
    let read = match spawn_blocking_ingestion(&lease, move || {
        crate::recall_blob::read_blob(&root, id, &reference)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => return err500(e.into()),
    };
    match read {
        Ok(bytes) => {
            let bytes = match bq.w {
                Some(w) => {
                    let width = snap_thumb_width(w);
                    thumb_response(&s.screen_history_dir, &blob_ref, width, bytes, &lease).await
                }
                None => bytes,
            };
            (
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "private, max-age=86400"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Only a confirmed missing path under an available, trusted root is
            // orphan evidence. Permission/I/O/path safety errors preserve rows.
            if let Err(e) = db::delete_orphaned_screen_frame(&s.db, id, frame_id).await {
                tracing::warn!(error = %e, %id, frame_id, "failed to delete orphaned screen_frames row");
            }
            (StatusCode::NOT_FOUND, "Frame blob missing").into_response()
        }
        Err(e) => err500(e.into()),
    }
}

#[cfg(test)]
mod thumb_tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_thumbnail_cache_finishes_before_deletion_cleanup() {
        let root = std::env::temp_dir().join(format!("vantyr-thumb-lifecycle-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let blob_ref = format!("{}/20261003/{}.jpg", Uuid::new_v4(), Uuid::new_v4());
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image::DynamicImage::new_rgb8(32, 16))
            .unwrap();
        let gate = Arc::new(tokio::sync::RwLock::new(()));
        let lease = Arc::new(gate.clone().read_owned().await);
        let mut thumbnail = Box::pin(thumb_response(&root, &blob_ref, 160, jpeg.clone(), &lease));
        assert!(futures_util::poll!(thumbnail.as_mut()).is_pending());
        let deletion_gate = gate.clone();
        let deletion_root = root.clone();
        let mut deletion = Box::pin(async move {
            let _exclusive = deletion_gate.write_owned().await;
            assert!(
                deletion_root.exists(),
                "thumbnail cache must finish before cleanup"
            );
            std::fs::remove_dir_all(deletion_root).unwrap();
        });
        assert!(futures_util::poll!(deletion.as_mut()).is_pending());
        let rendered = thumbnail.as_mut().await;
        assert_eq!(rendered, jpeg);
        assert_eq!(
            std::fs::read(thumb_path(&root, &blob_ref, 160).unwrap()).unwrap(),
            rendered
        );
        drop(thumbnail);
        drop(lease);
        deletion.await;
        assert!(!root.exists());
    }

    #[test]
    fn requested_width_snaps_to_a_cacheable_bucket() {
        assert_eq!(snap_thumb_width(1), 160);
        assert_eq!(snap_thumb_width(173), 160);
        assert_eq!(snap_thumb_width(300), 320);
        assert_eq!(snap_thumb_width(10_000), 640);
    }

    #[test]
    fn thumbs_live_inside_the_frame_day_dir_so_retention_reaps_them() {
        // Retention drops `<root>/<agent>/<YYYYMMDD>/` recursively. If a thumbnail
        // ever escaped that directory it would outlive the frame it renders, and the
        // blob store would grow without bound.
        let root = std::path::Path::new("/blobs");
        let p = thumb_path(root, "agent-a/20260907/frame.jpg", 320).unwrap();
        assert_eq!(
            p,
            std::path::Path::new("/blobs/agent-a/20260907/thumb-320/frame.jpg")
        );
        assert!(p.starts_with(root.join("agent-a").join("20260907")));
    }

    #[test]
    fn a_blob_ref_without_a_directory_yields_no_thumb_path() {
        // Nothing writes refs like this, but falling back to full-size beats
        // writing a thumbnail somewhere retention will never look.
        assert!(thumb_path(std::path::Path::new("/blobs"), "frame.jpg", 160).is_none());
    }
}

#[cfg(test)]
mod pagination_tests {
    use super::*;

    fn context(query: Option<&str>) -> HistoryCursor {
        page_context(
            Uuid::nil(),
            query,
            Some("2026-01-01T00:00:00Z".into()),
            Some("2026-01-02T00:00:00Z".into()),
            Some(1),
            None,
            None,
            None,
        )
        .unwrap()
    }

    fn token(query: Option<&str>) -> String {
        let c = context(query);
        let position = db::ScreenFramePosition {
            captured_at: c.from.unwrap() + Duration::microseconds(123456),
            id: 42,
            rank: query.map(|_| 0.06079271_f32),
        };
        next_cursor(c, Some(position)).unwrap()
    }

    #[test]
    fn round_trip_preserves_microseconds_and_exact_postgres_rank() {
        let raw = token(Some("needle"));
        let c = decode_cursor(Some(&raw)).unwrap().unwrap();
        assert_eq!(c.position.captured_at.timestamp_subsec_micros(), 123456);
        assert_eq!(c.position.rank.unwrap().to_bits(), 0.06079271_f32.to_bits());
    }

    #[test]
    fn maximum_query_with_json_escapes_has_a_usable_cursor() {
        let query = "\u{0001}".repeat(4096);
        let raw = token(Some(&query));
        assert!(decode_cursor(Some(&raw)).is_ok());
    }

    #[test]
    fn continuation_inherits_fixed_bounds_and_filters() {
        let raw = token(None);
        let c = page_context(Uuid::nil(), None, None, None, None, None, None, Some(&raw)).unwrap();
        assert_eq!(c.from, context(None).from);
        assert_eq!(c.to, context(None).to);
        assert_eq!(c.monitor, Some(1));
    }

    #[test]
    fn cursor_rejects_changed_device_query_range_monitor_scope_and_sort() {
        let raw = token(Some("needle"));
        for (agent, query, from, to, monitor, scope, sort) in [
            (Uuid::new_v4(), "needle", None, None, None, None, None),
            (Uuid::nil(), "different", None, None, None, None, None),
            (
                Uuid::nil(),
                "needle",
                Some("2025-01-01T00:00:00Z"),
                None,
                None,
                None,
                None,
            ),
            (
                Uuid::nil(),
                "needle",
                None,
                Some("2026-01-03T00:00:00Z"),
                None,
                None,
                None,
            ),
            (Uuid::nil(), "needle", None, None, Some(0), None, None),
            (
                Uuid::nil(),
                "needle",
                None,
                None,
                None,
                Some("retained"),
                None,
            ),
            (
                Uuid::nil(),
                "needle",
                None,
                None,
                None,
                None,
                Some("newest"),
            ),
        ] {
            assert!(page_context(
                agent,
                Some(query),
                from.map(str::to_owned),
                to.map(str::to_owned),
                monitor,
                scope,
                sort,
                Some(&raw)
            )
            .is_err());
        }
        let raw = token(None);
        assert!(page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&raw)
        )
        .is_err());
    }

    #[test]
    fn invalid_cursor_and_position_are_rejected() {
        for raw in ["", "not-base64!", "e30"] {
            assert!(decode_cursor(Some(raw)).is_err());
        }
        assert!(decode_cursor(Some(&"a".repeat(65_537))).is_err());
        for mutation in 0..5 {
            let mut c = decode_cursor(Some(&token(Some("needle"))))
                .unwrap()
                .unwrap();
            match mutation {
                0 => c.version = 3,
                1 => c.position.id = 0,
                2 => c.position.captured_at = c.to + Duration::seconds(1),
                3 => c.position.rank = None,
                _ => c.position.rank = Some(-1.0),
            }
            let raw = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap());
            assert!(decode_cursor(Some(&raw)).is_err());
        }
    }

    #[test]
    fn retained_scope_is_explicit_and_cannot_accept_from() {
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            Some("retained"),
            Some("newest"),
            None,
        )
        .unwrap();
        assert!(c.from.is_none());
        let raw = next_cursor(
            c,
            Some(db::ScreenFramePosition {
                captured_at: DateTime::parse_from_rfc3339("2000-01-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
                id: 1,
                rank: Some(0.1),
            }),
        )
        .unwrap();
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&raw),
        )
        .unwrap();
        assert_eq!(c.scope, "retained");
        assert_eq!(c.sort, "newest");
        assert!(page_context(
            Uuid::nil(),
            Some("needle"),
            Some("2026-01-01T00:00:00Z".into()),
            None,
            None,
            Some("retained"),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn invalid_filters_are_rejected_and_legacy_defaults_preserved() {
        let c = page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(c.sort, "ranked");
        assert_eq!(c.to - c.from.unwrap(), Duration::days(1));
        for (monitor, scope, sort) in [
            (Some(-1), None, None),
            (None, Some("all"), None),
            (None, None, Some("oldest")),
        ] {
            assert!(page_context(
                Uuid::nil(),
                Some("needle"),
                None,
                None,
                monitor,
                scope,
                sort,
                None
            )
            .is_err());
        }
        assert!(next_cursor(context(None), None).is_none());
    }
}

#[cfg(test)]
mod context_cursor_tests {
    use super::*;
    fn cursor(request: ContextFilterQuery, query: &str) -> String {
        let c = filtered_page_context(
            Uuid::nil(),
            Some(query),
            Some("2026-01-01T00:00:00Z".into()),
            Some("2026-01-02T00:00:00Z".into()),
            None,
            None,
            None,
            None,
            &request,
        )
        .unwrap();
        next_cursor(
            c,
            Some(db::ScreenFramePosition {
                captured_at: Utc.with_ymd_and_hms(2026, 1, 1, 1, 0, 0).unwrap(),
                id: 2,
                rank: Some(0.0),
            }),
        )
        .unwrap()
    }
    #[test]
    fn context_only_freezes_filters_and_rejects_changes_clears_and_ranked() {
        let request = ContextFilterQuery {
            app: Some("Editor.EXE".into()),
            ..Default::default()
        };
        let token = cursor(request, "");
        let decoded = decode_cursor(Some(&token)).unwrap().unwrap();
        assert_eq!(decoded.version, 2);
        assert_eq!(decoded.sort, "newest");
        assert_eq!(decoded.filters.app.as_deref(), Some("editor.exe"));
        let inherited = filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery::default(),
        )
        .unwrap();
        assert_eq!(inherited.filters, decoded.filters);
        for request in [
            ContextFilterQuery {
                app: Some("".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                title: Some("changed".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                app_mode: Some("prefix".into()),
                ..Default::default()
            },
            ContextFilterQuery {
                context: Some("known".into()),
                ..Default::default()
            },
        ] {
            assert!(filtered_page_context(
                Uuid::nil(),
                Some(""),
                None,
                None,
                None,
                None,
                None,
                Some(&token),
                &request
            )
            .is_err());
        }
        let known = ContextFilterQuery {
            context: Some("known".into()),
            ..Default::default()
        };
        assert!(filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            Some("ranked"),
            None,
            &known
        )
        .is_err());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some(""),
            None,
            None,
            None,
            None,
            None,
            None,
            &ContextFilterQuery::default()
        )
        .is_err());
        assert!(ContextFilterQuery {
            app_mode: Some("exact".into()),
            ..Default::default()
        }
        .resolve(None)
        .is_err());
        assert!(ContextFilterQuery {
            context: Some("unknown".into()),
            app: Some("editor".into()),
            ..Default::default()
        }
        .resolve(None)
        .is_err());
    }
    #[test]
    fn v1_unfiltered_support_does_not_authorize_context_filters() {
        let token = cursor(ContextFilterQuery::default(), "needle");
        let mut value: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).unwrap()).unwrap();
        value["version"] = serde_json::json!(1);
        value.as_object_mut().unwrap().remove("filters");
        let token = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery::default()
        )
        .is_ok());
        assert!(filtered_page_context(
            Uuid::nil(),
            Some("needle"),
            None,
            None,
            None,
            None,
            None,
            Some(&token),
            &ContextFilterQuery {
                context: Some("known".into()),
                ..Default::default()
            }
        )
        .is_err());
    }
    #[test]
    fn maximum_combined_escaped_fields_fit_bounded_cursor() {
        let q = "\u{1}".repeat(4096);
        let token = cursor(
            ContextFilterQuery {
                app: Some("\\".repeat(256)),
                title: Some("\\".repeat(1024)),
                url_host: Some(format!(
                    "{}.{}.{}.{}",
                    "a".repeat(63),
                    "b".repeat(63),
                    "c".repeat(63),
                    "d".repeat(61)
                )),
                ..Default::default()
            },
            &q,
        );
        assert!(token.len() > 8192 && token.len() < 65536);
        assert!(decode_cursor(Some(&token)).is_ok());
        assert!(decode_cursor(Some(&"a".repeat(65537))).is_err());
    }
}

#[cfg(test)]
mod context_handler_tests {
    use super::*;
    use crate::recall_context::test_support::{fixture, header};
    async fn get(
        s: Arc<AppState>,
        id: Uuid,
        params: serde_json::Value,
        role: &str,
    ) -> (StatusCode, serde_json::Value) {
        let q: SearchQuery = serde_json::from_value(params).unwrap();
        let mut user = crate::state::agent_lifecycle::test_support::admin();
        user.role = role.into();
        let r = history_search(
            Path(id),
            Query(q),
            State(s),
            Extension(user),
            HeaderMap::new(),
            ConnectInfo("127.0.0.1:1234".parse().unwrap()),
        )
        .await;
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
        let m = crate::recall_context::sanitize(&header(), Some(12), Some(9));
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

#[cfg(test)]
#[path = "recall_blob_tests.rs"]
mod recall_blob_tests;
