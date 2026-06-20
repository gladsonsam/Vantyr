//! HTTP authentication for the dashboard UI.
//!
//! Multi-user dashboard authentication (DB-backed users + sessions).
//!
//! ## Session lifecycle
//!
//! 1. `POST /api/login` with `{"username":"…","password":"…"}` → server validates
//!    and stores only a SHA-256 hash of a random token in Postgres, then sets
//!    an `HttpOnly` cookie `session=<token>`.
//! 2. Every protected request checks the cookie token hash against the DB and
//!    injects the current user into request extensions.
//! 3. `POST /api/logout` deletes the DB session and clears the cookie.
//! 4. Mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) on protected routes require
//!    header `X-CSRF-Token` matching the per-session value stored in Postgres (also
//!    returned in `POST /api/login` and `GET /api/me`). WebSocket upgrades stay `GET`-only.

use std::sync::Arc;
use std::time::{Duration, Instant};

use std::net::SocketAddr;

use anyhow::anyhow;
use axum::response::Redirect;
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rand::RngCore;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tracing::{info, warn};

use crate::db;
use crate::oidc;
use crate::state::AppState;

/// Stored in `audit_log.actor` for dashboard authentication events (login, logout, lockouts).
const AUTH_AUDIT_ACTOR: &str = "auth";

/// Drop failures older than this; max failures within the window triggers 429 on `/api/login`.
const LOGIN_FAIL_WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_LOGIN_FAILURES_PER_WINDOW: usize = 10;

const OIDC_STATE_COOKIE: &str = "oidc_state";
const OIDC_NONCE_COOKIE: &str = "oidc_nonce";
const OIDC_RETURN_COOKIE: &str = "oidc_return_to";

const CSRF_HEADER: &str = "x-csrf-token";

fn new_dashboard_csrf_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn csrf_header_matches(expected: &str, supplied: Option<&str>) -> bool {
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

const fn request_requires_csrf_token(method: &Method) -> bool {
    matches!(
        method,
        &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE
    )
}

fn sanitize_return_to(raw: &str) -> &str {
    let t = raw.trim();
    if t.is_empty() {
        return "/";
    }
    // Only allow relative paths to avoid open-redirects.
    // Reject protocol-relative URLs and anything containing a scheme.
    if !t.starts_with('/') || t.starts_with("//") || t.contains("://") {
        return "/";
    }
    // Keep it simple: don't allow control chars.
    if t.chars().any(char::is_control) {
        return "/";
    }
    t
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/// Axum middleware: rejects requests without a valid session cookie.
/// Passes through unconditionally when no `UI_PASSWORD` is configured.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    // Optional insecure mode: allow requests through when there are no users yet.
    // (Normal deployments should bootstrap an admin user via ADMIN_PASSWORD/UI_PASSWORD.)
    if cfg!(debug_assertions) && state.allow_insecure_dashboard_open {
        if let Ok(n) = db::dashboard_user_count(&state.db).await {
            if n == 0 {
                return next.run(req).await;
            }
        }
    }

    let mut req = req;
    let extracted_session = extract_session(req.headers());
    let Some(token) = extracted_session else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response();
    };

    let token_hash = db::sha256_hex_bytes(token.as_bytes());
    let user = match db::dashboard_session_get_user(&state.db, &token_hash).await {
        Ok(Some((user_id, username, role, display_name, display_icon, csrf_token))) => {
            if request_requires_csrf_token(req.method()) {
                let supplied = req.headers().get(CSRF_HEADER).and_then(|v| v.to_str().ok());
                if !csrf_header_matches(&csrf_token, supplied) {
                    return (
                        StatusCode::FORBIDDEN,
                        Json(serde_json::json!({
                            "error": "CSRF token missing or invalid"
                        })),
                    )
                        .into_response();
                }
            }
            AuthUser {
                user_id,
                username,
                role,
                display_name,
                display_icon,
                csrf_token,
            }
        }
        Ok(None) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Unauthorized" })),
            )
                .into_response()
        }
        Err(_) => {
            return crate::error::internal_error(anyhow!("Session store unavailable"));
        }
    };

    // Best-effort session activity touch.
    let _ = db::dashboard_session_touch(&state.db, &token_hash).await;

    req.extensions_mut().insert(user);
    next.run(req).await
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
    /// Optional second factor (6-digit TOTP or a recovery code).
    #[serde(default)]
    totp_code: Option<String>,
}

