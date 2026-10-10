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

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

mod lockout;
mod login;
pub mod middleware;
pub mod oidc;
pub mod secrets;
mod session_cookie;
pub mod twofa;
pub mod users;

pub use middleware::require_auth;
pub use session_cookie::extract_session;

/// Unauthenticated session endpoints: login/logout, status, and the OIDC round-trip.
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/login", post(login::login))
        .route("/api/logout", post(login::logout))
        .route("/api/auth/status", get(login::status))
        .route("/api/auth/config", get(login::config))
        .route("/api/auth/oidc/login", get(oidc::handlers::oidc_login))
        .route(
            "/api/auth/oidc/callback",
            get(oidc::handlers::oidc_callback),
        )
}

/// Authenticated `/api` routes owned by auth: `/me`, user accounts, and 2FA.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new().merge(users::routes()).merge(twofa::routes())
}
