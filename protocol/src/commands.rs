//! The typed server -> agent command protocol.
//!
//! Every server command is a JSON object tagged by `"type"`. [`ServerCommand`]
//! names each wire string explicitly so the mixed casing (`"LockHost"` next to
//! `"set_auto_update"`) stays exactly as the server sends it. The full table of
//! commands, fields and module gates is in `agent/docs/server-commands.md`.
//!
//! Payload fields are deliberately lenient, like the `val["x"].as_str()` reads
//! they replace: a missing or wrongly-typed field reads as absent (or its
//! default) instead of rejecting the whole command. Commands whose payload is
//! still read as raw JSON elsewhere (clipboard, `disable_module`, remote input)
//! carry no fields here.
//!
//! [`ServerCommand::gate`] is the one command -> authorization table. The agent
//! admits commands by it and the server authorizes sends by it.

use serde::{Deserialize, Serialize};

use crate::lenient;
use crate::modules::Module;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerCommand {
    // ── Lifecycle ───────────────────────────────────────────────────────────
    #[serde(rename = "agent_deleted")]
    AgentDeleted,
    #[serde(rename = "agent_credentials_revoked")]
    AgentCredentialsRevoked,
    /// The agent reads these fields from the raw JSON (`permissions::disable_and_wait`).
    #[serde(rename = "disable_module")]
    DisableModule(DisableModule),
    /// Consumed by the agent loop before dispatch (`agent_loop::history`).
    #[serde(rename = "history_frame_ack")]
    HistoryFrameAck(HistoryFrameAck),

    // ── Clipboard (the agent reads the raw JSON in `crate::input::clipboard`) ─
    #[serde(rename = "ClipboardRead")]
    ClipboardRead(ClipboardRequest),
    #[serde(rename = "ClipboardWrite")]
    ClipboardWrite(ClipboardWrite),
    #[serde(rename = "ClipboardCancel")]
    ClipboardCancel(ClipboardRequest),

    // ── Terminal ────────────────────────────────────────────────────────────
    #[serde(rename = "TerminalStart")]
    TerminalStart(TerminalSize),
    #[serde(rename = "TerminalInput")]
    TerminalInput(TerminalInput),
    #[serde(rename = "TerminalResize")]
    TerminalResize(TerminalSize),
    #[serde(rename = "TerminalClose")]
    TerminalClose(TerminalSession),

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
    SetAutoUpdate(SetAutoUpdate),
    #[serde(rename = "set_network_policy")]
    SetNetworkPolicy(SetNetworkPolicy),
    #[serde(rename = "set_internet_block_rules")]
    SetInternetBlockRules(BlockRules),
    #[serde(rename = "set_recall_settings")]
    SetRecallSettings(SetRecallSettings),
    #[serde(rename = "set_app_block_rules")]
    SetAppBlockRules(BlockRules),

    // ── Live screen and audio ───────────────────────────────────────────────
    #[serde(rename = "start_capture")]
    StartCapture(StartCapture),
    #[serde(rename = "stop_capture")]
    StopCapture,
    #[serde(rename = "start_audio")]
    StartAudio,
    #[serde(rename = "stop_audio")]
    StopAudio,

    // ── Logs ────────────────────────────────────────────────────────────────
    #[serde(rename = "ListLogSources")]
    ListLogSources(ListLogSources),
    #[serde(rename = "ReadLogTail")]
    ReadLogTail(ReadLogTail),

    // ── Files ───────────────────────────────────────────────────────────────
    #[serde(rename = "ListDir")]
    ListDir(FilePath),
    #[serde(rename = "ReadFile")]
    ReadFile(FilePath),
    #[serde(rename = "WriteFileChunk")]
    WriteFileChunk(WriteFileChunk),
    #[serde(rename = "Mkdir")]
    Mkdir(Mkdir),
    #[serde(rename = "RenamePath")]
    RenamePath(PathPair),
    #[serde(rename = "DeletePath")]
    DeletePath(DeletePath),
    #[serde(rename = "CopyPath")]
    CopyPath(PathPair),

    // ── Scripts ─────────────────────────────────────────────────────────────
    #[serde(rename = "RunScript")]
    RunScript(RunScript),

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

    /// The wire JSON object (`{"type": ..., <fields>}`) for this command.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("a server command always serializes")
    }

    /// How this command is authorized. The single table both sides read: the
    /// agent's fence admits by it, the server's `authorize_agent_command` sends by it.
    pub fn gate(&self) -> Gate {
        Gate::Module(match self {
            Self::StartCapture(_) => Module::LiveScreen,
            Self::StartAudio => Module::LiveAudio,
            Self::ClipboardRead(_) | Self::ClipboardWrite(_) => Module::Clipboard,
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
            Self::TerminalStart(_) | Self::TerminalInput(_) | Self::TerminalResize(_) => {
                Module::Terminal
            }
            Self::RunScript(_) => Module::Scripts,
            Self::ListDir(_)
            | Self::ReadFile(_)
            | Self::WriteFileChunk(_)
            | Self::Mkdir(_)
            | Self::RenamePath(_)
            | Self::DeletePath(_)
            | Self::CopyPath(_) => Module::Files,
            Self::CollectSoftware => Module::SoftwareInventory,
            Self::RequestInfo => Module::SystemInfo,
            Self::LockHost | Self::RestartHost | Self::ShutdownHost => Module::SystemControl,
            Self::SetAppBlockRules(_) => Module::AppPolicy,
            Self::SetNetworkPolicy(_) | Self::SetInternetBlockRules(_) => Module::NetworkPolicy,
            Self::ListLogSources(_) | Self::ReadLogTail(_) => Module::Logs,
            Self::DisableModule(_) => return Gate::DisableModule,
            Self::AgentDeleted
            | Self::AgentCredentialsRevoked
            | Self::HistoryFrameAck(_)
            | Self::ClipboardCancel(_)
            | Self::TerminalClose(_)
            | Self::UpdateNow
            | Self::SetAutoUpdate(_)
            | Self::SetRecallSettings(_)
            | Self::StopCapture
            | Self::StopAudio => return Gate::Protocol,
            Self::Unknown => return Gate::Denied,
        })
    }

    /// The device module that must be granted (and bound by generation) for
    /// this command; `None` for every ungated command.
    pub fn module(&self) -> Option<Module> {
        match self.gate() {
            Gate::Module(module) => Some(module),
            Gate::Protocol | Gate::DisableModule | Gate::Denied => None,
        }
    }
}

