//! Dashboard WebSockets: the viewer event/control socket and the interactive terminal.

use std::sync::Arc;

use axum::{routing::get, Router};

use crate::state::AppState;

pub mod capabilities;
mod command_shape;
pub mod terminal_ws;
pub mod ws;

/// Authenticated WebSocket upgrades (mounted beside `/api`, behind `require_auth`).
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/ws/view", get(ws::handler))
        .route("/ws/terminal", get(terminal_ws::handler))
}