/// Rate-limit/lockout key for a login attempt. Unlike [`client_ip_for_audit`], this only honors
/// forwarding headers when the direct peer is a trusted proxy, so spoofed `X-Forwarded-For`
/// can't rotate the key to dodge brute-force protection.
fn login_client_key(state: &AppState, headers: &HeaderMap, addr: SocketAddr) -> String {
    state.trusted_proxies.client_ip(headers, addr).to_string()
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
    lockout_retry_after(&mut state.login_failures.lock(), key, Instant::now())
}

/// Records a failed login. Returns `Ok(attempts_remaining)` (wrong tries left before lockout), or
/// `Err(retry_secs)` when this attempt triggered the limit.
fn record_login_failure(state: &AppState, key: &str) -> Result<u64, u64> {
    lockout_record(&mut state.login_failures.lock(), key, Instant::now())
}

fn clear_login_failures(state: &AppState, key: &str) {
    state.login_failures.lock().remove(key);
}

/// Lockout bucket keyed by account, so rotating the source IP (or a spoofed `X-Forwarded-For`)
/// can't sidestep the per-username limit. The `user:` prefix can't collide with an IP key.
fn login_username_key(username: &str) -> String {
    format!("user:{}", username.trim().to_lowercase())
}

/// Combined per-IP + per-username lockout check. Returns the longest retry-after if either bucket
/// is currently locked.
fn login_locked_retry_after(state: &AppState, ip_key: &str, user_key: &str) -> Option<u64> {
    let ip = login_rate_retry_after(state, ip_key);
    let user = login_rate_retry_after(state, user_key);
    ip.into_iter().chain(user).max()
}