/// How a [`ServerCommand`] is authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Needs the module granted on the device and a matching generation.
    Module(Module),
    /// Non-collecting protocol/config command (stop, ack, lifecycle, tunables):
    /// never gated on a module and passed through by both sides.
    Protocol,
    /// `disable_module`. The agent accepts and answers it itself, so it is
    /// ungated there. The server must not pass it through like [`Gate::Protocol`]:
    /// it only sends one that matches a persisted disable request.
    DisableModule,
    /// Not a known command (including server-only commands the agent refuses,
    /// such as the remote UI-password setter).
    Denied,
}

// ── Lifecycle and clipboard ─────────────────────────────────────────────────

/// `disable_module`: ask the agent to revoke its local grant of `module` if it is
/// still at `expected_revision`, answered with a `module_disable_ack` carrying `command_id`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DisableModule {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub module: Option<Module>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_revision: Option<u64>,
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub command_id: Option<uuid::Uuid>,
}

impl DisableModule {
    pub fn new(module: Module, expected_revision: u64, command_id: uuid::Uuid) -> Self {
        Self {
            module: Some(module),
            expected_revision: Some(expected_revision),
            command_id: Some(command_id),
        }
    }
}

/// `history_frame_ack`: the server persisted the Recall keyframe `uid`, or
/// (`rejected`, with a `reason`) will never accept it.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct HistoryFrameAck {
    #[serde(default, deserialize_with = "lenient::string")]
    pub uid: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rejected: Option<bool>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<String>,
}

impl HistoryFrameAck {
    /// The frame was stored.
    pub fn accepted(uid: &str) -> Self {
        Self {
            uid: uid.to_owned(),
            ..Self::default()
        }
    }

