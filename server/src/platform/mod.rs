//! Cross-cutting platform services: audit log, retention, storage accounting, version
//! info, cached assets, the agent local-UI password, web push, metrics, and mDNS.

use std::sync::Arc;

use axum::{routing::get, Router};

use crate::state::AppState;

mod assets;
pub mod audit;
mod capabilities;
pub mod local_ui;
pub mod mdns;
pub mod metrics;
pub mod push;
pub mod retention;
pub mod storage;
mod version;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/agents/:id/app-icons/:exe_name",
            get(assets::agent_app_icon),
        )
        .route(
            "/settings/capabilities",
            get(capabilities::settings_capabilities),
        )
        .route("/settings/version", get(version::settings_version))
        .merge(audit::routes())
        .merge(local_ui::routes())
        .merge(push::routes())
        .merge(retention::routes())
        .merge(storage::routes())
}
