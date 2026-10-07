//! Telemetry frames: keystrokes, idle/active, window focus, app icons, browser URLs,
//! app-block kills, resource metrics and the batch envelope.

use serde::Serialize;

use crate::permissions::Generation;

/// `keys`: buffered typed text with the window it was typed into.
#[derive(Serialize)]
#[serde(tag = "type", rename = "keys")]
pub struct Keys<'a> {
    /// Grant generation of the window-context module the app/window fields were read under.
    #[serde(rename = "__window_generation")]
    pub window_generation: Option<Generation>,
    pub text: &'a str,
    pub app: &'a str,
    pub app_display: &'a str,
    pub window: &'a str,
    pub ts: u64,
    pub user: Option<&'a str>,
}

/// `afk`: the user has been idle for `idle_secs`.
#[derive(Serialize)]
#[serde(tag = "type", rename = "afk")]
pub struct Afk<'a> {
    pub idle_secs: u64,
    pub ts: u64,
    pub user: Option<&'a str>,
}

/// `active`: the user is back after an AFK period.
#[derive(Serialize)]
#[serde(tag = "type", rename = "active")]
pub struct Active<'a> {
    pub ts: u64,
    pub user: Option<&'a str>,
}

/// `window_focus`: the foreground window changed.
#[derive(Serialize)]
#[serde(tag = "type", rename = "window_focus")]
pub struct WindowFocus<'a> {
    pub title: &'a str,
    pub app: &'a str,
    pub app_display: &'a str,
    pub app_path: &'a str,
    pub hwnd: usize,
    pub ts: u64,
    pub user: Option<&'a str>,
}

/// `app_icon`: the PNG of an executable's icon, sent once per exe per session.
#[derive(Serialize)]
#[serde(tag = "type", rename = "app_icon")]
pub struct AppIcon<'a> {
    pub exe_name: &'a str,
    pub png_base64: &'a str,
    pub ts: u64,
}

/// `app_block_kill`: an app-block rule ended a process.
#[derive(Serialize)]
#[serde(tag = "type", rename = "app_block_kill")]
pub struct AppBlockKill<'a> {
    pub rule_id: i64,
    pub rule_name: &'a str,
    pub exe_name: &'a str,
}

/// `url`: the active browser tab changed (live sample; sessions use `url_session`).
#[derive(Serialize)]
#[serde(tag = "type", rename = "url")]
pub struct Url<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub browser: &'a str,
    pub ts: u64,
    pub user: Option<&'a str>,
}

/// `url_session`: time on one site, emitted when the session ends.
#[derive(Serialize)]
#[serde(tag = "type", rename = "url_session")]
pub struct UrlSession<'a> {
    pub url: &'a str,
    pub title: Option<&'a str>,
    pub browser: Option<&'a str>,
    pub user: Option<&'a str>,
    pub started_at_ts: i64,
    pub ended_at_ts: i64,
    pub duration_ms: u64,
}

/// `metrics`: CPU, memory and system-disk sample for the health history.
#[derive(Serialize)]
#[serde(tag = "type", rename = "metrics")]
pub struct Metrics {
    pub cpu_pct: f64,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub mem_pct: f64,
    pub disk_pct: f64,
    pub disk_used_gb: f64,
    pub disk_total_gb: f64,
    pub uptime_secs: u64,
    pub ts: u64,
}

