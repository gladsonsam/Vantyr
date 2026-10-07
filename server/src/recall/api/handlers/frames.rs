//! Device picker, frame listing, nearest-frame lookup and per-frame OCR text.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::http::RequireOperator;
use crate::recall::api::cursor::{next_cursor, page_context};
use crate::recall::api::{audit_recall, AUDIT_REPLAY, MAX_FRAMES};
use crate::recall::db;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct FramesQuery {
    cursor: Option<String>,
    from: Option<String>,
    to: Option<String>,
    /// Restrict to one display (0-based). Omitted = every monitor, interleaved.
    monitor: Option<i32>,
    #[serde(default = "default_limit")]
    limit: i64,
}

const fn default_limit() -> i64 {
    2_000
}

/// `GET /agents/history/devices` — ids of agents that have recorded at least one
/// screen-history frame, for filtering the Recall device picker.
pub async fn history_devices(
    State(s): State<Arc<AppState>>,
    RequireOperator(_user): RequireOperator,
) -> ApiResult<Json<Value>> {
    let ids = db::timeline::list_agents_with_screen_history(&s.db).await?;
    Ok(Json(serde_json::json!({ "agent_ids": ids })))
}

/// `GET /agents/:id/history/frames?from&to&limit&cursor` — oldest-first metadata.
/// Range bounds are inclusive; ordering is `(captured_at, id) ASC`. Follow
/// `next_cursor` until null. `complete` means no further rows in this range after
/// this page, not a guarantee of capture coverage or a database snapshot.
/// Omitted filters on continuation inherit the cursor; explicit changes are 400.
/// Existing default/capped limits (2000/5000) and frame fields are unchanged.
pub async fn history_frames(
    Path(id): Path<Uuid>,
    Query(q): Query<FramesQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let context = page_context(
        id,
        None,
        q.from,
        q.to,
        q.monitor,
        None,
        None,
        q.cursor.as_deref(),
    )
    .map_err(ApiError::bad_request)?;
    let from = context.from.expect("frame range has a lower bound");
    let to = context.to;
    let monitor = context.monitor;
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let limit = q.limit.clamp(1, MAX_FRAMES);
    let page = db::timeline::list_screen_frames_page(
        &s.db,
        id,
        from,
        to,
        monitor,
        limit,
        q.cursor.as_ref().map(|_| &context.position),
    )
    .await?;
    let next_cursor = next_cursor(context, page.next);
    Ok(Json(serde_json::json!({
        "from": from, "to": to, "monitor": monitor,
        "count": page.items.len(), "frames": page.items,
        "limit": limit, "has_more": next_cursor.is_some(),
        "complete": next_cursor.is_none(), "next_cursor": next_cursor,
    })))
}

#[derive(Debug, Deserialize)]
pub struct FrameAtQuery {
    at: Option<String>,
    monitor: Option<i32>,
}

/// `GET /agents/:id/history/frame?at=<rfc3339>` — the frame nearest that instant.
pub async fn history_frame_at(
    Path(id): Path<Uuid>,
    Query(q): Query<FrameAtQuery>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    let at = match q.at {
        None => Utc::now(),
        Some(s) => match DateTime::parse_from_rfc3339(s.trim()) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => return Err(ApiError::bad_request("invalid 'at' (expected RFC3339)")),
        },
    };
    let frame = db::timeline::screen_frame_at(&s.db, id, at, q.monitor).await?;
    Ok(Json(serde_json::json!({ "frame": frame })))
}

/// `GET /agents/:id/history/text/:frame_id` — OCR text + word boxes for one frame.
///
/// Powers the selectable-text overlay: word boxes are normalized to 0..1 of the
/// frame, so the dashboard can position invisible spans over the replayed image at
/// whatever size it happens to be rendered.
pub async fn history_frame_text(
    Path((id, frame_id)): Path<(Uuid, i64)>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    // Reading the text off a frame is the same act as looking at it, so it shares
    // the replay audit action (and its throttle).
    audit_recall(
        &s,
        &user,
        id,
        AUDIT_REPLAY,
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    match db::frames::screen_frame_text(&s.db, id, frame_id).await {
        Ok(Some(v)) => {
            ([(header::CACHE_CONTROL, "private, max-age=86400")], Json(v)).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, "No such frame").into_response(),
        Err(e) => ApiError::from(e).into_response(),
    }
}
