//! Machine-to-machine API for Home Assistant and other integrations.
//!
//! Protected by `Authorization: Bearer <INTEGRATION_API_TOKEN>` (see env `INTEGRATION_API_TOKEN`).

use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use uuid::Uuid;

use crate::agents::db as agents_db;
use crate::auth::secrets;
use crate::http::AuthUser;
use crate::state::AppState;

pub fn routes() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route(
        "/settings/integration",
        axum::routing::get(settings_integration),
    )
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let prefix = "Bearer ";
    auth.strip_prefix(prefix).map(str::trim)
}

/// `GET /api/integration/agents/live` — all agents with DB names + online flag + last live telemetry.
pub async fn agents_live(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let Some(expected) = state.settings.integration_api_token.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let Some(supplied) = bearer_token(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            "missing Authorization: Bearer token",
        )
            .into_response();
    };

    if !secrets::ct_compare_secret(supplied, expected) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }

    let rows = match agents_db::list_agents(&state.db).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "integration agents_live: list_agents failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };

    let agents_map = state.agents.connections.lock();
    let live_map = state.agents.live.lock();

    let mut agents = Vec::new();
    for row in rows {
        let Some(id_str) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(id_str) else {
            continue;
        };
        let name = row
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let online = agents_map.contains_key(&id);
        let connected_at = agents_map.get(&id).map(|c| c.connected_at);

        let live = live_map.get(&id).cloned().unwrap_or_default();

        agents.push(serde_json::json!({
            "id": id,
            "name": name,
            "online": online,
            "connected_at": connected_at,
            "window_title": live.window_title,
            "window_app": live.window_app,
            "url": live.url,
            "activity": live.activity,
            "idle_secs": live.idle_secs,
            "live_updated_at": live.updated_at,
        }));
    }

    Json(serde_json::json!({ "agents": agents })).into_response()
}

/// Hints for Home Assistant / other integrations (no secrets).
pub async fn settings_integration(
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Response {
    Json(serde_json::json!({
        "enabled": s.settings.integration_api_token.is_some(),
        "live_path": "/api/integration/agents/live",
        "auth_header": "Authorization: Bearer <INTEGRATION_API_TOKEN>",
        "setup": "Optional: set INTEGRATION_API_TOKEN on the server to expose GET /api/integration/agents/live for your own scripts or tools (Bearer token). Alert notification channels (email, Slack, Discord, Teams, Telegram, ntfy, Pushover, generic webhook, Home Assistant) are configured separately via their own environment variables — see GET /api/settings/notifications and .env.example.",
    }))
    .into_response()
}
