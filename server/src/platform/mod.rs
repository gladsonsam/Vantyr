//! Cross-cutting platform services: audit log, retention, storage, version, assets,
//! local-UI password, web push, metrics, and mDNS.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod audit;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().merge(audit::routes())
}
