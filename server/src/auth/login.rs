//! Local username/password login, logout, and session status endpoints.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tracing::{info, warn};

use super::lockout::{
    clear_login_failures_both, login_client_key, login_locked_retry_after, login_username_key,
    record_login_failure_both, MAX_LOGIN_FAILURES_PER_WINDOW,
};
use super::session_cookie::{extract_session, new_dashboard_csrf_token};
use crate::auth::secrets;
use crate::auth::users::db;
use crate::http::client_ip_for_audit;
use crate::platform::audit;
use crate::state::AppState;

/// Stored in `audit_log.actor` for dashboard authentication events (login, logout, lockouts).
const AUTH_AUDIT_ACTOR: &str = "auth";

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
    /// Optional second factor (6-digit TOTP or a recovery code).
    #[serde(default)]
    totp_code: Option<String>,
}

pub(super) async fn audit_auth_event(
    state: &AppState,
    action: &str,
    status: &str,
    detail: serde_json::Value,
    client_ip: Option<&str>,
) {
    if let Err(e) = audit::insert_audit_log(
        &state.db,
        AUTH_AUDIT_ACTOR,
        None,
        action,
        status,
        &detail,
        client_ip,
    )
    .await
    {
        tracing::warn!(error = %e, action, "failed to write auth audit row");
    }
}

fn too_many_login_attempts_response(retry_secs: u64) -> Response {
    warn!(retry_secs, "login rate limited");
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({
            "error": "Too many login attempts. Try again later.",
            "attempts_remaining": 0u64,
            "max_attempts_per_window": MAX_LOGIN_FAILURES_PER_WINDOW,
            "retry_after_secs": retry_secs,
        })),
    )
        .into_response();
    if let Ok(hv) = HeaderValue::from_str(&retry_secs.to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, hv);
    }
    res
}

/// `POST /api/login` — validate password and issue a session cookie.
pub async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Response {
    let client_ip = client_ip_for_audit(&headers, Some(addr));
    let ip_ref = client_ip.as_deref();

    let key = login_client_key(&state, &headers, addr);
    let user_key = login_username_key(&body.username);
    if let Some(retry) = login_locked_retry_after(&state, &key, &user_key) {
        audit_auth_event(
            &state,
            "login_rate_limited",
            "rejected",
            serde_json::json!({
                "retry_after_secs": retry,
                "reason": "too_many_failures_in_window",
            }),
            ip_ref,
        )
        .await;
        return too_many_login_attempts_response(retry);
    }

    let user_row = match db::dashboard_user_get_by_username(&state.db, body.username.trim()).await {
        Ok(v) => v,
        Err(e) => return crate::error::internal_error(e),
    };
    let Some((user_id, password_hash, _role)) = user_row else {
        // Avoid disclosing whether a username exists.
        return match record_login_failure_both(&state, &key, &user_key) {
            Err(retry) => {
                audit_auth_event(
                    &state,
                    "login_rate_limited",
                    "rejected",
                    serde_json::json!({
                        "retry_after_secs": retry,
                        "reason": "wrong_password_threshold",
                    }),
                    ip_ref,
                )
                .await;
                too_many_login_attempts_response(retry)
            }
            Ok(attempts_remaining) => {
                audit_auth_event(
                    &state,
                    "login_failed",
                    "error",
                    serde_json::json!({
                        "attempts_remaining": attempts_remaining,
                        "max_attempts_per_window": MAX_LOGIN_FAILURES_PER_WINDOW,
                    }),
                    ip_ref,
                )
                .await;
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "Invalid credentials",
                        "attempts_remaining": attempts_remaining,
                        "max_attempts_per_window": MAX_LOGIN_FAILURES_PER_WINDOW,
                    })),
                )
                    .into_response()
            }
        };
    };

    if !secrets::verify_dashboard_password(&password_hash, &body.password) {
        match record_login_failure_both(&state, &key, &user_key) {
            Err(retry) => {
                audit_auth_event(
                    &state,
                    "login_rate_limited",
                    "rejected",
                    serde_json::json!({
                        "retry_after_secs": retry,
                        "reason": "wrong_password_threshold",
                    }),
                    ip_ref,
                )
                .await;
                return too_many_login_attempts_response(retry);
            }
            Ok(attempts_remaining) => {
                audit_auth_event(
                    &state,
                    "login_failed",
                    "error",
                    serde_json::json!({
                        "attempts_remaining": attempts_remaining,
                        "max_attempts_per_window": MAX_LOGIN_FAILURES_PER_WINDOW,
                    }),
                    ip_ref,
                )
                .await;
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "Invalid credentials",
                        "attempts_remaining": attempts_remaining,
                        "max_attempts_per_window": MAX_LOGIN_FAILURES_PER_WINDOW,
                    })),
                )
                    .into_response();
            }
        }
    }

    // Second factor (TOTP), if this user has enabled it. The password was
    // already verified above; we only gate the session on the 2FA code here.
    {
        let (totp_secret, totp_enabled) =
            match db::dashboard_user_totp_get(&state.db, user_id).await {
                Ok(v) => v,
                Err(e) => return crate::error::internal_error(e),
            };
        if totp_enabled {
            let code = body
                .totp_code
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if code.is_empty() {
                // Correct password, but a code is required to finish signing in.
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "Two-factor authentication code required",
                        "totp_required": true,
                    })),
                )
                    .into_response();
            }
            let totp_ok = totp_secret
                .as_deref()
                .is_some_and(|secret| crate::auth::twofa::verify(secret, &code))
                || db::dashboard_recovery_code_consume(&state.db, user_id, &code)
                    .await
                    .unwrap_or(false);
            if !totp_ok {
                audit_auth_event(
                    &state,
                    "login_2fa_failed",
                    "error",
                    serde_json::json!({ "username": body.username.trim() }),
                    ip_ref,
                )
                .await;
                let _ = record_login_failure_both(&state, &key, &user_key);
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({
                        "error": "Invalid two-factor code",
                        "totp_required": true,
                    })),
                )
                    .into_response();
            }
        }
    }

    clear_login_failures_both(&state, &key, &user_key);

    // New random session token; store only its hash in the DB.
    let token = uuid::Uuid::new_v4().to_string();
    let token_hash = secrets::sha256_hex_bytes(token.as_bytes());
    let csrf_token = new_dashboard_csrf_token();
    let expires_at = chrono::Utc::now() + chrono::Duration::days(1);
    if let Err(e) = db::dashboard_session_create(
        &state.db,
        &token_hash,
        user_id,
        expires_at,
        ip_ref,
        &csrf_token,
    )
    .await
    {
        return crate::error::internal_error(e);
    }

    info!("New dashboard session created.");
    audit_auth_event(
        &state,
        "login_success",
        "ok",
        serde_json::json!({ "username": body.username.trim() }),
        ip_ref,
    )
    .await;

    // Auto-detect HTTPS from Traefik's X-Forwarded-Proto header, or fall back
    // to the COOKIE_SECURE setting. This ensures the Secure cookie attribute
    // is set automatically when running behind a TLS-terminating reverse proxy.
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https" || state.settings.cookie_secure;

    // Use SameSite=None when Secure is set so the cookie is sent on
    // non-top-level requests (including WebSocket upgrades) in more
    // deployment/proxy scenarios.
    let cookie = if secure {
        format!("session={token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=86400",)
    } else {
        format!("session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400",)
    };

    (
        [(
            header::SET_COOKIE,
            HeaderValue::from_str(&cookie).unwrap_or_else(|_| HeaderValue::from_static("")),
        )],
        Json(serde_json::json!({ "ok": true, "csrf_token": csrf_token })),
    )
        .into_response()
}

