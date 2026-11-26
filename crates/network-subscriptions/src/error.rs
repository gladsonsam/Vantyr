//! Errors are safe to log: they carry no credentials and never echo a URL's
//! userinfo or query. Use [`crate::url::ValidatedUrl::safe_display`] whenever a
//! URL is rendered into a message.

use crate::url::ValidatedUrl;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum Error {
    #[error("invalid subscription configuration: {0}")]
    InvalidConfig(String),

    #[error("invalid public source URL: {0}")]
    InvalidUrl(String),

    #[error("source {0} is disabled")]
    Disabled(String),

    #[error("unknown subscription source {0}")]
    UnknownSource(String),

    #[error("source {0} is in an abuse rate cooldown until {1}")]
    AbuseCooldown(String, String),

    #[error("redirects are unsupported; source {0} returned HTTP {1}")]
    RedirectUnsupported(String, u16),

    #[error("HTTP {0} for source {1}")]
    HttpStatus(u16, String),

    #[error("transport failure for source {0}: {1}")]
    Transport(String, String),

    #[error("response for source {0} exceeded the {1} byte limit ({2} bytes)")]
    LimitExceeded(String, &'static str, u64),

    #[error("cache entry for source {0} is invalid: {1}")]
    Cache(String, String),

    #[error("cache entry for source {0} has a different URL identity")]
    CacheUrlMismatch(String),

    #[error("cache entry for source {0} is malformed: {1}")]
    CacheMalformed(String, String),

    #[error("cache snapshot for source {0} failed: {1}")]
    CacheWrite(String, String),

    #[error("candidate validation failed for source {0}: {1}")]
    ValidationFailed(String, String),

    #[error("cache path is not trustworthy: {}", .0.display())]
    UnsafeCachePath(PathBuf),

    #[error("worker shut down")]
    Shutdown,
}

impl Error {
    /// Truncate an untrusted diagnostic without panicking on UTF-8 boundaries.
    pub fn bounded_detail(detail: &str, limit: usize) -> String {
        let mut out = String::with_capacity(detail.len().min(limit));
        for ch in detail.chars() {
            if out.len() + ch.len_utf8() > limit {
                break;
            }
            out.push(ch);
        }
        // Diagnostics must not carry control characters that could fake a
        // new log line or a header.
        out.chars().filter(|c| !c.is_control()).collect()
    }

    pub fn for_url(_url: &ValidatedUrl, detail: impl Into<String>) -> Self {
        Error::InvalidUrl(Self::bounded_detail(&detail.into(), 256))
    }
}
