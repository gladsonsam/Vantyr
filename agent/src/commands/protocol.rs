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
}