/// `POST /api/logout` — revoke the current session cookie.
pub async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let client_ip = client_ip_for_audit(&headers, Some(addr));
    let ip_ref = client_ip.as_deref();

    if let Some(t) = extract_session(&headers) {
        let token_hash = secrets::sha256_hex_bytes(t.as_bytes());
        let _ = db::dashboard_session_delete(&state.db, &token_hash).await;
        info!("Dashboard session revoked.");
        audit_auth_event(&state, "logout", "ok", serde_json::json!({}), ip_ref).await;
    }

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https" || state.settings.cookie_secure;

    let clear = if secure {
        "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"
    } else {
        "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    };
    (
        [(header::SET_COOKIE, HeaderValue::from_static(clear))],
        StatusCode::OK,
    )
        .into_response()
}

/// `GET /api/auth/status` — let the SPA check whether it is already authenticated.
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if cfg!(debug_assertions) && state.settings.allow_insecure_dashboard_open {
        if let Ok(n) = db::dashboard_user_count(&state.db).await {
            if n == 0 {
                return Json(serde_json::json!({
                    "authenticated":     true,
                    "password_required": false,
                }))
                .into_response();
            }
        }
    }

    let authenticated = match extract_session(&headers) {
        Some(t) => {
            let token_hash = secrets::sha256_hex_bytes(t.as_bytes());
            db::dashboard_session_get_user(&state.db, &token_hash)
                .await
                .ok()
                .flatten()
                .is_some()
        }
        None => false,
    };

    let status_code = if authenticated {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    };

    (
        status_code,
        Json(serde_json::json!({
            "authenticated":     authenticated,
            "password_required": true,
        })),
    )
        .into_response()
}

/// `GET /api/auth/config` — lets the SPA decide whether to show OIDC/local login.
pub async fn config(State(state): State<Arc<AppState>>) -> Response {
    let cfg = state.settings.oidc.as_ref();
    let oidc_enabled = cfg.is_some();
    let oidc_auto_login = cfg.is_some_and(|c| c.auto_login);
    Json(serde_json::json!({
        "oidc_enabled": oidc_enabled,
        "oidc_auto_login": oidc_auto_login,
        "local_enabled": true
    }))
    .into_response()
}
