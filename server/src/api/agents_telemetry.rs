//! Per-agent history: windows, keys, URLs, activity, `WoL`, etc.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{AuthUser, RequireOperator};
use crate::{db, state::AppState};

use crate::http::audit_ip;

use crate::http::pagination::{validate_page_params, PageParams};
use crate::platform::audit;
use crate::web_activity::db as web_db;
use crate::web_activity::url_categorization::db as url_cat_db;
pub async fn agent_windows(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = db::query_windows(&s.db, id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_windows",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn agent_keys(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = db::query_keys(&s.db, id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_keys",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn agent_urls(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = web_db::query_urls(&s.db, id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_urls",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

#[derive(Debug, Deserialize)]
pub struct UrlCategoryStatsQuery {
    #[serde(default = "default_category_limit")]
    limit: i64,
}

const fn default_category_limit() -> i64 {
    24
}

pub async fn agent_url_category_stats(
    Path(id): Path<Uuid>,
    Query(q): Query<UrlCategoryStatsQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.clamp(1, 250);
    let ip = audit_ip(&headers, addr);
    let rows = web_db::query_url_category_stats(&s.db, id, limit).await?;
    let detail = serde_json::json!({ "limit": limit });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_url_category_stats",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

#[derive(Debug, Deserialize)]
pub struct UrlCategoryBackfillQuery {
    #[serde(default = "default_backfill_limit")]
    limit: i64,
}

const fn default_backfill_limit() -> i64 {
    25_000
}

/// Admin: enqueue existing uncategorized URL visits for categorization.
pub async fn agent_url_category_backfill(
    Path(id): Path<Uuid>,
    Query(q): Query<UrlCategoryBackfillQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let limit = q.limit.clamp(1, 250_000);
    let ip = audit_ip(&headers, addr);
    let enqueued = url_cat_db::enqueue_url_categorization_backfill(&s.db, id, limit).await?;
    let detail = serde_json::json!({ "limit": limit, "enqueued": enqueued });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "url_category_backfill",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "enqueued": enqueued })))
}

pub async fn agent_activity(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    let rows = db::query_activity(&s.db, id, p.limit, p.offset).await?;
    let detail = serde_json::json!({ "limit": p.limit, "offset": p.offset });
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_activity",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 10,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn agent_info(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let info = db::get_agent_info(&s.db, id).await?;
    let detail = serde_json::json!({});
    audit::insert_audit_log_dedup_traced(
        &s.db,
        audit::AuditLogDedup {
            actor: user.username.as_str(),
            agent_id: Some(id),
            action: "view_specs",
            status: "ok",
            detail: &detail,
            dedup_window_secs: 15,
            client_ip: ip.as_deref(),
        },
    )
    .await;
    Ok(Json(serde_json::json!({ "info": info })))
}

pub async fn agent_top_urls(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let rows = web_db::query_top_urls(&s.db, id, p.limit, p.offset).await?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn agent_top_windows(
    Path(id): Path<Uuid>,
    Query(p): Query<PageParams>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&p).map_err(ApiError::bad_request)?;
    let rows = db::query_top_windows(&s.db, id, p.limit, p.offset).await?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

/// Clear all stored telemetry history for an agent.
pub async fn clear_agent_history(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let cleared_rows = db::clear_agent_history(&s.db, id).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "clear_agent_history",
        "ok",
        &serde_json::json!({ "cleared_rows": cleared_rows }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "cleared_rows": cleared_rows })))
}

#[derive(Deserialize, Default)]
pub struct WakeQuery {
    /// IPv4 broadcast address (default `255.255.255.255`).
    broadcast: Option<String>,
    /// UDP port (default 9).
    port: Option<u16>,
}

/// Send a Wake-on-LAN magic packet using MAC from stored `agent_info`.
pub async fn agent_wake(
    Path(id): Path<Uuid>,
    Query(q): Query<WakeQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    if let Err(retry_secs) = s
        .throttles
        .wol_throttle_check(id, s.settings.wol_min_interval)
    {
        audit::insert_audit_log_traced(
            &s.db,
            user.username.as_str(),
            Some(id),
            "wake_on_lan",
            "rate_limited",
            &serde_json::json!({ "retry_after_secs": retry_secs }),
            ip.as_deref(),
        )
        .await;
        return Err(ApiError::Custom(
            (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": format!("Wake-on-LAN for this agent was sent recently; try again in about {retry_secs}s."),
                    "retry_after_secs": retry_secs,
                })),
            )
                .into_response(),
        ));
    }

    let info_val = db::get_agent_info(&s.db, id).await?;
    let Some(info) = info_val else {
        return Err(ApiError::not_found(
            "No stored system info for this agent. Connect it once so a MAC address is recorded.",
        ));
    };
    let Some(mac) = crate::wol::mac_bytes_from_agent_info(&info) else {
        return Err(ApiError::bad_request(
            "No usable MAC address in stored network adapters.",
        ));
    };

    let broadcast = q
        .broadcast
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("255.255.255.255");
    let port = q.port.unwrap_or(9);

    if let Err(e) = crate::wol::send_wake(mac, broadcast, port).await {
        tracing::warn!("WoL UDP send failed for {id}: {e}");
        audit::insert_audit_log_traced(
            &s.db,
            user.username.as_str(),
            Some(id),
            "wake_on_lan",
            "error",
            &serde_json::json!({ "error": e.to_string(), "broadcast": broadcast, "port": port }),
            ip.as_deref(),
        )
        .await;
        return Err(ApiError::status(
            StatusCode::BAD_GATEWAY,
            format!("Could not send magic packet: {e}"),
        ));
    }

    let mac_str = crate::wol::format_mac_colon(&mac);
    s.throttles.wol_mark_sent(id, s.settings.wol_min_interval);
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "wake_on_lan",
        "ok",
        &serde_json::json!({ "mac": mac_str, "broadcast": broadcast, "port": port }),
        ip.as_deref(),
    )
    .await;

    Ok(Json(serde_json::json!({
        "ok": true,
        "mac": mac_str,
        "broadcast": broadcast,
        "port": port,
    })))
}
