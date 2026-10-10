//! Session and transient cookies, plus the per-session CSRF token.

use axum::http::{header, HeaderMap, HeaderValue};
use rand::RngCore;
use subtle::ConstantTimeEq;

pub(super) fn new_dashboard_csrf_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(super) fn csrf_header_matches(expected: &str, supplied: Option<&str>) -> bool {
    let Some(s) = supplied else {
        return false;
    };
    let a = expected.as_bytes();
    let b = s.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

pub(super) fn cookie_get(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_str = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_str.split(';') {
        let t = part.trim();
        if let Some(val) = t.strip_prefix(&format!("{name}=")) {
            return Some(val.to_string());
        }
    }
    None
}

pub(super) fn cookie_clear(name: &str, secure: bool) -> HeaderValue {
    let samesite = if secure {
        "SameSite=None; Secure"
    } else {
        "SameSite=Lax"
    };
    HeaderValue::from_str(&format!("{name}=; HttpOnly; {samesite}; Path=/; Max-Age=0"))
        .unwrap_or_else(|_| HeaderValue::from_static(""))
}

pub fn extract_session(headers: &HeaderMap) -> Option<String> {
    let cookie_str = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_str.split(';') {
        if let Some(val) = part.trim().strip_prefix("session=") {
            return Some(val.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csrf_compare_matches_only_exact() {
        assert!(csrf_header_matches("abc123", Some("abc123")));
        assert!(!csrf_header_matches("abc123", Some("abc124")));
        assert!(!csrf_header_matches("abc123", Some("abc12")));
        assert!(!csrf_header_matches("abc123", None));
    }
}
