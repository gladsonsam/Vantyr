//! One connected session: the select loop that fans telemetry, commands, frames and
//! Recall keyframes between the local IPC channel and the server.
//!
//! [`run_session`] owns the channels and tickers the `select!` polls. Everything its
//! branches share and mutate (pending telemetry, AFK state, trackers, the input
//! controller, the capture stop-flags) lives in [`Session`], with one method per
//! branch, so each branch reads on its own.

use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use anyhow::Result;
use base64::Engine;
use tokio::sync::mpsc;
use tokio::time::{interval, interval_at, Instant, MissedTickBehavior, Sleep};
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use super::history::{
    handle_history_ack, pump_history_spool, InFlightFrame, RecallPipeline,
    HISTORY_PUMP_INTERVAL_SECS,
};
use super::now_epoch_ms;
use super::url_session::UrlTracker;
use crate::config::Config;
use crate::input::remote::InputController;
use crate::outbound::{self, telemetry};
use crate::permissions::{Generation, Module};
use crate::platform::activity_tracker::WindowTracker;
use crate::platform::keyboard_monitor::InputEvent;

/// How often to poll the foreground window for title/app changes.
const WINDOW_POLL_INTERVAL_MS: u64 = 200;

/// How often to sample the active browser URL (UIAutomation-backed).
const URL_POLL_INTERVAL_SECS: u64 = 2;

// Adaptive polling while AFK (saves laptop CPU/battery; resumes instantly on activity).
const URL_POLL_AFK_INTERVAL_SECS: u64 = 10;
const WINDOW_POLL_AFK_INTERVAL_MS: u64 = 1_000;

/// How often to sample CPU/memory/disk for the health-history feature.
const METRICS_INTERVAL_SECS: u64 = 60;

/// The error when the writer task behind `out_tx` has gone.
const CLOSED_OUTBOUND: &str = "Outbound channel closed; writer task exited unexpectedly.";

/// What a session is started with: the channels its `select!` polls, plus the
/// handles its branches act through ([`SessionHandles`]).
pub(super) struct RunSessionArgs<'a> {
    pub(super) in_rx: mpsc::Receiver<Message>,
    pub(super) frame_rx: &'a mut mpsc::Receiver<Vec<u8>>,
    pub(super) key_rx: &'a mut mpsc::Receiver<InputEvent>,
    pub(super) kill_report_tx: crate::policy::app_block::KillReportTx,
    pub(super) handles: SessionHandles<'a>,
}

/// Process-lifetime handles a session acts through; they outlive reconnects.
pub(super) struct SessionHandles<'a> {
    pub(super) out_tx: mpsc::Sender<Message>,
    pub(super) frame_tx: &'a mpsc::Sender<Vec<u8>>,
    pub(super) capture_stop: &'a mut Option<Arc<AtomicBool>>,
    pub(super) audio_stop: &'a mut Option<Arc<AtomicBool>>,
    pub(super) recall: RecallPipeline,
    pub(super) shared_cfg: Arc<Mutex<Config>>,
    pub(super) config_tx: tokio::sync::watch::Sender<Option<Config>>,
    pub(super) shared_rules: crate::policy::app_block::SharedRules,
}

/// What the `select!` branches share and mutate between ticks.
struct Session<'a> {
    out_tx: mpsc::Sender<Message>,
    frame_tx: &'a mpsc::Sender<Vec<u8>>,
    capture_stop: &'a mut Option<Arc<AtomicBool>>,
    audio_stop: &'a mut Option<Arc<AtomicBool>>,
    recall: RecallPipeline,
    shared_cfg: Arc<Mutex<Config>>,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_rules: crate::policy::app_block::SharedRules,

    /// Telemetry waiting for the next flush tick.
    pending_events: Vec<serde_json::Value>,
    /// The module-grant report last sent; a change is re-sent.
    permission_report: serde_json::Value,
    /// Remote input injection; `None` when the backend is unavailable.
    controller: Option<InputController>,

    win_tracker: WindowTracker,
    sent_app_icons: HashSet<String>,
    url_tracker: UrlTracker,
    /// Cached so we don't query the OS for every event.
    active_user: Option<String>,
    is_afk: bool,
    idle_generation: Option<Generation>,
    metrics_generation: Option<Generation>,
    metrics_sys: sysinfo::System,
    last_software_fingerprint: Arc<tokio::sync::Mutex<Option<(u64, Generation)>>>,
    /// Screen-history keyframes handed to the server but not yet acked, keyed by the
    /// spool uid. Dropped wholesale when the session ends, so anything unacked is
    /// simply re-sent next session (the server dedupes on uid).
    history_in_flight: HashMap<String, InFlightFrame>,

    /// Pollers with a moving deadline: re-armed by their branch and by AFK changes.
    url_sleep: Pin<Box<Sleep>>,
    window_sleep: Pin<Box<Sleep>>,
}

