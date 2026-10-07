//! Agent enrollment: dashboard-issued pairing codes, the public claim endpoints agents call,
//! and admin approval of pending claims.

use std::sync::Arc;

use axum::{
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;

mod api;
pub mod db;
mod public_http;

/// Admin settings routes under `/api`.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/settings/agent-enrollment-tokens",
            get(api::list_enrollment_tokens).post(api::create_enrollment_token),
        )
        .route(
            "/settings/agent-enrollment-tokens/:id",
            delete(api::revoke_enrollment_token),
        )
        .route(
            "/settings/agent-enrollment-tokens/revoke-all",
            post(api::revoke_all_enrollment_tokens),
        )
        .route(
            "/settings/agent-enrollment-tokens/:id/uses",
            get(api::list_enrollment_token_uses),
        )
        .route(
            "/settings/agent-enrollment-claims",
            get(api::list_enrollment_claims),
        )
        .route(
            "/settings/agent-enrollment-claims/:id/approve",
            post(api::approve_enrollment_claim),
        )
        .route(
            "/settings/agent-enrollment-claims/:id/reject",
            post(api::reject_enrollment_claim),
        )
        .route(
            "/settings/agent-setup-hints",
            get(api::get_agent_setup_hints),
        )
}

/// Unauthenticated claim endpoints called by agents (rate limited in `app.rs`).
pub fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/agent/enroll", post(public_http::agent_enroll_handler))
        .route(
            "/api/agent/enrollment/claims",
            post(public_http::create_enrollment_claim),
        )
        .route(
            "/api/agent/enrollment/claims/:id",
            get(public_http::poll_enrollment_claim),
        )
}
