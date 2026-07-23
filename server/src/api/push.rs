//! Web Push subscription endpoints for the PWA.
//!
//! Any authenticated dashboard user can register the browser they're using to
//! receive OS notifications for alert-rule matches. The VAPID public key is served
//! so the frontend can call `PushManager.subscribe`; subscribe/unsubscribe persist
//! or remove the resulting subscription (see `crate::db::web_push`).

use std::sync::Arc;

use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::{auth, db, state::AppState};

/// `GET /api/push/vapid-public-key` — the base64url VAPID key for `applicationServerKey`,
/// plus whether Web Push is configured at all.
pub async fn vapid_public_key(
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<auth::AuthUser>,
) -> Response {
    Json(serde_json::json!({
        "publicKey": s.vapid_public_key,
        "enabled": s.vapid_public_key.is_some(),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Mirrors the JSON shape of a browser `PushSubscription` (`subscription.toJSON()`).
#[derive(Deserialize)]
pub struct SubscribeBody {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// `POST /api/push/subscribe` — upsert the current browser's push subscription for
/// the signed-in user. Idempotent (keyed on the unique endpoint).
pub async fn subscribe(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    Json(body): Json<SubscribeBody>,
) -> Response {
    if s.vapid_public_key.is_none() {
        return bad_request("Web Push is not configured on this server.");
    }
    let endpoint = body.endpoint.trim();
    if endpoint.is_empty() || body.keys.p256dh.trim().is_empty() || body.keys.auth.trim().is_empty()
    {
        return bad_request("Missing endpoint or subscription keys.");
    }
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(400).collect::<String>());

    match db::upsert_web_push_subscription(
        &s.db,
        user.user_id,
        endpoint,
        body.keys.p256dh.trim(),
        body.keys.auth.trim(),
        user_agent.as_deref(),
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "failed to store web push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to store subscription" })),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct UnsubscribeBody {
    pub endpoint: String,
}

/// `POST /api/push/unsubscribe` — remove the given endpoint for the signed-in user.
pub async fn unsubscribe(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    Json(body): Json<UnsubscribeBody>,
) -> Response {
    let endpoint = body.endpoint.trim();
    if endpoint.is_empty() {
        return bad_request("Missing endpoint.");
    }
    match db::delete_web_push_subscription(&s.db, user.user_id, endpoint).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "failed to delete web push subscription");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to remove subscription" })),
            )
                .into_response()
        }
    }
}
