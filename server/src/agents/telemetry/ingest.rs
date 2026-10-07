//! Typed agent-telemetry ingest: parse the raw event JSON once, leniently, so the
//! `db` functions only bind parameters.
//!
//! Every struct deserializes exactly like the `val["x"].as_str()` / `as_i64()`
//! reads it replaced: a missing or wrongly-typed field yields the same
//! default / `None`. [`WindowFocusEvent::parse`] and its siblings then apply
//! the old post-extraction fixups (`app_display` falling back to `app`,
//! trimming `user`).

use serde::Deserialize;

use vantyr_protocol::lenient;

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

/// A `keys` frame: typed text, appended to the open key session.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct KeysEvent {
    #[serde(default, deserialize_with = "lenient::string")]
    pub app: String,
    /// Falls back to `app` when absent or wrongly typed (but not when
    /// explicitly empty, matching the old `unwrap_or(app)`).
    #[serde(default, deserialize_with = "lenient::opt")]
    pub app_display: Option<String>,
    #[serde(default, deserialize_with = "lenient::string")]
    pub window: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub text: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub user: Option<String>,
}

impl KeysEvent {
    /// Parse a `keys` frame exactly like the old inline extraction did.
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

/// An `afk` / `active` frame: an activity transition.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ActivityEvent {
    #[serde(rename = "type", default, deserialize_with = "lenient::string")]
    pub kind: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub idle_secs: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub ts: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub user: Option<String>,
}

impl ActivityEvent {
    /// Parse an `afk` / `active` frame exactly like the old inline extraction did.
    pub fn parse(v: &serde_json::Value) -> Self {
        let mut ev: Self = serde_json::from_value(v.clone()).unwrap_or_default();
        ev.user = lenient::trimmed_non_empty(ev.user);
        ev
    }
}

/// A `metrics` frame: one resource sample.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MetricsSample {
    #[serde(default, deserialize_with = "lenient::f32_or_zero")]
    pub cpu_pct: f32,
    #[serde(default, deserialize_with = "lenient::i64_wrap_or_zero")]
    pub mem_used_mb: i64,
    #[serde(default, deserialize_with = "lenient::i64_wrap_or_zero")]
    pub mem_total_mb: i64,
    #[serde(default, deserialize_with = "lenient::f32_or_zero")]
    pub mem_pct: f32,
    #[serde(default, deserialize_with = "lenient::f32_or_zero")]
    pub disk_pct: f32,
    #[serde(default, deserialize_with = "lenient::f32_or_zero")]
    pub disk_used_gb: f32,
    #[serde(default, deserialize_with = "lenient::f32_or_zero")]
    pub disk_total_gb: f32,
}

