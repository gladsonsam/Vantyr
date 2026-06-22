//! Admin endpoints for external notification channels: list configured channels
//! and send a test alert through them. Channel secrets are configured via server
//! environment variables (see `.env.example`) and never exposed here.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::{auth, db, notify, state::AppState};

use super::helpers::audit_ip;

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "Forbidden" })),
    )
        .into_response()
}

/// `GET /api/settings/notifications` — channel catalog with enabled state (admin).
pub async fn notifications_status(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_admin() {
        return forbidden();
    }
    Json(serde_json::json!({
        "providers": s.notify_hub.catalog(),
        "any_enabled": !s.notify_hub.is_empty(),
    }))
    .into_response()
}

/// `POST /api/settings/notifications/test` — fire a synthetic alert through every
/// configured channel and report per-channel success/failure (admin, audited).
pub async fn notifications_test(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_admin() {
        return forbidden();
    }
    if s.notify_hub.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "No notification channels are configured. Set the channel environment variables on the server and restart."
            })),
        )
            .into_response();
    }

    let now = chrono::Utc::now();
    let (dashboard_url, dashboard_activity_url) = match s.public_base_url.as_deref() {
        Some(base) => (
            Some(format!("{base}/agents")),
            Some(format!("{base}/alerts")),
        ),
        None => (None, None),
    };

    let payload = notify::AlertMatchPayload {
        event_id: 0,
        rule_id: 0,
        rule_name: "Test notification".to_string(),
        channel: "test".to_string(),
        agent_id: uuid::Uuid::nil(),
        agent_name: "Vantyr".to_string(),
        snippet: "If you can read this, Vantyr notifications are working.".to_string(),
        ts: now.timestamp(),
        dashboard_url,
        dashboard_activity_url,
    };

    let results = s.notify_hub.send_test(payload).await;
    let all_ok = results.iter().all(|r| r.ok);

    db::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "notifications.test",
        if all_ok { "success" } else { "error" },
        &serde_json::json!({
            "results": serde_json::to_value(&results).unwrap_or_default(),
        }),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;

    Json(serde_json::json!({ "results": results, "all_ok": all_ok })).into_response()
}
