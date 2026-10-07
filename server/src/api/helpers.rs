//! Small helpers shared across `api` submodules.

use std::net::SocketAddr;

use axum::http::HeaderMap;

use crate::auth;

pub fn audit_ip(headers: &HeaderMap, connect: SocketAddr) -> Option<String> {
    auth::client_ip_for_audit(headers, Some(connect))
}