pub(super) async fn run_session(args: RunSessionArgs<'_>) -> Result<()> {
    let RunSessionArgs {
        mut in_rx,
        frame_rx,
        key_rx,
        kill_report_tx,
        handles,
    } = args;

    // Register this session as the kill-event sink so the enforcer can report kills.
    let (kill_ev_tx, mut kill_ev_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::policy::app_block::KillEvent>();
    *kill_report_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(kill_ev_tx);

    // NOTE: `out_tx` writes to the Session 0 service over IPC; the service owns the real WebSocket.
    let permission_report = send_session_hello(&handles.out_tx).await;
    let mut session = Session::new(handles, permission_report);

    let mut flush_ticker = interval(Duration::from_millis(250));
    flush_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut user_ticker = interval(Duration::from_secs(10));
    // First software inventory ~1 minute after connect, then periodically (only if changed).
    let mut software_ticker = interval_at(
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(300),
    );
    software_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut metrics_ticker = interval_at(
        Instant::now() + Duration::from_secs(METRICS_INTERVAL_SECS),
        Duration::from_secs(METRICS_INTERVAL_SECS),
    );
    metrics_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut history_ticker = interval(Duration::from_secs(HISTORY_PUMP_INTERVAL_SECS));
    history_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Event loop. A branch ends the session by returning `Break` (channel closed) or an error.
    let result: Result<()> = loop {
        let step: Result<ControlFlow<()>> = tokio::select! {
            biased;

            // Inbound server commands forwarded by the service over IPC.
            msg = in_rx.recv() => match msg {
                Some(Message::Text(text)) => {
                    session.on_server_text(&text);
                    Ok(ControlFlow::Continue(()))
                }
                Some(_) => Ok(ControlFlow::Continue(())),
                None => Ok(ControlFlow::Break(())),
            },

            // Active username refresh (best-effort).
            _ = user_ticker.tick() => {
                session.refresh_active_user().await;
                Ok(ControlFlow::Continue(()))
            }

            // Telemetry flush, plus the periodic grant housekeeping.
            _ = flush_ticker.tick() => session.on_flush_tick().await.map(ControlFlow::Continue),

            // App block kill reports.
            ev = kill_ev_rx.recv() => {
                if let Some(kill) = ev {
                    session.on_kill_event(kill);
                }
                Ok(ControlFlow::Continue(()))
            }

            // Screen frame delivery. Stream only when frames exist; always drop to the latest.
            jpeg = frame_rx.recv() => session.on_frame(jpeg, frame_rx).await.map(ControlFlow::Continue),

            // Ship spooled screen-history keyframes (Recall). Woken by the spool writer
            // on each new capture; the ticker below covers backlog drain on reconnect
            // and ack-timeout retries. Frames are sent as their own message (bypassing
            // the batch buffer) and deleted from the spool only once the server acks them.
            () = session.recall.notify.notified(), if session.recall.enabled => {
                session.pump_history().await.map(ControlFlow::Continue)
            }
            _ = history_ticker.tick(), if session.recall.enabled => {
                session.pump_history().await.map(ControlFlow::Continue)
            }

            // Active browser URL.
            () = &mut session.url_sleep => {
                session.on_url_poll();
                Ok(ControlFlow::Continue(()))
            }

            // Keystrokes / AFK.
            event = key_rx.recv() => Ok(session.on_input_event(event)),

            // Foreground window changes.
            () = &mut session.window_sleep => {
                session.on_window_poll();
                Ok(ControlFlow::Continue(()))
            }

            // Installed-software inventory (only if changed).
            _ = software_ticker.tick() => {
                session.on_software_tick();
                Ok(ControlFlow::Continue(()))
            }

            // Resource metrics (CPU/mem/disk) for health history.
            _ = metrics_ticker.tick() => session.on_metrics_tick().await.map(ControlFlow::Continue),
        };
        match step {
            Ok(ControlFlow::Continue(())) => {}
            Ok(ControlFlow::Break(())) => break Ok(()),
            Err(e) => break Err(e),
        }
    };

    session.shutdown().await;
    result
}

impl<'a> Session<'a> {
    fn new(handles: SessionHandles<'a>, permission_report: serde_json::Value) -> Self {
        let SessionHandles {
            out_tx,
            frame_tx,
            capture_stop,
            audio_stop,
            recall,
            shared_cfg,
            config_tx,
            shared_rules,
        } = handles;
        // Input controller. Remote input injection is best-effort: on Wayland-only
        // sessions the X11/xdo backend may be unavailable. Never let that fail the
        // whole session (which would take telemetry, capture, and keystroke
        // streaming down with it) — just disable injection for this session.
        let controller = match InputController::new() {
            Ok(c) => Some(c),
            Err(e) => {
                warn!("Remote input injection unavailable; continuing without it: {e:#}");
                None
            }
        };

        // Resource metrics are sampled on a fixed cadence with a persistent `System`
        // so CPU% is averaged over the interval; prime it now.
        let mut metrics_sys = sysinfo::System::new();
        if crate::permissions::allowed(Module::ResourceMetrics) {
            metrics_sys.refresh_cpu_all();
        }

        Self {
            out_tx,
            frame_tx,
            capture_stop,
            audio_stop,
            recall,
            shared_cfg,
            config_tx,
            shared_rules,
            pending_events: Vec::new(),
            permission_report,
            controller,
            win_tracker: WindowTracker::new(),
            sent_app_icons: HashSet::new(),
            url_tracker: UrlTracker::default(),
            active_user: crate::inventory::system_info::active_username()
                .or_else(crate::inventory::system_info::env_username_fallback),
            is_afk: false,
            idle_generation: Generation::capture(Module::IdleActivity),
            metrics_generation: None,
            metrics_sys,
            last_software_fingerprint: Arc::new(tokio::sync::Mutex::new(None)),
            history_in_flight: HashMap::new(),
            url_sleep: Box::pin(tokio::time::sleep(Duration::from_secs(
                URL_POLL_INTERVAL_SECS,
            ))),
            window_sleep: Box::pin(tokio::time::sleep(Duration::from_millis(
                WINDOW_POLL_INTERVAL_MS,
            ))),
        }
    }

    /// Hand a server command to the dispatcher, or consume a keyframe ack here.
    fn on_server_text(&mut self, text: &str) {
        // Keyframe acks are session bookkeeping, not a server command: consume them
        // here and nudge the pump so the next frame ships right away instead of
        // waiting for the tick.
        if text.contains("history_frame_ack")
            && handle_history_ack(text, &mut self.history_in_flight)
        {
            self.recall.notify.notify_one();
            return;
        }
        crate::commands::handle_server_command(crate::commands::ServerCommandArgs {
            text,
            frame_tx: self.frame_tx,
            capture_stop: self.capture_stop,
            audio_stop: self.audio_stop,
            controller: self.controller.as_mut(),
            shared_cfg: &self.shared_cfg,
            config_tx: &self.config_tx,
            out_tx: self.out_tx.clone(),
            shared_rules: &self.shared_rules,
            history_settings: &self.recall.settings,
        });
    }

    async fn refresh_active_user(&mut self) {
        // Running PowerShell can block; do it off-thread.
        let next = tokio::task::spawn_blocking(|| {
            crate::inventory::system_info::active_username()
                .or_else(crate::inventory::system_info::env_username_fallback)
        })
        .await
        .ok()
        .flatten();
        if next != self.active_user {
            self.active_user = next;
        }
    }

    /// The 250 ms tick: notice grant changes, stop work whose module was revoked and
    /// send the queued telemetry.
    async fn on_flush_tick(&mut self) -> Result<()> {
        let next_idle = Generation::capture(Module::IdleActivity);
        if next_idle != self.idle_generation {
            self.idle_generation = next_idle;
            self.is_afk = false;
            self.url_tracker.blocked_by_afk = false;
            self.recall.active.store(true, Ordering::Relaxed);
        }
        if let Some(c) = self.controller.as_mut() {
            c.cleanup_revoked();
        }
        let next = crate::permissions::load().unwrap_or_default().wire();
        if next != self.permission_report {
            self.permission_report = next;
            let _ = self
                .out_tx
                .send(Message::Text(self.permission_report.to_string()))
                .await;
        }
        if !crate::permissions::allowed(Module::BrowserUrls) {
            self.url_tracker.reset();
        }
        if !crate::permissions::allowed(Module::LiveScreen) {
            if let Some(s) = self.capture_stop.take() {
                s.store(true, Ordering::Relaxed);
            }
        }
        if !crate::permissions::allowed(Module::LiveAudio) {
            if let Some(s) = self.audio_stop.take() {
                s.store(true, Ordering::Relaxed);
            }
        }
        // Time-based flush keeps the UI reasonably fresh without spamming frames.
        flush_events(&self.out_tx, &mut self.pending_events).await
    }

    fn on_kill_event(&mut self, kill: crate::policy::app_block::KillEvent) {
        self.pending_events.push(outbound::stamped(
            &telemetry::AppBlockKill {
                rule_id: kill.rule_id,
                rule_name: &kill.rule_name,
                exe_name: &kill.exe_name,
            },
            Some(kill.generation),
        ));
    }

    /// Forward the newest screen frame, dropping any older ones queued behind it.
    async fn on_frame(
        &mut self,
        first: Option<Vec<u8>>,
        frame_rx: &mut mpsc::Receiver<Vec<u8>>,
    ) -> Result<()> {
        let mut latest = first;
        while let Ok(j) = frame_rx.try_recv() {
            latest = Some(j);
        }
        // A closed frame channel means capture stopped; the session stays alive.
        let Some(jpeg) = latest else {
            return Ok(());
        };
        let msg = Message::Binary(jpeg);
        if crate::permissions::message_allowed(&msg) && self.out_tx.send(msg).await.is_err() {
            anyhow::bail!(CLOSED_OUTBOUND);
        }
        Ok(())
    }

    async fn pump_history(&mut self) -> Result<()> {
        if let Some(spool) = self.recall.spool.as_deref() {
            pump_history_spool(spool, &self.out_tx, &mut self.history_in_flight).await?;
        }
        Ok(())
    }

    fn on_url_poll(&mut self) {
        let secs = if self.is_afk {
            URL_POLL_AFK_INTERVAL_SECS
        } else {
            URL_POLL_INTERVAL_SECS
        };
        self.url_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(secs));
        self.url_tracker
            .poll(&self.active_user, &mut self.pending_events);
    }

    /// Queue a keystroke / AFK / active event. `Break` when the monitor has gone away.
    fn on_input_event(&mut self, event: Option<InputEvent>) -> ControlFlow<()> {
        let Some(event) = event else {
            return ControlFlow::Break(());
        };
        if !event.generation().valid() {
            return ControlFlow::Continue(());
        }
        let module = match event {
            InputEvent::Keys { .. } => Module::KeyboardText,
            _ => Module::IdleActivity,
        };
        if !crate::permissions::allowed(module) {
            return ControlFlow::Continue(());
        }
        let payload = match event {
            InputEvent::Keys {
                text,
                app,
                app_display,
                window,
                ts,
                generation,
                context_generation,
            } => {
                // Typing is active interaction — speed up screen-history capture.
                self.recall
                    .last_input
                    .store(now_epoch_ms(), Ordering::Relaxed);
                outbound::stamped(
                    &telemetry::Keys {
                        window_generation: context_generation,
                        text: &text,
                        app: &app,
                        app_display: &app_display,
                        window: &window,
                        ts,
                        user: self.active_user.as_deref(),
                    },
                    Some(generation),
                )
            }
            InputEvent::Afk {
                idle_secs,
                generation,
            } => {
                self.enter_afk();
                outbound::stamped(
                    &telemetry::Afk {
                        idle_secs,
                        ts: crate::unix_timestamp_secs(),
                        user: self.active_user.as_deref(),
                    },
                    Some(generation),
                )
            }
            InputEvent::Active { generation } => {
                self.leave_afk();
                outbound::stamped(
                    &telemetry::Active {
                        ts: crate::unix_timestamp_secs(),
                        user: self.active_user.as_deref(),
                    },
                    Some(generation),
                )
            }
        };
        self.pending_events.push(payload);
        ControlFlow::Continue(())
    }

    fn enter_afk(&mut self) {
        self.is_afk = true;
        // Close any in-flight URL session when the user goes AFK.
        self.url_tracker.blocked_by_afk = true;
        // Pause screen-history capture while idle (no keyframes for an unchanging,
        // unattended screen).
        self.recall.active.store(false, Ordering::Relaxed);
        self.url_tracker.end_session(&mut self.pending_events);
        // Slow down polling immediately while AFK.
        self.url_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(URL_POLL_AFK_INTERVAL_SECS));
        self.window_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_millis(WINDOW_POLL_AFK_INTERVAL_MS));
    }

    fn leave_afk(&mut self) {
        self.is_afk = false;
        self.url_tracker.blocked_by_afk = false;
        // Resume screen-history capture now the user is back, and mark this as fresh
        // interaction so capture starts on the fast cadence.
        self.recall.active.store(true, Ordering::Relaxed);
        self.recall
            .last_input
            .store(now_epoch_ms(), Ordering::Relaxed);
        // Resume normal polling immediately.
        self.url_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_secs(URL_POLL_INTERVAL_SECS));
        self.window_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_millis(WINDOW_POLL_INTERVAL_MS));
    }

    fn on_window_poll(&mut self) {
        let ms = if self.is_afk {
            WINDOW_POLL_AFK_INTERVAL_MS
        } else {
            WINDOW_POLL_INTERVAL_MS
        };
        self.window_sleep
            .as_mut()
            .reset(Instant::now() + Duration::from_millis(ms));
        if !crate::permissions::allowed(Module::WindowActivity) {
            return;
        }
        let generation = Generation::capture(Module::WindowActivity);
        if let Some(event) = self.win_tracker.poll() {
            // Switching windows is active interaction — speed up screen-history capture.
            self.recall
                .last_input
                .store(now_epoch_ms(), Ordering::Relaxed);
            push_window_focus(
                event,
                generation,
                &self.active_user,
                &mut self.sent_app_icons,
                &mut self.pending_events,
            );
        }
    }

    fn on_software_tick(&self) {
        if !crate::permissions::allowed(Module::SoftwareInventory) {
            return;
        }
        let out = self.out_tx.clone();
        let fingerprint = self.last_software_fingerprint.clone();
        tokio::spawn(async move {
            crate::inventory::software::send_inventory_if_changed(out, &fingerprint).await;
        });
    }

    async fn on_metrics_tick(&mut self) -> Result<()> {
        if !crate::permissions::allowed(Module::ResourceMetrics) {
            return Ok(());
        }
        let next_generation = Generation::capture(Module::ResourceMetrics);
        if self.metrics_generation != next_generation {
            // A new grant: start a fresh baseline instead of reporting across the gap.
            self.metrics_generation = next_generation;
            self.metrics_sys = sysinfo::System::new();
            self.metrics_sys.refresh_cpu_all();
            return Ok(());
        }
        if let Some(m) =
            crate::inventory::system_info::collect_resource_metrics(&mut self.metrics_sys)
        {
            let _ = self.out_tx.send(Message::Text(m.to_string())).await;
        }
        Ok(())
    }

    /// Release held input, close the open URL session and make a final best-effort
    /// flush so the last activity/url_session isn't lost.
    async fn shutdown(&mut self) {
        if let Some(c) = self.controller.as_mut() {
            c.release_all();
        }
        self.url_tracker.end_session(&mut self.pending_events);
        let _ = flush_events(&self.out_tx, &mut self.pending_events).await;
    }
}

