//! Live screen: single JPEG, MJPEG stream, and PCM audio stream.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use axum::extract::Extension;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

use crate::agents::db as agents_db;
use crate::http::AuthUser;
use crate::state::MjpegViewerPrefs;
use crate::{agents::capabilities, state::AppState};

/// Serve the most-recent JPEG screenshot as a single image.
pub async fn agent_screen(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
) -> Response {
    let frame = s.media.frames.lock().get(&id).cloned();
    match frame {
        Some(f) if f.jpeg.starts_with(&[0xff, 0xd8]) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "no-cache, no-store"),
            ],
            f.jpeg,
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "No JPEG frame available yet").into_response(),
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
    Extension(user): Extension<AuthUser>,
) -> Response {
    agent_live_stream(id, q, s, user, false).await
}

/// Length-prefixed, independently decodable H.264 packets. Uses the same
/// session admission, permission revocation and control lease as MJPEG.
pub async fn agent_video(
    Path(id): Path<Uuid>,
    Query(q): Query<MjpegQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    match agents_db::get_agent_info(&s.db, id).await {
        Ok(Some(info)) if info["capabilities"]["screen_h264"] == "supported" => {}
        _ => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "H.264 streaming requires an updated agent with video support.",
                    "code": "feature_unavailable", "feature": "screen_h264"
                })),
            )
                .into_response()
        }
    }
    agent_live_stream(id, q, s, user, true).await
}

