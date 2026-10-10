//! Web activity: URL visits, time-on-site sessions, and URL categorization.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod db;
pub mod ingest;
pub mod url_categorization;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().merge(url_categorization::routes())
}