    /// No retry will fix the frame; the agent should drop it.
    pub fn rejected(uid: &str, reason: &str) -> Self {
        Self {
            uid: uid.to_owned(),
            rejected: Some(true),
            reason: Some(reason.to_owned()),
        }
    }
}

/// `ClipboardRead` / `ClipboardCancel`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ClipboardRequest {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_id: Option<uuid::Uuid>,
}

impl ClipboardRequest {
    pub fn new(request_id: uuid::Uuid) -> Self {
        Self {
            request_id: Some(request_id),
        }
    }
}

/// `ClipboardWrite`. `Debug` hides the text: clipboard data must not reach logs.
#[derive(Default, Serialize, Deserialize)]
pub struct ClipboardWrite {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_id: Option<uuid::Uuid>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub text: Option<String>,
}

impl std::fmt::Debug for ClipboardWrite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClipboardWrite")
            .field("request_id", &self.request_id)
            .field("text", &self.text.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl ClipboardWrite {
    pub fn new(request_id: uuid::Uuid, text: &str) -> Self {
        Self {
            request_id: Some(request_id),
            text: Some(text.to_owned()),
        }
    }
}

// ── Terminal ────────────────────────────────────────────────────────────────

/// `TerminalStart` / `TerminalResize`. Sizes are clamped by the handler.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TerminalSize {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_id: Option<uuid::Uuid>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub cols: Option<u64>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rows: Option<u64>,
}

impl TerminalSize {
    pub fn new(session_id: uuid::Uuid, cols: u64, rows: u64) -> Self {
        Self {
            session_id: Some(session_id),
            cols: Some(cols),
            rows: Some(rows),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TerminalInput {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_id: Option<uuid::Uuid>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub data: Option<String>,
}

impl TerminalInput {
    pub fn new(session_id: uuid::Uuid, data: &str) -> Self {
        Self {
            session_id: Some(session_id),
            data: Some(data.to_owned()),
        }
    }
}

/// `TerminalClose`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TerminalSession {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_id: Option<uuid::Uuid>,
}

impl TerminalSession {
    pub fn new(session_id: uuid::Uuid) -> Self {
        Self {
            session_id: Some(session_id),
        }
    }
}

// ── Policy and settings ─────────────────────────────────────────────────────

/// `set_auto_update`; ignored unless `enabled` is a bool.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetAutoUpdate {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
}

impl SetAutoUpdate {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: Some(enabled),
        }
    }
}

/// `set_network_policy`; a missing `blocked` means unblocked.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetNetworkPolicy {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub blocked: Option<bool>,
}

impl SetNetworkPolicy {
    pub fn new(blocked: bool) -> Self {
        Self {
            blocked: Some(blocked),
        }
    }
}

/// `set_internet_block_rules` / `set_app_block_rules`. Each rule stays raw JSON
/// for the agent's own rule types; rules that fail to parse are skipped there.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct BlockRules {
    #[serde(default, deserialize_with = "lenient::array")]
    pub rules: Vec<serde_json::Value>,
}

impl BlockRules {
    /// Rules of any serializable type; each becomes one raw JSON element.
    pub fn new<T: Serialize>(rules: &[T]) -> Self {
        Self {
            rules: rules
                .iter()
                .map(|rule| serde_json::to_value(rule).expect("a block rule always serializes"))
                .collect(),
        }
    }
}

/// `set_recall_settings`; `settings` (null when missing) is parsed by the agent,
/// which rejects the whole update if it is malformed.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetRecallSettings {
    #[serde(default)]
    pub settings: serde_json::Value,
}

impl SetRecallSettings {
    pub fn new<T: Serialize>(settings: &T) -> Self {
        Self {
            settings: serde_json::to_value(settings).expect("Recall settings always serialize"),
        }
    }
}

// ── Live screen ─────────────────────────────────────────────────────────────

