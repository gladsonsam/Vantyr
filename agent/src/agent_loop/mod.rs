//! Agent Tokio runtime: IPC/WebSocket session, telemetry, and screen fan-in.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

/// Wall-clock epoch milliseconds (used as the screen-history "last input" activity stamp).
fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

use anyhow::Result;
use base64::Engine;
use tokio::sync::mpsc;
use tokio::time::{interval, interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

use crate::config::{AgentStatus, Config};
use crate::platform::activity_tracker::WindowTracker;
use crate::platform::input_control::InputController;
use crate::platform::keyboard_monitor::InputEvent;
use crate::reconnect::{reconnect_backoff_delay, set_status};

mod history;
mod transport;
mod url_session;

use history::{handle_history_ack, pump_history_spool, InFlightFrame, HISTORY_PUMP_INTERVAL_SECS};
use url_session::UrlTracker;

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

// NOTE: The capture worker already runs at ~5fps (see `capture.rs`). We avoid a separate
// fixed-rate "send" ticker so the agent doesn't wake up unnecessarily while streaming.

/// Bounded capacity for the JPEG frame channel.
pub const FRAME_CHANNEL_CAP: usize = 4;

/// Bounded capacity for the outbound WebSocket message channel.
const OUTBOUND_CHANNEL_CAP: usize = 16;

/// How often to poll the foreground window for title/app changes.
const WINDOW_POLL_INTERVAL_MS: u64 = 200;

/// How often to sample the active browser URL (UIAutomation-backed).
const URL_POLL_INTERVAL_SECS: u64 = 2;

// Adaptive polling while AFK (saves laptop CPU/battery; resumes instantly on activity).
const URL_POLL_AFK_INTERVAL_SECS: u64 = 10;
const WINDOW_POLL_AFK_INTERVAL_MS: u64 = 1_000;

/// How often to sample CPU/memory/disk for the health-history feature.
const METRICS_INTERVAL_SECS: u64 = 60;

pub async fn run_agent_loop(
    mut config_rx: tokio::sync::watch::Receiver<Option<Config>>,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_cfg: Arc<Mutex<Config>>,
    frame_tx: mpsc::Sender<Vec<u8>>,
    mut frame_rx: mpsc::Receiver<Vec<u8>>,
    mut key_rx: mpsc::Receiver<InputEvent>,
    status: Arc<Mutex<AgentStatus>>,
) {
    let (shared_rules, kill_report_tx) = start_app_block_enforcer(&shared_cfg);
    start_internet_curfew_scheduler(&shared_cfg);
    adopt_pending_enrollment(&shared_cfg, &config_tx).await;

    // The capture and audio stop-flags survive reconnects.
    let mut capture_stop: Option<Arc<AtomicBool>> = None;
    let mut audio_stop: Option<Arc<AtomicBool>> = None;
    let mut reconnect_attempt: u32 = 0;

    let recall = history::start_recall_capture(&shared_cfg);

    loop {
        // Snapshot current config (clears the "changed" flag too)
        let cfg_opt = config_rx.borrow_and_update().clone();

        match cfg_opt {
            None => {
                set_status(&status, AgentStatus::Disconnected);
                info!("No server URL configured - waiting for settings...");
                if config_rx.changed().await.is_err() {
                    return; // watch sender dropped = app exiting
                }
                continue;
            }
            Some(ref cfg) if cfg.server_url.is_empty() => {
                set_status(&status, AgentStatus::Disconnected);
                info!("Server URL is empty - waiting for settings...");
                if config_rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
            Some(_cfg) => {
                set_status(&status, AgentStatus::Connecting);
                info!("Connecting to service IPC pipe...");

                #[cfg(target_os = "windows")]
                let connect_res = transport::connect_service_ipc(&status).await;

                #[cfg(not(target_os = "windows"))]
                let connect_res = transport::start_ws_client(&shared_cfg, &status, &config_rx);

                match connect_res {
                    Ok((in_rx, out_tx, writer_handle)) => {
                        // Local IPC is connected. The service owns the real server WebSocket,
                        // so wait for its forwarded status before showing Connected.
                        set_status(&status, AgentStatus::Connecting);
                        match run_session(RunSessionArgs {
                            in_rx,
                            out_tx: out_tx.clone(),
                            frame_tx: &frame_tx,
                            frame_rx: &mut frame_rx,
                            key_rx: &mut key_rx,
                            capture_stop: &mut capture_stop,
                            audio_stop: &mut audio_stop,
                            history_spool: recall.spool.clone(),
                            history_notify: recall.notify.clone(),
                            history_active: recall.active.clone(),
                            history_last_input: recall.last_input.clone(),
                            history_settings: recall.settings.clone(),
                            history_enabled: recall.enabled,
                            shared_cfg: shared_cfg.clone(),
                            config_tx: config_tx.clone(),
                            shared_rules: shared_rules.clone(),
                            kill_report_tx: kill_report_tx.clone(),
                        })
                        .await
                        {
                            Ok(()) => info!("Session closed gracefully."),
                            Err(e) => error!("Session error: {e:#}"),
                        }
                        let _ = writer_handle.await;

                        stop_session_workers(&mut capture_stop, &mut audio_stop, &kill_report_tx);

                        set_status(&status, AgentStatus::Disconnected);
                        // Any successful connect resets backoff.
                        reconnect_attempt = 0;
                    }
                    Err(e) => {
                        set_status(&status, AgentStatus::Error(e.to_string()));
                        error!("IPC connection failed: {e:#}");
                        reconnect_attempt = reconnect_attempt.saturating_add(1);
                    }
                }

                // Wait before reconnect; wake early if the user updates config
                let delay = reconnect_backoff_delay(reconnect_attempt.max(1));
                info!("Reconnecting in {}ms...", delay.as_millis());
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    _ = config_rx.changed() => {
                        reconnect_attempt = 0;
                        info!("Config changed - applying new settings immediately.");
                    }
                }
            }
        }
    }
}

/// Load the persisted app block rules so enforcement starts immediately, and
/// start the enforcer. Returns the live rule set and the kill-report sink slot.
fn start_app_block_enforcer(
    shared_cfg: &Mutex<Config>,
) -> (
    crate::policy::app_block::SharedRules,
    crate::policy::app_block::KillReportTx,
) {
    // Load persisted app block rules from config so enforcement starts immediately.
    let shared_rules = crate::policy::app_block::new_shared_rules();
    {
        let cfg = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
        let persisted: Vec<crate::policy::app_block::BlockRule> = cfg
            .app_block_rules
            .iter()
            .map(crate::policy::app_block::BlockRule::from_stored)
            .collect();
        if !persisted.is_empty() {
            info!("Loaded {} persisted app block rule(s).", persisted.len());
            *shared_rules.lock().unwrap_or_else(|e| e.into_inner()) = persisted;
        }
    }
    let kill_report_tx = crate::policy::app_block::new_kill_report_tx();
    let rules_for_enforcer = shared_rules.clone();
    let kill_tx_for_enforcer = kill_report_tx.clone();
    tokio::spawn(async move {
        crate::policy::app_block::run_enforcer(rules_for_enforcer, kill_tx_for_enforcer).await;
    });
    (shared_rules, kill_report_tx)
}

/// Enforce scheduled internet curfews locally (agent time) even when offline.
fn start_internet_curfew_scheduler(shared_cfg: &Arc<Mutex<Config>>) {
    let cfg_for_sched = shared_cfg.clone();
    tokio::spawn(async move {
        crate::policy::network::scheduler::run_internet_curfew_scheduler(cfg_for_sched).await;
    });
}

/// Finish an enrollment queued before startup and hand the resulting config to
/// the loop.
async fn adopt_pending_enrollment(
    shared_cfg: &Mutex<Config>,
    config_tx: &tokio::sync::watch::Sender<Option<Config>>,
) {
    if matches!(
        crate::enrollment::try_consume_pending_enrollment().await,
        Ok(true)
    ) {
        let new_cfg = crate::config::load_config();
        if let Ok(mut g) = shared_cfg.lock() {
            *g = new_cfg.clone();
        }
        let watch_val = if new_cfg.server_url.is_empty() {
            None
        } else {
            Some(new_cfg)
        };
        let _ = config_tx.send(watch_val);
    }
}

/// Stop the capture and audio threads and detach the kill-report sink when a
/// session ends.
fn stop_session_workers(
    capture_stop: &mut Option<Arc<AtomicBool>>,
    audio_stop: &mut Option<Arc<AtomicBool>>,
    kill_report_tx: &crate::policy::app_block::KillReportTx,
) {
    // Stop the capture and audio threads on every session end.
    if let Some(stop) = capture_stop.take() {
        stop.store(true, Ordering::Relaxed);
        info!("Screen capture stopped (session ended).");
    }
    if let Some(stop) = audio_stop.take() {
        stop.store(true, Ordering::Relaxed);
        info!("Audio capture stopped (session ended).");
    }

    // Detach the kill-report sink so the enforcer doesn't
    // accumulate events while disconnected.
    *kill_report_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Bundles handles for [`run_session`] so the entry point stays under Clippy's argument limit.
struct RunSessionArgs<'a> {
    in_rx: mpsc::Receiver<Message>,
    out_tx: mpsc::Sender<Message>,
    frame_tx: &'a mpsc::Sender<Vec<u8>>,
    frame_rx: &'a mut mpsc::Receiver<Vec<u8>>,
    key_rx: &'a mut mpsc::Receiver<InputEvent>,
    capture_stop: &'a mut Option<Arc<AtomicBool>>,
    audio_stop: &'a mut Option<Arc<AtomicBool>>,
    history_spool: Option<Arc<crate::screen_spool::Spool>>,
    history_notify: Arc<tokio::sync::Notify>,
    history_active: Arc<AtomicBool>,
    history_last_input: Arc<AtomicU64>,
    history_settings: Arc<Mutex<crate::screen_history::HistorySettings>>,
    history_enabled: bool,
    shared_cfg: Arc<Mutex<Config>>,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_rules: crate::policy::app_block::SharedRules,
    kill_report_tx: crate::policy::app_block::KillReportTx,
}

async fn run_session(args: RunSessionArgs<'_>) -> Result<()> {
    let RunSessionArgs {
        mut in_rx,
        out_tx,
        frame_tx,
        frame_rx,
        key_rx,
        capture_stop,
        audio_stop,
        history_spool,
        history_notify,
        history_active,
        history_last_input,
        history_settings,
        history_enabled,
        shared_cfg,
        config_tx,
        shared_rules,
        kill_report_tx,
    } = args;

    // Register this session as the kill-event sink so the enforcer can report kills.
    let (kill_ev_tx, mut kill_ev_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::policy::app_block::KillEvent>();
    *kill_report_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(kill_ev_tx);
    // NOTE: `out_tx` writes to the Session 0 service over IPC; the service owns the real WebSocket.
    let mut pending_events: Vec<serde_json::Value> = Vec::new();
    let mut flush_ticker = interval(Duration::from_millis(250));
    flush_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Note: avoid capturing `&mut pending_events` in a closure; it makes borrowing across
    // `.await` sites harder for the compiler. Push directly instead.

    let mut permission_report = send_session_hello(&out_tx).await;

    // Input controller. Remote input injection is best-effort: on Wayland-only
    // sessions the X11/xdo backend may be unavailable. Never let that fail the
    // whole session (which would take telemetry, capture, and keystroke
    // streaming down with it) — just disable injection for this session.
    let mut controller = match InputController::new() {
        Ok(c) => Some(c),
        Err(e) => {
            warn!("Remote input injection unavailable; continuing without it: {e:#}");
            None
        }
    };

    // Window focus tracker.
    let mut win_tracker = WindowTracker::new();
    let mut sent_app_icons: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Timers.
    let mut is_afk = false;
    let mut idle_generation =
        crate::permissions::Generation::capture(crate::permissions::Module::IdleActivity);
    let mut metrics_generation = None;
    let url_sleep = tokio::time::sleep(Duration::from_secs(URL_POLL_INTERVAL_SECS));
    let window_sleep = tokio::time::sleep(Duration::from_millis(WINDOW_POLL_INTERVAL_MS));
    tokio::pin!(url_sleep);
    tokio::pin!(window_sleep);
    let mut user_ticker = interval(Duration::from_secs(10));

    // First software inventory ~1 minute after connect, then periodically (only if changed).
    let mut software_ticker = interval_at(
        Instant::now() + Duration::from_secs(60),
        Duration::from_secs(300),
    );

    software_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Resource metrics (CPU/mem/disk) sampled on a fixed cadence for health history.
    // Persistent `System` so CPU% is averaged over the interval; prime it now.
    let mut metrics_sys = sysinfo::System::new();
    if crate::permissions::allowed(crate::permissions::Module::ResourceMetrics) {
        metrics_sys.refresh_cpu_all();
    }
    let mut metrics_ticker = interval_at(
        Instant::now() + Duration::from_secs(METRICS_INTERVAL_SECS),
        Duration::from_secs(METRICS_INTERVAL_SECS),
    );
    metrics_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // URL sessions (time-on-site): maintained locally, emitted on transitions.
    let mut url_tracker = UrlTracker::default();

    // WS liveness is handled by the Session 0 service-owned connection.

    let last_software_fingerprint: Arc<
        tokio::sync::Mutex<Option<(u64, crate::permissions::Generation)>>,
    > = Arc::new(tokio::sync::Mutex::new(None));

    // Active user attribution.
    // Keep a cached username so we don't run PowerShell for every event.
    let mut active_user: Option<String> = crate::inventory::system_info::active_username()
        .or_else(crate::inventory::system_info::env_username_fallback);

    // Screen-history keyframes handed to the server but not yet acked, keyed by the
    // spool uid. Dropped wholesale when the session ends, so anything unacked is
    // simply re-sent next session (the server dedupes on uid).
    let mut history_in_flight: HashMap<String, InFlightFrame> = HashMap::new();
    let mut history_ticker = interval(Duration::from_secs(HISTORY_PUMP_INTERVAL_SECS));
    history_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Event loop.
    let result: Result<()> = loop {
        tokio::select! {
            biased;

            // Branch 1: inbound server commands forwarded by service over IPC.
            msg = in_rx.recv() => {
                match msg {
                    Some(Message::Text(text)) => {
                        // Keyframe acks are session bookkeeping, not a server command:
                        // consume them here and nudge the pump so the next frame ships
                        // right away instead of waiting for the tick.
                        if text.contains("history_frame_ack")
                            && handle_history_ack(&text, &mut history_in_flight)
                        {
                            history_notify.notify_one();
                            continue;
                        }
                        crate::commands::handle_server_command(crate::commands::ServerCommandArgs {
                            text: &text,
                            frame_tx,
                            capture_stop,
                            audio_stop,
                            controller: controller.as_mut(),
                            shared_cfg: &shared_cfg,
                            config_tx: &config_tx,
                            out_tx: out_tx.clone(),
                            shared_rules: &shared_rules,
                            history_settings: &history_settings,
                        });
                    }
                    Some(_) => {}
                    None => break Ok(()),
                }
            }

            // Branch 1e: active username refresh (best-effort).
            _ = user_ticker.tick() => {
                // Running PowerShell can block; do it off-thread.
                let next = tokio::task::spawn_blocking(|| {
                    crate::inventory::system_info::active_username()
                        .or_else(crate::inventory::system_info::env_username_fallback)
                }).await.ok().flatten();
                if next != active_user {
                    active_user = next;
                }
            }

            // Branch 1d: telemetry flush.
            _ = flush_ticker.tick() => {
                let next_idle=crate::permissions::Generation::capture(crate::permissions::Module::IdleActivity);
                if next_idle != idle_generation { idle_generation=next_idle; is_afk=false; url_tracker.blocked_by_afk=false; history_active.store(true,Ordering::Relaxed); }
                if let Some(c) = controller.as_mut() { c.cleanup_revoked(); }
                let next = crate::permissions::load().unwrap_or_default().wire();
                if next != permission_report { permission_report = next; let _ = out_tx.send(Message::Text(permission_report.to_string())).await; }
                if !crate::permissions::allowed(crate::permissions::Module::BrowserUrls) { url_tracker.reset(); }
                if !crate::permissions::allowed(crate::permissions::Module::LiveScreen) { if let Some(s) = capture_stop.take() { s.store(true,Ordering::Relaxed); } }
                if !crate::permissions::allowed(crate::permissions::Module::LiveAudio) { if let Some(s) = audio_stop.take() { s.store(true,Ordering::Relaxed); } }

                if pending_events.len() >= 25 {
                    flush_events(&out_tx, &mut pending_events).await?;
                } else if !pending_events.is_empty() {
                    // Time-based flush keeps UI reasonably fresh without spamming frames.
                    flush_events(&out_tx, &mut pending_events).await?;
                }
            }

            // Branch 2: app block kill reports.
            ev = kill_ev_rx.recv() => {
                if let Some(kill) = ev {
                    pending_events.push(crate::permissions::stamp(serde_json::json!({
                        "type": "app_block_kill",
                        "rule_id": kill.rule_id,
                        "rule_name": kill.rule_name,
                        "exe_name": kill.exe_name,
                    }), Some(kill.generation)));
                }
            }

            // Branch 3: screen frame delivery.
            // Stream only when frames exist. Always drop to the latest frame.
            jpeg = frame_rx.recv() => {
                let mut latest = jpeg;
                while let Ok(j) = frame_rx.try_recv() {
                    latest = Some(j);
                }
                if let Some(jpeg) = latest.filter(|b| crate::permissions::message_allowed(&Message::Binary(b.clone()))) {
                    if out_tx.send(Message::Binary(jpeg)).await.is_err() {
                        break Err(anyhow::anyhow!(
                            "Outbound channel closed; writer task exited unexpectedly."
                        ));
                    }
                } else {
                    // Frame channel closed => capture stopped; keep session alive.
                }
            }

            // Branch 3b: ship spooled screen-history keyframes (Recall). Woken by
            // the spool writer on each new capture; the ticker below covers
            // backlog drain on reconnect and ack-timeout retries. Frames are sent
            // as their own JSON message (base64 JPEG + metadata), bypassing the
            // batch buffer to avoid bloating it, and are deleted from the spool
            // only once the server acks them.
            () = history_notify.notified(), if history_enabled => {
                if let Some(spool) = history_spool.as_deref() {
                    pump_history_spool(spool, &out_tx, &mut history_in_flight).await?;
                }
            }

            // Branch 3c: periodic spool drain — catches the reconnect backlog and
            // re-sends frames whose ack never arrived.
            _ = history_ticker.tick(), if history_enabled => {
                if let Some(spool) = history_spool.as_deref() {
                    pump_history_spool(spool, &out_tx, &mut history_in_flight).await?;
                }
            }

            // Branch 3: active browser URL.
            () = &mut url_sleep => {
                url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(if is_afk { URL_POLL_AFK_INTERVAL_SECS } else { URL_POLL_INTERVAL_SECS }));
                url_tracker.poll(&active_user, &mut pending_events);
            }

            // Branch 4: keystrokes / AFK.
            event = key_rx.recv() => {
                if let Some(ref e) = event {
                    if !e.generation().valid() { continue; }
                    let m = match e { InputEvent::Keys { .. } => crate::permissions::Module::KeyboardText, _ => crate::permissions::Module::IdleActivity };
                    if !crate::permissions::allowed(m) { continue; }
                }
                let payload = match event {
                    Some(InputEvent::Keys {
                        text,
                        app,
                        app_display,
                        window,
                        ts,
                        generation,
                        context_generation,
                    }) => {
                        // Typing is active interaction — speed up screen-history capture.
                        history_last_input.store(now_epoch_ms(), Ordering::Relaxed);
                        Some(crate::permissions::stamp(serde_json::json!({
                            "type"   : "keys",
                            "__window_generation": context_generation,
                            "text"   : text,
                            "app"    : app,
                            "app_display": app_display,
                            "window" : window,
                            "ts"     : ts,
                            "user"   : active_user,
                        }), Some(generation)))
                    }
                    Some(InputEvent::Afk { idle_secs, generation }) => {
                        // Close any in-flight URL session when user goes AFK.
                        is_afk = true;
                        url_tracker.blocked_by_afk = true;
                        // Pause screen-history capture while idle (no keyframes for
                        // an unchanging, unattended screen).
                        history_active.store(false, Ordering::Relaxed);
                        url_tracker.end_session(&mut pending_events);
                        // Slow down polling immediately while AFK.
                        url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(URL_POLL_AFK_INTERVAL_SECS));
                        window_sleep.as_mut().reset(Instant::now() + Duration::from_millis(WINDOW_POLL_AFK_INTERVAL_MS));
                        Some(crate::permissions::stamp(serde_json::json!({
                            "type"     : "afk",
                            "idle_secs": idle_secs,
                            "ts"       : crate::unix_timestamp_secs(),
                            "user"     : active_user,
                        }), Some(generation)))
                    }
                    Some(InputEvent::Active { generation }) => {
                        is_afk = false;
                        url_tracker.blocked_by_afk = false;
                        // Resume screen-history capture now the user is back, and mark
                        // this as fresh interaction so capture starts on the fast cadence.
                        history_active.store(true, Ordering::Relaxed);
                        history_last_input.store(now_epoch_ms(), Ordering::Relaxed);
                        // Resume normal polling immediately.
                        url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(URL_POLL_INTERVAL_SECS));
                        window_sleep.as_mut().reset(Instant::now() + Duration::from_millis(WINDOW_POLL_INTERVAL_MS));
                        Some(crate::permissions::stamp(serde_json::json!({
                            "type": "active",
                            "ts"  : crate::unix_timestamp_secs(),
                            "user": active_user,
                        }), Some(generation)))
                    }
                    None => break Ok(()),
                };
                if let Some(v) = payload {
                    pending_events.push(v);
                }
            }

            // Branch 5: foreground window changes.
            () = &mut window_sleep => {
                window_sleep.as_mut().reset(Instant::now() + Duration::from_millis(if is_afk { WINDOW_POLL_AFK_INTERVAL_MS } else { WINDOW_POLL_INTERVAL_MS }));
                if !crate::permissions::allowed(crate::permissions::Module::WindowActivity) { continue; }
                let generation = crate::permissions::Generation::capture(crate::permissions::Module::WindowActivity);
                if let Some(event) = win_tracker.poll() {
                    // Switching windows is active interaction — speed up screen-history capture.
                    history_last_input.store(now_epoch_ms(), Ordering::Relaxed);
                    push_window_focus(event, generation, &active_user, &mut sent_app_icons, &mut pending_events);
                }
            }

            // Branch 6: installed-software inventory (only if changed).
            _ = software_ticker.tick() => {
                if !crate::permissions::allowed(crate::permissions::Module::SoftwareInventory) { continue; }
                let o = out_tx.clone();
                let fp = last_software_fingerprint.clone();
                tokio::spawn(async move {
                    crate::inventory::software::send_inventory_if_changed(o, &fp).await;
                });
            }

            // Branch 7: resource metrics (CPU/mem/disk) for health history.
            _ = metrics_ticker.tick() => {
                if !crate::permissions::allowed(crate::permissions::Module::ResourceMetrics) { continue; }
                let next_generation=crate::permissions::Generation::capture(crate::permissions::Module::ResourceMetrics);
                if metrics_generation != next_generation { metrics_generation=next_generation; metrics_sys=sysinfo::System::new(); metrics_sys.refresh_cpu_all(); continue; }
                let m = crate::inventory::system_info::collect_resource_metrics(&mut metrics_sys);
                let _ = out_tx.send(Message::Text(m.to_string())).await;
            }
        }
    };

    // Shutdown.
    if let Some(c) = controller.as_mut() {
        c.release_all();
    }
    url_tracker.end_session(&mut pending_events);
    // Final best-effort flush (ensures last activity/url_session isn't lost).
    let _ = flush_events(&out_tx, &mut pending_events).await;

    result
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
                "keys" => crate::permissions::allowed(crate::permissions::Module::KeyboardText),
                "afk" | "active" => {
                    crate::permissions::allowed(crate::permissions::Module::IdleActivity)
                }
                "window_focus" | "app_icon" => {
                    crate::permissions::allowed(crate::permissions::Module::WindowActivity)
                }
                "url" | "url_session" => {
                    crate::permissions::allowed(crate::permissions::Module::BrowserUrls)
                }
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
                return Err(anyhow::anyhow!(
                    "Outbound channel closed; writer task exited unexpectedly."
                ));
            }
        }
        return Ok(());
    }
    // Prefer batching; fall back to individual sends if the batch is too large.
    let batch = serde_json::json!({ "type": "batch", "events": pending }).to_string();
    if batch.len() <= 250_000 {
        pending.clear();
        if out_tx.send(Message::Text(batch)).await.is_err() {
            return Err(anyhow::anyhow!(
                "Outbound channel closed; writer task exited unexpectedly."
            ));
        }
        return Ok(());
    }
    // Too large: send individually in order.
    let mut items = std::mem::take(pending);
    for v in items.drain(..) {
        let s = v.to_string();
        if out_tx.send(Message::Text(s)).await.is_err() {
            return Err(anyhow::anyhow!(
                "Outbound channel closed; writer task exited unexpectedly."
            ));
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
    let info_payload = crate::inventory::system_info::collect_agent_info().to_string();
    let _ = out_tx.send(Message::Text(info_payload)).await;
    permission_report
}

/// Queue a `window_focus` event, plus the app's icon the first time this
/// session sees its executable.
fn push_window_focus(
    event: crate::platform::types::WindowEvent,
    generation: Option<crate::permissions::Generation>,
    active_user: &Option<String>,
    sent_app_icons: &mut std::collections::HashSet<String>,
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
            pending_events.push(crate::permissions::stamp(
                serde_json::json!({
                    "type": "app_icon",
                    "exe_name": exe_key,
                    "png_base64": base64::engine::general_purpose::STANDARD.encode(png),
                    "ts": crate::unix_timestamp_secs(),
                }),
                generation,
            ));
        }
        // Avoid retrying constantly for executables that can't produce icons.
        sent_app_icons.insert(exe_key);
    }
    pending_events.push(crate::permissions::stamp(
        serde_json::json!({
            "type"  : "window_focus",
            "title" : event.title,
            "app"   : event.app,
            "app_display": event.app_display,
            "app_path": event.app_path,
            "hwnd"  : event.hwnd,
            "ts"    : crate::unix_timestamp_secs(),
            "user"  : active_user,
        }),
        generation,
    ));
}