/// Records a failure against both the IP and username buckets. Returns `Ok(min remaining)` or
/// `Err(retry_secs)` when either bucket tripped the limit.
fn record_login_failure_both(state: &AppState, ip_key: &str, user_key: &str) -> Result<u64, u64> {
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

fn clear_login_failures_both(state: &AppState, ip_key: &str, user_key: &str) {
    clear_login_failures(state, ip_key);
    clear_login_failures(state, user_key);
}

async fn audit_auth_event(
    state: &AppState,
    action: &str,
    status: &str,
    detail: serde_json::Value,
    client_ip: Option<&str>,
) {
    if let Err(e) = db::insert_audit_log(
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

    if !db::verify_dashboard_password(&password_hash, &body.password) {
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
                .is_some_and(|secret| crate::twofa::verify(secret, &code))
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
    let token_hash = db::sha256_hex_bytes(token.as_bytes());
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
    // to the COOKIE_SECURE env var. This ensures the Secure cookie attribute
    // is set automatically when running behind a TLS-terminating reverse proxy.
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https"
        || std::env::var("COOKIE_SECURE")
            .ok()
            .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"));

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
        let token_hash = db::sha256_hex_bytes(t.as_bytes());
        let _ = db::dashboard_session_delete(&state.db, &token_hash).await;
        info!("Dashboard session revoked.");
        audit_auth_event(&state, "logout", "ok", serde_json::json!({}), ip_ref).await;
    }

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https"
        || std::env::var("COOKIE_SECURE")
            .ok()
            .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"));

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
    if cfg!(debug_assertions) && state.allow_insecure_dashboard_open {
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
            let token_hash = db::sha256_hex_bytes(t.as_bytes());
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
pub async fn config() -> Response {
    let oidc_enabled = oidc::OidcConfig::from_env().is_some();
    Json(serde_json::json!({
        "oidc_enabled": oidc_enabled,
        "local_enabled": true
    }))
    .into_response()
}

/// `GET /api/auth/oidc/login` — redirect to the OIDC provider.
pub async fn oidc_login(headers: HeaderMap) -> Response {
    let Some(cfg) = oidc::OidcConfig::from_env() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "OIDC not configured" })),
        )
            .into_response();
    };

    let provider_metadata = match oidc::discover_provider_metadata(&cfg).await {
        Ok(m) => m,
        Err(e) => return crate::error::internal_error(e),
    };
    let client = openidconnect::core::CoreClient::from_provider_metadata(
        provider_metadata,
        openidconnect::ClientId::new(cfg.client_id.clone()),
        Some(openidconnect::ClientSecret::new(cfg.client_secret.clone())),
    )
    .set_redirect_uri(
        openidconnect::RedirectUrl::new(cfg.redirect_url.clone()).unwrap_or_else(|_| {
            openidconnect::RedirectUrl::new("http://localhost".to_string())
                .unwrap_or_else(|e| panic!("invalid fallback url: {e}"))
        }),
    );

    let mut req = client.authorize_url(
        openidconnect::core::CoreAuthenticationFlow::AuthorizationCode,
        openidconnect::CsrfToken::new_random,
        openidconnect::Nonce::new_random,
    );
    for s in &cfg.scopes {
        req = req.add_scope(openidconnect::Scope::new(s.clone()));
    }
    let (url, state, nonce) = req.url();

    // Preserve SPA return path if provided (query param).
    let return_to = headers
        .get("x-vantyr-return-to")
        .and_then(|v| v.to_str().ok())
        .map_or("/", sanitize_return_to);

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https"
        || std::env::var("COOKIE_SECURE")
            .ok()
            .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"));

    let same_site = if secure {
        "SameSite=None; Secure"
    } else {
        "SameSite=Lax"
    };
    let c_state = format!(
        "{OIDC_STATE_COOKIE}={}; HttpOnly; {same_site}; Path=/; Max-Age=600",
        state.secret()
    );
    let c_nonce = format!(
        "{OIDC_NONCE_COOKIE}={}; HttpOnly; {same_site}; Path=/; Max-Age=600",
        nonce.secret()
    );
    let c_ret = format!(
        "{OIDC_RETURN_COOKIE}={}; HttpOnly; {same_site}; Path=/; Max-Age=600",
        urlencoding::encode(return_to)
    );

    let mut res = Redirect::to(url.as_str()).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&c_state).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&c_nonce).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&c_ret).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    res
}

#[derive(Deserialize)]
pub struct OidcCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn cookie_get(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_str = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_str.split(';') {
        let t = part.trim();
        if let Some(val) = t.strip_prefix(&format!("{name}=")) {
            return Some(val.to_string());
        }
    }
    None
}

