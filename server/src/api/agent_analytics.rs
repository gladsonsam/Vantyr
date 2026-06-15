//! Per-agent analytics endpoints (URLs/categories/time spent).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::{auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

fn parse_range(from: Option<String>, to: Option<String>) -> Result<(DateTime<Utc>, DateTime<Utc>), &'static str> {
    let now = Utc::now();
    let end = match to {
        None => now,
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'to' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    let start = match from {
        None => end - Duration::days(7),
        Some(s) => DateTime::parse_from_rfc3339(s.trim())
            .map_err(|_| "invalid 'from' (expected RFC3339)")?
            .with_timezone(&Utc),
    };
    if start > end {
        return Err("'from' must be <= 'to'");
    }
    Ok((start, end))
}

#[derive(Debug, Deserialize)]
pub struct RangeQuery {
    from: Option<String>,
    to: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

const fn default_limit() -> i64 {
    50
}

pub async fn agent_url_categories_time(
    Path(id): Path<Uuid>,
    Query(q): Query<RangeQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response(),
    };
    let limit = q.limit.clamp(1, 500);
    let ip = audit_ip(&headers, addr);
    match db::query_agent_url_categories_time(&s.db, id, from, to, limit).await {
        Ok(rows) => {
            let detail = serde_json::json!({ "from": from, "to": to, "limit": limit });
            db::insert_audit_log_dedup_traced(
                &s.db,
                db::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: Some(id),
                    action: "view_agent_url_categories_time",
                    status: "ok",
                    detail: &detail,
                    dedup_window_secs: 10,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Json(serde_json::json!({ "rows": rows })).into_response()
        }
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct MetricsQuery {
    from: Option<String>,
    to: Option<String>,
}

/// Resource health history (CPU/mem/disk) for one agent over a time range.
/// Returns bucketed averages so the payload stays bounded for long ranges.
pub async fn agent_metrics_history(
    Path(id): Path<Uuid>,
    Query(q): Query<MetricsQuery>,
    State(s): State<Arc<AppState>>,
) -> Response {
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response()
        }
    };
    // Aim for ~240 points across the range; clamp the bucket to a sane floor
    // (the agent samples every ~60s, so going finer adds no resolution).
    let span_secs = (to - from).num_seconds().max(1);
    let bucket_secs = (span_secs / 240).max(60);
    match db::query_agent_metrics(&s.db, id, from, to, bucket_secs).await {
        Ok(rows) => Json(serde_json::json!({
            "from": from,
            "to": to,
            "bucket_secs": bucket_secs,
            "points": rows,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct SitesQuery {
    from: Option<String>,
    to: Option<String>,
    category_key: Option<String>,
    custom_category_key: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

pub async fn agent_url_sites_time(
    Path(id): Path<Uuid>,
    Query(q): Query<SitesQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response(),
    };
    let limit = q.limit.clamp(1, 500);
    let cat = q.category_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let custom = q.custom_category_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let ip = audit_ip(&headers, addr);
    match db::query_agent_url_sites_time(&s.db, id, from, to, custom.as_deref(), cat.as_deref(), limit).await {
        Ok(rows) => {
            let detail = serde_json::json!({ "from": from, "to": to, "limit": limit, "custom_category_key": custom, "category_key": cat });
            db::insert_audit_log_dedup_traced(
                &s.db,
                db::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: Some(id),
                    action: "view_agent_url_sites_time",
                    status: "ok",
                    detail: &detail,
                    dedup_window_secs: 10,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Json(serde_json::json!({ "rows": rows })).into_response()
        }
        Err(e) => err500(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct SessionsQuery {
    from: Option<String>,
    to: Option<String>,
    #[serde(default = "default_limit")]
    limit: i64,
}

pub async fn agent_url_sessions(
    Path(id): Path<Uuid>,
    Query(q): Query<SessionsQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let (from, to) = match parse_range(q.from, q.to) {
        Ok(v) => v,
        Err(msg) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response(),
    };
    let limit = q.limit.clamp(1, 2000);
    let ip = audit_ip(&headers, addr);
    match db::query_agent_url_sessions(&s.db, id, from, to, limit).await {
        Ok(rows) => {
            let detail = serde_json::json!({ "from": from, "to": to, "limit": limit });
            db::insert_audit_log_dedup_traced(
                &s.db,
                db::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: Some(id),
                    action: "view_agent_url_sessions",
                    status: "ok",
                    detail: &detail,
                    dedup_window_secs: 10,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Json(serde_json::json!({ "rows": rows })).into_response()
        }
        Err(e) => err500(e),
    }
}

