//! Agent Tokio runtime: IPC/WebSocket session, telemetry, and screen fan-in.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use tokio::sync::mpsc;
use tokio::time::{interval, interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info};

use crate::config::{AgentStatus, Config};
use crate::platform::activity_tracker::WindowTracker;
use crate::platform::input_control::InputController;
use crate::platform::keyboard_monitor::InputEvent;

#[derive(Debug, Clone)]
struct UrlSession {
    url: String,
    title: Option<String>,
    browser: Option<String>,
    user: Option<String>,
    started_at_instant: std::time::Instant,
    started_at_ts: i64,
}

fn url_session_event_value(sess: UrlSession, ended_at_ts: i64) -> serde_json::Value {
    let duration_ms = sess
        .started_at_instant
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    serde_json::json!({
        "type": "url_session",
        "url": sess.url,
        "title": sess.title,
        "browser": sess.browser,
        "user": sess.user,
        "started_at_ts": sess.started_at_ts,
        "ended_at_ts": ended_at_ts,
        "duration_ms": duration_ms,
    })
}

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

// NOTE: The capture worker already runs at ~5fps (see `capture.rs`). We avoid a separate
// fixed-rate "send" ticker so the agent doesn't wake up unnecessarily while streaming.

/// Exponential reconnect backoff parameters (WAN-friendly).
const RECONNECT_BACKOFF_BASE_MS: u64 = 750;
const RECONNECT_BACKOFF_MAX_MS: u64 = 30_000;

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

fn reconnect_backoff_delay(attempt: u32) -> Duration {
    // Exponential backoff with small jitter, no RNG dependency.
    let pow = attempt.min(6); // cap exponential growth (2^6 = 64x)
    let exp = 1u64.checked_shl(pow).unwrap_or(u64::MAX);
    let base = RECONNECT_BACKOFF_BASE_MS.saturating_mul(exp);
    let capped = base.min(RECONNECT_BACKOFF_MAX_MS);
    let jitter_ms = u64::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis(),
    ) % 500; // 0..499ms
    Duration::from_millis(capped.saturating_add(jitter_ms))
}

