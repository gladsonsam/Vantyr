//! `require_auth`: resolves the session cookie to an [`AuthUser`] and enforces CSRF on
//! mutating requests.

use std::sync::Arc;

use anyhow::anyhow;
use axum::{
    extract::{Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};

use super::session_cookie::{csrf_header_matches, extract_session};
use crate::auth::secrets;
use crate::auth::users::db;
use crate::http::AuthUser;
use crate::state::AppState;

const CSRF_HEADER: &str = "x-csrf-token";

const fn request_requires_csrf_token(method: &Method) -> bool {
    matches!(
        method,
        &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE
    )
}

/// Axum middleware: rejects requests without a valid session cookie.
/// Passes through unconditionally when no `UI_PASSWORD` is configured.
pub async fn require_auth(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    // Optional insecure mode: allow requests through when there are no users yet.
    // (Normal deployments should bootstrap an admin user via ADMIN_PASSWORD/UI_PASSWORD.)
    if cfg!(debug_assertions) && state.settings.allow_insecure_dashboard_open {
        if let Ok(n) = db::users::dashboard_user_count(&state.db).await {
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

    let token_hash = secrets::sha256_hex_bytes(token.as_bytes());
    let user = match db::sessions::dashboard_session_get_user(&state.db, &token_hash).await {
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
    let _ = db::sessions::dashboard_session_touch(&state.db, &token_hash).await;

    req.extensions_mut().insert(user);
    next.run(req).await
}
