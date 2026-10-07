//! Typed agent-telemetry ingest: parse the raw event JSON once, leniently, so the
//! `db` functions only bind parameters.
//!
//! Every struct deserializes exactly like the `val["x"].as_str()` / `as_i64()`
//! reads it replaced: a missing or wrongly-typed field yields the same
//! default / `None`. [`WindowFocusEvent::parse`] and its siblings then apply
//! the old post-extraction fixups (`app_display` falling back to `app`,
//! trimming `user`).

use serde::Deserialize;

use crate::lenient;

/// A `window_focus` frame: the newly focused window.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WindowFocusEvent {
    #[serde(default, deserialize_with = "lenient::string")]
    pub title: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub app: String,
    /// Falls back to `app` when absent or wrongly typed (but not when
    /// explicitly empty, matching the old `unwrap_or(app)`).
    #[serde(default, deserialize_with = "lenient::opt")]
    pub app_display: Option<String>,
    #[serde(default, deserialize_with = "lenient::i64_or_zero")]
    pub hwnd: i64,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub user: Option<String>,
}

impl WindowFocusEvent {
    /// Parse a `window_focus` frame exactly like the old inline extraction did.
    pub fn parse(v: &serde_json::Value) -> Self {
        let mut ev: Self = serde_json::from_value(v.clone()).unwrap_or_default();
        if ev.app_display.is_none() {
            ev.app_display = Some(ev.app.clone());
        }
        ev.user = lenient::trimmed_non_empty(ev.user);
        ev
    }

    pub fn app_display(&self) -> &str {
        self.app_display.as_deref().unwrap_or("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_focus_parses_valid_input() {
        let ev = WindowFocusEvent::parse(&json!({
            "type": "window_focus",
            "title": "Budget.xlsx",
            "app": "excel.exe",
            "app_display": "Excel",
            "hwnd": 12345,
            "ts": 1_700_000_000,
            "user": "  alice  ",
        }));
        assert_eq!(ev.title, "Budget.xlsx");
        assert_eq!(ev.app, "excel.exe");
        assert_eq!(ev.app_display(), "Excel");
        assert_eq!(ev.hwnd, 12345);
        assert_eq!(ev.ts, Some(1_700_000_000));
        assert_eq!(ev.user.as_deref(), Some("alice"));
    }

    #[test]
    fn window_focus_missing_fields_yield_old_defaults() {
        let ev = WindowFocusEvent::parse(&json!({ "type": "window_focus" }));
        assert_eq!(ev.title, "");
        assert_eq!(ev.app, "");
        // `app_display` fell back to `app` (both empty here).
        assert_eq!(ev.app_display(), "");
        assert_eq!(ev.hwnd, 0);
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn window_focus_wrong_types_yield_old_defaults() {
        let ev = WindowFocusEvent::parse(&json!({
            "title": 7,
            "app": ["excel.exe"],
            "app_display": 42,
            "hwnd": "123",
            "ts": "yesterday",
            "user": 99,
        }));
        assert_eq!(ev.title, "");
        assert_eq!(ev.app, "");
        // Wrongly-typed `app_display` reads as absent, so it falls back to `app`.
        assert_eq!(ev.app_display(), "");
        assert_eq!(ev.hwnd, 0);
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn window_focus_explicit_empty_app_display_is_kept() {
        // The old `unwrap_or(app)` only applied when the field was not a
        // string at all; an explicit "" stayed "".
        let ev = WindowFocusEvent::parse(&json!({ "app": "excel.exe", "app_display": "" }));
        assert_eq!(ev.app_display(), "");
    }

    #[test]
    fn window_focus_blank_user_is_absent() {
        let ev = WindowFocusEvent::parse(&json!({ "user": "   " }));
        assert_eq!(ev.user, None);
    }
}