async fn agent_live_stream(
    id: Uuid,
    q: MjpegQuery,
    s: Arc<AppState>,
    _user: AuthUser,
    h264: bool,
) -> Response {
    match capabilities::capability_attemptable(&s.db, id, "screen_capture").await {
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
    viewer_prefs.h264 = h264;
    // Metadata lookup is outside the integration mutex. Unknown primary remains
    // symbolic and is viewable, but cannot grant a physically selected input lease.
    let info = agents_db::get_agent_info(&s.db, id).await.ok().flatten();
    viewer_prefs.monitor =
        match crate::control::capture_arbitration::resolve_monitor(q.monitor, info.as_ref()) {
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
    let poll_ms = 33;
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
            if !stream_state.agents.module_authorized(id,crate::agents::modules::Module::LiveScreen) {break;}
            let current = stream_state.agents.connections.lock().get(&id).map(|c| c.conn_id);
            if !stream_state.media.mjpeg_sessions.lock().get(&session_id).is_some_and(|s| Some(s.conn_id)==current) {break;}

            let cadence = stream_state.media.mjpeg_sessions.lock().get(&session_id)
                .map(|s| s.prefs.interval_ms).unwrap_or(1000);
            if last_seq != 0 && last_emit.elapsed() < Duration::from_millis(u64::from(cadence)) { continue; }
            let agent_online = stream_state.agents.connections.lock().contains_key(&id);

            // Agent just (re)connected while we're still watching — send a
            // fresh start_capture so frames start flowing again.
            if agent_online && !agent_was_online {
                stream_state.sync_mjpeg_capture(id);
            }
            agent_was_online = agent_online;

            let frame = stream_state.media.frames.lock().get(&id).cloned();

            let Some(f) = frame else {
                // Agent not connected yet — keep the connection alive.
                continue;
            };

            if f.jpeg.starts_with(b"H264") != h264 { continue; }

            // Skip frames we've already sent.
            if f.seq == last_seq
                && last_emit.elapsed() < RESEND_EVERY {
                    continue;
                }
            last_seq = f.seq;
            last_emit = Instant::now();

            if h264 {
                let mut part = Vec::with_capacity(4 + f.jpeg.len());
                part.extend_from_slice(&(f.jpeg.len() as u32).to_le_bytes());
                part.extend_from_slice(&f.jpeg);
                yield Bytes::from(part);
                continue;
            }
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
            if h264 {
                "application/vnd.vantyr.h264".to_owned()
            } else {
                format!("multipart/x-mixed-replace; boundary={BOUNDARY}")
            },
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
    Extension(_user): Extension<AuthUser>,
    Json(body): Json<MjpegLeaveBody>,
) -> Response {
    s.end_mjpeg_session(id, body.session, Some(_user.user_id));
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct TuningBody {
    session: Uuid,
    jpeg_q: u8,
    interval_ms: u32,
}
pub async fn agent_mjpeg_tuning(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<TuningBody>,
) -> Response {
    match s.tune_mjpeg_session(
        id,
        body.session,
        user.user_id,
        body.jpeg_q,
        body.interval_ms,
    ) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(error) => error.response(),
    }
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
    let jpeg_quality = q.jpeg_q.unwrap_or(80).clamp(20, 85);
    let interval_ms = q.interval_ms.unwrap_or(200).clamp(33, 1000);
    let monitor = q.monitor;
    MjpegViewerPrefs {
        h264: false,
        jpeg_quality,
        interval_ms,
        monitor,
    }
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
    Extension(user): Extension<AuthUser>,
) -> Response {
    if !user.is_operator() {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    // Check capability.
    match capabilities::capability_attemptable(&s.db, id, "audio_capture").await {
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

    // Subscribe before StartAudio: the first frame supplies stream metadata.
    let mut rx = s.media.audio_sender_for(id).subscribe();
    let guard = match AudioGuard::start(s.clone(), id) {
        Ok(guard) => guard,
        Err(error) => return error.response(),
    };
    let conn_id = guard.conn_id;
    let module_revision = guard.module_revision;
    let state_clone = s.clone();

    let stream = async_stream::stream! {
        let _guard = guard;
        let mut authorization_tick = tokio::time::interval(Duration::from_millis(250));
        let mut header_sent = false;
        let mut idle_deadline = tokio::time::Instant::now() + Duration::from_secs(30);

        loop {
            let next = tokio::select! {
                _ = authorization_tick.tick() => {
                    let current = state_clone.agents.connections.lock().get(&id).map(|c| c.conn_id);
                    if current != Some(conn_id) || !audio_generation_current(&state_clone, id, module_revision) { break; }
                    continue;
                }
                _ = tokio::time::sleep_until(idle_deadline) => break,
                next = rx.recv() => next,
            };
            match next {
                Ok(frame) => {
                    idle_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
                    if state_clone.agents.connections.lock().get(&id).map(|c| c.conn_id) != Some(conn_id)
                        || !audio_generation_current(&state_clone, id, module_revision) {break;}
                    // Validate magic prefix and minimum length (4 magic + 4 sr + 2 ch = 10).
                    if frame.len() < 10 || &frame[..4] != vantyr_protocol::frames::AUDIO_FRAME_MAGIC {
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
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Fell behind — skip frames and catch up.
                    continue;
                }
                // Channel closed (agent disconnected) or 30-second timeout.
                Err(_) => break,
            }
        }

    };

    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "audio/pcm")
        .header(header::CACHE_CONTROL, "no-cache, no-store")
        .header("Connection", "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Refcounts capture across viewers and tears it down even if an HTTP body is
/// cancelled before its next poll. Old guards cannot stop a new connection.
struct AudioGuard {
    state: Arc<AppState>,
    agent_id: Uuid,
    conn_id: Uuid,
    module_revision: u64,
}

fn audio_generation_current(state: &AppState, agent: Uuid, revision: u64) -> bool {
    state
        .agents
        .authorize_agent_command(
            agent,
            &vantyr_protocol::ServerCommand::StartAudio.to_value(),
        )
        .is_ok_and(|command| command["__module_generation"]["revision"].as_u64() == Some(revision))
}

impl AudioGuard {
    fn start(
        state: Arc<AppState>,
        agent_id: Uuid,
    ) -> Result<Self, crate::agents::modules::CommandDenied> {
        let _control = state.control.lock();
        let conn_id = state
            .agents
            .connections
            .lock()
            .get(&agent_id)
            .map(|c| c.conn_id)
            .ok_or_else(|| {
                crate::agents::modules::CommandDenied::new(
                    "agent_offline",
                    "Agent is offline.",
                    None,
                )
            })?;
        let command = state.agents.authorize_agent_command(
            agent_id,
            &vantyr_protocol::ServerCommand::StartAudio.to_value(),
        )?;
        let module_revision = command["__module_generation"]["revision"]
            .as_u64()
            .unwrap_or(0);
        let key = (agent_id, conn_id, module_revision);
        let mut viewers = state.media.audio_viewers.lock();
        let count = viewers.get(&key).copied().unwrap_or(0);
        if count >= 256 {
            return Err(crate::agents::modules::CommandDenied::new(
                "audio_viewer_limit",
                "Too many audio listeners.",
                None,
            ));
        }
        if count == 0 {
            state
                .agents
                .enqueue_authorized_command(agent_id, conn_id, command)?;
        }
        viewers.insert(key, count + 1);
        drop(viewers);
        drop(_control);
        Ok(Self {
            state,
            agent_id,
            conn_id,
            module_revision,
        })
    }
}
impl Drop for AudioGuard {
    fn drop(&mut self) {
        let _control = self.state.control.lock();
        let mut viewers = self.state.media.audio_viewers.lock();
        let key = (self.agent_id, self.conn_id, self.module_revision);
        let Some(count) = viewers.get_mut(&key) else {
            return;
        };
        if *count > 1 {
            *count -= 1;
            return;
        }
        viewers.remove(&key);
        drop(viewers);
        if self
            .state
            .agents
            .connections
            .lock()
            .get(&self.agent_id)
            .map(|c| c.conn_id)
            != Some(self.conn_id)
        {
            return;
        }
        if !audio_generation_current(&self.state, self.agent_id, self.module_revision) {
            return;
        }
        if let Ok(command) = self.state.agents.authorize_agent_command(
            self.agent_id,
            &vantyr_protocol::ServerCommand::StopAudio.to_value(),
        ) {
            if self
                .state
                .agents
                .enqueue_authorized_command(self.agent_id, self.conn_id, command)
                .is_err()
            {
                // A dropped final StopAudio must not leave capture running.
                if let Some(connection) = self
                    .state
                    .agents
                    .connections
                    .lock()
                    .get(&self.agent_id)
                    .filter(|c| c.conn_id == self.conn_id)
                {
                    connection.shutdown.send_replace(Some(""));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AgentControl;
    use crate::test_support::control::{connect, offline_state};

    fn kind(command: AgentControl) -> String {
        let AgentControl::Text(text) = command else {
            panic!("expected text command")
        };
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["type"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn audio_last_viewer_drop_stops_capture_once() {
        let state = offline_state();
        let agent = Uuid::new_v4();
        let (_, mut queue, _) = connect(&state, agent, 32);
        let first = AudioGuard::start(state.clone(), agent).unwrap();
        assert_eq!(kind(queue.try_recv().unwrap()), "start_audio");
        let second = AudioGuard::start(state.clone(), agent).unwrap();
        assert!(queue.try_recv().is_err());
        drop(first);
        assert!(queue.try_recv().is_err());
        assert_eq!(state.media.audio_viewers.lock().values().sum::<u32>(), 1);
        drop(second);
        assert_eq!(kind(queue.try_recv().unwrap()), "stop_audio");
        assert!(state.media.audio_viewers.lock().is_empty());
    }

    #[tokio::test]
    async fn old_audio_permission_generation_cannot_stop_regranted_capture() {
        let state = offline_state();
        let agent = Uuid::new_v4();
        let (_, mut queue, _) = connect(&state, agent, 32);
        let old = AudioGuard::start(state.clone(), agent).unwrap();
        queue.try_recv().unwrap();
        state.agents.modules.lock().get_mut(&agent).unwrap().report =
            crate::test_support::control::module_report(2, true);
        assert!(!audio_generation_current(
            &state,
            agent,
            old.module_revision
        ));
        let replacement = AudioGuard::start(state.clone(), agent).unwrap();
        assert_eq!(kind(queue.try_recv().unwrap()), "start_audio");
        drop(old);
        assert!(queue.try_recv().is_err());
        drop(replacement);
        assert_eq!(kind(queue.try_recv().unwrap()), "stop_audio");
    }

    #[tokio::test]
    async fn cancelled_unpolled_audio_body_and_old_connection_guard_are_safe() {
        let state = offline_state();
        let agent = Uuid::new_v4();
        let (_, mut old_queue, _) = connect(&state, agent, 32);
        let old = AudioGuard::start(state.clone(), agent).unwrap();
        old_queue.try_recv().unwrap();
        let (_, mut new_queue, _) = connect(&state, agent, 32);
        let replacement = AudioGuard::start(state.clone(), agent).unwrap();
        assert_eq!(kind(new_queue.try_recv().unwrap()), "start_audio");
        drop(old);
        assert!(new_queue.try_recv().is_err());
        let stream = async_stream::stream! {
            let _guard = replacement;
            yield Ok::<Bytes, Infallible>(Bytes::from_static(b"test"));
        };
        let body = Body::from_stream(stream);
        drop(body);
        assert_eq!(kind(new_queue.try_recv().unwrap()), "stop_audio");
        assert!(state.media.audio_viewers.lock().is_empty());
    }
}
