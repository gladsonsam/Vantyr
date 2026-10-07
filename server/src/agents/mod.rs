//! Agents: the device directory and everything administered per device.

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

pub mod db;
pub mod enrollment;
pub mod groups;
pub mod lifecycle;
mod list;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents", get(list::list_agents))
        .route("/agents/overview", get(list::list_agents_overview))
        .route(
            "/agents/:id/revoke-credentials",
            post(lifecycle::revoke_agent_credentials),
        )
        .route("/agents/delete", post(lifecycle::delete_agents_bulk))
        .route(
            "/agents/:id/icon",
            get(list::agent_icon_get).put(list::agent_icon_put),
        )
        .route("/agent-sessions", get(list::agent_sessions_all))
        .merge(enrollment::routes())
        .merge(groups::routes())
}
