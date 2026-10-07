//! In-memory agent connections and live-media fixtures for control, viewer and ingest tests.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::agents::modules::{ModuleReport, ModuleState, RuntimeModules, MODULES};
use crate::http::AuthUser;
use crate::state::{AgentConn, AgentControl, AppState, Settings};

/// `AppState` whose pool never connects, for tests that stay in memory.
pub fn offline_state() -> Arc<AppState> {
    Arc::new(AppState::new(
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(100))
            .connect_lazy("postgres://fixture:fixture@localhost/fixture")
            .unwrap(),
        Settings::for_tests(),
        None,
        crate::notify::NotifyHub::new(vec![]),
    ))
}

/// A device's module report with every module available and `enabled` at `revision`.
pub fn module_report(revision: u64, enabled: bool) -> ModuleReport {
    ModuleReport {
        kind: "module_states".into(),
        schema_version: 1,
        revision,
        modules: MODULES
            .iter()
            .map(|module| ModuleState {
                module: *module,
                available: true,
                enabled,
                revision,
                authorization_required: !enabled,
            })
            .collect(),
    }
}

/// Register a live connection for `agent` (replacing any previous one) with all modules
/// granted, an active monitor-0 capture and a stored frame. Returns the connection id,
/// its command queue and its shutdown signal.
pub fn connect(
    s: &AppState,
    agent: Uuid,
    capacity: usize,
) -> (
    Uuid,
    mpsc::Receiver<AgentControl>,
    watch::Receiver<Option<&'static str>>,
) {
    let mut control = s.control.lock();
    let old = s.agents.connections.lock().get(&agent).map(|c| c.conn_id);
    if let Some(old) = old {
        s.revoke_agent_control_locked(&mut control, agent, old);
    }
    let conn = Uuid::new_v4();
    let (shutdown, shutdown_rx) = watch::channel(None);
    let (sender, receiver) = mpsc::channel(capacity);
    s.agents.connections.lock().insert(
        agent,
        AgentConn {
            conn_id: conn,
            connected_at: chrono::Utc::now(),
            session_id: 1,
            shutdown,
            legacy_policy_delivery: false,
        },
    );
    s.agents.cmds.lock().insert(agent, sender);
    s.agents.modules.lock().insert(
        agent,
        RuntimeModules {
            conn_id: conn,
            report: module_report(1, true),
            pending: HashMap::new(),
            sent: HashSet::new(),
            last_sent: HashMap::new(),
        },
    );
    s.media.mjpeg_sessions.lock().insert(
        agent,
        crate::state::MjpegSession {
            requested_monitor: Some(0),
            agent_id: agent,
            user_id: Uuid::from_u128(1),
            conn_id: conn,
            prefs: crate::state::MjpegViewerPrefs {
                monitor: Some(0),
                jpeg_quality: 40,
                interval_ms: 200,
            },
        },
    );
    s.media.mjpeg_active_capture.lock().insert(
        agent,
        crate::control::capture_arbitration::ActiveCapture {
            generation: Uuid::new_v4(),
            retired_capture_ids: [None; 32],
            wire_monitor: Some(0),
            conn_id: conn,
            prefs: crate::state::MjpegViewerPrefs {
                monitor: Some(0),
                jpeg_quality: 40,
                interval_ms: 200,
            },
        },
    );
    s.media.store_frame(agent, tagged_frame(0));
    (conn, receiver, shutdown_rx)
}

/// The admin that owns the sessions registered by [`connect`].
pub fn user() -> AuthUser {
    let mut user = super::admin();
    user.user_id = Uuid::from_u128(1);
    user
}

/// A JPEG carrying capture-geometry metadata for `monitor`.
pub fn tagged_frame(monitor: u32) -> bytes::Bytes {
    let mut data = b"VantyrGeometry\0".to_vec();
    data.extend(serde_json::to_vec(&json!({"type":"capture_geometry","schema_version":1,"geometry":{"capture_id":Uuid::new_v4(),"geometry_revision":1,"monitor_index":monitor,"desktop":{"x":0,"y":0,"physical_width":1920,"physical_height":1080},"frame_width":960,"frame_height":540}})).unwrap());
    let mut jpeg = vec![0xff, 0xd8, 0xff, 0xef];
    jpeg.extend(((data.len() + 2) as u16).to_be_bytes());
    jpeg.extend(data);
    jpeg.extend([0xff, 0xd9]);
    bytes::Bytes::from(jpeg)
}
