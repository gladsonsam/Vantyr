// Everything below `OutboundFrame` is the Windows companion ↔ service pipe
// protocol, so its dependencies are Windows-only too.
#[cfg(windows)]
use base64::Engine;
#[cfg(windows)]
use serde::{Deserialize, Serialize};

#[cfg(windows)]
use crate::config::AgentStatus;

#[cfg(windows)]
pub const AGENT_IPC_PIPE_NAME: &str = r"\\.\pipe\VantyrAgentIpc";

/// Frames forwarded between the user-session companion and the Session 0 service.
#[derive(Debug, Clone)]
pub enum OutboundFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// One JSON object per line, newline-terminated (named-pipe friendly).
///
/// We keep this intentionally simple:
/// - Most telemetry is already JSON text the server understands → `WsText`.
/// - Screen frames are forwarded as base64 in `WsBinaryB64`.
///
/// Windows-only: this is the wire format of the companion ↔ Session 0 service
/// named pipe, and Linux runs the agent as a single standalone process with no
/// service split. [`OutboundFrame`] above stays cross-platform.
#[cfg(windows)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcLine {
    /// Forward this string as a WebSocket `Text` frame to the server.
    WsText { text: String },
    /// Forward this base64 payload as a WebSocket `Binary` frame to the server.
    WsBinaryB64 { data_b64: String },
    /// Best-effort hint from the companion: config on disk was updated.
    ConfigChanged,
    /// Ask the Session 0 service to persist the machine-wide config on the
    /// companion's behalf. The user session usually cannot write
    /// `%ProgramData%\Vantyr\config.dat` (owned by the SYSTEM service), so
    /// server-pushed settings and enrollment tokens are forwarded here to be
    /// written with the service's privileges.
    PersistConfig { config: Box<crate::config::Config> },
    /// Service-owned WebSocket connection status, forwarded to the user-session companion.
    WsStatus {
        status: String,
        #[serde(default)]
        message: Option<String>,
    },
}

#[cfg(windows)]
impl IpcLine {
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_else(|_| "{\"type\":\"invalid\"}".into());
        s.push('\n');
        s
    }

    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }

    pub fn into_outbound(self) -> Option<OutboundFrame> {
        match self {
            Self::WsText { text } => Some(OutboundFrame::Text(text)),
            Self::WsBinaryB64 { data_b64 } => {
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(data_b64)
                    .ok()?;
                Some(OutboundFrame::Binary(decoded))
            }
            Self::ConfigChanged | Self::PersistConfig { .. } | Self::WsStatus { .. } => None,
        }
    }

    pub fn ws_status(status: &AgentStatus) -> Self {
        match status {
            AgentStatus::Connected => Self::WsStatus {
                status: "Connected".into(),
                message: None,
            },
            AgentStatus::Connecting => Self::WsStatus {
                status: "Connecting".into(),
                message: None,
            },
            AgentStatus::Disconnected => Self::WsStatus {
                status: "Disconnected".into(),
                message: None,
            },
            AgentStatus::Error(msg) => Self::WsStatus {
                status: "Error".into(),
                message: Some(msg.clone()),
            },
        }
    }

    pub fn into_agent_status(self) -> Option<AgentStatus> {
        match self {
            Self::WsStatus { status, message } => Some(match status.as_str() {
                "Connected" => AgentStatus::Connected,
                "Connecting" => AgentStatus::Connecting,
                "Error" => AgentStatus::Error(message.unwrap_or_else(|| "WebSocket error".into())),
                _ => AgentStatus::Disconnected,
            }),
            _ => None,
        }
    }
}

#[cfg(windows)]
pub fn outbound_binary_line(bytes: &[u8]) -> String {
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    IpcLine::WsBinaryB64 { data_b64 }.to_line()
}

/// Tell the Session 0 service to reload `%ProgramData%\Vantyr\config.dat`.
///
/// The settings UI can write a fresh enrollment token while the service-owned
/// WebSocket loop is retrying with an old token. This best-effort nudge makes
/// the service pick up the new config without waiting for the user-session IPC
/// stream to reconnect.
#[cfg(windows)]
pub async fn notify_config_changed_best_effort() {
    use tokio::io::AsyncWriteExt;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tracing::warn;

    match ClientOptions::new().open(AGENT_IPC_PIPE_NAME) {
        Ok(mut pipe) => {
            let line = IpcLine::ConfigChanged.to_line();
            if let Err(e) = pipe.write_all(line.as_bytes()).await {
                warn!("Could not notify service of config change: {e:#}");
                return;
            }
            let _ = pipe.flush().await;
        }
        Err(e) => {
            warn!("Could not connect to service IPC for config reload: {e:#}");
        }
    }
}

/// Ask the Session 0 service to persist `config` to `%ProgramData%\Vantyr\config.dat`.
///
/// The user-session companion runs unprivileged and cannot write the machine-wide
/// config directly, so this forwards the whole config to the SYSTEM service (which
/// owns the file) over the same IPC pipe. Synchronous so it slots into the existing
/// `save_config` call sites without restructuring them into async.
///
/// The service replaces its pipe listener after each accept, so a short-lived client
/// connection here is fine and mirrors [`notify_config_changed_best_effort`]. We retry
/// briefly to ride out the tiny accept/replace window.
#[cfg(windows)]
pub fn request_service_persist_config(config: &crate::config::Config) -> std::io::Result<()> {
    use std::io::Write;

    let line = IpcLine::PersistConfig {
        config: Box::new(config.clone()),
    }
    .to_line();

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..5u32 {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(AGENT_IPC_PIPE_NAME)
        {
            Ok(mut pipe) => {
                pipe.write_all(line.as_bytes())?;
                pipe.flush()?;
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(
                    40 * u64::from(attempt + 1),
                ));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("agent IPC pipe unavailable")))
}