/// `batch`: several telemetry events in one frame.
#[derive(Serialize)]
#[serde(tag = "type", rename = "batch")]
pub struct Batch<'a> {
    pub events: &'a [serde_json::Value],
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::outbound::{stamped, to_text, to_value};
    use crate::permissions::Module;

    /// The typed message and the `json!` literal it replaced must serialize identically.
    fn same(typed: serde_json::Value, literal: serde_json::Value) {
        assert_eq!(typed.to_string(), literal.to_string());
    }

    fn generation() -> Generation {
        Generation {
            module: Module::KeyboardText,
            revision: 7,
        }
    }

    #[test]
    fn keys_matches_the_json_shape() {
        let g = Some(generation());
        same(
            to_value(&Keys {
                window_generation: g,
                text: "hi[⌫]",
                app: "chrome.exe",
                app_display: "Google Chrome",
                window: "Docs",
                ts: 1_700_000_000,
                user: Some("sam"),
            }),
            json!({
                "type": "keys",
                "__window_generation": g,
                "text": "hi[⌫]",
                "app": "chrome.exe",
                "app_display": "Google Chrome",
                "window": "Docs",
                "ts": 1_700_000_000_u64,
                "user": "sam",
            }),
        );
        same(
            to_value(&Keys {
                window_generation: None,
                text: "",
                app: "",
                app_display: "",
                window: "",
                ts: 0,
                user: None,
            }),
            json!({
                "type": "keys",
                "__window_generation": null,
                "text": "",
                "app": "",
                "app_display": "",
                "window": "",
                "ts": 0,
                "user": null,
            }),
        );
    }

    #[test]
    fn afk_and_active_match_the_json_shape() {
        same(
            to_value(&Afk {
                idle_secs: 61,
                ts: 5,
                user: Some("sam"),
            }),
            json!({"type": "afk", "idle_secs": 61, "ts": 5, "user": "sam"}),
        );
        same(
            to_value(&Active { ts: 5, user: None }),
            json!({"type": "active", "ts": 5, "user": null}),
        );
    }

    #[test]
    fn window_focus_and_app_icon_match_the_json_shape() {
        same(
            to_value(&WindowFocus {
                title: "t",
                app: "a.exe",
                app_display: "A",
                app_path: r"C:\a.exe",
                hwnd: 42,
                ts: 9,
                user: Some("u"),
            }),
            json!({
                "type": "window_focus",
                "title": "t",
                "app": "a.exe",
                "app_display": "A",
                "app_path": r"C:\a.exe",
                "hwnd": 42,
                "ts": 9,
                "user": "u",
            }),
        );
        same(
            to_value(&AppIcon {
                exe_name: "a.exe",
                png_base64: "AAAA",
                ts: 9,
            }),
            json!({"type": "app_icon", "exe_name": "a.exe", "png_base64": "AAAA", "ts": 9}),
        );
    }

    #[test]
    fn app_block_kill_matches_the_json_shape() {
        same(
            to_value(&AppBlockKill {
                rule_id: -3,
                rule_name: "Games",
                exe_name: "game.exe",
            }),
            json!({"type": "app_block_kill", "rule_id": -3, "rule_name": "Games", "exe_name": "game.exe"}),
        );
    }

    #[test]
    fn url_and_url_session_match_the_json_shape() {
        same(
            to_value(&Url {
                url: "https://example.com",
                title: "Example",
                browser: "Chrome",
                ts: 11,
                user: None,
            }),
            json!({
                "type": "url",
                "url": "https://example.com",
                "title": "Example",
                "browser": "Chrome",
                "ts": 11,
                "user": null,
            }),
        );
        same(
            to_value(&UrlSession {
                url: "https://example.com",
                title: None,
                browser: Some("Chrome"),
                user: Some("sam"),
                started_at_ts: 10,
                ended_at_ts: 20,
                duration_ms: 10_000,
            }),
            json!({
                "type": "url_session",
                "url": "https://example.com",
                "title": null,
                "browser": "Chrome",
                "user": "sam",
                "started_at_ts": 10,
                "ended_at_ts": 20,
                "duration_ms": 10_000,
            }),
        );
    }

    #[test]
    fn metrics_match_the_json_shape() {
        same(
            to_value(&Metrics {
                cpu_pct: 12.5,
                mem_used_mb: 4096,
                mem_total_mb: 16384,
                mem_pct: 25.0,
                disk_pct: 61.3,
                disk_used_gb: 300.12,
                disk_total_gb: 476.94,
                uptime_secs: 3600,
                ts: 100,
            }),
            json!({
                "type": "metrics",
                "cpu_pct": 12.5,
                "mem_used_mb": 4096,
                "mem_total_mb": 16384,
                "mem_pct": 25.0,
                "disk_pct": 61.3,
                "disk_used_gb": 300.12,
                "disk_total_gb": 476.94,
                "uptime_secs": 3600,
                "ts": 100,
            }),
        );
    }

    #[test]
    fn batch_matches_the_json_shape() {
        let events = [json!({"type": "active", "ts": 1}), json!({"type": "afk"})];
        assert_eq!(
            to_text(&Batch { events: &events }),
            json!({"type": "batch", "events": events}).to_string()
        );
    }

    #[test]
    fn stamping_adds_the_generation_like_the_json_path() {
        let g = Some(generation());
        let typed = stamped(&Active { ts: 1, user: None }, g);
        let literal =
            crate::permissions::stamp(json!({"type": "active", "ts": 1, "user": null}), g);
        assert_eq!(typed.to_string(), literal.to_string());
        assert!(typed["__module_generation"].is_object());
    }
}
