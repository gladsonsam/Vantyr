//! The one typed set of agent -> server telemetry payloads.
//!
//! These are the fields the current agent actually emits and the server
//! actually binds. Every field is strict: a missing or wrongly-typed field
//! rejects the whole frame. `Option` appears only where the current agent
//! legitimately emits `null` (or omits the field) — never as a compatibility
//! fallback for an older peer. Normalization (trimming a user name) is done
//! after parsing and is not a compat reader.

use serde::Deserialize;

use crate::error::{from_serde, trimmed_non_empty, ProtocolError};

fn parse<T: serde::de::DeserializeOwned>(v: &serde_json::Value) -> Result<T, ProtocolError> {
    serde_json::from_value(v.clone()).map_err(from_serde)
}

/// `window_focus`: the foreground window.
#[derive(Debug, Clone, Deserialize)]
pub struct WindowFocusEvent {
    pub title: String,
    pub app: String,
    pub app_display: String,
    pub hwnd: i64,
    pub ts: i64,
    pub user: Option<String>,
}

impl WindowFocusEvent {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        let mut ev = parse::<Self>(v)?;
        ev.user = trimmed_non_empty(ev.user);
        Ok(ev)
    }

    pub fn app_display(&self) -> &str {
        &self.app_display
    }
}

/// `keys`: typed text and the window it was typed into.
#[derive(Debug, Clone, Deserialize)]
pub struct KeysEvent {
    pub text: String,
    pub app: String,
    pub app_display: String,
    pub window: String,
    pub ts: i64,
    pub user: Option<String>,
}

impl KeysEvent {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        let mut ev = parse::<Self>(v)?;
        ev.user = trimmed_non_empty(ev.user);
        Ok(ev)
    }

    pub fn app_display(&self) -> &str {
        &self.app_display
    }
}

/// `afk` / `active`: one activity transition. `idle_secs` is present on `afk`
/// and legitimately absent on `active`.
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub idle_secs: Option<i64>,
    pub ts: i64,
    pub user: Option<String>,
}

impl ActivityEvent {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        let mut ev = parse::<Self>(v)?;
        if !matches!(ev.kind.as_str(), "afk" | "active") {
            return Err(ProtocolError::InvalidField("type"));
        }
        ev.user = trimmed_non_empty(ev.user);
        Ok(ev)
    }
}

/// `metrics`: one resource sample.
#[derive(Debug, Clone, Deserialize)]
pub struct MetricsSample {
    pub cpu_pct: f32,
    pub mem_used_mb: i64,
    pub mem_total_mb: i64,
    pub mem_pct: f32,
    pub disk_pct: f32,
    pub disk_used_gb: f32,
    pub disk_total_gb: f32,
}

impl MetricsSample {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        parse(v)
    }
}

/// `url`: one completed navigation.
#[derive(Debug, Clone, Deserialize)]
pub struct UrlVisit {
    pub url: String,
    pub title: String,
    pub browser: String,
    pub ts: i64,
    pub user: Option<String>,
}

impl UrlVisit {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        let mut ev = parse::<Self>(v)?;
        ev.user = trimmed_non_empty(ev.user);
        Ok(ev)
    }
}

/// `url_session`: time spent on one page. The current agent genuinely emits
/// `null` for title/browser/user, so those stay optional.
#[derive(Debug, Clone, Deserialize)]
pub struct UrlSessionEvent {
    pub url: String,
    pub title: Option<String>,
    pub browser: Option<String>,
    pub user: Option<String>,
    pub started_at_ts: i64,
    pub ended_at_ts: i64,
    pub duration_ms: i64,
}

impl UrlSessionEvent {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        let mut ev = parse::<Self>(v)?;
        ev.duration_ms = ev.duration_ms.max(0);
        ev.user = trimmed_non_empty(ev.user);
        Ok(ev)
    }
}

/// One installed-software entry in a `software_inventory` snapshot.
#[derive(Debug, Clone, Deserialize)]
pub struct SoftwareItem {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub install_date: Option<String>,
}

impl SoftwareItem {
    /// `None` when it has no usable name (the entry is skipped, never defaulted).
    pub fn parse(v: &serde_json::Value) -> Result<Option<Self>, ProtocolError> {
        let mut item = parse::<Self>(v)?;
        item.name = item.name.trim().to_owned();
        if item.name.is_empty() {
            return Ok(None);
        }
        Ok(Some(item))
    }

