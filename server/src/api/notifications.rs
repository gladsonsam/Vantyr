//! Admin endpoints for external notification channels: list configured channels
//! and send a test alert through them. Channel secrets are configured via server
//! environment variables (see `.env.example`) and never exposed here.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::http::RequireAdmin;
use crate::{db, notify, state::AppState};

use crate::http::audit_ip;

/// `GET /api/settings/notifications` — channel catalog with enabled state (admin).
pub async fn notifications_status(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
) -> Json<Value> {
    Json(serde_json::json!({
        "providers": s.notify_hub.catalog(),
        "any_enabled": !s.notify_hub.is_empty(),
    }))
}

/// `POST /api/settings/notifications/test` — fire a synthetic alert through every
/// configured channel and report per-channel success/failure (admin, audited).
pub async fn notifications_test(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if s.notify_hub.is_empty() {
        return Err(ApiError::bad_request(
            "No notification channels are configured. Set the channel environment variables on the server and restart.",
        ));
    }

    let now = chrono::Utc::now();
    let (dashboard_url, dashboard_activity_url) = match s.settings.public_base_url.as_deref() {
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

    Ok(Json(
        serde_json::json!({ "results": results, "all_ok": all_ok }),
    ))
}