pub async fn run_agent_loop(
    mut config_rx: tokio::sync::watch::Receiver<Option<Config>>,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_cfg: Arc<Mutex<Config>>,
    frame_tx: mpsc::Sender<Vec<u8>>,
    mut frame_rx: mpsc::Receiver<Vec<u8>>,
    mut key_rx: mpsc::Receiver<InputEvent>,
    status: Arc<Mutex<AgentStatus>>,
) {
    // Load persisted app block rules from config so enforcement starts immediately.
    let shared_rules = crate::app_block::new_shared_rules();
    {
        let cfg = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
        let persisted: Vec<crate::app_block::BlockRule> = cfg
            .app_block_rules
            .iter()
            .map(crate::app_block::BlockRule::from_stored)
            .collect();
        if !persisted.is_empty() {
            info!("Loaded {} persisted app block rule(s).", persisted.len());
            *shared_rules.lock().unwrap_or_else(|e| e.into_inner()) = persisted;
        }
    }
    let kill_report_tx = crate::app_block::new_kill_report_tx();
    let rules_for_enforcer = shared_rules.clone();
    let kill_tx_for_enforcer = kill_report_tx.clone();
    tokio::spawn(async move {
        crate::app_block::run_enforcer(rules_for_enforcer, kill_tx_for_enforcer).await;
    });

    // Enforce scheduled internet curfews locally (agent time) even when offline.
    {
        let cfg_for_sched = shared_cfg.clone();
        tokio::spawn(async move {
            crate::network_scheduler::run_internet_curfew_scheduler(cfg_for_sched).await;
        });
    }
    #[cfg(target_os = "windows")]
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

    // The capture stop-flag survives reconnects.
    let mut capture_stop: Option<Arc<AtomicBool>> = None;
    let mut reconnect_attempt: u32 = 0;

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
                let connect_res = async {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                    use tokio::net::windows::named_pipe::ClientOptions;

                    let pipe = ClientOptions::new()
                        .open(crate::ipc::AGENT_IPC_PIPE_NAME)
                        .context("open agent IPC pipe")?;

                    let (pipe_r, mut pipe_w) = tokio::io::split(pipe);
                    let mut reader = BufReader::new(pipe_r);

                    // Ensure the service reloads machine config (best-effort) so changes from the UI
                    // take effect without restarting the service.
                    let _ = pipe_w
                        .write_all(crate::ipc::IpcLine::ConfigChanged.to_line().as_bytes())
                        .await;
                    let _ = pipe_w.flush().await;

                    let (in_tx, in_rx) = mpsc::channel::<Message>(256);
                    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_CHANNEL_CAP);

                    // Writer: translate tungstenite Messages to IPC lines.
                    let writer = tokio::spawn(async move {
                        while let Some(msg) = out_rx.recv().await {
                            match msg {
                                Message::Text(text) => {
                                    let line = crate::ipc::IpcLine::WsText { text }.to_line();
                                    if pipe_w.write_all(line.as_bytes()).await.is_err() {
                                        break;
                                    }
                                }
                                Message::Binary(bytes) => {
                                    let line = crate::ipc::outbound_binary_line(&bytes);
                                    if pipe_w.write_all(line.as_bytes()).await.is_err() {
                                        break;
                                    }
                                }
                                Message::Pong(_) | Message::Ping(_) => {}
                                Message::Close(_) => break,
                                _ => {}
                            }
                            let _ = pipe_w.flush().await;
                        }
                    });

                    // Reader: one line per server command, plus service-owned WS status updates.
                    let status_for_reader = status.clone();
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        loop {
                            buf.clear();
                            match reader.read_until(b'\n', &mut buf).await {
                                Ok(0) => break,
                                Ok(_) => {}
                                Err(_) => break,
                            }
                            while matches!(buf.last().copied(), Some(b'\n' | b'\r')) {
                                buf.pop();
                            }
                            if buf.is_empty() {
                                continue;
                            }
                            if let Some(line) = crate::ipc::IpcLine::from_slice(&buf) {
                                if let Some(ws_status) = line.into_agent_status() {
                                    set_status(&status_for_reader, ws_status);
                                    continue;
                                }
                            }
                            if let Ok(text) = String::from_utf8(buf.clone()) {
                                let _ = in_tx.send(Message::Text(text)).await;
                            }
                        }
                    });

                    Ok::<
                        (
                            mpsc::Receiver<Message>,
                            mpsc::Sender<Message>,
                            tokio::task::JoinHandle<()>,
                        ),
                        anyhow::Error,
                    >((in_rx, out_tx, writer))
                }
                .await;

                #[cfg(not(target_os = "windows"))]
                let connect_res: Result<
                    (
                        mpsc::Receiver<Message>,
                        mpsc::Sender<Message>,
                        tokio::task::JoinHandle<()>,
                    ),
                    anyhow::Error,
                > = {
                    let (in_tx, in_rx) = mpsc::channel::<Message>(256);
                    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_CHANNEL_CAP);
                    let (ws_out_tx, ws_out_rx) =
                        mpsc::channel::<crate::ipc::OutboundFrame>(OUTBOUND_CHANNEL_CAP);
                    let (inbound_text_tx, _) = tokio::sync::broadcast::channel::<String>(256);
                    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                    let (cfg_changed_tx, cfg_changed_rx) = tokio::sync::watch::channel(0u64);

                    let ws_cfg = shared_cfg.clone();
                    let ws_status = status.clone();
                    let ws_inbound_text_tx = inbound_text_tx.clone();
                    tokio::spawn(async move {
                        crate::ws_client::run_ws_client(
                            ws_cfg,
                            ws_status,
                            ws_out_rx,
                            ws_inbound_text_tx,
                            stop_rx,
                            cfg_changed_rx,
                            crate::ws_client::WsClientOpts {
                                run_context: "linux-user",
                                ..Default::default()
                            },
                        )
                        .await;
                    });

                    let mut cfg_updates = config_rx.clone();
                    let cfg_shared = shared_cfg.clone();
                    tokio::spawn(async move {
                        let mut version = 0u64;
                        while cfg_updates.changed().await.is_ok() {
                            if let Some(next) = cfg_updates.borrow().clone() {
                                if let Ok(mut guard) = cfg_shared.lock() {
                                    *guard = next;
                                }
                            }
                            version = version.wrapping_add(1);
                            let _ = cfg_changed_tx.send(version);
                        }
                    });

                    let mut inbound_rx = inbound_text_tx.subscribe();
                    tokio::spawn(async move {
                        loop {
                            match inbound_rx.recv().await {
                                Ok(text) => {
                                    if in_tx.send(Message::Text(text)).await.is_err() {
                                        break;
                                    }
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    });

                    let writer = tokio::spawn(async move {
                        while let Some(msg) = out_rx.recv().await {
                            let frame = match msg {
                                Message::Text(text) => crate::ipc::OutboundFrame::Text(text),
                                Message::Binary(bytes) => crate::ipc::OutboundFrame::Binary(bytes),
                                Message::Close(_) => break,
                                Message::Ping(_) | Message::Pong(_) => continue,
                                _ => continue,
                            };
                            if ws_out_tx.send(frame).await.is_err() {
                                break;
                            }
                        }
                        let _ = stop_tx.send(true);
                    });

                    Ok((in_rx, out_tx, writer))
                };

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

                        // Stop the capture thread on every session end so it
                        // never bleeds into the next reconnect without an
                        // explicit start_capture from the server.
                        if let Some(stop) = capture_stop.take() {
                            stop.store(true, Ordering::Relaxed);
                            info!("Screen capture stopped (session ended).");
                        }

                        // Detach the kill-report sink so the enforcer doesn't
                        // accumulate events while disconnected.
                        *kill_report_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;

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

/// Bundles handles for [`run_session`] so the entry point stays under Clippy's argument limit.
struct RunSessionArgs<'a> {
    in_rx: mpsc::Receiver<Message>,
    out_tx: mpsc::Sender<Message>,
    frame_tx: &'a mpsc::Sender<Vec<u8>>,
    frame_rx: &'a mut mpsc::Receiver<Vec<u8>>,
    key_rx: &'a mut mpsc::Receiver<InputEvent>,
    capture_stop: &'a mut Option<Arc<AtomicBool>>,
    shared_cfg: Arc<Mutex<Config>>,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_rules: crate::app_block::SharedRules,
    kill_report_tx: crate::app_block::KillReportTx,
}

async fn run_session(args: RunSessionArgs<'_>) -> Result<()> {
    let RunSessionArgs {
        mut in_rx,
        out_tx,
        frame_tx,
        frame_rx,
        key_rx,
        capture_stop,
        shared_cfg,
        config_tx,
        shared_rules,
        kill_report_tx,
    } = args;

    // Register this session as the kill-event sink so the enforcer can report kills.
    let (kill_ev_tx, mut kill_ev_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::app_block::KillEvent>();
    *kill_report_tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(kill_ev_tx);
    // NOTE: `out_tx` writes to the Session 0 service over IPC; the service owns the real WebSocket.
    let mut pending_events: Vec<serde_json::Value> = Vec::new();
    let mut flush_ticker = interval(Duration::from_millis(250));
    flush_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    async fn flush_events(
        out_tx: &mpsc::Sender<Message>,
        pending: &mut Vec<serde_json::Value>,
    ) -> Result<()> {
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

    // Note: avoid capturing `&mut pending_events` in a closure; it makes borrowing across
    // `.await` sites harder for the compiler. Push directly instead.

    // Send system info once per session.
    let info_payload = crate::platform::system_info::collect_agent_info().to_string();
    let _ = out_tx.send(Message::Text(info_payload)).await;

    // Input controller.
    let mut controller = InputController::new().context("Failed to create input controller")?;

    // Window focus tracker.
    let mut win_tracker = WindowTracker::new();
    let mut sent_app_icons: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Timers.
    let mut is_afk = false;
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
    metrics_sys.refresh_cpu_all();
    let mut metrics_ticker = interval_at(
        Instant::now() + Duration::from_secs(METRICS_INTERVAL_SECS),
        Duration::from_secs(METRICS_INTERVAL_SECS),
    );
    metrics_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // URL sessions (time-on-site): maintained locally, emitted on transitions.
    let mut url_session: Option<UrlSession> = None;
    let mut url_session_blocked_by_afk = false;
    let mut last_live_url_key: Option<String> = None;

    // WS liveness is handled by the Session 0 service-owned connection.

    let last_software_fingerprint: Arc<tokio::sync::Mutex<Option<u64>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    // Active user attribution.
    // Keep a cached username so we don't run PowerShell for every event.
    let mut active_user: Option<String> = crate::platform::system_info::active_username()
        .or_else(crate::platform::system_info::env_username_fallback);

    // Event loop.
    let result: Result<()> = loop {
        tokio::select! {
            biased;

            // Branch 1: inbound server commands forwarded by service over IPC.
            msg = in_rx.recv() => {
                match msg {
                    Some(Message::Text(text)) => {
                        crate::server_command::handle_server_command(crate::server_command::ServerCommandArgs {
                            text: &text,
                            frame_tx,
                            capture_stop,
                            controller: &mut controller,
                            shared_cfg: &shared_cfg,
                            config_tx: &config_tx,
                            out_tx: out_tx.clone(),
                            shared_rules: &shared_rules,
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
                    crate::platform::system_info::active_username()
                        .or_else(crate::platform::system_info::env_username_fallback)
                }).await.ok().flatten();
                if next != active_user {
                    active_user = next;
                }
            }

            // Branch 1d: telemetry flush.
            _ = flush_ticker.tick() => {
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
                    pending_events.push(serde_json::json!({
                        "type": "app_block_kill",
                        "rule_id": kill.rule_id,
                        "rule_name": kill.rule_name,
                        "exe_name": kill.exe_name,
                    }));
                }
            }

            // Branch 3: screen frame delivery.
            // Stream only when frames exist. Always drop to the latest frame.
            jpeg = frame_rx.recv() => {
                let mut latest = jpeg;
                while let Ok(j) = frame_rx.try_recv() {
                    latest = Some(j);
                }
                if let Some(jpeg) = latest {
                    if out_tx.send(Message::Binary(jpeg)).await.is_err() {
                        break Err(anyhow::anyhow!(
                            "Outbound channel closed; writer task exited unexpectedly."
                        ));
                    }
                } else {
                    // Frame channel closed => capture stopped; keep session alive.
                }
            }

            // Branch 3: active browser URL.
            () = &mut url_sleep => {
                url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(if is_afk { URL_POLL_AFK_INTERVAL_SECS } else { URL_POLL_INTERVAL_SECS }));
                let now_ts_u64 = crate::unix_timestamp_secs();
                let now_ts = now_ts_u64 as i64;
                let active = if url_session_blocked_by_afk {
                    None
                } else {
                    crate::platform::url_provider::active_url()
                };

                // Session transitions.
                match (&url_session, &active) {
                    (None, Some(info)) => {
                        url_session = Some(UrlSession {
                            url: info.url.clone(),
                            title: if info.title.trim().is_empty() { None } else { Some(info.title.clone()) },
                            browser: Some(info.browser_name.clone()),
                            user: active_user.clone(),
                            started_at_instant: std::time::Instant::now(),
                            started_at_ts: now_ts,
                        });
                    }
                    (Some(sess), Some(info)) if sess.url != info.url => {
                        if let Some(prev) = url_session.take() {
                            pending_events.push(url_session_event_value(prev, now_ts));
                        }
                        url_session = Some(UrlSession {
                            url: info.url.clone(),
                            title: if info.title.trim().is_empty() { None } else { Some(info.title.clone()) },
                            browser: Some(info.browser_name.clone()),
                            user: active_user.clone(),
                            started_at_instant: std::time::Instant::now(),
                            started_at_ts: now_ts,
                        });
                    }
                    (Some(_), None) => {
                        if let Some(prev) = url_session.take() {
                            pending_events.push(url_session_event_value(prev, now_ts));
                        }
                    }
                    _ => {}
                }

                // Live URL sample for dashboard + `url_visits` (sessions use `url_session`).
                // Only emit when the URL changes to save WAN bandwidth.
                if let Some(info) = active {
                    let key = format!("{}\n{}\n{}", info.url, info.title, info.browser_name);
                    if last_live_url_key.as_deref() != Some(key.as_str()) {
                        last_live_url_key = Some(key);
                        pending_events.push(serde_json::json!({
                            "type"    : "url",
                            "url"     : info.url,
                            "title"   : info.title,
                            "browser" : info.browser_name,
                            "ts"      : now_ts_u64,
                            "user"    : active_user,
                        }));
                    }
                } else {
                    last_live_url_key = None;
                }
            }

            // Branch 4: keystrokes / AFK.
            event = key_rx.recv() => {
                let payload = match event {
                    Some(InputEvent::Keys {
                        text,
                        app,
                        app_display,
                        window,
                        ts,
                    }) => {
                        Some(serde_json::json!({
                            "type"   : "keys",
                            "text"   : text,
                            "app"    : app,
                            "app_display": app_display,
                            "window" : window,
                            "ts"     : ts,
                            "user"   : active_user,
                        }))
                    }
                    Some(InputEvent::Afk { idle_secs }) => {
                        // Close any in-flight URL session when user goes AFK.
                        is_afk = true;
                        url_session_blocked_by_afk = true;
                        if let Some(prev) = url_session.take() {
                            let now_ts = crate::unix_timestamp_secs() as i64;
                            pending_events.push(url_session_event_value(prev, now_ts));
                        }
                        // Slow down polling immediately while AFK.
                        url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(URL_POLL_AFK_INTERVAL_SECS));
                        window_sleep.as_mut().reset(Instant::now() + Duration::from_millis(WINDOW_POLL_AFK_INTERVAL_MS));
                        Some(serde_json::json!({
                            "type"     : "afk",
                            "idle_secs": idle_secs,
                            "ts"       : crate::unix_timestamp_secs(),
                            "user"     : active_user,
                        }))
                    }
                    Some(InputEvent::Active) => {
                        is_afk = false;
                        url_session_blocked_by_afk = false;
                        // Resume normal polling immediately.
                        url_sleep.as_mut().reset(Instant::now() + Duration::from_secs(URL_POLL_INTERVAL_SECS));
                        window_sleep.as_mut().reset(Instant::now() + Duration::from_millis(WINDOW_POLL_INTERVAL_MS));
                        Some(serde_json::json!({
                            "type": "active",
                            "ts"  : crate::unix_timestamp_secs(),
                            "user": active_user,
                        }))
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
                if let Some(event) = win_tracker.poll() {
                    // Opportunistically upload an app icon once per exe name per session.
                    // This keeps the dashboard snappy without requiring extra round trips.
                    let exe_key = event.app.trim().to_lowercase();
                    if !exe_key.is_empty() && !sent_app_icons.contains(&exe_key) && !event.app_path.trim().is_empty() {
                        // `ExtractIconExW` often fails for our own EXE even with a valid installer icon.
                        // Fall back to the bundled `icons/icon.ico` so Activity shows a tile on the server.
                        let png =
                            crate::platform::activity_tracker::app_icon_png_for_path(&event.app_path, 64);
                        if let Ok(png) = png {
                            pending_events.push(serde_json::json!({
                                "type": "app_icon",
                                "exe_name": exe_key,
                                "png_base64": base64::engine::general_purpose::STANDARD.encode(png),
                                "ts": crate::unix_timestamp_secs(),
                            }));
                        }
                        // Avoid retrying constantly for executables that can't produce icons.
                        sent_app_icons.insert(exe_key);
                    }
                    pending_events.push(serde_json::json!({
                        "type"  : "window_focus",
                        "title" : event.title,
                        "app"   : event.app,
                        "app_display": event.app_display,
                        "app_path": event.app_path,
                        "hwnd"  : event.hwnd,
                        "ts"    : crate::unix_timestamp_secs(),
                        "user"  : active_user,
                    }));
                }
            }

            // Branch 6: installed-software inventory (only if changed).
            _ = software_ticker.tick() => {
                let o = out_tx.clone();
                let fp = last_software_fingerprint.clone();
                tokio::spawn(async move {
                    crate::platform::software_inventory::send_inventory_if_changed(o, &fp).await;
                });
            }

            // Branch 7: resource metrics (CPU/mem/disk) for health history.
            _ = metrics_ticker.tick() => {
                let m = crate::platform::system_info::collect_resource_metrics(&mut metrics_sys);
                let _ = out_tx.send(Message::Text(m.to_string())).await;
            }
        }
    };

    // Shutdown.
    if let Some(prev) = url_session.take() {
        let now_ts = crate::unix_timestamp_secs() as i64;
        pending_events.push(url_session_event_value(prev, now_ts));
    }
    // Final best-effort flush (ensures last activity/url_session isn't lost).
    let _ = flush_events(&out_tx, &mut pending_events).await;

    result
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/// Write to the shared status mutex, ignoring lock-poison errors.
pub fn set_status(status: &Mutex<AgentStatus>, s: AgentStatus) {
    if let Ok(mut guard) = status.lock() {
        *guard = s;
    }
}
