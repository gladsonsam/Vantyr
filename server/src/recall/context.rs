//! Optional, independently authorized foreground observations around a capture.
//! No raw client context, identity tokens, paths or grant revisions reach the API.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Default)]
pub struct Metadata {
    pub context: Option<Value>,
    pub duration_ms: Option<i32>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub host: Option<String>,
}

fn bounded_clean(s: &str, max: usize) -> (String, bool) {
    let clean: String = s.chars().filter(|c| !c.is_control()).collect();
    if clean.len() <= max {
        return (clean, false);
    }
    let mut end = max;
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    (clean[..end].into(), true)
}

/// Exact host literals only. Never infer a URL from an omnibox fragment.
pub fn normalize_host(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty() || raw.len() > 1024 || raw.trim() != raw || raw.chars().any(char::is_control)
    {
        return Err("invalid url_host");
    }
    let ip = raw
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(raw);
    if let Ok(ip) = ip.parse::<std::net::IpAddr>() {
        return Ok(ip.to_string());
    }
    if raw.contains(['/', ':', '?', '#', '@', '\\', '%', '[', ']'])
        || raw.chars().any(char::is_whitespace)
    {
        return Err("url_host must be a host literal without scheme, path or port");
    }
    let host = idna::domain_to_ascii(raw.strip_suffix('.').unwrap_or(raw))
        .map_err(|_| "invalid url_host")?
        .to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("invalid url_host");
    }
    // URL host parsing normalizes IPv4 forms consistently with the agent.
    let url = url::Url::parse(&format!("https://{host}/")).map_err(|_| "invalid url_host")?;
    Ok(url
        .host_str()
        .ok_or("invalid url_host")?
        .trim_end_matches('.')
        .to_owned())
}

fn empty(reason: &str, status: &str, browser: bool) -> Value {
    if browser {
        json!({"status": status, "reason": reason, "source":"none", "url":null, "url_host":null})
    } else {
        json!({"status": status, "reason": reason, "source":"none", "app":null, "title":null})
    }
}
fn component(
    raw: Option<&Value>,
    browser: bool,
    revision: Option<u64>,
    current: Option<u64>,
) -> Value {
    let Some(c) = raw.filter(|v| v.is_object()) else {
        return empty("invalid_context", "unknown", browser);
    };
    let keys = if browser {
        &["status", "reason", "source", "url", "url_host"][..]
    } else {
        &[
            "status",
            "reason",
            "source",
            "app",
            "title",
            "title_truncated",
        ][..]
    };
    let status = c["status"].as_str().unwrap_or("");
    let reason = c["reason"].as_str();
    let valid_reason = c.get("reason").is_some_and(|v| v.is_null())
        || reason.is_some_and(|r| {
            matches!(
                r,
                "module_disabled"
                    | "revoked"
                    | "unsupported"
                    | "no_foreground"
                    | "not_browser"
                    | "read_failed"
                    | "sample_timeout"
                    | "changed"
                    | "identity_unverified"
                    | "invalid_url"
                    | "invalid_context"
            )
        });
    let source = c["source"].as_str().unwrap_or("");
    let valid_source = if browser {
        matches!(source, "uia_hwnd" | "none")
    } else {
        matches!(source, "win32" | "hyprland" | "none")
    };
    let scalar = |key: &str| c.get(key).is_none_or(|v| v.is_null() || v.is_string());
    let valid_values = if browser {
        c.get("url").is_none_or(Value::is_null) && scalar("url_host")
    } else {
        scalar("app") && scalar("title") && c.get("title_truncated").is_none_or(Value::is_boolean)
    };
    if c.as_object()
        .unwrap()
        .keys()
        .any(|k| !keys.contains(&k.as_str()))
        || !matches!(
            status,
            "observed" | "uncertain" | "unknown" | "not_collected"
        )
        || !valid_reason
        || !valid_source
        || !valid_values
        || (status == "observed" && (source == "none" || reason.is_some()))
    {
        return empty("invalid_context", "unknown", browser);
    }
    if status != "observed" {
        let has_values = if browser {
            !c["url_host"].is_null()
        } else {
            !c["app"].is_null() || !c["title"].is_null()
        };
        if has_values {
            return empty("invalid_context", "unknown", browser);
        }
        return if browser {
            json!({"status":status,"reason":c["reason"],"source":source,"url":null,"url_host":null})
        } else {
            json!({"status":status,"reason":c["reason"],"source":source,"app":null,"title":null})
        };
    }
    if revision.is_none() || revision != current {
        return empty("revoked", "not_collected", browser);
    }
    if browser {
        let host = c["url_host"].as_str().map(normalize_host).transpose();
        match host {
            Ok(host) => {
                json!({"status":status,"reason":null,"source":source,"url":null,"url_host":host})
            }
            Err(_) => empty("invalid_url", "unknown", true),
        }
    } else {
        let app = c["app"]
            .as_str()
            .map(|s| bounded_clean(s, 256))
            .and_then(|(s, long)| {
                (!long && !s.is_empty() && !s.contains(['/', '\\'])).then_some(s)
            });
        let title = c["title"].as_str().map(|s| bounded_clean(s, 1024));
        let truncated = c["title_truncated"].as_bool().unwrap_or(false)
            || title.as_ref().is_some_and(|(_, t)| *t);
        let mut out = json!({"status":status,"reason":null,"source":source,"app":app,"title":title.map(|(s,_)| s).filter(|s| !s.is_empty())});
        if truncated {
            out["title_truncated"] = json!(true);
        }
        out
    }
}

