//! Installed-software list and on-demand collection.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::db;
use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, AuthUser};
use crate::platform::audit;
use crate::state::AppState;

#[derive(Deserialize, Default)]
pub struct SoftwareListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn agent_software_list(
    Path(id): Path<Uuid>,
    Query(q): Query<SoftwareListQuery>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let paged = q.limit.is_some() || q.offset.is_some();
    if paged {
        let limit = q.limit.unwrap_or(500);
        let offset = q.offset.unwrap_or(0);
        if !(1..=5000).contains(&limit) {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "limit must be between 1 and 5000",
            ));
        }
        if !(0..=500_000).contains(&offset) {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "offset must be between 0 and 500000",
            ));
        }
        let (rows, total) = db::list_agent_software_paged(&s.db, id, limit, offset).await?;
        let last = db::latest_software_capture_time(&s.db, id)
            .await
            .unwrap_or(None);
        Ok(Json(serde_json::json!({
            "rows": rows,
            "last_captured_at": last,
            "total": total,
            "limit": limit,
            "offset": offset,
        })))
    } else {
        let rows = db::list_agent_software(&s.db, id).await?;
        let last = db::latest_software_capture_time(&s.db, id)
            .await
            .unwrap_or(None);
        Ok(Json(serde_json::json!({
            "rows": rows,
            "last_captured_at": last,
        })))
    }
}

fn idempotency_key_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get("idempotency-key")
        .or_else(|| headers.get("Idempotency-Key"))?;
    let s = raw.to_str().ok()?.trim();
    if s.is_empty() || s.len() > 128 {
        return None;
    }
    Some(s.to_string())
}

const SOFTWARE_COLLECT_IDEMPOTENCY_TTL: Duration = Duration::from_secs(120);

pub async fn agent_software_collect(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_operator() {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Forbidden",
        ));
    }
    let ip = audit_ip(&headers, addr);

    if let Some(key) = idempotency_key_from_headers(&headers) {
        let now = Instant::now();
        let mut map = s.throttles.software_collect_dedup.lock();
        map.retain(|_, t| now.duration_since(*t) < SOFTWARE_COLLECT_IDEMPOTENCY_TTL);
        if map.contains_key(&(id, key.clone())) {
            return Ok(Json(serde_json::json!({
                "ok": true,
                "idempotent_replay": true
            })));
        }
        map.insert((id, key), now);
    }

    if let Err(e) = s
        .agents
        .send_command(id, &vantyr_protocol::ServerCommand::CollectSoftware)
    {
        if let Some(key) = idempotency_key_from_headers(&headers) {
            s.throttles.software_collect_dedup.lock().remove(&(id, key));
        }
        return Err(ApiError::Custom(e.response()));
    }
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "software_collect",
        "ok",
        &serde_json::json!({}),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
