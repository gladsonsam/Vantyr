use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::config::AgentStatus;

#[cfg(windows)]
pub const AGENT_IPC_PIPE_NAME: &str = r"\\.\pipe\SentinelAgentIpc";

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcLine {
    /// Forward this string as a WebSocket `Text` frame to the server.
    WsText { text: String },
    /// Forward this base64 payload as a WebSocket `Binary` frame to the server.
    WsBinaryB64 { data_b64: String },
    /// Best-effort hint from the companion: config on disk was updated.
    ConfigChanged,
    /// Service-owned WebSocket connection status, forwarded to the user-session companion.
    WsStatus {
        status: String,
        #[serde(default)]
        message: Option<String>,
    },
}

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
            Self::ConfigChanged | Self::WsStatus { .. } => None,
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

pub fn outbound_binary_line(bytes: &[u8]) -> String {
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    IpcLine::WsBinaryB64 { data_b64 }.to_line()
}

/// Tell the Session 0 service to reload `%ProgramData%\Sentinel\config.dat`.
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

#[cfg(not(windows))]
pub async fn notify_config_changed_best_effort() {}
