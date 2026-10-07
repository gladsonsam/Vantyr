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
//! Self-contained (serde/serde_json/uuid only) so it can move to a shared
//! protocol crate alongside `permissions::modules`.

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

    // ── Clipboard (raw JSON handled by `crate::input::clipboard`) ────────────
    #[serde(rename = "ClipboardRead")]
    ClipboardRead,
    #[serde(rename = "ClipboardWrite")]
    ClipboardWrite,
    #[serde(rename = "ClipboardCancel")]
    ClipboardCancel,

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

    /// The device module that must be granted (and bound by generation) for
    /// this command; `None` for protocol/config commands that collect nothing.
    /// The single command -> module table; `permissions::command_module` reads it.
    pub fn module(&self) -> Option<Module> {
        Some(match self {
            Self::StartCapture(_) => Module::LiveScreen,
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
            Self::AgentDeleted
            | Self::AgentCredentialsRevoked
            | Self::DisableModule
            | Self::HistoryFrameAck
            | Self::ClipboardCancel
            | Self::TerminalClose(_)
            | Self::UpdateNow
            | Self::SetAutoUpdate(_)
            | Self::SetRecallSettings(_)
            | Self::StopCapture
            | Self::StopAudio
            | Self::Unknown => return None,
        })
    }
}

// ── Terminal ────────────────────────────────────────────────────────────────

