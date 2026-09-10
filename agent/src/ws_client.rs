use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::{AgentStatus, Config};
use crate::ipc::OutboundFrame;

const RECONNECT_BACKOFF_BASE_MS: u64 = 750;
const RECONNECT_BACKOFF_MAX_MS: u64 = 30_000;

fn reconnect_backoff_delay(attempt: u32) -> Duration {
    let exp = 2u64.saturating_pow(attempt.min(8));
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

/// Build the full WebSocket URL, appending `?name=<agent_name>`.
///
/// Agent authentication is sent in the WebSocket handshake `Authorization` header
/// (not in the query string) to avoid leaking secrets via proxy/access logs.
pub fn build_ws_url(cfg: &Config) -> String {
    let base = cfg.server_url.trim_end_matches('/');
    let mut url = base.to_string();

    fn enc(v: &str) -> String {
        use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
        // Encode everything except a conservative unreserved set.
        const SAFE: &AsciiSet = &CONTROLS
            .add(b' ')
            .add(b'"')
            .add(b'#')
            .add(b'%')
            .add(b'&')
            .add(b'+')
            .add(b',')
            .add(b'/')
            .add(b':')
            .add(b';')
            .add(b'<')
            .add(b'=')
            .add(b'>')
            .add(b'?')
            .add(b'@')
            .add(b'\\')
            .add(b'|')
            .add(b'[')
            .add(b']')
            .add(b'{')
            .add(b'}');
        utf8_percent_encode(v, SAFE).to_string()
    }

    let first_param = !url.contains('?');
    if !cfg.agent_name.is_empty() {
        url.push(if first_param { '?' } else { '&' });
        url.push_str("name=");
        url.push_str(&enc(cfg.agent_name.trim()));
    }
    url
}

/// Redact `secret=...` query parameter so agent secrets don't leak via logs.
///
/// (Kept for backward compatibility with older URLs/logs; current versions do not
/// place secrets in the query string.)
pub fn redact_secret_from_ws_url(url: &str) -> String {
    let Some(secret_start) = url.find("secret=") else {
        return url.to_string();
    };
    let mut out = url.to_string();
    let value_start = secret_start + "secret=".len();
    if value_start >= out.len() {
        return out;
    }
    let value_end = out[value_start..]
        .find('&')
        .map_or(out.len(), |i| value_start + i);
    out.replace_range(value_start..value_end, "***");
    out
}

fn set_status(status: &Arc<Mutex<AgentStatus>>, v: AgentStatus) {
    if let Ok(mut g) = status.lock() {
        *g = v;
    }
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

/// Best-effort parse of a server `{"type": ...}` text frame.
fn server_text_type(text: &str) -> Option<String> {
    let t = text.trim_start();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("type")?
        .as_str()
        .map(str::to_string)
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

        // Only the Windows auto-enrolment path below reassigns `cfg`.
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut cfg = match shared_cfg.lock() {
            Ok(g) => g.clone(),
            Err(e) => e.into_inner().clone(),
        };
        #[cfg(target_os = "windows")]
        if cfg.agent_token.trim().is_empty() {
            match crate::enrollment::try_auto_discover_and_request_access().await {
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

                let (mut ws_tx, mut ws_rx) = ws_stream.split();

                // Send `agent_info` immediately (service/lock-screen presence).
                let mut info = crate::platform::system_info::collect_agent_info();
                if let serde_json::Value::Object(ref mut obj) = info {
                    obj.insert(
                        "run_context".to_string(),
                        serde_json::Value::String(opts.run_context.to_string()),
                    );
                }
                let _ = ws_tx.send(Message::Text(info.to_string())).await;

                // Flush any buffered frames first.
                while let Some(f) = buffered.pop_front() {
                    let msg = match f {
                        OutboundFrame::Text(s) => Message::Text(s),
                        OutboundFrame::Binary(b) => Message::Binary(b),
                    };
                    if ws_tx.send(msg).await.is_err() {
                        break;
                    }
                }

                let mut ping_ticker = interval(Duration::from_secs(20));
                ping_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

                let mut info_ticker =
                    interval(Duration::from_secs(opts.agent_info_interval_secs.max(1)));
                info_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

                // Set when the server tells us this agent was deleted / revoked
                // (`agent_deleted` / `agent_credentials_revoked` ahead of Close).
                // The socket is about to drop; what matters is that we do NOT
                // fall through to the generic Disconnected + backoff path.
                let mut removed_by_server: Option<String> = None;

                loop {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            if *stop_rx.borrow() { break; }
                        }
                        _ = ping_ticker.tick() => {
                            let _ = ws_tx.send(Message::Ping(Vec::new())).await;
                        }
                        _ = info_ticker.tick(), if opts.agent_info_interval_secs > 0 => {
                            let mut info = crate::platform::system_info::collect_agent_info();
                            if let serde_json::Value::Object(ref mut obj) = info {
                                obj.insert(
                                    "run_context".to_string(),
                                    serde_json::Value::String(opts.run_context.to_string()),
                                );
                            }
                            let _ = ws_tx.send(Message::Text(info.to_string())).await;
                        }
                        f = outbound_rx.recv() => {
                            let Some(f) = f else { break; };
                            // Build a WS frame without consuming `f` so we can re-buffer on failure.
                            let msg = match &f {
                                OutboundFrame::Text(s) => Message::Text(s.clone()),
                                OutboundFrame::Binary(b) => Message::Binary(b.clone()),
                            };
                            if ws_tx.send(msg).await.is_err() {
                                buffered.push_back(f);
                                break;
                            }
                        }
                        changed = config_changed_rx.changed() => {
                            if changed.is_ok() {
                                info!("Config changed; reconnecting WebSocket with updated settings.");
                            }
                            break;
                        }
                        msg = ws_rx.next() => {
                            match msg {
                                None => break,
                                Some(Err(e)) => {
                                    warn!("WS read error: {e:#}");
                                    break;
                                }
                                Some(Ok(Message::Close(_))) => break,
                                Some(Ok(Message::Pong(_))) => {}
                                Some(Ok(Message::Ping(v))) => {
                                    let _ = ws_tx.send(Message::Pong(v)).await;
                                }
                                Some(Ok(Message::Text(t))) => {
                                    // The server sends this just before dropping a
                                    // deleted / revoked agent. Record it so the
                                    // post-loop logic parks in Error instead of
                                    // reconnecting, then still forward it so the
                                    // companion / UI sees the same reason.
                                    if let Some(kind) = server_text_type(&t) {
                                        if kind == "agent_deleted"
                                            || kind == "agent_credentials_revoked"
                                        {
                                            warn!(
                                                "Server removed this agent ({kind}); stopping reconnects until re-enrolled."
                                            );
                                            removed_by_server = Some(kind);
                                            set_status(
                                                &status,
                                                AgentStatus::Error(auth_rejected_message(401)),
                                            );
                                        }
                                    }
                                    let _ = inbound_text_tx.send(t);
                                }
                                Some(Ok(Message::Binary(_))) => {
                                    // Not expected from server; ignore.
                                }
                                Some(Ok(_)) => {}
                            }
                        }
                    }
                }

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