/// `start_capture`; every field is optional and `capture::CaptureSettings`
/// applies the defaults and clamps. The outer `Option` of an aliased field
/// records presence: the first alias present wins even if its value is unusable.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StartCapture {
    /// JPEG quality 1-100 (alias `jpeg_q`).
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub jpeg_quality: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub jpeg_q: Option<Option<u64>>,
    /// Frame interval in ms, integer or float; when absent, `fps` decides.
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub interval_ms: Option<Option<serde_json::Number>>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub fps: Option<f64>,
    /// 0-based monitor index (alias `monitor_index`); primary when absent.
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub monitor: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub monitor_index: Option<Option<u64>>,
}

impl StartCapture {
    /// A capture request as the server sends it: `monitor` is always present
    /// (`null` for the primary monitor) and the legacy aliases are never sent.
    pub fn new(monitor: Option<u32>, jpeg_quality: u8, interval_ms: u32) -> Self {
        Self {
            jpeg_quality: Some(Some(u64::from(jpeg_quality))),
            interval_ms: Some(Some(serde_json::Number::from(interval_ms))),
            monitor: Some(monitor.map(u64::from)),
            ..Self::default()
        }
    }
}

// ── Logs ────────────────────────────────────────────────────────────────────

/// `ListLogSources`; ignored without a (trimmed) `request_id`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListLogSources {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
}

impl ListLogSources {
    pub fn new(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_owned(),
        }
    }
}

/// `ReadLogTail`; `kind` defaults to `local_agent`, `max_kb` to 512 (max 2048).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ReadLogTail {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_kb: Option<u64>,
}

impl ReadLogTail {
    pub fn new(request_id: &str, kind: &str, max_kb: u64) -> Self {
        Self {
            request_id: request_id.to_owned(),
            kind: Some(kind.to_owned()),
            max_kb: Some(max_kb),
        }
    }
}

// ── Files ───────────────────────────────────────────────────────────────────
//
// Paths are trimmed and length-capped by the handlers; a missing or empty
// `request_id` / path makes them ignore the command (no reply), as before.

/// `ListDir` / `ReadFile`. For `ListDir` an empty path lists Documents and
/// `__this_pc__` lists drives / mount points.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct FilePath {
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
}

/// `Mkdir`: create `name` (no separators allowed) under `path`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Mkdir {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub name: String,
}

/// `RenamePath` / `CopyPath`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PathPair {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub src: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub dst: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DeletePath {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub recursive: Option<bool>,
}

/// One base64 chunk of a dashboard upload. Bad parameters (missing counts,
/// index out of range, empty path) get an error `file_upload_result`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WriteFileChunk {
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub total_chunks: Option<u64>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub chunk_index: Option<u64>,
    #[serde(default, deserialize_with = "lenient::string")]
    pub data: String,
}

// ── Scripts ─────────────────────────────────────────────────────────────────

/// `RunScript`. A missing `request_id` or a script over 256 KiB is dropped with
/// a warning; `shell` defaults to `powershell`, `timeout_secs` to 120 (5-300).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RunScript {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub shell: Option<String>,
    #[serde(default, deserialize_with = "lenient::string")]
    pub script: String,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub timeout_secs: Option<u64>,
}

impl RunScript {
    pub fn new(request_id: &str, shell: &str, script: &str, timeout_secs: u64) -> Self {
        Self {
            request_id: request_id.to_owned(),
            shell: Some(shell.to_owned()),
            script: script.to_owned(),
            timeout_secs: Some(timeout_secs),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The string table the agent's `permissions::command_module` held before
    /// it moved onto [`ServerCommand::module`].
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
            assert_eq!(command.gate(), Gate::Protocol, "{kind}");
        }
        assert_eq!(
            ServerCommand::from_kind("disable_module").gate(),
            Gate::DisableModule
        );
        assert_eq!(ServerCommand::from_kind("nope").gate(), Gate::Denied);
    }

