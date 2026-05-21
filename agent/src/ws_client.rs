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

        let cfg = match shared_cfg.lock() {
            Ok(g) => g.clone(),
            Err(e) => e.into_inner().clone(),
        };
        if cfg.server_url.trim().is_empty() {
            set_status(&status, AgentStatus::Disconnected);
            tokio::select! {
                _ = stop_rx.changed() => {},
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
                let mut info = crate::system_info::collect_agent_info();
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

                loop {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            if *stop_rx.borrow() { break; }
                        }
                        _ = ping_ticker.tick() => {
                            let _ = ws_tx.send(Message::Ping(Vec::new())).await;
                        }
                        _ = info_ticker.tick(), if opts.agent_info_interval_secs > 0 => {
                            let mut info = crate::system_info::collect_agent_info();
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

                set_status(&status, AgentStatus::Disconnected);
                info!("WS disconnected; will reconnect.");
            }
            Err(e) => {
                set_status(&status, AgentStatus::Disconnected);
                warn!("WS connect failed: {e:#}");
            }
        }

        attempt = attempt.saturating_add(1);
        let delay = reconnect_backoff_delay(attempt.max(1));
        tokio::select! {
            _ = stop_rx.changed() => {},
            () = tokio::time::sleep(delay) => {},
        }
    }
}
