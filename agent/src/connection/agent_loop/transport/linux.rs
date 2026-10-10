//! Linux: the agent runs the WebSocket client itself.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::SessionChannels;
use crate::config::{AgentStatus, Config};
use crate::connection::agent_loop::OUTBOUND_CHANNEL_CAP;

/// The subset of [`Config`](crate::config::Config) that, when changed,
/// requires tearing down and re-establishing the agent WebSocket. Everything
/// else (UI password,
/// auto-update, network/app-block policy, …) is applied live without dropping
/// the socket. Gating reconnects on this prevents an endless online/offline
/// flap: the server re-pushes its current settings on every connect, and
/// reacting to each push by reconnecting would loop forever.
fn connection_signature(cfg: &Config) -> (String, String, String) {
    (
        cfg.server_url.trim().to_string(),
        cfg.agent_name.trim().to_string(),
        cfg.agent_token.trim().to_string(),
    )
}

/// Start this process's own WebSocket client and bridge it to the session
/// channels. Config changes reconnect only when [`connection_signature`]
/// changes.
pub(super) async fn connect(
    shared_cfg: &Arc<Mutex<Config>>,
    status: &Arc<Mutex<AgentStatus>>,
    config_rx: &tokio::sync::watch::Receiver<Option<Config>>,
) -> anyhow::Result<SessionChannels> {
    let (in_tx, in_rx) = mpsc::channel::<Message>(256);
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_CHANNEL_CAP);
    let (ws_out_tx, ws_out_rx) =
        mpsc::channel::<crate::connection::ws_client::OutboundFrame>(OUTBOUND_CHANNEL_CAP);
    let (inbound_text_tx, _) = tokio::sync::broadcast::channel::<String>(256);
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let (cfg_changed_tx, cfg_changed_rx) = tokio::sync::watch::channel(0u64);

    let ws_cfg = shared_cfg.clone();
    let ws_status = status.clone();
    let ws_inbound_text_tx = inbound_text_tx.clone();
    tokio::spawn(async move {
        crate::connection::ws_client::run_ws_client(
            ws_cfg,
            ws_status,
            ws_out_rx,
            ws_inbound_text_tx,
            stop_rx,
            cfg_changed_rx,
            crate::connection::ws_client::WsClientOpts {
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
        // Only force a WebSocket reconnect when connection-relevant
        // fields change. The server pushes its current settings (UI
        // password, auto-update, policies, block rules) on every
        // connect; those are applied live via `shared_cfg` and must
        // NOT drop the socket, or the agent flaps online/offline
        // forever. See `connection_signature`.
        let mut last_sig =
            connection_signature(&cfg_shared.lock().unwrap_or_else(|e| e.into_inner()));
        while cfg_updates.changed().await.is_ok() {
            let Some(next) = cfg_updates.borrow().clone() else {
                continue;
            };
            let sig = connection_signature(&next);
            if let Ok(mut guard) = cfg_shared.lock() {
                *guard = next;
            }
            if sig != last_sig {
                last_sig = sig;
                version = version.wrapping_add(1);
                let _ = cfg_changed_tx.send(version);
            }
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
            if !crate::permissions::message_allowed(&msg) {
                continue;
            }
            let frame = match msg {
                Message::Text(text) => crate::connection::ws_client::OutboundFrame::Text(text),
                Message::Binary(bytes) => {
                    crate::connection::ws_client::OutboundFrame::Binary(bytes)
                }
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
}