    #[test]
    fn terminal_fields_fall_back_like_the_untyped_reads() {
        let sid = uuid::Uuid::from_u128(0x1234_5678);
        let ServerCommand::TerminalStart(start) = ServerCommand::parse(&serde_json::json!({
            "type": "TerminalStart", "session_id": sid.to_string(), "cols": "120", "rows": -1
        })) else {
            panic!("not TerminalStart");
        };
        assert_eq!(start.session_id, Some(sid));
        assert_eq!((start.cols, start.rows), (None, None));
        let ServerCommand::TerminalInput(input) = ServerCommand::parse(&serde_json::json!({
            "type": "TerminalInput", "session_id": "not-a-uuid", "data": 7
        })) else {
            panic!("not TerminalInput");
        };
        assert_eq!((input.session_id, input.data), (None, None));
    }

    #[test]
    fn policy_fields_fall_back_like_the_untyped_reads() {
        let ServerCommand::SetNetworkPolicy(policy) = ServerCommand::parse(
            &serde_json::json!({ "type": "set_network_policy", "blocked": "yes" }),
        ) else {
            panic!("not set_network_policy");
        };
        assert_eq!(policy.blocked, None);
        let ServerCommand::SetAppBlockRules(rules) = ServerCommand::parse(
            &serde_json::json!({ "type": "set_app_block_rules", "rules": { "id": 1 } }),
        ) else {
            panic!("not set_app_block_rules");
        };
        assert!(rules.rules.is_empty());
        let ServerCommand::SetRecallSettings(recall) =
            ServerCommand::from_kind("set_recall_settings")
        else {
            panic!("not set_recall_settings");
        };
        assert!(recall.settings.is_null());
    }

