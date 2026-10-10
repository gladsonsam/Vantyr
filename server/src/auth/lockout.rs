//! Login brute-force protection: per-IP and per-username failure windows.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

use crate::state::AppState;

/// Drop failures older than this; max failures within the window triggers 429 on `/api/login`.
const LOGIN_FAIL_WINDOW: Duration = Duration::from_secs(15 * 60);

pub(super) const MAX_LOGIN_FAILURES_PER_WINDOW: usize = 10;

/// Rate-limit/lockout key for a login attempt. Unlike [`crate::http::client_ip_for_audit`], this only honors
/// forwarding headers when the direct peer is a trusted proxy, so spoofed `X-Forwarded-For`
/// can't rotate the key to dodge brute-force protection.
pub(super) fn login_client_key(state: &AppState, headers: &HeaderMap, addr: SocketAddr) -> String {
    state
        .settings
        .trusted_proxies
        .client_ip(headers, addr)
        .to_string()
}

type FailureMap = std::collections::HashMap<String, Vec<Instant>>;

/// Pure lockout-window math (no DB / no global clock): retry-after for `key`, or `None` if not
/// currently locked. Prunes expired timestamps in place.
fn lockout_retry_after(map: &mut FailureMap, key: &str, now: Instant) -> Option<u64> {
    let v = map.get_mut(key)?;
    v.retain(|t| now.saturating_duration_since(*t) < LOGIN_FAIL_WINDOW);
    if v.is_empty() {
        map.remove(key);
        return None;
    }
    if v.len() >= MAX_LOGIN_FAILURES_PER_WINDOW {
        let oldest = *v.iter().min()?;
        Some(
            LOGIN_FAIL_WINDOW
                .checked_sub(now.saturating_duration_since(oldest))
                .unwrap_or_default()
                .as_secs()
                .max(1),
        )
    } else {
        None
    }
}

/// Pure failure-recording: returns `Ok(attempts_remaining)` or `Err(retry_secs)` when this attempt
/// tripped the limit.
fn lockout_record(map: &mut FailureMap, key: &str, now: Instant) -> Result<u64, u64> {
    let v = map.entry(key.to_string()).or_default();
    v.retain(|t| now.saturating_duration_since(*t) < LOGIN_FAIL_WINDOW);
    v.push(now);
    if v.len() >= MAX_LOGIN_FAILURES_PER_WINDOW {
        let oldest = *v.iter().min().unwrap_or(&now);
        Err(LOGIN_FAIL_WINDOW
            .checked_sub(now.saturating_duration_since(oldest))
            .unwrap_or_default()
            .as_secs()
            .max(1))
    } else {
        let remaining = MAX_LOGIN_FAILURES_PER_WINDOW - v.len();
        Ok(remaining as u64)
    }
}

fn login_rate_retry_after(state: &AppState, key: &str) -> Option<u64> {
    lockout_retry_after(
        &mut state.throttles.login_failures.lock(),
        key,
        Instant::now(),
    )
}

/// Records a failed login. Returns `Ok(attempts_remaining)` (wrong tries left before lockout), or
/// `Err(retry_secs)` when this attempt triggered the limit.
fn record_login_failure(state: &AppState, key: &str) -> Result<u64, u64> {
    lockout_record(
        &mut state.throttles.login_failures.lock(),
        key,
        Instant::now(),
    )
}

fn clear_login_failures(state: &AppState, key: &str) {
    state.throttles.login_failures.lock().remove(key);
}

/// Lockout bucket keyed by account, so rotating the source IP (or a spoofed `X-Forwarded-For`)
/// can't sidestep the per-username limit. The `user:` prefix can't collide with an IP key.
pub(super) fn login_username_key(username: &str) -> String {
    format!("user:{}", username.trim().to_lowercase())
}

/// Combined per-IP + per-username lockout check. Returns the longest retry-after if either bucket
/// is currently locked.
pub(super) fn login_locked_retry_after(
    state: &AppState,
    ip_key: &str,
    user_key: &str,
) -> Option<u64> {
    let ip = login_rate_retry_after(state, ip_key);
    let user = login_rate_retry_after(state, user_key);
    ip.into_iter().chain(user).max()
}

/// Records a failure against both the IP and username buckets. Returns `Ok(min remaining)` or
/// `Err(retry_secs)` when either bucket tripped the limit.
pub(super) fn record_login_failure_both(
    state: &AppState,
    ip_key: &str,
    user_key: &str,
) -> Result<u64, u64> {
    // Evaluate both so each bucket is incremented regardless of the other's outcome.
    let ip = record_login_failure(state, ip_key);
    let user = record_login_failure(state, user_key);
    match (ip, user) {
        (Err(a), Err(b)) => Err(a.max(b)),
        (Err(a), _) => Err(a),
        (_, Err(b)) => Err(b),
        (Ok(a), Ok(b)) => Ok(a.min(b)),
    }
}

pub(super) fn clear_login_failures_both(state: &AppState, ip_key: &str, user_key: &str) {
    clear_login_failures(state, ip_key);
    clear_login_failures(state, user_key);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_key_is_normalized() {
        assert_eq!(login_username_key("  Admin "), "user:admin");
        assert_eq!(login_username_key("ALICE"), "user:alice");
        // Distinct from any raw-IP key (which never starts with "user:").
        assert!(login_username_key("bob").starts_with("user:"));
    }

    #[test]
    fn lockout_trips_after_max_failures() {
        let mut map = FailureMap::new();
        let now = Instant::now();
        // Not locked before any failure.
        assert!(lockout_retry_after(&mut map, "k", now).is_none());
        // Up to the threshold returns Ok(remaining); the final one trips Err.
        for i in 1..MAX_LOGIN_FAILURES_PER_WINDOW {
            let remaining = lockout_record(&mut map, "k", now).expect("not yet locked");
            assert_eq!(remaining as usize, MAX_LOGIN_FAILURES_PER_WINDOW - i);
        }
        let retry = lockout_record(&mut map, "k", now).expect_err("should be locked");
        assert!(retry >= 1);
        assert!(lockout_retry_after(&mut map, "k", now).is_some());
    }

    #[test]
    fn lockout_expires_after_window() {
        let mut map = FailureMap::new();
        let start = Instant::now();
        for _ in 0..MAX_LOGIN_FAILURES_PER_WINDOW {
            let _ = lockout_record(&mut map, "k", start);
        }
        assert!(lockout_retry_after(&mut map, "k", start).is_some());
        // After the window elapses, the bucket prunes empty and unlocks.
        let later = start + LOGIN_FAIL_WINDOW + Duration::from_secs(1);
        assert!(lockout_retry_after(&mut map, "k", later).is_none());
    }

    #[test]
    fn lockout_buckets_are_independent() {
        let mut map = FailureMap::new();
        let now = Instant::now();
        for _ in 0..MAX_LOGIN_FAILURES_PER_WINDOW {
            let _ = lockout_record(&mut map, "user:alice", now);
        }
        // Locking alice's account must not lock a different IP/account bucket.
        assert!(lockout_retry_after(&mut map, "user:alice", now).is_some());
        assert!(lockout_retry_after(&mut map, "203.0.113.7", now).is_none());
    }
}
