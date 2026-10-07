//! Capture mutations and leases share the control integration mutex. HTTP identity
//! alone never grants a bypass: two tabs of the same user obey the same freeze.
use crate::{
    agent_modules::{CommandDenied, Module},
    control::runtime::ControlRuntime,
    control::sessions::LeaseOwner,
    state::{AppState, MjpegSession, MjpegViewerPrefs},
};
use serde_json::{json, Value};
use std::time::Instant;
use uuid::Uuid;

pub(crate) type RetiredCaptures = (Uuid, [Option<Uuid>; 32]);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ActiveCapture {
    pub wire_monitor: Option<u32>,
    pub generation: Uuid,
    pub retired_capture_ids: [Option<Uuid>; 32],
    pub conn_id: Uuid,
    pub prefs: MjpegViewerPrefs,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct FrozenCapture {
    pub owner: LeaseOwner,
    pub session_id: Uuid,
    pub active: ActiveCapture,
}

pub(crate) fn resolve_monitor(
    request: Option<u32>,
    info: Option<&Value>,
) -> Result<Option<u32>, CommandDenied> {
    if request.is_some_and(|i| i >= 64) {
        return Err(denied("invalid_monitor", "Monitor index must be below 64."));
    }
    let monitors = info
        .and_then(|i| i["monitors"].as_array())
        .filter(|m| !m.is_empty());
    if let Some(monitors) = monitors {
        let primary = monitors
            .iter()
            .position(|m| m["primary"].as_bool() == Some(true))
            .unwrap_or(0) as u32;
        let index = request.unwrap_or(primary);
        if index as usize >= monitors.len() {
            return Err(denied(
                "invalid_monitor",
                "Monitor is absent from the recorded device inventory; refresh device information.",
            ));
        }
        Ok(Some(index))
    } else {
        Ok(request)
    }
}
fn denied(code: &'static str, message: &str) -> CommandDenied {
    CommandDenied::new(code, message, Some(Module::LiveScreen))
}
impl AppState {
    /// Called under control. No arbitrary old HTTP session can grant input for
    /// today's socket or for a selection replaced by a later read-only request.
    pub(crate) fn validate_control_capture(
        &self,
        agent: Uuid,
        owner: LeaseOwner,
        value: &Value,
    ) -> Result<FrozenCapture, CommandDenied> {
        self.agents
            .authorize_agent_command(agent, &json!({"type":"start_capture"}))?;
        let session = value["capture_session"]
            .as_str()
            .and_then(|s| s.parse::<Uuid>().ok())
            .ok_or_else(|| {
                denied(
                    "capture_session_required",
                    "Open a live stream and supply its session UUID as capture_session.",
                )
            })?;
        let mapped=self.media.mjpeg_sessions.lock().get(&session).copied()
            .filter(|s| s.agent_id==agent && s.user_id==owner.user_id && s.conn_id==owner.agent_connection_id)
            .ok_or_else(|| denied("capture_session_stale", "Live stream is missing, belongs to another user, or uses an old connection; reopen it."))?;
        let active=self.media.mjpeg_active_capture.lock().get(&agent).copied()
            .filter(|a| a.conn_id==owner.agent_connection_id && a.prefs.monitor==mapped.prefs.monitor)
            .ok_or_else(|| denied("capture_selection_stale", "Live display selection changed; reopen the requested stream before acquiring control."))?;
        let frame = self
            .media
            .frames
            .lock()
            .get(&agent)
            .cloned()
            .filter(|f| f.last_update.elapsed() <= std::time::Duration::from_secs(10))
            .ok_or_else(|| {
                denied(
                    "capture_frame_required",
                    "Wait for a fresh live frame before acquiring control.",
                )
            })?;
        let geometry=frame_geometry(&frame.jpeg)
            .ok_or_else(|| denied("capture_geometry_required", "Live frame has no verified physical desktop geometry. This capture is view-only until the agent provides valid geometry."))?;
        if (value.get("capture_id").is_some() || value.get("geometry_revision").is_some())
            && (value["capture_id"] != geometry["capture_id"]
                || value["geometry_revision"] != geometry["geometry_revision"])
        {
            return Err(denied("capture_geometry_stale", "Displayed frame geometry changed; wait for the current frame before acquiring control."));
        }
        let observed = geometry["capture_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        if active.retired_capture_ids.contains(&Some(observed)) {
            return Err(denied(
                "capture_frame_pending",
                "Wait for a frame from the new capture session before acquiring control.",
            ));
        }
        let index = geometry["monitor_index"].as_u64().unwrap() as u32;
        if active.prefs.monitor.is_some_and(|m| m != index) {
            return Err(denied(
                "capture_selection_stale",
                "Agent frame does not match the requested display; wait for its new frame.",
            ));
        }
        // The resolved monitor is pinned only by commit_control_capture, after
        // the lease is granted; a rejected acquire leaves the selection untouched.
        let mut active = active;
        active.prefs.monitor = Some(index);
        Ok(FrozenCapture {
            owner,
            session_id: session,
            active,
        })
    }
    /// Called under control after a successful acquire. Pins a default-monitor
    /// capture to the display the lease was validated against.
    pub(crate) fn commit_control_capture(&self, agent: Uuid, frozen: &FrozenCapture) {
        let mut captures = self.media.mjpeg_active_capture.lock();
        let Some(active) = captures
            .get_mut(&agent)
            .filter(|a| a.conn_id == frozen.active.conn_id && a.prefs.monitor.is_none())
        else {
            return;
        };
        active.prefs.monitor = frozen.active.prefs.monitor;
        drop(captures);
        for session in self.media.mjpeg_sessions.lock().values_mut().filter(|s| {
            s.agent_id == agent
                && s.conn_id == frozen.active.conn_id
                && s.requested_monitor.is_none()
        }) {
            session.prefs.monitor = frozen.active.prefs.monitor;
        }
    }
    /// Transactional admission: a conflict changes no sessions, counts, capture,
    /// or queue entries. A failed start closes the socket rather than letting old
    /// input/selection work cross an incomplete capture transition.
    pub(crate) fn begin_mjpeg_session(
        &self,
        agent: Uuid,
        session: Uuid,
        user: Uuid,
        mut prefs: MjpegViewerPrefs,
        requested_monitor: Option<u32>,
    ) -> Result<(), CommandDenied> {
        let mut control = self.control.lock();
        let expired = control.sessions.expire(Instant::now());
        self.deliver_control_cleanup(&mut control, expired);
        let conn = self
            .agents
            .connections
            .lock()
            .get(&agent)
            .filter(|c| c.shutdown.borrow().is_none())
            .map(|c| c.conn_id)
            .ok_or_else(|| denied("agent_offline", "Agent is offline or closing."))?;
        self.agents
            .authorize_agent_command(agent, &json!({"type":"start_capture"}))?;
        if self.media.mjpeg_sessions.lock().contains_key(&session) {
            return Err(denied(
                "duplicate_capture_session",
                "Use a fresh session UUID for each live stream.",
            ));
        }
        if prefs.monitor.is_none() && requested_monitor.is_none() {
            if let Some(active) = self
                .media
                .mjpeg_active_capture
                .lock()
                .get(&agent)
                .filter(|a| a.conn_id == conn && a.wire_monitor.is_none())
            {
                prefs.monitor = active.prefs.monitor;
            }
        }
        if let Some(frozen) = control.capture.get(&agent) {
            if frozen.active.conn_id != conn || frozen.active.prefs.monitor != prefs.monitor {
                return Err(denied("capture_selection_locked", "Another live control lease freezes the display. Release control, change the stream monitor, then reacquire."));
            }
        }
        let count = self
            .media
            .capture_viewers
            .lock()
            .get(&agent)
            .copied()
            .unwrap_or(0);
        if count >= 256 || self.media.mjpeg_sessions.lock().len() >= 4096 {
            return Err(denied(
                "capture_viewer_limit",
                "Too many live stream sessions; close an existing stream first.",
            ));
        }
        self.media.mjpeg_sessions.lock().insert(
            session,
            MjpegSession {
                requested_monitor,
                agent_id: agent,
                user_id: user,
                conn_id: conn,
                prefs,
            },
        );
        self.media.capture_viewers.lock().insert(agent, count + 1);
        // Latest accepted selection wins only without a lease. During a lease
        // both monitor and tuning are frozen, so compatible admission emits no restart.
        let result = self.sync_capture_locked(&control, agent, Some(prefs.monitor));
        if result.is_err() {
            self.media.mjpeg_sessions.lock().remove(&session);
            if count == 0 {
                self.media.capture_viewers.lock().remove(&agent);
            } else {
                self.media.capture_viewers.lock().insert(agent, count);
            }
        }
        result
    }
    pub(crate) fn end_mjpeg_session(&self, agent: Uuid, session: Uuid, user: Option<Uuid>) -> bool {
        let mut control = self.control.lock();
        let mapped = self.media.mjpeg_sessions.lock().get(&session).copied();
        let Some(mapped) =
            mapped.filter(|s| s.agent_id == agent && user.is_none_or(|u| u == s.user_id))
        else {
            return false;
        };
        self.media.mjpeg_sessions.lock().remove(&session);
        if control
            .capture
            .get(&agent)
            .is_some_and(|c| c.session_id == session)
        {
            self.revoke_agent_control_locked(&mut control, agent, mapped.conn_id);
        }
        let remaining = self
            .media
            .mjpeg_sessions
            .lock()
            .values()
            .filter(|s| s.agent_id == agent)
            .count() as u32;
        if remaining == 0 {
            self.media.capture_viewers.lock().remove(&agent);
        } else {
            self.media.capture_viewers.lock().insert(agent, remaining);
        }
        let _ = self.sync_capture_locked(&control, agent, None);
        true
    }
    pub(crate) fn clear_capture_connection_locked(&self, agent: Uuid, conn: Uuid) {
        let mut retired = self.media.mjpeg_retired_captures.lock();
        if retired.get(&agent).is_some_and(|e| e.0 == conn) {
            retired.remove(&agent);
        }
        drop(retired);
        self.media
            .mjpeg_sessions
            .lock()
            .retain(|_, s| s.agent_id != agent || s.conn_id != conn);
        let remaining = self
            .media
            .mjpeg_sessions
            .lock()
            .values()
            .filter(|s| s.agent_id == agent)
            .count() as u32;
        if remaining == 0 {
            self.media.capture_viewers.lock().remove(&agent);
        } else {
            self.media.capture_viewers.lock().insert(agent, remaining);
        }
        let mut active = self.media.mjpeg_active_capture.lock();
        if active.get(&agent).is_some_and(|a| a.conn_id == conn) {
            active.remove(&agent);
            self.media.frames.lock().remove(&agent);
        }
    }
    pub(crate) fn sync_mjpeg_capture(&self, agent: Uuid) {
        let control = self.control.lock();
        let _ = self.sync_capture_locked(&control, agent, None);
    }
    fn sync_capture_locked(
        &self,
        control: &ControlRuntime,
        agent: Uuid,
        requested: Option<Option<u32>>,
    ) -> Result<(), CommandDenied> {
        let conn = self
            .agents
            .connections
            .lock()
            .get(&agent)
            .filter(|c| c.shutdown.borrow().is_none())
            .map(|c| c.conn_id);
        let sessions: Vec<_> = self
            .media
            .mjpeg_sessions
            .lock()
            .values()
            .filter(|s| s.agent_id == agent && Some(s.conn_id) == conn)
            .copied()
            .collect();
        let old = self.media.mjpeg_active_capture.lock().get(&agent).copied();
        if sessions.is_empty() {
            if let Some(old) = old.filter(|a| Some(a.conn_id) == conn) {
                self.enqueue_capture(agent, old.conn_id, json!({"type":"stop_capture"}), None)?;
            }
            self.media.mjpeg_active_capture.lock().remove(&agent);
            return Ok(());
        }
        let conn = conn.unwrap();
        let selection = requested.unwrap_or_else(|| {
            old.filter(|a| a.conn_id == conn)
                .map(|a| a.prefs.monitor)
                .unwrap_or(sessions[0].prefs.monitor)
        });
        let prefs = if let Some(frozen) = control
            .capture
            .get(&agent)
            .filter(|c| c.active.conn_id == conn)
        {
            frozen.active.prefs
        } else {
            MjpegViewerPrefs {
                monitor: selection,
                jpeg_quality: sessions.iter().map(|s| s.prefs.jpeg_quality).max().unwrap(),
                interval_ms: sessions.iter().map(|s| s.prefs.interval_ms).min().unwrap(),
            }
        };
        let wire_monitor = old
            .filter(|a| a.conn_id == conn && a.prefs.monitor == prefs.monitor)
            .map(|a| a.wire_monitor)
            .unwrap_or_else(|| {
                sessions
                    .iter()
                    .find(|s| s.prefs.monitor == prefs.monitor)
                    .map(|s| s.requested_monitor)
                    .unwrap_or(prefs.monitor)
            });
        if old.is_some_and(|a| {
            a.conn_id == conn
                && a.prefs == prefs
                && a.wire_monitor == wire_monitor
                && !a.generation.is_nil()
        }) {
            return Ok(());
        }
        let observed = self
            .media
            .frames
            .lock()
            .get(&agent)
            .and_then(|f| frame_geometry(&f.jpeg))
            .and_then(|g| {
                g["capture_id"]
                    .as_str()
                    .and_then(|id| id.parse::<Uuid>().ok())
            });
        let retired_capture_ids = {
            let mut retired = self.media.mjpeg_retired_captures.lock();
            let entry = retired.entry(agent).or_insert((conn, [None; 32]));
            if entry.0 != conn {
                *entry = (conn, [None; 32]);
            }
            if let Some(id) = observed.filter(|id| !entry.1.contains(&Some(*id))) {
                entry.1.rotate_right(1);
                entry.1[0] = Some(id);
            }
            entry.1
        };
        let active = ActiveCapture {
            conn_id: conn,
            prefs,
            wire_monitor,
            generation: Uuid::new_v4(),
            retired_capture_ids,
        };
        // start_capture atomically replaces capture on the agent; avoid a separate
        // stop which could succeed while start fails on a full queue.
        self.enqueue_capture(agent,conn,json!({"type":"start_capture","monitor":wire_monitor,"jpeg_quality":prefs.jpeg_quality,"interval_ms":prefs.interval_ms}), Some(active.generation))?;
        self.media.mjpeg_active_capture.lock().insert(agent, active);
        self.media.frames.lock().remove(&agent); // never serve a cached frame from the previous selection
        Ok(())
    }
    fn enqueue_capture(
        &self,
        agent: Uuid,
        conn: Uuid,
        cmd: Value,
        generation: Option<Uuid>,
    ) -> Result<(), CommandDenied> {
        let mut command = self.agents.authorize_agent_command(agent, &cmd)?;
        command["__capture_generation"] = generation.map(|g| json!(g)).unwrap_or(json!("stopped"));
        let result = self.agents.enqueue_authorized_command(agent, conn, command);
        if result.is_err() {
            if let Some(c) = self
                .agents
                .connections
                .lock()
                .get(&agent)
                .filter(|c| c.conn_id == conn)
            {
                c.shutdown.send_replace(Some(""));
            }
        }
        result
    }
}
#[cfg(test)]
mod tests;

/// Read only bounded JPEG header segments; never decode/re-encode pixels or
/// modify APP15. Absence/invalid geometry denies control, not read-only viewing.
pub(crate) fn frame_geometry(jpeg: &[u8]) -> Option<Value> {
    if !jpeg.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut at = 2;
    for _ in 0..128 {
        if jpeg.get(at) != Some(&0xff) {
            return None;
        }
        while jpeg.get(at) == Some(&0xff) {
            at += 1;
        }
        let marker = *jpeg.get(at)?;
        at += 1;
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        if matches!(marker, 0xd0..=0xd7 | 0x01) {
            continue;
        }
        let len = u16::from_be_bytes([*jpeg.get(at)?, *jpeg.get(at + 1)?]) as usize;
        if len < 2 {
            return None;
        }
        let data = jpeg.get(at + 2..at.checked_add(len)?)?;
        at += len;
        if marker == 0xef && data.starts_with(b"VantyrGeometry\0") {
            if data.len() > 16384 {
                return None;
            }
            let value: Value = serde_json::from_slice(&data[15..]).ok()?;
            if value["type"] != "capture_geometry" || value["schema_version"] != 1 {
                return None;
            }
            let g = &value["geometry"];
            g["capture_id"].as_str()?.parse::<Uuid>().ok()?;
            if g["geometry_revision"].as_u64()? == 0 {
                return None;
            }
            for field in ["frame_width", "frame_height"] {
                if !(1..=65535).contains(&g[field].as_u64()?) {
                    return None;
                }
            }
            for field in ["physical_width", "physical_height"] {
                if !(1..=65535).contains(&g["desktop"][field].as_u64()?) {
                    return None;
                }
            }
            for (origin, size) in [("x", "physical_width"), ("y", "physical_height")] {
                let origin = i32::try_from(g["desktop"][origin].as_i64()?).ok()?;
                if i64::from(origin) + g["desktop"][size].as_u64()? as i64 - 1 > i64::from(i32::MAX)
                {
                    return None;
                }
            }
            if g["monitor_index"].as_u64()? >= 64 {
                return None;
            }
            return Some(g.clone());
        }
    }
    None
}