/// Send the queued telemetry events, batched when there is more than one.
/// Events whose module grant has gone are dropped first.
async fn flush_events(
    out_tx: &mpsc::Sender<Message>,
    pending: &mut Vec<serde_json::Value>,
) -> Result<()> {
    pending.retain(|v| {
        crate::permissions::outbound_allowed(v)
            && match v["type"].as_str().unwrap_or("") {
                "keys" => crate::permissions::allowed(Module::KeyboardText),
                "afk" | "active" => crate::permissions::allowed(Module::IdleActivity),
                "window_focus" | "app_icon" => crate::permissions::allowed(Module::WindowActivity),
                "url" | "url_session" => crate::permissions::allowed(Module::BrowserUrls),
                _ => true,
            }
    });
    if pending.is_empty() {
        return Ok(());
    }
    if pending.len() == 1 {
        if let Some(one) = pending.pop() {
            let s = one.to_string();
            if out_tx.send(Message::Text(s)).await.is_err() {
                anyhow::bail!(CLOSED_OUTBOUND);
            }
        }
        return Ok(());
    }
    // Prefer batching; fall back to individual sends if the batch is too large.
    let batch = outbound::to_text(&telemetry::Batch { events: pending });
    if batch.len() <= 250_000 {
        pending.clear();
        if out_tx.send(Message::Text(batch)).await.is_err() {
            anyhow::bail!(CLOSED_OUTBOUND);
        }
        return Ok(());
    }
    // Too large: send individually in order.
    let mut items = std::mem::take(pending);
    for v in items.drain(..) {
        let s = v.to_string();
        if out_tx.send(Message::Text(s)).await.is_err() {
            anyhow::bail!(CLOSED_OUTBOUND);
        }
    }
    Ok(())
}

