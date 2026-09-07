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
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use uuid::Uuid;

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

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
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

/// `GET /agents/:id/history/frames?from&to&limit` — frame metadata over a range (timelapse/scrub).
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
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, MAX_FRAMES);
    match db::list_screen_frames(&s.db, id, from, to, q.monitor, limit).await {
        Ok(frames) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "monitor": q.monitor,
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

/// `GET /agents/:id/history/search?q=&from&to&limit` — ranked OCR full-text search.
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
    if query.is_empty() {
        return bad_request("missing search query 'q'");
    }
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return bad_request(msg),
    };
    // Always logged, never throttled: unlike replay volume, *what* was searched for
    // across someone's screen contents is exactly what an audit needs to show.
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        AUDIT_SEARCH,
        "ok",
        &serde_json::json!({ "role": user.role, "q": query }),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, 500);
    match db::search_screen_frames(&s.db, id, query, from, to, q.monitor, limit).await {
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
) -> Vec<u8> {
    let Some(path) = thumb_path(root, blob_ref, width) else {
        return full;
    };
    if let Ok(cached) = tokio::fs::read(&path).await {
        return cached;
    }
    let rendered = match tokio::task::spawn_blocking(move || render_thumb(&full, width)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            tracing::debug!(error = %e, blob_ref, width, "thumbnail render failed");
            return tokio::fs::read(root.join(blob_ref))
                .await
                .unwrap_or_default();
        }
        Err(e) => {
            tracing::warn!(error = %e, "thumbnail render task panicked");
            return Vec::new();
        }
    };
    // Best-effort cache write: a failure here only costs a re-render next time.
    if let Some(parent) = path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_ok() {
            let _ = tokio::fs::write(&path, &rendered).await;
        }
    }
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
        Ok(bytes) => {
            let bytes = match bq.w {
                Some(w) => {
                    thumb_response(&s.screen_history_dir, &blob_ref, snap_thumb_width(w), bytes)
                        .await
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

#[cfg(test)]
mod thumb_tests {
    use super::*;

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
