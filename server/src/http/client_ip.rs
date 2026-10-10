//! Best-effort client IP for audit rows.

use std::net::SocketAddr;

use axum::http::HeaderMap;

/// Best-effort client IP for audit logging (HTTP). Prefer `X-Forwarded-For` first hop,
/// then `X-Real-IP`, then the direct TCP peer when `connect` is provided.
pub fn client_ip_for_audit(headers: &HeaderMap, connect: Option<SocketAddr>) -> Option<String> {
    if let Some(ff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = ff.split(',').next() {
            let t = first.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    if let Some(x) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let t = x.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    connect.map(|a| a.ip().to_string())
}

pub fn audit_ip(headers: &HeaderMap, connect: SocketAddr) -> Option<String> {
    client_ip_for_audit(headers, Some(connect))
}
