//! Live screen: single JPEG, MJPEG stream, forced update.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use axum::extract::Extension;
use axum::{
    body::Body,
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

use crate::state::{AgentControl, MjpegSession, MjpegViewerPrefs};
use crate::{agent_capabilities, auth, db, state::AppState};

use super::helpers::audit_ip;

pub async fn agent_update_now(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_operator() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);

    let payload = serde_json::json!({ "type": "update_now" }).to_string();
    let tx = s.agent_cmds.lock().get(&id).cloned();
    let Some(tx) = tx else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "Agent is not connected" })),
        )
            .into_response();
    };
    if tx.try_send(AgentControl::Text(payload)).is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Agent command queue is full; retry shortly" })),
        )
            .into_response();
    }

    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "agent_update_now",
        "ok",
        &serde_json::json!({}),
        ip.as_deref(),
    )
    .await;

    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Serve the most-recent JPEG screenshot as a single image.
pub async fn agent_screen(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    let frame = s.frames.lock().get(&id).cloned();
    match frame {
        Some(f) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-cache, no-store"),
            ],
            f.jpeg,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "No frame available yet").into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct MjpegQuery {
    /// Per-tab stream id from the dashboard; required so `POST .../mjpeg/leave` can end the
    /// session even if the browser keeps the multipart request open briefly.
    session: Uuid,
    /// JPEG encode quality (1–100). Omitted values are clamped to a dashboard-safe default on the server.
    #[serde(default)]
    jpeg_q: Option<u8>,
    /// Minimum time between captured frames on the agent (milliseconds).
    #[serde(default)]
    interval_ms: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct MjpegLeaveBody {
    session: Uuid,
}

/// `multipart/x-mixed-replace` MJPEG; polls cached frames on a viewer-specific cadence.
/// Viewer refcount drives `start_capture` / `stop_capture` on the agent (guard dropped when HTTP ends).
pub async fn agent_mjpeg(
    Path(id): Path<Uuid>,
    Query(q): Query<MjpegQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    match agent_capabilities::capability_attemptable(&s.db, id, "screen_capture").await {
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "Screen capture is not supported by this agent.",
                    "code": "feature_unavailable",
                    "feature": "screen_capture",
                })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check screen capture capability");
        }
        Ok(true) => {}
    }
    const BOUNDARY: &str = "mjpegframe";
    let session_id = q.session;
    let viewer_prefs = clamp_mjpeg_viewer_prefs(&q);

    {
        let mut sessions = s.mjpeg_sessions.lock();
        if sessions.contains_key(&session_id) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Duplicate MJPEG session id" })),
            )
                .into_response();
        }
        sessions.insert(
            session_id,
            MjpegSession {
                agent_id: id,
                prefs: viewer_prefs,
            },
        );
    }

    {
        let mut counts = s.capture_viewers.lock();
        let count = counts.entry(id).or_insert(0);
        *count += 1;
    }

    sync_mjpeg_capture_for_agent(&s, id);

    let guard = CaptureGuard {
        agent_id: id,
        session_id,
        state: s.clone(),
    };

    let stream_state = s;
    let poll_ms = u64::from(viewer_prefs.interval_ms).clamp(33, 2000);
    let stream = async_stream::stream! {
        // Moving the guard into the stream keeps it alive until the HTTP
        // connection drops, at which point Drop ends the session (if not already ended).
        let _guard = guard;

        let mut interval = tokio::time::interval(Duration::from_millis(poll_ms));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut last_seq: u64 = 0;
        let mut last_emit = Instant::now();
        // Some reverse proxies / browsers will drop an idle multipart response.
        // If the agent is paused (or re-sending identical frames), periodically re-send the latest frame.
        const RESEND_EVERY: Duration = Duration::from_secs(5);
        // Track whether the agent was reachable on the previous tick so we can
        // re-issue start_capture the moment it comes back online (the agent
        // always stops capture when its WebSocket session ends, so it needs a
        // fresh start_capture even if the MJPEG HTTP connection never dropped).
        let mut agent_was_online = false;

        loop {
            interval.tick().await;

            let agent_online = stream_state.agents.lock().contains_key(&id);

            // Agent just (re)connected while we're still watching — send a
            // fresh start_capture so frames start flowing again.
            if agent_online && !agent_was_online {
                sync_mjpeg_capture_for_agent(&stream_state, id);
            }
            agent_was_online = agent_online;

            let frame = stream_state.frames.lock().get(&id).cloned();

            let Some(f) = frame else {
                // Agent not connected yet — keep the connection alive.
                continue;
            };

            // Skip frames we've already sent.
            if f.seq == last_seq
                && last_emit.elapsed() < RESEND_EVERY {
                    continue;
                }
            last_seq = f.seq;
            last_emit = Instant::now();

            let header = format!(
                "--{BOUNDARY}\r\n\
                 Content-Type: image/jpeg\r\n\
                 Content-Length: {}\r\n\
                 \r\n",
                f.jpeg.len()
            );

            let mut part: Vec<u8> = header.into_bytes();
            part.extend_from_slice(&f.jpeg);
            part.extend_from_slice(b"\r\n");

            yield Bytes::from(part);
        }
    };

    let result_stream = stream.map(|b| -> Result<Bytes, Infallible> { Ok(b) });

    Response::builder()
        .status(200)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/x-mixed-replace; boundary={BOUNDARY}"),
        )
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .header("Connection", "keep-alive")
        .body(Body::from_stream(result_stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Dashboard calls this when leaving the screen tab so `stop_capture` is sent immediately,
/// even if the browser delays tearing down the MJPEG `<img>` request.
pub async fn agent_mjpeg_leave(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    Json(body): Json<MjpegLeaveBody>,
) -> Response {
    if !user.is_operator() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if try_end_mjpeg_session(&s, id, body.session) {
        send_stop_capture(&s, id);
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

fn send_stop_capture(state: &Arc<AppState>, agent_id: Uuid) {
    if let Some(tx) = state.agent_cmds.lock().get(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(r#"{"type":"stop_capture"}"#.to_string()));
    }
}

/// Removes `session_id` from the session table and decrements the per-agent viewer count.
/// Returns `true` when the refcount reached zero (`stop_capture` should be sent).
/// Idempotent with HTTP disconnect: only the first path to consume the session decrements.
fn try_end_mjpeg_session(state: &Arc<AppState>, agent_id: Uuid, session_id: Uuid) -> bool {
    {
        let mut sessions = state.mjpeg_sessions.lock();
        let Some(mapped) = sessions.get(&session_id).copied() else {
            return false;
        };
        if mapped.agent_id != agent_id {
            tracing::warn!(
                %session_id,
                mapped_agent = %mapped.agent_id,
                expected_agent = %agent_id,
                "mjpeg session agent mismatch"
            );
            return false;
        }
        sessions.remove(&session_id);
    }

    let stop = {
        let mut counts = state.capture_viewers.lock();
        let Some(c) = counts.get_mut(&agent_id) else {
            return false;
        };
        *c = c.saturating_sub(1);
        let stop = *c == 0;
        if stop {
            counts.remove(&agent_id);
        }
        stop
    };

    if stop {
        state.mjpeg_active_capture.lock().remove(&agent_id);
    } else {
        sync_mjpeg_capture_for_agent(state, agent_id);
    }
    stop
}

// --- CaptureGuard (MJPEG refcount)

struct CaptureGuard {
    agent_id: Uuid,
    session_id: Uuid,
    state: Arc<AppState>,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if try_end_mjpeg_session(&self.state, self.agent_id, self.session_id) {
            send_stop_capture(&self.state, self.agent_id);
        }
    }
}

fn clamp_mjpeg_viewer_prefs(q: &MjpegQuery) -> MjpegViewerPrefs {
    let jpeg_quality = q.jpeg_q.unwrap_or(40).clamp(20, 85);
    let interval_ms = q.interval_ms.unwrap_or(200).clamp(33, 1000);
    MjpegViewerPrefs {
        jpeg_quality,
        interval_ms,
    }
}

fn merge_mjpeg_prefs_for_agent(state: &AppState, agent_id: Uuid) -> Option<MjpegViewerPrefs> {
    let sessions = state.mjpeg_sessions.lock();
    let mut merged: Option<MjpegViewerPrefs> = None;
    for s in sessions.values().copied() {
        if s.agent_id != agent_id {
            continue;
        }
        merged = Some(match merged {
            None => s.prefs,
            Some(m) => MjpegViewerPrefs {
                jpeg_quality: m.jpeg_quality.max(s.prefs.jpeg_quality),
                interval_ms: m.interval_ms.min(s.prefs.interval_ms),
            },
        });
    }
    merged
}

fn start_capture_payload(prefs: MjpegViewerPrefs) -> String {
    serde_json::json!({
        "type": "start_capture",
        "jpeg_quality": prefs.jpeg_quality,
        "interval_ms": prefs.interval_ms,
    })
    .to_string()
}

fn sync_mjpeg_capture_for_agent(state: &Arc<AppState>, agent_id: Uuid) {
    let viewers = state
        .capture_viewers
        .lock()
        .get(&agent_id)
        .copied()
        .unwrap_or(0);
    if viewers == 0 {
        state.mjpeg_active_capture.lock().remove(&agent_id);
        return;
    }

    let Some(merged) = merge_mjpeg_prefs_for_agent(state, agent_id) else {
        return;
    };

    let mut active = state.mjpeg_active_capture.lock();
    if active.get(&agent_id).copied() == Some(merged) {
        return;
    }

    let tx = state.agent_cmds.lock().get(&agent_id).cloned();
    let Some(tx) = tx else {
        return;
    };

    if active.contains_key(&agent_id) {
        let _ = tx.try_send(AgentControl::Text(r#"{"type":"stop_capture"}"#.to_string()));
    }
    let _ = tx.try_send(AgentControl::Text(start_capture_payload(merged)));
    active.insert(agent_id, merged);
}
