//! The reconnecting server WebSocket client: [`run_ws_client`] owns config, enrollment,
//! backoff and credential-rejection handling; [`connection`] runs one live socket.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::{AgentStatus, Config};
use crate::connection::reconnect::{reconnect_backoff_delay, set_status};

mod connection;
mod url;

use connection::Link;
use url::{build_ws_url, redact_secret_from_ws_url};

/// Frames queued for the server WebSocket (by the Windows service on behalf of
/// the companion, or by the Linux agent itself).
#[derive(Debug, Clone)]
pub enum OutboundFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// Message shown on the agent when the server rejects its credentials.
///
/// Covers both deletion (`DELETE FROM agents`) and credential revocation: in
/// either case the stored per-device token no longer authenticates, and
/// hammering the server with reconnects only fills both logs. The agent parks
/// in `Error` until its config changes (re-enrollment) or it restarts.
fn auth_rejected_message(code: u16) -> String {
    format!(
        "Server rejected agent credentials (HTTP {code}). This agent was likely deleted on the server or its credentials were revoked. Re-enroll this agent from Settings to reconnect."
    )
}

/// Extract an HTTP status from a WebSocket handshake failure, if it carries one.
///
/// `tokio-tungstenite` surfaces a failed handshake (e.g. the server's `401
/// Unauthorized` from the agent WS auth gate) as `tungstenite::Error::Http`
/// with the response status. Anything else (DNS, TLS, refused) is transient
/// and keeps the normal reconnect backoff.
fn handshake_http_status(e: &tokio_tungstenite::tungstenite::Error) -> Option<u16> {
    match e {
        tokio_tungstenite::tungstenite::Error::Http(resp) => Some(resp.status().as_u16()),
        _ => None,
    }
}

fn is_auth_rejection_status(code: u16) -> bool {
    code == 401 || code == 403
}

/// The `agent_info` frame for this connection, tagged with the process that sends it and
/// run through the outbound fence. `None` when the fence drops it.
async fn agent_info_message(run_context: &str) -> Option<Message> {
    let mut info = crate::inventory::system_info::collect_agent_info_async().await?;
    if let serde_json::Value::Object(ref mut obj) = info {
        obj.insert(
            "run_context".to_string(),
            serde_json::Value::String(run_context.to_string()),
        );
    }
    crate::permissions::prepare_message(Message::Text(info.to_string()))
}

pub struct WsClientOpts {
    /// Max queued outbound frames while disconnected (drop oldest).
    pub max_buffered_frames: usize,
    /// Send `agent_info` on connect + every N seconds (0 disables).
    pub agent_info_interval_secs: u64,
    /// Include an extra field in `agent_info` to indicate which process sent it.
    pub run_context: &'static str,
}

impl Default for WsClientOpts {
    fn default() -> Self {
        Self {
            max_buffered_frames: 5_000,
            agent_info_interval_secs: 300,
            run_context: "service",
        }
    }
}

