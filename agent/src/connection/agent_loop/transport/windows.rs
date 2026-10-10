//! Windows: the companion talks to the Session 0 service over the IPC pipe;
//! the service owns the WebSocket.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::SessionChannels;
use crate::config::{AgentStatus, Config};
use crate::connection::agent_loop::OUTBOUND_CHANNEL_CAP;

/// Connect to the service's companion IPC pipe. Server commands and the
/// service-owned WebSocket status arrive on it; outbound messages are written
/// back as IPC lines.
pub(super) async fn connect(
    _shared_cfg: &Arc<Mutex<Config>>,
    status: &Arc<Mutex<AgentStatus>>,
    _config_rx: &tokio::sync::watch::Receiver<Option<Config>>,
) -> anyhow::Result<SessionChannels> {
    use anyhow::Context;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;

    use crate::connection::reconnect::set_status;

    let pipe = ClientOptions::new()
        .open(crate::host::ipc::AGENT_IPC_PIPE_NAME)
        .context("open agent IPC pipe")?;

    let (pipe_r, mut pipe_w) = tokio::io::split(pipe);
    let mut reader = BufReader::new(pipe_r);

    // Ensure the service reloads machine config (best-effort) so changes from the UI
    // take effect without restarting the service.
    let _ = pipe_w
        .write_all(
            crate::host::ipc::IpcLine::ConfigChanged
                .to_line()
                .as_bytes(),
        )
        .await;
    let _ = pipe_w.flush().await;

    let (in_tx, in_rx) = mpsc::channel::<Message>(256);
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_CHANNEL_CAP);

    // Writer: translate tungstenite Messages to IPC lines.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if !crate::permissions::message_allowed(&msg) {
                continue;
            }
            match msg {
                Message::Text(text) => {
                    let line = crate::host::ipc::IpcLine::WsText { text }.to_line();
                    if pipe_w.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Message::Binary(bytes) => {
                    let line = crate::host::ipc::outbound_binary_line(&bytes);
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
            if let Some(line) = crate::host::ipc::IpcLine::from_slice(&buf) {
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

    Ok((in_rx, out_tx, writer))
}
