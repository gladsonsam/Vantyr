//! Live screen/audio fan-out: cached frames, MJPEG viewer sessions, and audio channels.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use bytes::Bytes;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::capture_arbitration::{ActiveCapture, RetiredCaptures};

/// Normalised MJPEG viewer tuning (after clamping query params).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MjpegViewerPrefs {
    pub jpeg_quality: u8,
    pub interval_ms: u32,
    /// Which monitor to capture (0-based). `None` = the agent's primary monitor.
    pub monitor: Option<u32>,
}

/// Active MJPEG HTTP session (`?session=<uuid>` → agent + tuning).
#[derive(Clone, Copy, Debug)]
pub struct MjpegSession {
    pub requested_monitor: Option<u32>,
    pub agent_id: Uuid,
    pub user_id: Uuid,
    pub conn_id: Uuid,
    pub prefs: MjpegViewerPrefs,
}

/// Per-agent audio broadcast channel capacity (PCM frames, each ~960 samples = ~20ms @ 48kHz).
pub const AUDIO_CHANNEL_CAPACITY: usize = 128;

/// Cached JPEG with a monotonic `seq` for MJPEG change detection.
#[derive(Clone, Debug)]
pub struct Frame {
    pub seq: u64,
    pub jpeg: Bytes,
    /// Last time this frame was written; used for LRU eviction of the bounded frame cache.
    pub last_update: Instant,
}

/// Upper bound on agents whose latest frame we cache. Each frame is up to ~8 MiB, so this caps
/// frame-cache memory (e.g. stale frames left over from alert-screenshot captures on agents with
/// no live viewer can't accumulate without bound).
const MAX_CACHED_FRAMES: usize = 16;

/// Per-agent live media state. Capture admission and teardown (see
/// `capture_arbitration`) take these locks while holding `AppState::control`;
/// `mjpeg_active_capture` is taken before `frames` when both are held.
pub struct LiveMedia {
    pub frames: Mutex<HashMap<Uuid, Frame>>,
    frame_seq: AtomicU64,
    pub(crate) mjpeg_retired_captures: Mutex<HashMap<Uuid, RetiredCaptures>>,

    /// MJPEG viewer refcount per agent; drives `start_capture` / `stop_capture`.
    pub capture_viewers: Mutex<HashMap<Uuid, u32>>,

    /// Active MJPEG HTTP sessions (`?session=<uuid>` → agent + tuning). Used so explicit “leave”
    /// can drop refcount immediately (browser may delay closing the image request).
    pub mjpeg_sessions: Mutex<HashMap<Uuid, MjpegSession>>,
    /// Last `start_capture` parameters applied for an agent (so we can restart capture when merged prefs change).
    pub mjpeg_active_capture: Mutex<HashMap<Uuid, ActiveCapture>>,

    /// Per-agent audio broadcast channels (agent PCM frames → live audio viewers).
    audio_senders: Mutex<HashMap<Uuid, broadcast::Sender<Bytes>>>,
}

impl Default for LiveMedia {
    fn default() -> Self {
        Self {
            frames: Mutex::new(HashMap::new()),
            frame_seq: AtomicU64::new(1),
            mjpeg_retired_captures: Mutex::new(HashMap::new()),
            capture_viewers: Mutex::new(HashMap::new()),
            mjpeg_sessions: Mutex::new(HashMap::new()),
            mjpeg_active_capture: Mutex::new(HashMap::new()),
            audio_senders: Mutex::new(HashMap::new()),
        }
    }
}

impl LiveMedia {
    /// Cache the latest JPEG frame for `agent_id`, bumping its `seq`. Bounds the cache to
    /// [`MAX_CACHED_FRAMES`] agents, evicting the least-recently-updated frame when a new agent
    /// would exceed the cap.
    pub fn store_frame(&self, agent_id: Uuid, jpeg: Bytes) {
        let mut frames = self.frames.lock();
        let next_seq = self.frame_seq.fetch_add(1, Ordering::Relaxed);
        if !frames.contains_key(&agent_id) && frames.len() >= MAX_CACHED_FRAMES {
            if let Some(oldest) = frames
                .iter()
                .min_by_key(|(_, f)| f.last_update)
                .map(|(k, _)| *k)
            {
                frames.remove(&oldest);
            }
        }
        frames.insert(
            agent_id,
            Frame {
                seq: next_seq,
                jpeg,
                last_update: Instant::now(),
            },
        );
    }

    /// Get or create a broadcast sender for an agent's audio stream.
    /// The sender persists until explicitly removed (e.g. on agent disconnect).
    pub fn audio_sender_for(&self, agent_id: Uuid) -> broadcast::Sender<Bytes> {
        self.audio_senders
            .lock()
            .entry(agent_id)
            .or_insert_with(|| broadcast::channel(AUDIO_CHANNEL_CAPACITY).0)
            .clone()
    }

    /// Broadcast an audio frame to any active audio viewers for the given agent.
    /// Returns true if at least one viewer received it.
    pub fn route_audio_frame(&self, agent_id: Uuid, frame: Bytes) -> bool {
        let tx = self.audio_senders.lock().get(&agent_id).cloned();
        tx.is_some_and(|tx| tx.send(frame).is_ok())
    }
}