/// Run a reconnecting WebSocket client.
///
/// - `outbound_rx` receives frames to send to the server (from IPC and/or local timers)
/// - inbound WS `Text` frames are broadcast to all subscribers (typically the user-session companion)
pub async fn run_ws_client(
    shared_cfg: Arc<Mutex<Config>>,
    status: Arc<Mutex<AgentStatus>>,
    mut outbound_rx: mpsc::Receiver<OutboundFrame>,
    inbound_text_tx: broadcast::Sender<String>,
    mut stop_rx: watch::Receiver<bool>,
    mut config_changed_rx: watch::Receiver<u64>,
    opts: WsClientOpts,
) {
    let mut buffered: VecDeque<OutboundFrame> = VecDeque::new();
    let mut attempt: u32 = 0;

    loop {
        if *stop_rx.borrow() {
            break;
        }

        // Drain any new outbound frames into our disconnected buffer.
        while let Ok(f) = outbound_rx.try_recv() {
            buffered.push_back(f);
            while buffered.len() > opts.max_buffered_frames {
                buffered.pop_front();
            }
        }

        let mut cfg = match shared_cfg.lock() {
            Ok(g) => g.clone(),
            Err(e) => e.into_inner().clone(),
        };
        // Auto-enrolment (mDNS discovery) only acts on Windows.
        if cfg.agent_token.trim().is_empty() {
            match crate::connection::enrollment::try_auto_discover_and_request_access().await {
                Ok(Some(new_cfg)) => {
                    cfg = new_cfg.clone();
                    if let Ok(mut g) = shared_cfg.lock() {
                        *g = new_cfg;
                    }
                }
                Ok(None) => {}
                Err(e) => warn!("Automatic Vantyr access request failed: {e:#}"),
            }
        }
        if cfg.server_url.trim().is_empty() {
            set_status(&status, AgentStatus::Disconnected);
            tokio::select! {
                _ = stop_rx.changed() => {},
                _ = config_changed_rx.changed() => {
                    attempt = 0;
                },
                () = tokio::time::sleep(Duration::from_secs(3)) => {},
                f = outbound_rx.recv() => {
                    if let Some(f) = f {
                        buffered.push_back(f);
                        while buffered.len() > opts.max_buffered_frames { buffered.pop_front(); }
                    }
                }
            }
            continue;
        }
        if cfg.agent_token.trim().is_empty() {
            set_status(&status, AgentStatus::Disconnected);
            warn!("WS waiting for admin approval before connecting.");
            tokio::select! {
                _ = stop_rx.changed() => {},
                _ = config_changed_rx.changed() => {
                    attempt = 0;
                },
                () = tokio::time::sleep(Duration::from_secs(15)) => {},
            }
            continue;
        }

        let ws_url = build_ws_url(&cfg);
        let ws_url_for_log = redact_secret_from_ws_url(&ws_url);
        if !ws_url.starts_with("wss://") {
            set_status(
                &status,
                AgentStatus::Error("Refusing non-TLS WebSocket URL (must be wss://)".into()),
            );
            warn!("WS refusing to connect to non-TLS URL: {ws_url_for_log}");
            tokio::select! {
                _ = stop_rx.changed() => {},
                _ = config_changed_rx.changed() => {
                    attempt = 0;
                },
                () = tokio::time::sleep(Duration::from_secs(15)) => {},
            }
            continue;
        }

        set_status(&status, AgentStatus::Connecting);
        info!("WS connecting to {ws_url_for_log} …");

        let mut req = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                set_status(
                    &status,
                    AgentStatus::Error(format!("WS invalid URL: {e:#}")),
                );
                warn!("WS invalid URL: {ws_url_for_log} ({e:#})");
                attempt = attempt.saturating_add(1);
                let delay = reconnect_backoff_delay(attempt.max(1));
                tokio::select! {
                    _ = stop_rx.changed() => {},
                    _ = config_changed_rx.changed() => {
                        attempt = 0;
                    },
                    () = tokio::time::sleep(delay) => {},
                }
                continue;
            }
        };

        if !cfg.agent_token.trim().is_empty() {
            // Prefer header-based auth so secrets don't end up in URLs/logs.
            let v = format!("Bearer {}", cfg.agent_token.trim());
            if let Ok(hv) = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(&v) {
                req.headers_mut().insert("authorization", hv);
            }
        }

        match tokio_tungstenite::connect_async(req).await {
            Ok((ws_stream, resp)) => {
                attempt = 0;
                set_status(&status, AgentStatus::Connected);
                info!("WS connected (HTTP {}).", resp.status().as_u16());

                let removed_by_server = connection::serve(
                    Link {
                        status: &status,
                        outbound_rx: &mut outbound_rx,
                        buffered: &mut buffered,
                        inbound_text_tx: &inbound_text_tx,
                        stop_rx: &mut stop_rx,
                        config_changed_rx: &mut config_changed_rx,
                        opts: &opts,
                    },
                    ws_stream,
                )
                .await;

                if let Some(kind) = removed_by_server {
                    // Park here until the config changes (re-enrollment) or we stop.
                    // The normal backoff path below would immediately reconnect
                    // with a dead token and log a 401; skip it.
                    warn!(
                        "Agent {kind} by server; parked in Error until re-enrolled (no reconnect)."
                    );
                    tokio::select! {
                        _ = stop_rx.changed() => {},
                        changed = config_changed_rx.changed() => {
                            if changed.is_ok() {
                                attempt = 0;
                                info!("Config changed after server removal; retrying WebSocket.");
                            }
                        },
                    }
                    continue;
                }

                set_status(&status, AgentStatus::Disconnected);
                info!("WS disconnected; will reconnect.");
            }
            Err(e) => {
                if let Some(code) = handshake_http_status(&e) {
                    if is_auth_rejection_status(code) {
                        // Deleted on the server, or credentials revoked: the stored
                        // token will never succeed again. Park in Error until the
                        // config changes (re-enrollment) instead of backing off
                        // and retrying forever.
                        let msg = auth_rejected_message(code);
                        set_status(&status, AgentStatus::Error(msg.clone()));
                        warn!("WS auth rejected (HTTP {code}); parked in Error until re-enrolled: {e:#}");
                        tokio::select! {
                            _ = stop_rx.changed() => {},
                            changed = config_changed_rx.changed() => {
                                if changed.is_ok() {
                                    attempt = 0;
                                    info!("Config changed after auth rejection; retrying WebSocket.");
                                }
                            },
                        }
                        continue;
                    }
                }
                set_status(&status, AgentStatus::Disconnected);
                warn!("WS connect failed: {e:#}");
            }
        }

        attempt = attempt.saturating_add(1);
        let delay = reconnect_backoff_delay(attempt.max(1));
        tokio::select! {
            _ = stop_rx.changed() => {},
            changed = config_changed_rx.changed() => {
                if changed.is_ok() {
                    attempt = 0;
                    info!("Config changed; retrying WebSocket immediately.");
                }
            },
            () = tokio::time::sleep(delay) => {},
        }
    }
}
