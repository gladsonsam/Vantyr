//! One established server WebSocket: the hello frames, the select loop that relays
//! frames both ways, and admission of the commands the server sends.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::{interval, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tracing::{info, warn};

use super::{agent_info_message, auth_rejected_message, OutboundFrame, WsClientOpts};
use crate::config::AgentStatus;
use crate::connection::reconnect::set_status;

/// What a live connection shares with the reconnect loop that owns it.
pub(super) struct Link<'a> {
    pub(super) status: &'a Arc<Mutex<AgentStatus>>,
    pub(super) outbound_rx: &'a mut mpsc::Receiver<OutboundFrame>,
    /// Frames queued while disconnected; sent first, and refilled with any frame that
    /// could not be written.
    pub(super) buffered: &'a mut VecDeque<OutboundFrame>,
    pub(super) inbound_text_tx: &'a broadcast::Sender<String>,
    pub(super) stop_rx: &'a mut watch::Receiver<bool>,
    pub(super) config_changed_rx: &'a mut watch::Receiver<u64>,
    pub(super) opts: &'a WsClientOpts,
}

/// Run one connection until it ends. Returns the server's `"type"` when it ended the
/// connection by removing this agent (`agent_deleted` / `agent_credentials_revoked`
/// ahead of Close), so the caller parks instead of reconnecting with a dead token.
pub(super) async fn serve<S>(link: Link<'_>, ws_stream: WebSocketStream<S>) -> Option<String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Link {
        status,
        outbound_rx,
        buffered,
        inbound_text_tx,
        stop_rx,
        config_changed_rx,
        opts,
    } = link;

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Send `agent_info` immediately (service/lock-screen presence).
    if let Some(msg) = agent_info_message(opts.run_context).await {
        let _ = ws_tx.send(msg).await;
    }

    let mut permission_report = crate::permissions::load().unwrap_or_default().wire();
    let _ = ws_tx
        .send(Message::Text(permission_report.to_string()))
        .await;
    let mut permission_ticker = interval(Duration::from_millis(250));
    // Flush any buffered frames first.
    while let Some(f) = buffered.pop_front() {
        let msg = match f {
            OutboundFrame::Text(s) => Message::Text(s),
            OutboundFrame::Binary(b) => Message::Binary(b),
        };
        let Some(msg) = crate::permissions::prepare_message(msg) else {
            continue;
        };
        if ws_tx.send(msg).await.is_err() {
            break;
        }
    }

    let mut ping_ticker = interval(Duration::from_secs(20));
    ping_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut info_ticker = interval(Duration::from_secs(opts.agent_info_interval_secs.max(1)));
    info_ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Set when the server tells us this agent was deleted / revoked. The socket is about
    // to drop; what matters is that we do NOT fall through to the generic Disconnected +
    // backoff path.
    let mut removed_by_server: Option<String> = None;

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() { break; }
            }
            _ = permission_ticker.tick() => {
                let next = crate::permissions::load().unwrap_or_default().wire();
                if next != permission_report {
                    permission_report = next;
                    let _ = ws_tx.send(Message::Text(permission_report.to_string())).await;
                }
            }
            _ = ping_ticker.tick() => {
                let _ = ws_tx.send(Message::Ping(Vec::new())).await;
            }
            _ = info_ticker.tick(), if opts.agent_info_interval_secs > 0 => {
                if let Some(msg) = agent_info_message(opts.run_context).await {
                    let _ = ws_tx.send(msg).await;
                }
            }
            f = outbound_rx.recv() => {
                let Some(f) = f else { break; };
                // Build a WS frame without consuming `f` so we can re-buffer on failure.
                let msg = match &f {
                    OutboundFrame::Text(s) => Message::Text(s.clone()),
                    OutboundFrame::Binary(b) => Message::Binary(b.clone()),
                };
                let Some(msg) = crate::permissions::prepare_message(msg) else { continue; };
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
                        // The server sends this just before dropping a deleted / revoked
                        // agent. Record it so the caller parks in Error instead of
                        // reconnecting, then still forward it so the companion / UI sees
                        // the same reason.
                        if let Some(kind) = removal_notice(&t) {
                            warn!(
                                "Server removed this agent ({kind}); stopping reconnects until re-enrolled."
                            );
                            removed_by_server = Some(kind);
                            set_status(status, AgentStatus::Error(auth_rejected_message(401)));
                        }
                        if let Some(text) = admit_text(t, &mut ws_tx).await {
                            let _ = inbound_text_tx.send(text);
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // Not expected from server; ignore.
                    }
                    Some(Ok(_)) => {}
                }
            }
        }
    }

    removed_by_server
}

/// The `"type"` of a server text frame that says this agent was removed, if it is one.
fn removal_notice(text: &str) -> Option<String> {
    server_text_type(text)
        .filter(|kind| kind == "agent_deleted" || kind == "agent_credentials_revoked")
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

/// Admit one server text frame for forwarding to the companion: a `disable_module` is
/// answered here (never forwarded), a command that fails admission is dropped, and
/// clipboard commands get a local deadline. Non-JSON text is forwarded as is.
async fn admit_text<S>(
    text: String,
    ws_tx: &mut SplitSink<WebSocketStream<S>, Message>,
) -> Option<String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Some(text);
    };
    if v["type"] == "disable_module" {
        let ack = crate::permissions::disable_and_wait(&v).await;
        let _ = ws_tx.send(Message::Text(ack.to_string())).await;
        return None;
    }
    let mut v = crate::permissions::admit_command(v)?;
    if matches!(v["type"].as_str(), Some("ClipboardRead" | "ClipboardWrite")) {
        // Local deadline survives queues and Windows companion IPC.
        // Never trust an incoming deadline supplied by the server.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        v["__clipboard_deadline_ms"] = (now + 4000).into();
        crate::input::clipboard::pin_request(&mut v);
    }
    Some(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_removal_notices_are_recognised() {
        assert_eq!(
            removal_notice(r#"{"type":"agent_deleted"}"#).as_deref(),
            Some("agent_deleted")
        );
        assert_eq!(
            removal_notice(r#"  {"type":"agent_credentials_revoked","reason":"x"}"#).as_deref(),
            Some("agent_credentials_revoked")
        );
        assert_eq!(removal_notice(r#"{"type":"RequestInfo"}"#), None);
        assert_eq!(removal_notice(r#"{"type":7}"#), None);
        assert_eq!(removal_notice("agent_deleted"), None);
        assert_eq!(removal_notice("{not json"), None);
    }
}