/// `TerminalStart` / `TerminalResize`. Sizes are clamped by the handler.
#[derive(Debug, Default, Deserialize)]
pub struct TerminalSize {
    #[serde(default, deserialize_with = "lenient::uuid")]
    pub session_id: Option<uuid::Uuid>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub cols: Option<u64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub rows: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TerminalInput {
    #[serde(default, deserialize_with = "lenient::uuid")]
    pub session_id: Option<uuid::Uuid>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub data: Option<String>,
}

/// `TerminalClose`.
#[derive(Debug, Default, Deserialize)]
pub struct TerminalSession {
    #[serde(default, deserialize_with = "lenient::uuid")]
    pub session_id: Option<uuid::Uuid>,
}

// ── Policy and settings ─────────────────────────────────────────────────────

/// `set_auto_update`; ignored unless `enabled` is a bool.
#[derive(Debug, Default, Deserialize)]
pub struct SetAutoUpdate {
    #[serde(default, deserialize_with = "lenient::opt")]
    pub enabled: Option<bool>,
}

/// `set_network_policy`; a missing `blocked` means unblocked.
#[derive(Debug, Default, Deserialize)]
pub struct SetNetworkPolicy {
    #[serde(default, deserialize_with = "lenient::opt")]
    pub blocked: Option<bool>,
}

/// `set_internet_block_rules` / `set_app_block_rules`. Each rule stays raw JSON
/// for the agent's own rule types; rules that fail to parse are skipped there.
#[derive(Debug, Default, Deserialize)]
pub struct BlockRules {
    #[serde(default, deserialize_with = "lenient::array")]
    pub rules: Vec<serde_json::Value>,
}

/// `set_recall_settings`; `settings` (null when missing) is parsed by the agent,
/// which rejects the whole update if it is malformed.
#[derive(Debug, Default, Deserialize)]
pub struct SetRecallSettings {
    #[serde(default)]
    pub settings: serde_json::Value,
}

// ── Live screen ─────────────────────────────────────────────────────────────

/// `start_capture`; every field is optional and `capture::CaptureSettings`
/// applies the defaults and clamps. The outer `Option` of an aliased field
/// records presence: the first alias present wins even if its value is unusable.
#[derive(Debug, Default, Deserialize)]
pub struct StartCapture {
    /// JPEG quality 1-100 (alias `jpeg_q`).
    #[serde(default, deserialize_with = "lenient::present")]
    pub jpeg_quality: Option<Option<u64>>,
    #[serde(default, deserialize_with = "lenient::present")]
    pub jpeg_q: Option<Option<u64>>,
    /// Frame interval in ms, integer or float; when absent, `fps` decides.
    #[serde(default, deserialize_with = "lenient::present")]
    pub interval_ms: Option<Option<serde_json::Number>>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub fps: Option<f64>,
    /// 0-based monitor index (alias `monitor_index`); primary when absent.
    #[serde(default, deserialize_with = "lenient::present")]
    pub monitor: Option<Option<u64>>,
    #[serde(default, deserialize_with = "lenient::present")]
    pub monitor_index: Option<Option<u64>>,
}

// ── Logs ────────────────────────────────────────────────────────────────────

/// `ListLogSources`; ignored without a (trimmed) `request_id`.
#[derive(Debug, Default, Deserialize)]
pub struct ListLogSources {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
}

/// `ReadLogTail`; `kind` defaults to `local_agent`, `max_kb` to 512 (max 2048).
#[derive(Debug, Default, Deserialize)]
pub struct ReadLogTail {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub max_kb: Option<u64>,
}

// ── Files ───────────────────────────────────────────────────────────────────
//
// Paths are trimmed and length-capped by the handlers; a missing or empty
// `request_id` / path makes them ignore the command (no reply), as before.

/// `ListDir` / `ReadFile`. For `ListDir` an empty path lists Documents and
/// `__this_pc__` lists drives / mount points.
#[derive(Debug, Default, Deserialize)]
pub struct FilePath {
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
}

/// `Mkdir`: create `name` (no separators allowed) under `path`.
#[derive(Debug, Default, Deserialize)]
pub struct Mkdir {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub name: String,
}

/// `RenamePath` / `CopyPath`.
#[derive(Debug, Default, Deserialize)]
pub struct PathPair {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub src: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub dst: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct DeletePath {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub recursive: Option<bool>,
}

/// One base64 chunk of a dashboard upload. Bad parameters (missing counts,
/// index out of range, empty path) get an error `file_upload_result`.
#[derive(Debug, Default, Deserialize)]
pub struct WriteFileChunk {
    #[serde(default, deserialize_with = "lenient::string")]
    pub path: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub total_chunks: Option<u64>,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub chunk_index: Option<u64>,
    #[serde(default, deserialize_with = "lenient::string")]
    pub data: String,
}

// ── Scripts ─────────────────────────────────────────────────────────────────

/// `RunScript`. A missing `request_id` or a script over 256 KiB is dropped with
/// a warning; `shell` defaults to `powershell`, `timeout_secs` to 120 (5-300).
#[derive(Debug, Default, Deserialize)]
pub struct RunScript {
    #[serde(default, deserialize_with = "lenient::string")]
    pub request_id: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub shell: Option<String>,
    #[serde(default, deserialize_with = "lenient::string")]
    pub script: String,
    #[serde(default, deserialize_with = "lenient::opt")]
    pub timeout_secs: Option<u64>,
}

/// Field readers that never fail a command: a missing field or one of the
/// wrong JSON type reads as absent, exactly like `as_str()` / `as_u64()` /
/// `as_bool()` on the raw value.
mod lenient {
    use serde::{de::DeserializeOwned, Deserialize, Deserializer};

    /// `Some` only when the value has the expected JSON type.
    pub(super) fn opt<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: DeserializeOwned,
    {
        let value = serde_json::Value::deserialize(d)?;
        Ok(serde_json::from_value(value).ok())
    }

    /// A string, empty when missing or not a string.
    pub(super) fn string<'de, D>(d: D) -> Result<String, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(opt(d)?.unwrap_or_default())
    }

    /// `Some` whenever the field is present (null included), wrapping the
    /// lenient value; the field's `#[serde(default)]` covers absence.
    pub(super) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: DeserializeOwned,
    {
        opt(d).map(Some)
    }

    /// The elements of an array, empty when missing or not an array.
    pub(super) fn array<'de, D>(d: D) -> Result<Vec<serde_json::Value>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(opt(d)?.unwrap_or_default())
    }

    /// A string that parses as a UUID (any form `Uuid::parse_str` accepts).
    pub(super) fn uuid<'de, D>(d: D) -> Result<Option<uuid::Uuid>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(opt::<D, String>(d)?.and_then(|s| uuid::Uuid::parse_str(&s).ok()))
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
    fn terminal_fields_fall_back_like_the_untyped_reads() {
        let sid = uuid::Uuid::new_v4();
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
}
