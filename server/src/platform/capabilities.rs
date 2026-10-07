//! Server capability flags the dashboard uses to show or hide features.

use std::sync::Arc;

use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};

use crate::state::AppState;

pub async fn settings_capabilities(State(s): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "remote_script": s.settings.allow_remote_script,
        "scheduler_timezone": s.settings.scheduler_tz.to_string(),
    }))
    .into_response()
}
