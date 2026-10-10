//! Telemetry retention settings.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::RequireAdmin;
use crate::platform::retention::db;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;
// ─── Retention (telemetry auto-prune) ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct RetentionBody {
    keylog_days: Option<i32>,
    window_days: Option<i32>,
    url_days: Option<i32>,
}

/// Global policy: `None` or `0` → unlimited (stored as SQL NULL). Otherwise 1..=36500.
fn normalize_global_retention(body: RetentionBody) -> Result<db::RetentionPolicy, &'static str> {
    let norm = |d: Option<i32>| -> Result<Option<i32>, &'static str> {
        match d {
            None => Ok(None),
            Some(0) => Ok(None),
            Some(x) if (1..=36_500).contains(&x) => Ok(Some(x)),
            Some(x) if x < 0 => Err("retention days cannot be negative"),
            Some(_) => Err("retention days must be 0 (unlimited) or between 1 and 36500"),
        }
    };
    Ok(db::RetentionPolicy {
        keylog_days: norm(body.keylog_days)?,
        window_days: norm(body.window_days)?,
        url_days: norm(body.url_days)?,
    })
}

/// Agent override: `None` → inherit global. `Some(0)` → unlimited. `Some(n)` → n days.
fn parse_agent_retention(body: RetentionBody) -> Result<db::RetentionAgentOverride, &'static str> {
    let parse = |d: Option<i32>| -> Result<Option<i32>, &'static str> {
        match d {
            None => Ok(None),
            Some(0) => Ok(Some(0)),
            Some(x) if (1..=36_500).contains(&x) => Ok(Some(x)),
            Some(x) if x < 0 => Err("retention days cannot be negative"),
            Some(_) => {
                Err("retention override must be omitted (inherit), 0 (unlimited), or 1–36500 days")
            }
        }
    };
    Ok(db::RetentionAgentOverride {
        keylog_days: parse(body.keylog_days)?,
        window_days: parse(body.window_days)?,
        url_days: parse(body.url_days)?,
    })
}

pub async fn retention_global_get(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let p = db::get_retention_global(&s.db).await?;
    Ok(Json(serde_json::json!({
        "keylog_days": p.keylog_days,
        "window_days": p.window_days,
        "url_days": p.url_days,
    })))
}

pub async fn retention_global_put(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RetentionBody>,
) -> ApiResult<Json<Value>> {
    let p = normalize_global_retention(body).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    db::set_retention_global(&s.db, &p).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "set_retention_global",
        "ok",
        &serde_json::json!({
            "keylog_days": p.keylog_days,
            "window_days": p.window_days,
            "url_days": p.url_days
        }),
        ip.as_deref(),
    )
    .await;
    retention_global_get(State(s.clone())).await
}

pub async fn agent_retention_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let global = db::get_retention_global(&s.db).await?;
    let ov = db::get_retention_agent(&s.db, id).await?;
    let override_json = match &ov {
        Some(o) => serde_json::json!({
            "keylog_days": o.keylog_days,
            "window_days": o.window_days,
            "url_days": o.url_days,
        }),
        None => serde_json::Value::Null,
    };

    Ok(Json(serde_json::json!({
        "global": {
            "keylog_days": global.keylog_days,
            "window_days": global.window_days,
            "url_days": global.url_days,
        },
        "override": override_json,
    })))
}

pub async fn agent_retention_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RetentionBody>,
) -> ApiResult<Json<Value>> {
    let ov = parse_agent_retention(body).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    db::set_retention_agent(&s.db, id, &ov).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "set_retention_agent",
        "ok",
        &serde_json::json!({
            "keylog_days": ov.keylog_days,
            "window_days": ov.window_days,
            "url_days": ov.url_days
        }),
        ip.as_deref(),
    )
    .await;
    agent_retention_get(Path(id), State(s.clone())).await
}

pub async fn agent_retention_delete(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    db::clear_retention_agent(&s.db, id).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "clear_retention_agent",
        "ok",
        &serde_json::json!({}),
        ip.as_deref(),
    )
    .await;
    agent_retention_get(Path(id), State(s.clone())).await
}