/// Announce the session: current module grants and system info. Returns the
/// grant report sent, so later changes can be detected.
async fn send_session_hello(out_tx: &mpsc::Sender<Message>) -> serde_json::Value {
    let permission_report = crate::permissions::load().unwrap_or_default().wire();
    let _ = out_tx
        .send(Message::Text(permission_report.to_string()))
        .await;
    // Send system info once per session.
    if let Some(info) = crate::inventory::system_info::collect_agent_info_async().await {
        let _ = out_tx.send(Message::Text(info.to_string())).await;
    }
    permission_report
}

/// Queue a `window_focus` event, plus the app's icon the first time this
/// session sees its executable.
fn push_window_focus(
    event: crate::platform::types::WindowEvent,
    generation: Option<Generation>,
    active_user: &Option<String>,
    sent_app_icons: &mut HashSet<String>,
    pending_events: &mut Vec<serde_json::Value>,
) {
    // Opportunistically upload an app icon once per exe name per session.
    // This keeps the dashboard snappy without requiring extra round trips.
    let exe_key = event.app.trim().to_lowercase();
    if !exe_key.is_empty()
        && !sent_app_icons.contains(&exe_key)
        && !event.app_path.trim().is_empty()
    {
        // `ExtractIconExW` often fails for our own EXE even with a valid installer icon.
        // Fall back to the bundled `icons/icon.ico` so Activity shows a tile on the server.
        let png = crate::platform::activity_tracker::app_icon_png_for_path(&event.app_path, 64);
        if let Ok(png) = png {
            pending_events.push(outbound::stamped(
                &telemetry::AppIcon {
                    exe_name: &exe_key,
                    png_base64: &base64::engine::general_purpose::STANDARD.encode(png),
                    ts: crate::unix_timestamp_secs(),
                },
                generation,
            ));
        }
        // Avoid retrying constantly for executables that can't produce icons.
        sent_app_icons.insert(exe_key);
    }
    pending_events.push(outbound::stamped(
        &telemetry::WindowFocus {
            title: &event.title,
            app: &event.app,
            app_display: &event.app_display,
            app_path: &event.app_path,
            hwnd: event.hwnd,
            ts: crate::unix_timestamp_secs(),
            user: active_user.as_deref(),
        },
        generation,
    ));
}
