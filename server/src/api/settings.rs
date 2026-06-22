//! Capabilities, integration hints, storage usage.

use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};

use crate::{auth, db, state::AppState};

use super::helpers::err500;
pub async fn settings_capabilities(State(s): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "remote_script": s.allow_remote_script,
        "scheduler_timezone": s.scheduler_tz.to_string(),
    }))
    .into_response()
}

/// Hints for Home Assistant / other integrations (no secrets).
pub async fn settings_integration(
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<auth::AuthUser>,
) -> Response {
    Json(serde_json::json!({
        "enabled": s.integration_api_token.is_some(),
        "live_path": "/api/integration/agents/live",
        "auth_header": "Authorization: Bearer <INTEGRATION_API_TOKEN>",
        "setup": "Optional: set INTEGRATION_API_TOKEN on the server to expose GET /api/integration/agents/live for your own scripts or tools (Bearer token). Alert notification channels (email, Slack, Discord, Teams, Telegram, ntfy, Pushover, generic webhook, Home Assistant) are configured separately via their own environment variables — see GET /api/settings/notifications and .env.example.",
    }))
    .into_response()
}

pub async fn storage_usage(State(s): State<Arc<AppState>>) -> Response {
    match db::query_database_storage(&s.db).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err500(e),
    }
}