fn cookie_clear(name: &str, secure: bool) -> HeaderValue {
    let samesite = if secure {
        "SameSite=None; Secure"
    } else {
        "SameSite=Lax"
    };
    HeaderValue::from_str(&format!("{name}=; HttpOnly; {samesite}; Path=/; Max-Age=0"))
        .unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// Whether an OIDC login is allowed to be provisioned into a local user. An empty allowlist means
/// open provisioning (current default); otherwise the token's groups must intersect the allowlist.
fn oidc_provisioning_allowed(cfg: &oidc::OidcConfig, groups: &[String]) -> bool {
    cfg.allowed_groups.is_empty()
        || cfg
            .allowed_groups
            .iter()
            .any(|allowed| groups.iter().any(|g| g == allowed))
}

fn map_role_from_groups(cfg: &oidc::OidcConfig, groups: &[String]) -> String {
    if let Some(ref g) = cfg.admin_group {
        if groups.iter().any(|x| x == g) {
            return "admin".to_string();
        }
    }
    if let Some(ref g) = cfg.operator_group {
        if groups.iter().any(|x| x == g) {
            return "operator".to_string();
        }
    }
    "viewer".to_string()
}

/// `GET /api/auth/oidc/callback` — exchanges code, validates ID token, creates a dashboard session.
pub async fn oidc_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    axum::extract::Query(q): axum::extract::Query<OidcCallbackQuery>,
) -> Response {
    let client_ip = client_ip_for_audit(&headers, Some(addr));
    let ip_ref = client_ip.as_deref();

    let Some(cfg) = oidc::OidcConfig::from_env() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "OIDC not configured" })),
        )
            .into_response();
    };

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https"
        || std::env::var("COOKIE_SECURE")
            .ok()
            .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"));

    // Always clear transient cookies.
    let clear_state = cookie_clear(OIDC_STATE_COOKIE, secure);
    let clear_nonce = cookie_clear(OIDC_NONCE_COOKIE, secure);
    let clear_ret = cookie_clear(OIDC_RETURN_COOKIE, secure);

    if let Some(err) = q.error {
        let mut res = (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": err,
                "error_description": q.error_description
            })),
        )
            .into_response();
        res.headers_mut().append(header::SET_COOKIE, clear_state);
        res.headers_mut().append(header::SET_COOKIE, clear_nonce);
        res.headers_mut().append(header::SET_COOKIE, clear_ret);
        return res;
    }

    let Some(code) = q.code else {
        let mut res = (StatusCode::BAD_REQUEST, "Missing code").into_response();
        res.headers_mut().append(header::SET_COOKIE, clear_state);
        res.headers_mut().append(header::SET_COOKIE, clear_nonce);
        res.headers_mut().append(header::SET_COOKIE, clear_ret);
        return res;
    };
    let Some(cb_state) = q.state else {
        let mut res = (StatusCode::BAD_REQUEST, "Missing state").into_response();
        res.headers_mut().append(header::SET_COOKIE, clear_state);
        res.headers_mut().append(header::SET_COOKIE, clear_nonce);
        res.headers_mut().append(header::SET_COOKIE, clear_ret);
        return res;
    };

    let expected_state = cookie_get(&headers, OIDC_STATE_COOKIE);
    let expected_nonce = cookie_get(&headers, OIDC_NONCE_COOKIE);
    let return_to = cookie_get(&headers, OIDC_RETURN_COOKIE)
        .and_then(|s| urlencoding::decode(&s).ok().map(|c| c.to_string()))
        .unwrap_or_else(|| "/".to_string());

    if expected_state.as_deref() != Some(cb_state.as_str()) {
        let mut res = (StatusCode::UNAUTHORIZED, "Invalid state").into_response();
        res.headers_mut().append(header::SET_COOKIE, clear_state);
        res.headers_mut().append(header::SET_COOKIE, clear_nonce);
        res.headers_mut().append(header::SET_COOKIE, clear_ret);
        return res;
    }
    let Some(nonce_str) = expected_nonce else {
        let mut res = (StatusCode::UNAUTHORIZED, "Missing nonce").into_response();
        res.headers_mut().append(header::SET_COOKIE, clear_state);
        res.headers_mut().append(header::SET_COOKIE, clear_nonce);
        res.headers_mut().append(header::SET_COOKIE, clear_ret);
        return res;
    };

    let provider_metadata = match oidc::discover_provider_metadata(&cfg).await {
        Ok(m) => m,
        Err(e) => return crate::error::internal_error(e),
    };
    let client = openidconnect::core::CoreClient::from_provider_metadata(
        provider_metadata,
        openidconnect::ClientId::new(cfg.client_id.clone()),
        Some(openidconnect::ClientSecret::new(cfg.client_secret.clone())),
    )
    .set_redirect_uri(
        openidconnect::RedirectUrl::new(cfg.redirect_url.clone()).unwrap_or_else(|_| {
            openidconnect::RedirectUrl::new("http://localhost".to_string())
                .unwrap_or_else(|e| panic!("invalid fallback url: {e}"))
        }),
    );

    let token_req = match client.exchange_code(openidconnect::AuthorizationCode::new(code)) {
        Ok(r) => r,
        Err(e) => {
            return crate::error::internal_error(anyhow!("OIDC token request build failed: {e}"))
        }
    };
    let token = match token_req
        .request_async(&crate::oidc_http::async_http_client)
        .await
    {
        Ok(t) => t,
        Err(e) => return crate::error::internal_error(anyhow!("OIDC token exchange failed: {e}")),
    };

    let id_token = match token.extra_fields().id_token() {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, "Missing id_token").into_response(),
    };

    let nonce = openidconnect::Nonce::new(nonce_str);
    let claims = match id_token.claims(&client.id_token_verifier(), &nonce) {
        Ok(c) => c,
        Err(e) => return crate::error::internal_error(anyhow!("ID token validation failed: {e}")),
    };

    let issuer = claims.issuer().url().to_string();
    let subject = claims.subject().as_str().to_string();
    let preferred_username = claims.preferred_username().map(|s| s.to_string());
    let email = claims.email().map(|e| e.as_str().to_string());
    let name = claims
        .name()
        .and_then(|n| n.get(None).map(|s| s.to_string()));

    // Authentik: groups often appear as a custom claim `groups` (array of strings).
    let mut groups: Vec<String> = Vec::new();
    if let Ok(val) = serde_json::to_value(claims) {
        if let Some(arr) = val.get("groups").and_then(|v| v.as_array()) {
            for it in arr {
                if let Some(s) = it.as_str() {
                    groups.push(s.to_string());
                }
            }
        }
    }

    let role = map_role_from_groups(&cfg, &groups);

    // Find or create the local dashboard user row.
    let user_id = match db::dashboard_identity_get_user_id(&state.db, &issuer, &subject).await {
        Ok(Some(uid)) => uid,
        Ok(None) => {
            // Gate first-time provisioning behind the group allowlist (if configured).
            if !oidc_provisioning_allowed(&cfg, &groups) {
                audit_auth_event(
                    &state,
                    "oidc_provisioning_denied",
                    "rejected",
                    serde_json::json!({ "reason": "not_in_allowed_groups" }),
                    ip_ref,
                )
                .await;
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "error": "Your account is not authorized to access this dashboard."
                    })),
                )
                    .into_response();
            }
            // Create a local user record (password hash is required but unused for OIDC users).
            // We generate a random password so local login is effectively disabled unless reset by an admin.
            let uname = preferred_username
                .clone()
                .or(email.clone())
                .unwrap_or_else(|| format!("oidc-{}", &subject[..subject.len().min(12)]));
            let random_pw = uuid::Uuid::new_v4().to_string();
            let dname = name.clone().unwrap_or_default();
            match db::dashboard_user_create(&state.db, &uname, &random_pw, &role, dname.trim())
                .await
            {
                Ok(uid) => uid,
                Err(e) => return crate::error::internal_error(e),
            }
        }
        Err(e) => return crate::error::internal_error(e),
    };

    // IMPORTANT: do not overwrite roles on every login.
    // Roles are assigned on first provision; afterwards admins can manage roles
    // in-app without OIDC groups forcing them back to viewer/operator.

    let _ = db::dashboard_identity_upsert(
        &state.db,
        &issuer,
        &subject,
        user_id,
        preferred_username.as_deref(),
        email.as_deref(),
        name.as_deref(),
    )
    .await;

    // Create a dashboard session cookie like local login.
    let token_plain = uuid::Uuid::new_v4().to_string();
    let token_hash = db::sha256_hex_bytes(token_plain.as_bytes());
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

    audit_auth_event(
        &state,
        "oidc_login_success",
        "ok",
        serde_json::json!({ "issuer": issuer, "subject": subject, "role": role }),
        ip_ref,
    )
    .await;

    let same_site = if secure {
        "SameSite=None; Secure"
    } else {
        "SameSite=Lax"
    };
    let session_cookie =
        format!("session={token_plain}; HttpOnly; {same_site}; Path=/; Max-Age=86400");

    let mut res = Redirect::to(&return_to).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&session_cookie).unwrap_or_else(|_| HeaderValue::from_static("")),
    );
    res.headers_mut().append(header::SET_COOKIE, clear_state);
    res.headers_mut().append(header::SET_COOKIE, clear_nonce);
    res.headers_mut().append(header::SET_COOKIE, clear_ret);
    res
}