    pub fn key(&self) -> Option<String> {
        let name = self.name.trim();
        if name.is_empty() {
            return None;
        }
        let version = self.version.as_deref().unwrap_or("").trim();
        let publisher = self.publisher.as_deref().unwrap_or("").trim();
        Some(format!(
            "{}\n{}\n{}",
            name.to_ascii_lowercase(),
            version.to_ascii_lowercase(),
            publisher.to_ascii_lowercase()
        ))
    }
}

/// `software_inventory`: the snapshot envelope; `items` is required and always
/// an array, bounded by the server's ingest cap before any mutation.
#[derive(Debug, Clone, Deserialize)]
pub struct SoftwareInventoryEvent {
    pub items: Vec<serde_json::Value>,
    pub captured_at: i64,
}

impl SoftwareInventoryEvent {
    pub fn parse(v: &serde_json::Value) -> Result<Self, ProtocolError> {
        parse(v)
    }
}

/// `app_icon`: a PNG icon, sent once per executable per session.
#[derive(Debug, Clone, Deserialize)]
pub struct AppIconFields {
    pub exe_name: String,
    pub png_base64: String,
}

/// `app_block_kill`: an app-block rule ended a process.
#[derive(Debug, Clone, Deserialize)]
pub struct AppBlockKillFields {
    pub rule_id: i64,
    pub rule_name: String,
    pub exe_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_current_payloads_parse() {
        let keys = KeysEvent::parse(&json!({
            "type": "keys", "text": "hi", "app": "a.exe", "app_display": "A",
            "window": "w", "ts": 7, "user": " bob "
        }))
        .unwrap();
        assert_eq!(keys.app_display(), "A");
        assert_eq!(keys.user.as_deref(), Some("bob"));
        let focus = WindowFocusEvent::parse(&json!({
            "type": "window_focus", "title": "t", "app": "a.exe",
            "app_display": "A", "hwnd": 4, "ts": 7, "user": null
        }))
        .unwrap();
        assert_eq!(focus.hwnd, 4);
        assert_eq!(focus.user, None);
        assert!(ActivityEvent::parse(&json!({"type":"active","ts":1})).is_ok());
        assert!(MetricsSample::parse(&json!({
            "cpu_pct": 1.0, "mem_used_mb": 2, "mem_total_mb": 3,
            "mem_pct": 4.0, "disk_pct": 5.0, "disk_used_gb": 6.0, "disk_total_gb": 7.0
        }))
        .is_ok());
        let inv = SoftwareInventoryEvent::parse(&json!({
            "items": [], "captured_at": 9
        }))
        .unwrap();
        assert!(inv.items.is_empty());
    }

    #[test]
    fn malformed_fields_are_rejected_not_defaulted() {
        assert!(KeysEvent::parse(&json!({"text":7,"app":"a","app_display":"A","window":"w","ts":1})).is_err());
        assert!(KeysEvent::parse(&json!({"text":"t"})).is_err());
        assert!(WindowFocusEvent::parse(&json!({"title":"t","app":"a","app_display":"A","hwnd":"4","ts":1})).is_err());
        assert!(MetricsSample::parse(&json!({"cpu_pct":"high"})).is_err());
        assert!(SoftwareInventoryEvent::parse(&json!({"items":"none","captured_at":1})).is_err());
        assert!(UrlSessionEvent::parse(&json!({"url":"u","started_at_ts":1,"ended_at_ts":2,"duration_ms":"x"})).is_err());
        assert!(ActivityEvent::parse(&json!({"type":"other","ts":1})).is_err());
    }

    #[test]
    fn software_item_name_is_required_and_optional_fields_are_typed() {
        assert!(SoftwareItem::parse(&json!({"version":"1"})).is_err());
        assert!(SoftwareItem::parse(&json!({"name":"   "})).unwrap().is_none());
        assert!(SoftwareItem::parse(&json!({"name": " A ", "version": 7})).is_err());
        let item = SoftwareItem::parse(&json!({"name":" A ","version":null}))
            .unwrap()
            .unwrap();
        assert_eq!(item.name, "A");
        assert_eq!(item.version, None);
        assert_eq!(item.key().as_deref(), Some("a\n\n"));
    }
}
