//! Live screen: single JPEG, MJPEG stream, forced update, and PCM audio stream.

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
use serde_json::Value;
use uuid::Uuid;

use crate::auth::RequireOperator;
use crate::error::{ApiError, ApiResult};
use crate::state::MjpegViewerPrefs;
use crate::{agent_capabilities, auth, db, state::AppState};

use super::helpers::audit_ip;

pub async fn agent_update_now(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);

    if let Err(e) = s.send_agent_command_json(id, &serde_json::json!({"type":"update_now"})) {
        return Err(ApiError::Custom(e.response()));
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

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Serve the most-recent JPEG screenshot as a single image.
pub async fn agent_screen(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<auth::AuthUser>,
) -> Response {
    let frame = s.media.frames.lock().get(&id).cloned();
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
    /// Which monitor to capture (0-based index). Omitted = primary monitor.
    #[serde(default)]
    monitor: Option<u32>,
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
    Extension(_user): Extension<auth::AuthUser>,
) -> Response {
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
    // Watching is open to every role, including viewers; input, audio and power
    // actions stay operator-only on their own paths.
    const BOUNDARY: &str = "mjpegframe";
    let session_id = q.session;
    let mut viewer_prefs = clamp_mjpeg_viewer_prefs(&q);
    // Metadata lookup is outside the integration mutex. Unknown primary remains
    // symbolic and is viewable, but cannot grant a physically selected input lease.
    let info = db::get_agent_info(&s.db, id).await.ok().flatten();
    viewer_prefs.monitor =
        match crate::capture_arbitration::resolve_monitor(q.monitor, info.as_ref()) {
            Ok(monitor) => monitor,
            Err(error) => return error.response(),
        };
    if let Err(error) =
        s.begin_mjpeg_session(id, session_id, _user.user_id, viewer_prefs, q.monitor)
    {
        return error.response();
    }

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
            if !stream_state.module_authorized(id,crate::agent_modules::Module::LiveScreen) {break;}
            let current = stream_state.agents.lock().get(&id).map(|c| c.conn_id);
            if !stream_state.media.mjpeg_sessions.lock().get(&session_id).is_some_and(|s| Some(s.conn_id)==current) {break;}

            let agent_online = stream_state.agents.lock().contains_key(&id);

            // Agent just (re)connected while we're still watching — send a
            // fresh start_capture so frames start flowing again.
            if agent_online && !agent_was_online {
                sync_mjpeg_capture_for_agent(&stream_state, id);
            }
            agent_was_online = agent_online;

            let frame = stream_state.media.frames.lock().get(&id).cloned();

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
    Extension(_user): Extension<auth::AuthUser>,
    Json(body): Json<MjpegLeaveBody>,
) -> Response {
    s.end_mjpeg_session(id, body.session, Some(_user.user_id));
    Json(serde_json::json!({ "ok": true })).into_response()
}

// --- CaptureGuard (MJPEG refcount)

struct CaptureGuard {
    agent_id: Uuid,
    session_id: Uuid,
    state: Arc<AppState>,
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        self.state
            .end_mjpeg_session(self.agent_id, self.session_id, None);
    }
}

fn clamp_mjpeg_viewer_prefs(q: &MjpegQuery) -> MjpegViewerPrefs {
    let jpeg_quality = q.jpeg_q.unwrap_or(40).clamp(20, 85);
    let interval_ms = q.interval_ms.unwrap_or(200).clamp(33, 1000);
    let monitor = q.monitor;
    MjpegViewerPrefs {
        jpeg_quality,
        interval_ms,
        monitor,
    }
}

pub(crate) fn sync_mjpeg_capture_for_agent(state: &Arc<AppState>, agent_id: Uuid) {
    state.sync_mjpeg_capture(agent_id);
}

/// `GET /api/agents/:id/audio` — streams raw Float32LE PCM audio from the agent's
/// desktop audio output (WASAPI loopback).
///
/// Response body layout:
///   [0..4]  sample_rate  u32 LE  (from the first received audio frame)
///   [4..6]  channels     u16 LE
///   [6..]   continuous Float32LE interleaved PCM samples
///
/// The stream ends when the agent disconnects, the viewer disconnects, or no audio
/// frame arrives within 30 seconds (agent likely not sending audio).
pub async fn agent_audio(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_operator() {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    // Check capability.
    match agent_capabilities::capability_attemptable(&s.db, id, "audio_capture").await {
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "Audio capture is not supported by this agent.",
                    "code": "feature_unavailable",
                    "feature": "audio_capture",
                })),
            )
                .into_response();
        }
        Err(e) => {
            tracing::warn!(agent_id = %id, error = %e, "failed to check audio_capture capability");
        }
        Ok(true) => {}
    }

    // Tell the agent to start sending audio frames.
    if let Err(e) = s.send_agent_command_json(id, &serde_json::json!({"type":"start_audio"})) {
        return e.response();
    }

    let mut rx = s.media.audio_sender_for(id).subscribe();

    let state_clone = s.clone();

    let stream = async_stream::stream! {
        let mut header_sent = false;

        loop {
            match tokio::time::timeout(
                Duration::from_secs(30),
                rx.recv(),
            ).await {
                Ok(Ok(frame)) => {
                    if !state_clone.module_authorized(id,crate::agent_modules::Module::LiveAudio) {break;}
                    // Validate magic prefix and minimum length (4 magic + 4 sr + 2 ch = 10).
                    if frame.len() < 10 || &frame[..4] != b"AUD\0" {
                        continue;
                    }

                    if !header_sent {
                        // Emit the 6-byte metadata header (sample_rate + channels).
                        yield Ok::<Bytes, Infallible>(frame.slice(4..10));
                        header_sent = true;
                    }

                    // Relay the raw PCM data (skip the 10-byte agent frame header).
                    let pcm = frame.slice(10..);
                    if !pcm.is_empty() {
                        yield Ok(pcm);
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    // Fell behind — skip frames and catch up.
                    continue;
                }
                // Channel closed (agent disconnected) or 30-second timeout.
                Ok(Err(_)) | Err(_) => break,
            }
        }

        // Tell the agent to stop when all viewers are gone.
        // (Simplified: we stop on every disconnect; a refcount could be added later.)
        let _ = state_clone.send_agent_command_json(id, &serde_json::json!({"type":"stop_audio"}));
    };

    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "audio/pcm")
        .header(header::CACHE_CONTROL, "no-cache, no-store")
        .header("Connection", "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
