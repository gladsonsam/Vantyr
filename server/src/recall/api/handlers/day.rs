//! Day-scoped views: activity segments and the narrative summary.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireOperator;
use crate::recall::api::{audit_recall, AUDIT_DAY_VIEW};
use crate::recall::local_day::local_midnight;
use crate::recall::narrative::db as narrative_db;
use crate::state::AppState;

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
