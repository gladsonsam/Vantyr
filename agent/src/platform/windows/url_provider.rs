//! Windows active-tab URL provider: a thin wrapper around the `browser-url` crate.
//!
//! Returns [`None`] when the browser is unavailable, when extraction fails, or when the
//! address bar still shows partial input (omnibox typing), so URL history and analytics
//! only record completed navigations.

use std::net::IpAddr;

pub use crate::platform::types::ActiveUrl;

fn looks_like_complete_navigation_url(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_ascii_lowercase();

    if lower.starts_with("chrome:")
        || lower.starts_with("edge:")
        || lower.starts_with("brave:")
        || lower.starts_with("about:")
        || lower.starts_with("file:")
        || lower.starts_with("moz-extension:")
        || lower.starts_with("devtools:")
    {
        return true;
    }

    let to_parse = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };

    let Ok(u) = url::Url::parse(&to_parse) else {
        return false;
    };

    let Some(host) = u.host_str() else {
        return false;
    };

    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    if host.starts_with('[')
        && host.ends_with(']')
        && host[1..host.len() - 1].parse::<IpAddr>().is_ok()
    {
        return true;
    }
    host.contains('.')
}

/// Active browser tab if extraction succeeds and the URL looks like a real navigation.
pub fn active_url() -> Option<ActiveUrl> {
    // Convert the OS-native `browser_url::BrowserInfo` into the shared
    // `ActiveUrl` at the backend boundary so the agent loop never depends on
    // a Windows-only type.
    get_active_url().map(|info| ActiveUrl {
        url: info.url,
        title: info.title,
        browser_name: info.browser_name,
    })
}

fn get_active_url() -> Option<browser_url::BrowserInfo> {
    if !crate::permissions::allowed(crate::permissions::Module::BrowserUrls) {
        return None;
    }
    match browser_url::get_active_browser_url() {
        Ok(info)
            if !info.url.trim().is_empty() && looks_like_complete_navigation_url(&info.url) =>
        {
            Some(info)
        }
        _ => None,
    }
}
