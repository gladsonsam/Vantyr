//! Agents: the device directory and everything administered per device.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod groups;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().merge(groups::routes())
}
