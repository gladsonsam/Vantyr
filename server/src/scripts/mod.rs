//! Remote scripts: ad-hoc and bulk runs, scheduled scripts and their scheduler, and the
//! installed-software inventory.

use std::sync::Arc;

use axum::{
    routing::{get, post, put},
    Router,
};

use crate::state::AppState;

pub mod dispatch;
pub mod remote_api;
pub mod scheduled;
pub mod scheduler;
pub mod software_inventory;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents/bulk-script", post(remote_api::agents_bulk_script))
        .route(
            "/agents/:id/software",
            get(software_inventory::api::agent_software_list),
        )
        .route(
            "/agents/:id/software/collect",
            post(software_inventory::api::agent_software_collect),
        )
        .route("/agents/:id/script", post(remote_api::agent_run_script))
        .route(
            "/scheduled-scripts",
            get(scheduled::api::list_scripts).post(scheduled::api::create_script),
        )
        .route(
            "/scheduled-scripts/:id",
            put(scheduled::api::update_script).delete(scheduled::api::delete_script),
        )
        .route(
            "/scheduled-scripts/:id/events",
            get(scheduled::api::events_for_script),
        )
        .route(
            "/scheduled-scripts/:id/trigger",
            post(scheduled::api::trigger_script),
        )
        .route("/scheduled-script-events", get(scheduled::api::events_all))
}
