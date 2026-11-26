//! HTTP handlers for durable DNS events. Admin read routes inherit the `/api`
//! session cookie + CSRF middleware and need an explicit household grant. The
//! worker ingest route is cookie-free and needs a scoped Bearer command.
//!
//! Nothing here publishes policy, claims enforcement or reports verification.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::dns_events_db;
use super::dns_events_dto::{EventBatchBody, EventQueryParams, StatsQueryParams};
use super::dns_events_service::{self, SearchOutcome, StatsOutcome};
use super::{authz, gateway_api};

fn reject_json(rejection: JsonRejection) -> ApiError {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::status(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body exceeds the bound",
        )
    } else {
        ApiError::bad_request("invalid or unsupported request fields")
    }
}

async fn require_events_read(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    household_id: Uuid,
) -> ApiResult<()> {
    let admin = authz::has_grant(pool, user_id, household_id, authz::NetworkGrant::Admin).await?;
    let events = authz::has_grant(pool, user_id, household_id, authz::NetworkGrant::Events).await?;
    if admin || events {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

// ─── Admin reads ─────────────────────────────────────────────────────────────

pub async fn events_search(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<EventQueryParams>,
) -> ApiResult<Json<SearchOutcome>> {
    require_events_read(&s.db, user.user_id, hid).await?;
    Ok(Json(
        dns_events_service::search(&s.db, hid, &params, Utc::now()).await?,
    ))
}

pub async fn events_stats(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<StatsQueryParams>,
) -> ApiResult<Json<StatsOutcome>> {
    require_events_read(&s.db, user.user_id, hid).await?;

    // A per-device scope must be a device assigned inside this household.
    let device_ok = match params.device_id.as_deref() {
        None => false,
        Some(raw) => {
            let device_id = Uuid::parse_str(raw.trim())
                .map_err(|_| ApiError::bad_request("invalid device_id"))?;
            let mut conn = s.db.acquire().await?;
            dns_events_db::device_in_household(&mut conn, hid, device_id).await?
        }
    };

    Ok(Json(
        dns_events_service::stats(&s.db, hid, &params, device_ok, Utc::now()).await?,
    ))
}

// ─── Worker ingest ───────────────────────────────────────────────────────────

pub async fn worker_ingest(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<EventBatchBody>, JsonRejection>,
) -> ApiResult<Json<serde_json::Value>> {
    let body = body.map_err(reject_json)?.0;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let outcome = dns_events_service::ingest(&s.db, bearer, body, Utc::now()).await?;

    let ip = audit_ip(&headers, addr);
    gateway_api::audit_worker(
        &s,
        outcome.household_id,
        ip.as_deref(),
        "network_dns_events_ingest",
        json!({
            "gateway_id": outcome.gateway_id,
            "batch_id": outcome.batch_id,
            "event_count": outcome.event_count,
            "inserted": outcome.inserted,
            "replayed": outcome.replayed,
        }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "household_id": outcome.household_id,
        "gateway_id": outcome.gateway_id,
        "batch_id": outcome.batch_id,
        "event_count": outcome.event_count,
        "inserted": outcome.inserted,
        "duplicates": outcome.duplicates,
        "replayed": outcome.replayed,
    })))
}
