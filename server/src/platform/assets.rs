//! Cached app icons.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use uuid::Uuid;

use crate::agents::telemetry::db as telemetry_db;
use crate::error::ApiError;
use crate::http::AuthUser;
use crate::state::AppState;

pub async fn agent_app_icon(
    Path((id, exe_name)): Path<(Uuid, String)>,
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Response {
    // Basic input hardening: only allow a reasonable exe token.
    let exe = exe_name.trim().to_lowercase();
    if exe.is_empty() || exe.len() > 128 {
        return (StatusCode::BAD_REQUEST, "invalid exe_name").into_response();
    }
    if !exe
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ')
    {
        return (StatusCode::BAD_REQUEST, "invalid exe_name").into_response();
    }

    match telemetry_db::get_app_icon_png(&s.db, id, &exe).await {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, "image/png"),
                (header::CACHE_CONTROL, "public, max-age=604800, immutable"),
            ],
            bytes,
        )
            .into_response(),
        // Missing icons are routine (e.g. system binaries the agent never
        // captured). Return 204 instead of 404 so the browser doesn't log a
        // console error for the `<img>` load — the client already falls back.
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => ApiError::from(e).into_response(),
    }
}