// ─── Request extensions ──────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_id: uuid::Uuid,
    pub username: String,
    pub role: String, // 'admin' | 'operator' | 'viewer'
    /// Optional full name shown in the UI; sign-in uses `username`.
    pub display_name: String,
    /// Optional avatar glyph (e.g. emoji) for the dashboard UI.
    pub display_icon: Option<String>,
    /// Per-session secret; sent to the SPA for `X-CSRF-Token` on mutating requests.
    pub csrf_token: String,
}

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
    pub fn is_operator(&self) -> bool {
        self.role == "operator" || self.role == "admin"
    }
}

// ─── Cookie helper ────────────────────────────────────────────────────────────

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

fn extract_session(headers: &HeaderMap) -> Option<String> {
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

    #[test]
    fn csrf_compare_matches_only_exact() {
        assert!(csrf_header_matches("abc123", Some("abc123")));
        assert!(!csrf_header_matches("abc123", Some("abc124")));
        assert!(!csrf_header_matches("abc123", Some("abc12")));
        assert!(!csrf_header_matches("abc123", None));
    }

    fn oidc_cfg(admin: Option<&str>, operator: Option<&str>, allowed: &[&str]) -> oidc::OidcConfig {
        oidc::OidcConfig {
            issuer_url: "https://idp.example".into(),
            client_id: "id".into(),
            client_secret: "secret".into(),
            redirect_url: "https://app.example/cb".into(),
            scopes: vec!["openid".into()],
            admin_group: admin.map(str::to_string),
            operator_group: operator.map(str::to_string),
            allowed_groups: allowed.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn role_mapping_prefers_admin_then_operator() {
        let cfg = oidc_cfg(Some("admins"), Some("ops"), &[]);
        assert_eq!(
            map_role_from_groups(&cfg, &["admins".into(), "ops".into()]),
            "admin"
        );
        assert_eq!(map_role_from_groups(&cfg, &["ops".into()]), "operator");
        assert_eq!(map_role_from_groups(&cfg, &["other".into()]), "viewer");
    }

    #[test]
    fn provisioning_gate_respects_allowlist() {
        // Empty allowlist = open provisioning.
        let open = oidc_cfg(None, None, &[]);
        assert!(oidc_provisioning_allowed(&open, &[]));
        // Configured allowlist requires intersection.
        let gated = oidc_cfg(None, None, &["staff", "contractors"]);
        assert!(oidc_provisioning_allowed(&gated, &["staff".into()]));
        assert!(!oidc_provisioning_allowed(&gated, &["randoms".into()]));
        assert!(!oidc_provisioning_allowed(&gated, &[]));
    }

    #[test]
    fn sanitize_return_to_blocks_open_redirects() {
        assert_eq!(sanitize_return_to("/agents"), "/agents");
        assert_eq!(sanitize_return_to(""), "/");
        assert_eq!(sanitize_return_to("//evil.com"), "/");
        assert_eq!(sanitize_return_to("https://evil.com"), "/");
        assert_eq!(sanitize_return_to("javascript://x"), "/");
        assert_eq!(sanitize_return_to("not-relative"), "/");
    }
}
