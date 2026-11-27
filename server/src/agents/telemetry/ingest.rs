//! Typed agent-telemetry ingest.
//!
//! The payload types and their strict parser live once, in
//! `vantyr_protocol::telemetry`; this module re-exports them for the `db`
//! functions. There is no lenient field reader: a missing or wrongly-typed
//! field rejects the whole frame before any database mutation.

pub use vantyr_protocol::telemetry::{ActivityEvent, KeysEvent, MetricsSample, WindowFocusEvent};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_current_events_parse() {
        let focus = WindowFocusEvent::parse(&json!({
            "type": "window_focus", "title": "Budget.xlsx", "app": "excel.exe",
            "app_display": "Excel", "hwnd": 12345, "ts": 1_700_000_000, "user": " alice "
        }))
        .unwrap();
        assert_eq!(focus.title, "Budget.xlsx");
        assert_eq!(focus.app_display(), "Excel");
        assert_eq!(focus.hwnd, 12345);
        assert_eq!(focus.user.as_deref(), Some("alice"));

        let keys = KeysEvent::parse(&json!({
            "type": "keys", "app": "editor.exe", "app_display": "Editor",
            "window": "notes.txt", "text": "hello", "ts": 1, "user": null
        }))
        .unwrap();
        assert_eq!(keys.text, "hello");
        assert_eq!(keys.user, None);

        let activity = ActivityEvent::parse(&json!({"type":"afk","idle_secs":90,"ts":1})).unwrap();
        assert_eq!(activity.kind, "afk");
        assert_eq!(activity.idle_secs, Some(90));
    }

    #[test]
    fn missing_and_wrong_typed_fields_are_rejected() {
        assert!(WindowFocusEvent::parse(&json!({"type":"window_focus"})).is_err());
        assert!(WindowFocusEvent::parse(&json!({
            "title": 7, "app": ["excel.exe"], "app_display": 42,
            "hwnd": "123", "ts": "yesterday", "user": 99
        }))
        .is_err());
        assert!(KeysEvent::parse(&json!({"type":"keys","text":["h"]})).is_err());
        assert!(ActivityEvent::parse(&json!({"type":7,"idle_secs":"long","ts":[1]})).is_err());
        assert!(MetricsSample::parse(&json!({"cpu_pct":"high"})).is_err());
    }
}
