//! Small helpers shared across notification provider modules.

use std::time::Duration;

/// Read an environment variable, trimmed; `None` when unset or empty.
pub fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Truthy environment flag (`1/true/yes/on`, case-insensitive).
#[allow(dead_code)]
pub fn env_bool(key: &str) -> bool {
    matches!(
        env_trim(key).as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

/// Strip a trailing slash so we can append paths predictably.
#[allow(dead_code)]
pub fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// A shared reqwest client with a sane timeout and a recognisable user agent.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("vantyr-server/notify")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}