impl MetricsSample {
    /// Parse a `metrics` frame exactly like the old inline extraction did.
    pub fn parse(v: &serde_json::Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
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

    #[test]
    fn keys_parses_valid_input() {
        let ev = KeysEvent::parse(&json!({
            "type": "keys",
            "app": "editor.exe",
            "app_display": "Editor",
            "window": "notes.txt",
            "text": "hello",
            "ts": 1_700_000_000,
            "user": " bob ",
        }));
        assert_eq!(ev.app, "editor.exe");
        assert_eq!(ev.app_display(), "Editor");
        assert_eq!(ev.window, "notes.txt");
        assert_eq!(ev.text, "hello");
        assert_eq!(ev.ts, Some(1_700_000_000));
        assert_eq!(ev.user.as_deref(), Some("bob"));
    }

    #[test]
    fn keys_missing_fields_yield_old_defaults() {
        let ev = KeysEvent::parse(&json!({ "type": "keys" }));
        assert_eq!(ev.app, "");
        assert_eq!(ev.app_display(), "");
        assert_eq!(ev.window, "");
        assert_eq!(ev.text, "");
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn keys_wrong_types_yield_old_defaults() {
        let ev = KeysEvent::parse(&json!({
            "app": 1,
            "app_display": false,
            "window": null,
            "text": ["h"],
            "ts": 1.5,
            "user": {},
        }));
        assert_eq!(ev.app, "");
        // Wrongly-typed `app_display` reads as absent, so it falls back to `app`.
        assert_eq!(ev.app_display(), "");
        assert_eq!(ev.window, "");
        assert_eq!(ev.text, "");
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn keys_explicit_empty_app_display_is_kept() {
        let ev = KeysEvent::parse(&json!({ "app": "editor.exe", "app_display": "" }));
        assert_eq!(ev.app_display(), "");
    }

    #[test]
    fn activity_parses_valid_input() {
        let ev = ActivityEvent::parse(&json!({
            "type": "afk",
            "idle_secs": 90,
            "ts": 1_700_000_000,
            "user": " alice ",
        }));
        assert_eq!(ev.kind, "afk");
        assert_eq!(ev.idle_secs, Some(90));
        assert_eq!(ev.ts, Some(1_700_000_000));
        assert_eq!(ev.user.as_deref(), Some("alice"));
    }

    #[test]
    fn activity_missing_fields_yield_old_defaults() {
        let ev = ActivityEvent::parse(&json!({ "type": "active" }));
        assert_eq!(ev.kind, "active");
        assert_eq!(ev.idle_secs, None);
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn activity_wrong_types_yield_old_defaults() {
        let ev = ActivityEvent::parse(&json!({
            "type": 7,
            "idle_secs": "long",
            "ts": [1],
            "user": false,
        }));
        assert_eq!(ev.kind, "");
        assert_eq!(ev.idle_secs, None);
        assert_eq!(ev.ts, None);
        assert_eq!(ev.user, None);
    }

    #[test]
    fn metrics_parses_valid_input() {
        let ev = MetricsSample::parse(&json!({
            "type": "metrics",
            "cpu_pct": 12.5,
            "mem_used_mb": 4096,
            "mem_total_mb": 8192,
            "mem_pct": 50,
            "disk_pct": 33.25,
            "disk_used_gb": 100.5,
            "disk_total_gb": 256,
        }));
        assert_eq!(ev.cpu_pct, 12.5);
        assert_eq!(ev.mem_used_mb, 4096);
        assert_eq!(ev.mem_total_mb, 8192);
        assert_eq!(ev.mem_pct, 50.0);
        assert_eq!(ev.disk_pct, 33.25);
        assert_eq!(ev.disk_used_gb, 100.5);
        assert_eq!(ev.disk_total_gb, 256.0);
    }

    #[test]
    fn metrics_missing_fields_yield_zero() {
        let ev = MetricsSample::parse(&json!({ "type": "metrics" }));
        assert_eq!(ev.cpu_pct, 0.0);
        assert_eq!(ev.mem_used_mb, 0);
        assert_eq!(ev.mem_total_mb, 0);
        assert_eq!(ev.mem_pct, 0.0);
        assert_eq!(ev.disk_pct, 0.0);
        assert_eq!(ev.disk_used_gb, 0.0);
        assert_eq!(ev.disk_total_gb, 0.0);
    }

    #[test]
    fn metrics_wrong_types_yield_zero() {
        let ev = MetricsSample::parse(&json!({
            "cpu_pct": "high",
            "mem_used_mb": "4GB",
            "mem_total_mb": [8192],
            "mem_pct": null,
            "disk_pct": true,
            "disk_used_gb": {},
            "disk_total_gb": "256",
        }));
        assert_eq!(ev.cpu_pct, 0.0);
        assert_eq!(ev.mem_used_mb, 0);
        assert_eq!(ev.mem_total_mb, 0);
        assert_eq!(ev.mem_pct, 0.0);
        assert_eq!(ev.disk_pct, 0.0);
        assert_eq!(ev.disk_used_gb, 0.0);
        assert_eq!(ev.disk_total_gb, 0.0);
    }
}
