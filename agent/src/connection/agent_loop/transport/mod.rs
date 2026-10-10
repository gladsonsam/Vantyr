//! The session's message channels. On Windows the companion talks to the
//! Session 0 service over the IPC pipe and the service owns the WebSocket; on
//! Linux the agent runs the WebSocket client itself.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::config::{AgentStatus, Config};

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

/// Inbound server commands, the outbound sink, and the writer task draining it.
pub(super) type SessionChannels = (
    mpsc::Receiver<Message>,
    mpsc::Sender<Message>,
    tokio::task::JoinHandle<()>,
);

/// Open the session's channels for the current platform.
pub(super) async fn connect(
    shared_cfg: &Arc<Mutex<Config>>,
    status: &Arc<Mutex<AgentStatus>>,
    config_rx: &tokio::sync::watch::Receiver<Option<Config>>,
) -> anyhow::Result<SessionChannels> {
    imp::connect(shared_cfg, status, config_rx).await
}