    #[test]
    fn start_capture_records_alias_presence() {
        let ServerCommand::StartCapture(capture) = ServerCommand::parse(&serde_json::json!({
            "type": "start_capture", "jpeg_quality": null, "jpeg_q": 80,
            "interval_ms": 12.5, "fps": "30", "monitor_index": 2
        })) else {
            panic!("not start_capture");
        };
        assert_eq!(capture.jpeg_quality, Some(None));
        assert_eq!(capture.jpeg_q, Some(Some(80)));
        assert_eq!(
            capture.interval_ms.flatten().and_then(|n| n.as_f64()),
            Some(12.5)
        );
        assert_eq!(capture.fps, None);
        assert_eq!(
            (capture.monitor, capture.monitor_index),
            (None, Some(Some(2)))
        );
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

    // ── What the server sends ───────────────────────────────────────────────
    //
    // Each test pins the exact JSON of the commands the server builds, and that
    // the agent-side parse of that JSON reads the same fields back.

    use serde_json::{json, Value};

    const ID: uuid::Uuid = uuid::Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
    const ID_STR: &str = "01234567-89ab-cdef-0123-456789abcdef";

    /// Serialize, pin the JSON, and check it parses back to the same JSON.
    fn pin(command: ServerCommand, expected: Value) {
        let wire = command.to_value();
        assert_eq!(wire, expected);
        assert_eq!(ServerCommand::parse(&wire).to_value(), expected);
    }

    #[test]
    fn bare_commands_serialize_as_just_their_type() {
        for kind in [
            "start_capture",
            "stop_capture",
            "start_audio",
            "stop_audio",
            "CollectSoftware",
            "update_now",
            "RequestInfo",
            "LockHost",
        ] {
            let wire = ServerCommand::from_kind(kind).to_value();
            assert_eq!(wire, json!({ "type": kind }), "{kind}");
        }
    }

    #[test]
    fn policy_pushes_keep_their_wire_fields() {
        pin(
            ServerCommand::SetAutoUpdate(SetAutoUpdate::new(true)),
            json!({ "type": "set_auto_update", "enabled": true }),
        );
        pin(
            ServerCommand::SetNetworkPolicy(SetNetworkPolicy::new(false)),
            json!({ "type": "set_network_policy", "blocked": false }),
        );
        let rules = [json!({ "id": 1, "days": [1, 2] }), json!({ "id": 2 })];
        pin(
            ServerCommand::SetInternetBlockRules(BlockRules::new(&rules)),
            json!({ "type": "set_internet_block_rules", "rules": rules }),
        );
        pin(
            ServerCommand::SetAppBlockRules(BlockRules::new(&rules)),
            json!({ "type": "set_app_block_rules", "rules": rules }),
        );
        pin(
            ServerCommand::SetAppBlockRules(BlockRules::new::<Value>(&[])),
            json!({ "type": "set_app_block_rules", "rules": [] }),
        );
        pin(
            ServerCommand::SetRecallSettings(SetRecallSettings::new(&json!({ "enabled": true }))),
            json!({ "type": "set_recall_settings", "settings": { "enabled": true } }),
        );
    }

    #[test]
    fn history_acks_omit_rejection_fields_when_accepted() {
        pin(
            ServerCommand::HistoryFrameAck(HistoryFrameAck::accepted("u1")),
            json!({ "type": "history_frame_ack", "uid": "u1" }),
        );
        pin(
            ServerCommand::HistoryFrameAck(HistoryFrameAck::rejected("u1", "too_large")),
            json!({
                "type": "history_frame_ack", "uid": "u1",
                "rejected": true, "reason": "too_large"
            }),
        );
    }

    #[test]
    fn capture_commands_keep_a_null_monitor() {
        pin(
            ServerCommand::StartCapture(StartCapture::new(None, 40, 200)),
            json!({
                "type": "start_capture", "monitor": null,
                "jpeg_quality": 40, "interval_ms": 200
            }),
        );
        pin(
            ServerCommand::StartCapture(StartCapture::new(Some(2), 80, 33)),
            json!({
                "type": "start_capture", "monitor": 2,
                "jpeg_quality": 80, "interval_ms": 33
            }),
        );
    }

    #[test]
    fn clipboard_commands_carry_the_request_id() {
        pin(
            ServerCommand::ClipboardRead(ClipboardRequest::new(ID)),
            json!({ "type": "ClipboardRead", "request_id": ID_STR }),
        );
        pin(
            ServerCommand::ClipboardWrite(ClipboardWrite::new(ID, "hi")),
            json!({ "type": "ClipboardWrite", "request_id": ID_STR, "text": "hi" }),
        );
        pin(
            ServerCommand::ClipboardCancel(ClipboardRequest::new(ID)),
            json!({ "type": "ClipboardCancel", "request_id": ID_STR }),
        );
    }

    #[test]
    fn terminal_commands_carry_the_session_id() {
        pin(
            ServerCommand::TerminalStart(TerminalSize::new(ID, 80, 24)),
            json!({ "type": "TerminalStart", "session_id": ID_STR, "cols": 80, "rows": 24 }),
        );
        pin(
            ServerCommand::TerminalResize(TerminalSize::new(ID, 120, 40)),
            json!({ "type": "TerminalResize", "session_id": ID_STR, "cols": 120, "rows": 40 }),
        );
        pin(
            ServerCommand::TerminalInput(TerminalInput::new(ID, "ls\r")),
            json!({ "type": "TerminalInput", "session_id": ID_STR, "data": "ls\r" }),
        );
        pin(
            ServerCommand::TerminalClose(TerminalSession::new(ID)),
            json!({ "type": "TerminalClose", "session_id": ID_STR }),
        );
    }

    #[test]
    fn request_reply_commands_carry_their_request_id() {
        pin(
            ServerCommand::RunScript(RunScript::new(ID_STR, "powershell", "dir", 120)),
            json!({
                "type": "RunScript", "request_id": ID_STR, "shell": "powershell",
                "script": "dir", "timeout_secs": 120
            }),
        );
        pin(
            ServerCommand::ListLogSources(ListLogSources::new(ID_STR)),
            json!({ "type": "ListLogSources", "request_id": ID_STR }),
        );
        pin(
            ServerCommand::ReadLogTail(ReadLogTail::new(ID_STR, "local_agent", 512)),
            json!({
                "type": "ReadLogTail", "request_id": ID_STR,
                "kind": "local_agent", "max_kb": 512
            }),
        );
    }

    #[test]
    fn disable_module_carries_its_binding() {
        pin(
            ServerCommand::DisableModule(DisableModule::new(Module::LiveScreen, 7, ID)),
            json!({
                "type": "disable_module", "module": "live_screen",
                "expected_revision": 7, "command_id": ID_STR
            }),
        );
    }
}