// Cap serialized wire size without allocating another unbounded JSON buffer.
fn context_fits(value: &Value) -> bool {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > 4096_usize.saturating_sub(self.0) {
                return Err(std::io::Error::other("context limit"));
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Size(0), value).is_ok()
}

pub fn sanitize(
    header: &Value,
    window_revision: Option<u64>,
    browser_revision: Option<u64>,
) -> Metadata {
    let mut m = Metadata {
        duration_ms: header["capture_duration_ms"]
            .as_u64()
            .filter(|v| *v <= 1000)
            .map(|v| v as i32),
        ..Metadata::default()
    };
    let Some(c) = header.get("context").filter(|v| v.is_object()) else {
        return m;
    };
    if !context_fits(c)
        || c["version"].as_u64() != Some(1)
        || c["scope"].as_str() != Some("session_foreground")
        || !c["bracket_ms"].as_u64().is_some_and(|n| n <= 1000)
        || !matches!(
            c["monitor_relation"].as_str(),
            Some("unknown" | "same" | "other")
        )
        || c.as_object().unwrap().keys().any(|k| {
            ![
                "version",
                "scope",
                "bracket_ms",
                "monitor_relation",
                "window",
                "browser",
                "grant_revisions",
            ]
            .contains(&k.as_str())
        })
    {
        return m;
    }
    let window = component(
        c.get("window"),
        false,
        c["grant_revisions"]["window_activity"].as_u64(),
        window_revision,
    );
    let browser = component(
        c.get("browser"),
        true,
        c["grant_revisions"]["browser_urls"].as_u64(),
        browser_revision,
    );
    m.app = window["app"].as_str().map(str::to_ascii_lowercase);
    m.title = window["title"].as_str().map(str::to_owned);
    m.host = browser["url_host"].as_str().map(str::to_owned);
    m.context = Some(
        json!({"version":1,"scope":"session_foreground","bracket_ms":c["bracket_ms"],"monitor_relation":c["monitor_relation"],"window":window,"browser":browser}),
    );
    m
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    pub app: Option<String>,
    pub app_mode: String,
    pub title: Option<String>,
    pub url_host: Option<String>,
    pub context: String,
}
impl Default for Filters {
    fn default() -> Self {
        Self {
            app: None,
            app_mode: "exact".into(),
            title: None,
            url_host: None,
            context: "all".into(),
        }
    }
}
impl Filters {
    pub fn active(&self) -> bool {
        self.app.is_some()
            || self.title.is_some()
            || self.url_host.is_some()
            || self.context != "all"
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.app_mode.as_str(), "exact" | "prefix")
            || !matches!(self.context.as_str(), "all" | "known" | "unknown")
            || (self.app.is_none() && self.app_mode != "exact")
        {
            return Err("invalid context filters");
        }
        for (s, max) in [(self.app.as_deref(), 256), (self.title.as_deref(), 1024)] {
            if s.is_some_and(|s| s.is_empty() || s.len() > max || s.chars().any(char::is_control)) {
                return Err("invalid context filter value");
            }
        }
        if self
            .app
            .as_ref()
            .is_some_and(|s| s != &s.to_ascii_lowercase())
        {
            return Err("invalid app filter");
        }
        if let Some(host) = &self.url_host {
            if normalize_host(host)? != *host {
                return Err("invalid host filter");
            }
        }
        if self.context == "unknown"
            && (self.app.is_some() || self.title.is_some() || self.url_host.is_some())
        {
            return Err("context=unknown cannot combine with value filters");
        }
        Ok(())
    }
}
pub fn literal_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::recall::context_header as header;
    #[test]
    fn components_grants_revisions_and_reserved_url_are_independent() {
        let h = header();
        let m = sanitize(&h, Some(12), Some(9));
        assert_eq!(m.app.as_deref(), Some("editor.exe"));
        assert_eq!(m.host.as_deref(), Some("example.com"));
        assert!(!m.context.unwrap().to_string().contains("grant_revisions"));
        let mut exact = h.clone();
        exact["context"]["grant_revisions"]["window_activity"] = json!(u64::MAX);
        assert!(sanitize(&exact, Some(u64::MAX), Some(9)).app.is_some());
        assert!(sanitize(&exact, Some(u64::MAX - 1), Some(9)).app.is_none());
        let m = sanitize(&h, Some(13), Some(9));
        assert!(m.app.is_none() && m.title.is_none());
        assert_eq!(m.host.as_deref(), Some("example.com"));
        assert_eq!(m.context.as_ref().unwrap()["window"]["reason"], "revoked");
        let m = sanitize(&h, Some(12), None);
        assert_eq!(m.app.as_deref(), Some("editor.exe"));
        assert!(m.host.is_none());
        let mut bad = h.clone();
        bad["context"]["browser"]["url"] = json!("https://example.com/private?secret");
        let m = sanitize(&bad, Some(12), Some(9));
        assert!(m.host.is_none());
        assert!(m.app.is_some());
        assert!(!m.context.unwrap().to_string().contains("secret"));
    }
    #[test]
    fn malformed_components_envelopes_types_and_utf8_bounds_preserve_safe_parts() {
        let mut h = header();
        h["context"]["window"]["app"] = json!(7);
        assert!(sanitize(&h, Some(12), Some(9)).app.is_none());
        assert!(sanitize(&h, Some(12), Some(9)).host.is_some());
        h = header();
        h["context"]["window"]["title"] = json!(format!("\0{}\n", "文".repeat(400)));
        h["context"]["window"]["app"] = json!("a".repeat(257));
        let m = sanitize(&h, Some(12), Some(9));
        assert!(m.app.is_none());
        assert_eq!(m.title.unwrap().len(), 1023);
        assert_eq!(m.context.unwrap()["window"]["title_truncated"], true);
        h = header();
        h["context"]["window"]["app"] = json!("C:\\private\\editor.exe");
        assert!(sanitize(&h, Some(12), Some(9)).app.is_none());
        for malformed in [
            json!(null),
            json!("context"),
            json!({"version":2}),
            json!({"version":1,"secret":"s".repeat(5000)}),
        ] {
            h["context"] = malformed;
            assert!(sanitize(&h, Some(12), Some(9)).context.is_none());
        }
        h = header();
        h["capture_duration_ms"] = json!("24");
        assert!(sanitize(&h, Some(12), Some(9)).duration_ms.is_none());
        h["capture_duration_ms"] = json!(1001);
        assert!(sanitize(&h, Some(12), Some(9)).duration_ms.is_none());
        h["context"]["window"]["status"] = json!("uncertain");
        assert!(sanitize(&h, Some(12), Some(9)).app.is_none());
        assert!(sanitize(&h, Some(12), Some(9)).host.is_some());
    }
    #[test]
    fn host_exact_validation_normalizes_idna_ipv4_ipv6_without_paths_or_ports() {
        for (raw, expected) in [
            ("EXAMPLE.COM.", "example.com"),
            ("bücher.example", "xn--bcher-kva.example"),
            ("[2001:0db8::1]", "2001:db8::1"),
            ("2001:db8::1", "2001:db8::1"),
            ("127.1", "127.0.0.1"),
            ("localhost", "localhost"),
        ] {
            assert_eq!(normalize_host(raw).unwrap(), expected);
        }
        for bad in [
            "https://example.com",
            "example.com:80",
            "example.com/a",
            "a@example.com",
            "example.com?secret",
            "example.com#x",
            "example..com",
            "example.com..",
            "-example.com",
            "x_y.example",
            " example.com",
            "example.com\\x",
            "",
        ] {
            assert!(normalize_host(bad).is_err(), "{bad}");
        }
    }
}
