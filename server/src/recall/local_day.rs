//! Local-calendar-day boundaries shared by the day read endpoints and the narrative worker,
//! so the worker writes exactly the day rows the read path asks for.

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};

/// Midnight on `d` in `tz`, as a UTC instant. Resolves DST gaps forward and DST
/// overlaps to the earlier instant rather than failing.
pub(super) fn local_midnight(d: NaiveDate, tz: chrono_tz::Tz) -> Option<DateTime<Utc>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_midnight_matches_the_api_day_boundary() {
        // Worker and read path must agree or the worker writes rows the API can't find.
        let tz = chrono_tz::Australia::Perth;
        let d = NaiveDate::from_ymd_opt(2026, 8, 8).unwrap();
        let start = local_midnight(d, tz).unwrap();
        assert_eq!(start.to_rfc3339(), "2026-08-07T16:00:00+00:00");
    }
}
