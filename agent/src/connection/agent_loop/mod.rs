//! Agent Tokio runtime: IPC/WebSocket session, telemetry, and screen fan-in.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use tokio::sync::mpsc;
use tracing::{error, info};

use crate::config::{AgentStatus, Config};
use crate::connection::reconnect::{reconnect_backoff_delay, set_status};
use crate::platform::keyboard_monitor::InputEvent;

mod history;
mod session;
mod transport;
mod url_session;

use session::{run_session, RunSessionArgs, SessionHandles};

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

/// Wall-clock epoch milliseconds (used as the screen-history "last input" activity stamp).
fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// NOTE: The capture worker already runs at ~5fps (see `capture.rs`). We avoid a separate
// fixed-rate "send" ticker so the agent doesn't wake up unnecessarily while streaming.

/// Bounded capacity for the JPEG frame channel.
pub const FRAME_CHANNEL_CAP: usize = 4;

/// Bounded capacity for the outbound WebSocket message channel.
const OUTBOUND_CHANNEL_CAP: usize = 16;

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

                let connect_res = transport::connect(&shared_cfg, &status, &config_rx).await;

                match connect_res {
                    Ok((in_rx, out_tx, writer_handle)) => {
                        // Local IPC is connected. The service owns the real server WebSocket,
                        // so wait for its forwarded status before showing Connected.
                        set_status(&status, AgentStatus::Connecting);
                        match run_session(RunSessionArgs {
                            in_rx,
                            frame_rx: &mut frame_rx,
                            key_rx: &mut key_rx,
                            kill_report_tx: kill_report_tx.clone(),
                            handles: SessionHandles {
                                out_tx: out_tx.clone(),
                                frame_tx: &frame_tx,
                                capture_stop: &mut capture_stop,
                                audio_stop: &mut audio_stop,
                                recall: recall.clone(),
                                shared_cfg: shared_cfg.clone(),
                                config_tx: config_tx.clone(),
                                shared_rules: shared_rules.clone(),
                            },
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
        crate::connection::enrollment::try_consume_pending_enrollment().await,
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
