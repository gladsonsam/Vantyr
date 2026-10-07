//! OIDC login redirect and callback: provisions or resolves the local user and issues a
//! dashboard session.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::anyhow;
use axum::response::Redirect;
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::auth::login::audit_auth_event;
use crate::auth::oidc;
use crate::auth::secrets;
use crate::auth::session_cookie::{cookie_clear, cookie_get, new_dashboard_csrf_token};
use crate::auth::users::db;
use crate::http::client_ip_for_audit;
use crate::state::AppState;

const OIDC_STATE_COOKIE: &str = "oidc_state";

const OIDC_NONCE_COOKIE: &str = "oidc_nonce";

const OIDC_RETURN_COOKIE: &str = "oidc_return_to";

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

/// `GET /api/auth/oidc/login` — redirect to the OIDC provider.
pub async fn oidc_login(
    State(app): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<OidcLoginQuery>,
) -> Response {
    let Some(cfg) = app.settings.oidc.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "OIDC not configured" })),
        )
            .into_response();
    };

    let provider_metadata = match oidc::discover_provider_metadata(cfg).await {
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
    // `window.location.href` navigations can't set headers, so prefer an explicit
    // `?return_to=` and fall back to the `X-Vantyr-Return-To` header (fetch flows).
    let return_to = q.return_to.as_deref().map_or_else(
        || {
            headers
                .get("x-vantyr-return-to")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("/")
                .to_string()
        },
        str::to_string,
    );
    let return_to = sanitize_return_to(return_to.trim()).to_string();

    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secure = forwarded_proto == "https" || app.settings.cookie_secure;

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
        urlencoding::encode(&return_to)
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
pub struct OidcLoginQuery {
    #[serde(default)]
    return_to: Option<String>,
}

#[derive(Deserialize)]
pub struct OidcCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
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

    let Some(cfg) = state.settings.oidc.as_ref() else {
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
    let secure = forwarded_proto == "https" || state.settings.cookie_secure;

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

    let provider_metadata = match oidc::discover_provider_metadata(cfg).await {
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
        .request_async(&crate::auth::oidc::http_client::async_http_client)
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

    let role = map_role_from_groups(cfg, &groups);

    // Find or create the local dashboard user row.
    let user_id = match db::dashboard_identity_get_user_id(&state.db, &issuer, &subject).await {
        Ok(Some(uid)) => uid,
        Ok(None) => {
            // Gate first-time provisioning behind the group allowlist (if configured).
            if !oidc_provisioning_allowed(cfg, &groups) {
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
    let token_hash = secrets::sha256_hex_bytes(token_plain.as_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;

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
            auto_login: false,
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
