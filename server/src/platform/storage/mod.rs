//! Database storage usage for the settings page.

use std::sync::Arc;

use axum::{extract::State, routing::get, Json, Router};

use crate::error::ApiResult;
use crate::state::AppState;

pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/settings/storage", get(storage_usage))
}

pub async fn storage_usage(State(s): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(db::query_database_storage(&s.db).await?))
}
