//! Capabilities, integration hints, storage usage.

use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::State,
    response::{IntoResponse, Response},
    Json,
};

use crate::error::ApiResult;
use crate::{auth, db, state::AppState};

pub async fn settings_capabilities(State(s): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "remote_script": s.settings.allow_remote_script,
        "scheduler_timezone": s.settings.scheduler_tz.to_string(),
    }))
    .into_response()
}

/// Hints for Home Assistant / other integrations (no secrets).
pub async fn settings_integration(
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<auth::AuthUser>,
) -> Response {
    Json(serde_json::json!({
        "enabled": s.settings.integration_api_token.is_some(),
        "live_path": "/api/integration/agents/live",
        "auth_header": "Authorization: Bearer <INTEGRATION_API_TOKEN>",
        "setup": "Optional: set INTEGRATION_API_TOKEN on the server to expose GET /api/integration/agents/live for your own scripts or tools (Bearer token). Alert notification channels (email, Slack, Discord, Teams, Telegram, ntfy, Pushover, generic webhook, Home Assistant) are configured separately via their own environment variables — see GET /api/settings/notifications and .env.example.",
    }))
    .into_response()
}

pub async fn storage_usage(State(s): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(db::query_database_storage(&s.db).await?))
}
