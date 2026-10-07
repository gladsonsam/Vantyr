//! Schedule evaluation helpers (agent-local time).
//!
//! Windows uses agent-local time for curfews: when offline, the agent still enforces.

use chrono::{Datelike, Local, Timelike};

use crate::config::StoredScheduleWindow;

/// Returns `true` if at least one window is active right now (agent-local time).
/// If `windows` is empty, the schedule is treated as "always active".
pub fn is_active_now_local(windows: &[StoredScheduleWindow]) -> bool {
    if windows.is_empty() {
        return true;
    }
    let now = Local::now();
    // Chrono: Sunday=0 ... Saturday=6
    let dow: u8 = now.weekday().num_days_from_sunday() as u8;
    let minute: u16 = (now.hour() as u16) * 60 + (now.minute() as u16);

    windows
        .iter()
        .any(|w| w.day_of_week == dow && w.start_minute <= minute && minute < w.end_minute)
}
