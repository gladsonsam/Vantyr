//! Internet blocking rules (all / group / agent scope) and per-agent overrides.

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
            "/agents/:id/internet-blocked",
            get(api::agent_internet_blocked_get).put(api::agent_internet_blocked_put),
        )
        .route(
            "/internet-block-rules",
            get(api::internet_block_rules_list).post(api::internet_block_rules_create),
        )
        .route(
            "/internet-block-rules/:id",
            put(api::internet_block_rules_update).delete(api::internet_block_rules_delete),
        )
}
