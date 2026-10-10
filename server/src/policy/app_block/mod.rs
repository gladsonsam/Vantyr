//! App blocking rules: CRUD, scopes/schedules, effective rules per agent, and block events.

use std::sync::Arc;

use axum::{
    routing::{get, put},
    Router,
};

use crate::state::AppState;

mod api;
pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/app-block-rules",
            get(api::app_block_rules_list).post(api::app_block_rules_create),
        )
        .route(
            "/app-block-rules/:id",
            put(api::app_block_rules_update).delete(api::app_block_rules_delete),
        )
        .route("/app-block-rules/protected", get(api::protected_exes_list))
        .route(
            "/app-block-rules/:id/events",
            get(api::rule_app_block_events),
        )
        .route("/app-block-events", get(api::all_app_block_events))
        .route(
            "/agents/:id/app-block-events",
            get(api::agent_app_block_events),
        )
        .route(
            "/agents/:id/effective-rules",
            get(api::agent_effective_rules),
        )
        .route("/agents/:id/known-exes", get(api::agent_known_exes))
}
