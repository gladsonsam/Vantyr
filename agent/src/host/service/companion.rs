//! One connection on the persistent companion IPC pipe
//! ([`crate::host::ipc::AGENT_IPC_PIPE_NAME`]): the user-session companion's frames go
//! up to the service-owned WebSocket, server commands come back down, and the
//! WebSocket status is mirrored to the companion.

use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{broadcast, mpsc, watch};
use tracing::{info, warn};

use crate::config::{AgentStatus, Config};
use crate::connection::ws_client::OutboundFrame;
use crate::host::ipc::IpcLine;

/// The service-side state one companion connection talks to.
pub(super) struct CompanionLink {
    pub to_ws_tx: mpsc::Sender<OutboundFrame>,
    pub shared_cfg: Arc<Mutex<Config>>,
    pub config_changed_tx: watch::Sender<u64>,
    pub ws_status: Arc<Mutex<AgentStatus>>,
    pub clipboard_routes: Arc<Mutex<crate::input::clipboard::session::Routes>>,
    pub clipboard_client: uuid::Uuid,
    /// Whether the peer is one of our own agent binaries, decided while the
    /// pipe was connected. Clipboard routing only trusts its pipe identity then.
    pub clipboard_trusted: bool,
}

/// Serve `pipe` until the companion disconnects. `cmd_rx` carries server
/// commands from the WebSocket.
pub(super) async fn serve_companion(
    pipe: NamedPipeServer,
    link: CompanionLink,
    mut cmd_rx: broadcast::Receiver<String>,
) {
    let _clipboard_connection = crate::input::clipboard::session::ConnectionGuard {
        client: link.clipboard_client,
        routes: link.clipboard_routes.clone(),
    };
    let mut clipboard_ticker = tokio::time::interval(Duration::from_millis(20));
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    let mut status_ticker = tokio::time::interval(Duration::from_millis(900));
    status_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_status_line = String::new();
    loop {
        tokio::select! {
            // `read_until` appends, so keeping `buf` across iterations makes this
            // branch cancel-safe: a partial line survives when another branch wins.
            res = reader.read_until(b'\n', &mut buf) => {
                match res {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => {
                        warn!("Agent IPC pipe read failed: {e:#}");
                        break;
                    }
                }
                let mut buf = std::mem::take(&mut buf);
                while matches!(buf.last().copied(), Some(b'\n' | b'\r')) { buf.pop(); }
                if buf.is_empty() { continue; }

                if let Some(line) = IpcLine::from_slice(&buf) {
                    handle_companion_line(&link, line, reader.get_ref()).await;
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Ok(text) => {
                        if forward_server_command(&link, text, reader.get_mut()).await.is_break() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = clipboard_ticker.tick() => {
                link.clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).refresh(
                    crate::input::clipboard::session::active_console(),crate::input::clipboard::session::now_ms());
            }
            _ = status_ticker.tick() => {
                let status_snapshot = link.ws_status
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_else(|e| e.into_inner().clone());
                let line = IpcLine::ws_status(&status_snapshot).to_line();
                if line != last_status_line {
                    let pipe = reader.get_mut();
                    if let Err(e) = pipe.write_all(line.as_bytes()).await {
                        warn!("Agent IPC status write failed: {e:#}");
                        break;
                    }
                    let _ = pipe.flush().await;
                    last_status_line = line;
                }
            }
        }
    }
}

/// Act on one line from the companion: config reload/persist requests, or a
/// frame to forward to the server.
async fn handle_companion_line(link: &CompanionLink, line: IpcLine, pipe: &NamedPipeServer) {
    let CompanionLink {
        to_ws_tx,
        shared_cfg,
        config_changed_tx,
        clipboard_routes,
        clipboard_client,
        clipboard_trusted,
        ..
    } = link;
    match line {
        IpcLine::ConfigChanged => {
            // Reload machine config so WS URL/auth changes apply without service restart.
            if let Ok(mut g) = shared_cfg.lock() {
                *g = crate::config::load_config();
            }
            let next = {
                let current = *config_changed_tx.borrow();
                current.wrapping_add(1)
            };
            let _ = config_changed_tx.send(next);
        }
        IpcLine::PersistConfig { config } => {
            // The unprivileged user session can't write %ProgramData%\Vantyr;
            // persist on its behalf with the service's SYSTEM rights. Do NOT
            // bump `config_changed` here: policy/UI-password/auto-update pushes
            // don't affect the service-owned WS connection, and the server
            // re-pushes them on every connect — reconnecting on each would
            // flap the socket. Connection-relevant changes (URL/token) arrive
            // with a separate ConfigChanged nudge that does reload + reconnect.
            match crate::config::save_config(&config) {
                Ok(()) => {
                    if let Ok(mut g) = shared_cfg.lock() {
                        *g = *config;
                    }
                    info!("Persisted machine config on behalf of user session.");
                }
                Err(e) => warn!("Failed to persist config from user session: {e:#}"),
            }
        }
        other => {
            if let Some(frame) = other.into_outbound() {
                if let OutboundFrame::Text(ref text) = frame {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                        if crate::input::clipboard::session::contains_result(&value) {
                            // Kernel-derived pipe identity, not fields supplied by the companion.
                            let session = if *clipboard_trusted {
                                crate::input::clipboard::session::pipe_user_session(pipe)
                            } else {
                                None
                            };
                            let allowed = clipboard_routes
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .result_allowed(
                                    &value,
                                    *clipboard_client,
                                    session,
                                    crate::input::clipboard::session::active_console(),
                                    crate::input::clipboard::session::now_ms(),
                                );
                            if allowed && crate::input::clipboard::session::console_current(&value)
                            {
                                // Never wait with sensitive content queued behind telemetry.
                                let _ = to_ws_tx.try_send(frame);
                            }
                            return;
                        }
                    }
                }
                let _ = to_ws_tx.send(frame).await;
            }
        }
    }
}

/// Write one server command down to the companion, after clipboard routing.
/// `Break` ends the connection (write failed or a clipboard write was abandoned).
async fn forward_server_command(
    link: &CompanionLink,
    text: String,
    pipe: &mut NamedPipeServer,
) -> ControlFlow<()> {
    let CompanionLink {
        clipboard_routes,
        clipboard_client,
        clipboard_trusted,
        ..
    } = link;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ControlFlow::Continue(());
    };
    // Only clipboard routing consults the pipe identity; skip the Win32 lookups for input/telemetry.
    let routed = matches!(
        value["type"].as_str(),
        Some("ClipboardRead" | "ClipboardWrite" | "ClipboardCancel")
    );
    let session = if *clipboard_trusted && routed {
        crate::input::clipboard::session::pipe_user_session(pipe)
    } else {
        None
    };
    let allowed = clipboard_routes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .command_allowed(
            &value,
            *clipboard_client,
            session,
            crate::input::clipboard::session::active_console(),
            crate::input::clipboard::session::now_ms(),
        );
    // Filter BEFORE any bytes (including write text) reach the pipe.
    if !allowed {
        return ControlFlow::Continue(());
    }
    let clipboard = matches!(
        value["type"].as_str(),
        Some("ClipboardRead" | "ClipboardWrite")
    );
    let mut s = text;
    s.push('\n');
    if clipboard {
        // `command_allowed` only admits clipboard commands with a valid request id.
        let Some(id) = value["request_id"]
            .as_str()
            .and_then(|id| id.parse::<uuid::Uuid>().ok())
        else {
            return ControlFlow::Continue(());
        };
        let deadline = value["__clipboard_deadline_ms"].as_u64().unwrap_or(0);
        let remaining = deadline.saturating_sub(crate::input::clipboard::session::now_ms());
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_millis(remaining), pipe.write_all(s.as_bytes())) => matches!(result,Ok(Ok(()))),
            _ = async { loop {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if !clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).owns(id,*clipboard_client,session,
                    crate::input::clipboard::session::active_console(),crate::input::clipboard::session::now_ms()) { break; }
            }} => false,
        };
        if !result {
            return ControlFlow::Break(());
        }
    } else if let Err(e) = pipe.write_all(s.as_bytes()).await {
        warn!("Agent IPC pipe write failed: {e:#}");
        return ControlFlow::Break(());
    }
    let _ = pipe.flush().await;
    ControlFlow::Continue(())
}
