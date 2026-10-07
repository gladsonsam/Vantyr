//! The typed server -> agent command protocol.
//!
//! Every server command is a JSON object tagged by `"type"`. [`ServerCommand`]
//! names each wire string explicitly so the mixed casing (`"LockHost"` next to
//! `"set_auto_update"`) stays exactly as the server sends it. The full table of
//! commands, fields and module gates is in `agent/docs/server-commands.md`.
//!
//! Self-contained (serde/serde_json only) so it can move to a shared protocol
//! crate alongside `permissions::modules`.

use serde::Deserialize;

use crate::permissions::Module;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ServerCommand {
    // ── Lifecycle ───────────────────────────────────────────────────────────
    #[serde(rename = "agent_deleted")]
    AgentDeleted,
    #[serde(rename = "agent_credentials_revoked")]
    AgentCredentialsRevoked,
    /// Fields are read from the raw JSON by `permissions::disable_and_wait`.
    #[serde(rename = "disable_module")]
    DisableModule,
    /// Consumed by the agent loop before dispatch (`agent_loop::history`).
    #[serde(rename = "history_frame_ack")]
    HistoryFrameAck,

    // ── Clipboard (raw JSON handled by `crate::clipboard`) ──────────────────
    #[serde(rename = "ClipboardRead")]
    ClipboardRead,
    #[serde(rename = "ClipboardWrite")]
    ClipboardWrite,
    #[serde(rename = "ClipboardCancel")]
    ClipboardCancel,

    // ── Terminal ────────────────────────────────────────────────────────────
    #[serde(rename = "TerminalStart")]
    TerminalStart,
    #[serde(rename = "TerminalInput")]
    TerminalInput,
    #[serde(rename = "TerminalResize")]
    TerminalResize,
    #[serde(rename = "TerminalClose")]
    TerminalClose,

    // ── System info, inventory and power ────────────────────────────────────
    #[serde(rename = "RequestInfo")]
    RequestInfo,
    #[serde(rename = "CollectSoftware")]
    CollectSoftware,
    #[serde(rename = "LockHost")]
    LockHost,
    #[serde(rename = "RestartHost")]
    RestartHost,
    #[serde(rename = "ShutdownHost")]
    ShutdownHost,
    #[serde(rename = "update_now")]
    UpdateNow,

    // ── Policy and settings ─────────────────────────────────────────────────
    #[serde(rename = "set_auto_update")]
    SetAutoUpdate,
    #[serde(rename = "set_network_policy")]
    SetNetworkPolicy,
    #[serde(rename = "set_internet_block_rules")]
    SetInternetBlockRules,
    #[serde(rename = "set_recall_settings")]
    SetRecallSettings,
    #[serde(rename = "set_app_block_rules")]
    SetAppBlockRules,

    // ── Live screen and audio ───────────────────────────────────────────────
    #[serde(rename = "start_capture")]
    StartCapture,
    #[serde(rename = "stop_capture")]
    StopCapture,
    #[serde(rename = "start_audio")]
    StartAudio,
    #[serde(rename = "stop_audio")]
    StopAudio,

    // ── Logs ────────────────────────────────────────────────────────────────
    #[serde(rename = "ListLogSources")]
    ListLogSources,
    #[serde(rename = "ReadLogTail")]
    ReadLogTail,

    // ── Files ───────────────────────────────────────────────────────────────
    #[serde(rename = "ListDir")]
    ListDir,
    #[serde(rename = "ReadFile")]
    ReadFile,
    #[serde(rename = "WriteFileChunk")]
    WriteFileChunk,
    #[serde(rename = "Mkdir")]
    Mkdir,
    #[serde(rename = "RenamePath")]
    RenamePath,
    #[serde(rename = "DeletePath")]
    DeletePath,
    #[serde(rename = "CopyPath")]
    CopyPath,

    // ── Scripts ─────────────────────────────────────────────────────────────
    #[serde(rename = "RunScript")]
    RunScript,

    // ── Remote input (raw JSON parsed by `input::ControlCommand`) ───────────
    #[serde(rename = "MouseMove")]
    MouseMove,
    #[serde(rename = "MouseClick")]
    MouseClick,
    #[serde(rename = "MouseDoubleClick")]
    MouseDoubleClick,
    #[serde(rename = "MouseDown")]
    MouseDown,
    #[serde(rename = "MouseUp")]
    MouseUp,
    #[serde(rename = "MouseScroll")]
    MouseScroll,
    /// Gated like remote input, but `ControlCommand` has no such variant.
    #[serde(rename = "Scroll")]
    Scroll,
    #[serde(rename = "KeyDown")]
    KeyDown,
    #[serde(rename = "KeyUp")]
    KeyUp,
    #[serde(rename = "KeyPress")]
    KeyPress,
    #[serde(rename = "KeyChar")]
    KeyChar,
    #[serde(rename = "TypeText")]
    TypeText,
    #[serde(rename = "Notify")]
    Notify,

    /// Any other `"type"`, or a frame with no string `"type"`.
    #[serde(other)]
    Unknown,
}

impl ServerCommand {
    /// Parse a server command. Unknown or untagged frames become
    /// [`ServerCommand::Unknown`] rather than an error.
    pub fn parse(val: &serde_json::Value) -> Self {
        Self::deserialize(val).unwrap_or(Self::Unknown)
    }

    /// The command for a bare `"type"` string, every payload field defaulted.
    pub fn from_kind(kind: &str) -> Self {
        Self::parse(&serde_json::json!({ "type": kind }))
    }

