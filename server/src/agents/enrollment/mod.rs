//! Agent enrollment: dashboard-issued pairing codes, the public claim endpoints agents call,
//! and admin approval of pending claims.

use std::sync::Arc;

use axum::{
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;
use crate::state::PendingEnrollmentToken;
use uuid::Uuid;

mod api;
pub mod db;
mod public_http;
mod service;

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

impl AppState {
    /// Bound enrollment rotates the credential. Keep approval and token publication
    /// under the same gate as final socket registration and administrative removal.
    pub async fn approve_agent_enrollment_claim(
        &self,
        claim_id: Uuid,
        approved_by: &str,
        agent_name: Option<&str>,
        group_id: Option<Uuid>,
    ) -> anyhow::Result<Result<(Uuid, String, String), db::claims::ClaimApproveReject>> {
        let bound = db::claims::enrollment_claim_bound_agent_id(&self.db, claim_id).await?;
        let _lifecycle = match bound {
            Some(id) => Some(self.agents.lifecycle.for_agent(id).write_owned().await),
            None => None,
        };
        if let Some(id) = bound {
            // Another approval/removal may have completed while we waited.
            // A duplicate or stale claim must not kick off the new installation.
            if db::claims::enrollment_claim_bound_agent_id(&self.db, claim_id).await? != Some(id) {
                return Ok(Err(db::claims::ClaimApproveReject::NotPending));
            }
            self.invalidate_agent_connection(id, "agent_credentials_revoked")
                .await;
        }
        let outcome = service::approve_claim_with_binding(
            &self.db,
            claim_id,
            approved_by,
            agent_name,
            group_id,
            bound,
        )
        .await?;
        if let Ok((agent_id, token, name)) = &outcome {
            self.agents.pending_enrollment_tokens.lock().insert(
                claim_id,
                PendingEnrollmentToken {
                    agent_id: *agent_id,
                    agent_name: name.clone(),
                    agent_token: token.clone(),
                },
            );
        }
        Ok(outcome)
    }
}
