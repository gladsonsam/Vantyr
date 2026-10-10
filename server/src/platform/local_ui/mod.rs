//! Windows agent local settings-window password policy.

use std::sync::Arc;

use axum::{routing::get, Router};

use crate::state::AppState;

mod api;
pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/settings/local-ui-password",
            get(api::local_ui_password_global_get).put(api::local_ui_password_global_put),
        )
        .route(
            "/agents/:id/local-ui-password",
            get(api::local_ui_password_agent_get)
                .put(api::local_ui_password_agent_put)
                .delete(api::local_ui_password_agent_delete),
        )
}