    /// The device module that must be granted (and bound by generation) for
    /// this command; `None` for protocol/config commands that collect nothing.
    /// The single command -> module table; `permissions::command_module` reads it.
    pub fn module(&self) -> Option<Module> {
        Some(match self {
            Self::StartCapture => Module::LiveScreen,
            Self::StartAudio => Module::LiveAudio,
            Self::ClipboardRead | Self::ClipboardWrite => Module::Clipboard,
            Self::MouseMove
            | Self::MouseClick
            | Self::MouseDoubleClick
            | Self::MouseDown
            | Self::MouseUp
            | Self::MouseScroll
            | Self::Scroll
            | Self::KeyDown
            | Self::KeyUp
            | Self::KeyPress
            | Self::KeyChar
            | Self::TypeText
            | Self::Notify => Module::RemoteInput,
            Self::TerminalStart | Self::TerminalInput | Self::TerminalResize => Module::Terminal,
            Self::RunScript => Module::Scripts,
            Self::ListDir
            | Self::ReadFile
            | Self::WriteFileChunk
            | Self::Mkdir
            | Self::RenamePath
            | Self::DeletePath
            | Self::CopyPath => Module::Files,
            Self::CollectSoftware => Module::SoftwareInventory,
            Self::RequestInfo => Module::SystemInfo,
            Self::LockHost | Self::RestartHost | Self::ShutdownHost => Module::SystemControl,
            Self::SetAppBlockRules => Module::AppPolicy,
            Self::SetNetworkPolicy | Self::SetInternetBlockRules => Module::NetworkPolicy,
            Self::ListLogSources | Self::ReadLogTail => Module::Logs,
            Self::AgentDeleted
            | Self::AgentCredentialsRevoked
            | Self::DisableModule
            | Self::HistoryFrameAck
            | Self::ClipboardCancel
            | Self::TerminalClose
            | Self::UpdateNow
            | Self::SetAutoUpdate
            | Self::SetRecallSettings
            | Self::StopCapture
            | Self::StopAudio
            | Self::Unknown => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The string table `permissions::command_module` held before it moved
    /// onto [`ServerCommand::module`].
    const GATED: &[(&str, Module)] = &[
        ("start_capture", Module::LiveScreen),
        ("start_audio", Module::LiveAudio),
        ("ClipboardRead", Module::Clipboard),
        ("ClipboardWrite", Module::Clipboard),
        ("MouseMove", Module::RemoteInput),
        ("MouseClick", Module::RemoteInput),
        ("MouseDoubleClick", Module::RemoteInput),
        ("MouseDown", Module::RemoteInput),
        ("MouseUp", Module::RemoteInput),
        ("MouseScroll", Module::RemoteInput),
        ("Scroll", Module::RemoteInput),
        ("KeyDown", Module::RemoteInput),
        ("KeyUp", Module::RemoteInput),
        ("KeyPress", Module::RemoteInput),
        ("KeyChar", Module::RemoteInput),
        ("TypeText", Module::RemoteInput),
        ("Notify", Module::RemoteInput),
        ("TerminalStart", Module::Terminal),
        ("TerminalInput", Module::Terminal),
        ("TerminalResize", Module::Terminal),
        ("RunScript", Module::Scripts),
        ("ListDir", Module::Files),
        ("ReadFile", Module::Files),
        ("WriteFileChunk", Module::Files),
        ("Mkdir", Module::Files),
        ("RenamePath", Module::Files),
        ("DeletePath", Module::Files),
        ("CopyPath", Module::Files),
        ("CollectSoftware", Module::SoftwareInventory),
        ("RequestInfo", Module::SystemInfo),
        ("LockHost", Module::SystemControl),
        ("RestartHost", Module::SystemControl),
        ("ShutdownHost", Module::SystemControl),
        ("set_app_block_rules", Module::AppPolicy),
        ("set_network_policy", Module::NetworkPolicy),
        ("set_internet_block_rules", Module::NetworkPolicy),
        ("ListLogSources", Module::Logs),
        ("ReadLogTail", Module::Logs),
    ];
    const UNGATED: &[&str] = &[
        "agent_deleted",
        "agent_credentials_revoked",
        "disable_module",
        "history_frame_ack",
        "ClipboardCancel",
        "TerminalClose",
        "update_now",
        "set_auto_update",
        "set_recall_settings",
        "stop_capture",
        "stop_audio",
    ];

    #[test]
    fn every_wire_name_parses_with_its_module_gate() {
        for (kind, module) in GATED {
            let command = ServerCommand::from_kind(kind);
            assert!(!matches!(command, ServerCommand::Unknown), "{kind}");
            assert_eq!(command.module(), Some(*module), "{kind}");
        }
        for kind in UNGATED {
            let command = ServerCommand::from_kind(kind);
            assert!(!matches!(command, ServerCommand::Unknown), "{kind}");
            assert_eq!(command.module(), None, "{kind}");
        }
    }

    #[test]
    fn unknown_or_untagged_frames_parse_as_unknown() {
        for kind in ["", "lockhost", "set_ui_password", "TerminalOpen"] {
            assert!(matches!(
                ServerCommand::from_kind(kind),
                ServerCommand::Unknown
            ));
        }
        for frame in [
            serde_json::json!({}),
            serde_json::json!({ "type": 5 }),
            serde_json::json!({ "type": null }),
            serde_json::json!("LockHost"),
        ] {
            assert!(matches!(
                ServerCommand::parse(&frame),
                ServerCommand::Unknown
            ));
        }
    }
}
