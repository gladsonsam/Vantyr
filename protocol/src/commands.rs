//! The one typed server -> agent command contract.
//!
//! Every server command is a JSON object tagged by `"type"`. Wire strings stay
//! exactly as before (mixed casing is intentional). Payload fields are strict:
//! a missing or wrongly-typed field rejects the whole command. `Option` is used
//! only where the current sender legitimately omits or nulls a field. The full
//! command/field/module table is in `agent/docs/server-commands.md`.
//!
//! [`ServerCommand::gate`] is the one command -> authorization table. The agent
//! admits commands by it and the server authorizes sends by it. Gate lookups by
//! wire kind use [`ServerCommand::gate_for_kind`], which needs no payload.

use serde::{Deserialize, Serialize};

use crate::error::{from_serde, ProtocolError};
use crate::modules::Module;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerCommand {
    // ── Lifecycle ───────────────────────────────────────────────────────────
    #[serde(rename = "agent_deleted")]
    AgentDeleted,
    #[serde(rename = "agent_credentials_revoked")]
    AgentCredentialsRevoked,
    #[serde(rename = "disable_module")]
    DisableModule(DisableModule),
    #[serde(rename = "history_frame_ack")]
    HistoryFrameAck(HistoryFrameAck),

    // ── Clipboard ───────────────────────────────────────────────────────────
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

    /// Only produced by [`ServerCommand::parse`] for a rejected frame.
    #[serde(other)]
    Unknown,
}

impl ServerCommand {
    /// Strict parse: `Err` for an unknown type or any missing/wrongly-typed
    /// field. No command defaults are invented for bad fields.
    pub fn try_parse(val: &serde_json::Value) -> Result<Self, ProtocolError> {
        let command: Self = serde_json::from_value(val.clone()).map_err(from_serde)?;
        if matches!(command, Self::Unknown) {
            return Err(ProtocolError::UnknownType);
        }
        Ok(command)
    }

    /// Signature-compatible fallback for the two agent call sites that consume
    /// a value; rejected frames become `Unknown`, which every gate denies.
    pub fn parse(val: &serde_json::Value) -> Self {
        Self::try_parse(val).unwrap_or(Self::Unknown)
    }

    /// The wire JSON object for this command.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("a server command always serializes")
    }

    /// The exact wire `"type"` string.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::AgentDeleted => "agent_deleted",
            Self::AgentCredentialsRevoked => "agent_credentials_revoked",
            Self::DisableModule(_) => "disable_module",
            Self::HistoryFrameAck(_) => "history_frame_ack",
            Self::ClipboardRead(_) => "ClipboardRead",
            Self::ClipboardWrite(_) => "ClipboardWrite",
            Self::ClipboardCancel(_) => "ClipboardCancel",
            Self::TerminalStart(_) => "TerminalStart",
            Self::TerminalInput(_) => "TerminalInput",
            Self::TerminalResize(_) => "TerminalResize",
            Self::TerminalClose(_) => "TerminalClose",
            Self::RequestInfo => "RequestInfo",
            Self::CollectSoftware => "CollectSoftware",
            Self::LockHost => "LockHost",
            Self::RestartHost => "RestartHost",
            Self::ShutdownHost => "ShutdownHost",
            Self::UpdateNow => "update_now",
            Self::SetAutoUpdate(_) => "set_auto_update",
            Self::SetNetworkPolicy(_) => "set_network_policy",
            Self::SetInternetBlockRules(_) => "set_internet_block_rules",
            Self::SetRecallSettings(_) => "set_recall_settings",
            Self::SetAppBlockRules(_) => "set_app_block_rules",
            Self::StartCapture(_) => "start_capture",
            Self::StopCapture => "stop_capture",
            Self::StartAudio => "start_audio",
            Self::StopAudio => "stop_audio",
            Self::ListLogSources(_) => "ListLogSources",
            Self::ReadLogTail(_) => "ReadLogTail",
            Self::ListDir(_) => "ListDir",
            Self::ReadFile(_) => "ReadFile",
            Self::WriteFileChunk(_) => "WriteFileChunk",
            Self::Mkdir(_) => "Mkdir",
            Self::RenamePath(_) => "RenamePath",
            Self::DeletePath(_) => "DeletePath",
            Self::CopyPath(_) => "CopyPath",
            Self::RunScript(_) => "RunScript",
            Self::MouseMove => "MouseMove",
            Self::MouseClick => "MouseClick",
            Self::MouseDoubleClick => "MouseDoubleClick",
            Self::MouseDown => "MouseDown",
            Self::MouseUp => "MouseUp",
            Self::MouseScroll => "MouseScroll",
            Self::Scroll => "Scroll",
            Self::KeyDown => "KeyDown",
            Self::KeyUp => "KeyUp",
            Self::KeyPress => "KeyPress",
            Self::KeyChar => "KeyChar",
            Self::TypeText => "TypeText",
            Self::Notify => "Notify",
            Self::Unknown => "",
        }
    }

    /// How this command is authorized, from its wire type alone. This keeps
    /// gating available for a raw frame without parsing (or trusting) its
    /// payload; the payload is strictly parsed separately at the boundary.
    pub fn gate_for_kind(kind: &str) -> Gate {
        Gate::Module(match kind {
            "start_capture" => Module::LiveScreen,
            "start_audio" => Module::LiveAudio,
            "ClipboardRead" | "ClipboardWrite" => Module::Clipboard,
            "MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp"
            | "MouseScroll" | "Scroll" | "KeyDown" | "KeyUp" | "KeyPress" | "KeyChar"
            | "TypeText" | "Notify" => Module::RemoteInput,
            "TerminalStart" | "TerminalInput" | "TerminalResize" => Module::Terminal,
            "RunScript" => Module::Scripts,
            "ListDir" | "ReadFile" | "WriteFileChunk" | "Mkdir" | "RenamePath" | "DeletePath"
            | "CopyPath" => Module::Files,
            "CollectSoftware" => Module::SoftwareInventory,
            "RequestInfo" => Module::SystemInfo,
            "LockHost" | "RestartHost" | "ShutdownHost" => Module::SystemControl,
            "set_app_block_rules" => Module::AppPolicy,
            "set_network_policy" | "set_internet_block_rules" => Module::NetworkPolicy,
            "ListLogSources" | "ReadLogTail" => Module::Logs,
            "disable_module" => return Gate::DisableModule,
            "agent_deleted" | "agent_credentials_revoked" | "history_frame_ack"
            | "ClipboardCancel" | "TerminalClose" | "update_now" | "set_auto_update"
            | "set_recall_settings" | "stop_capture" | "stop_audio" => return Gate::Protocol,
            _ => return Gate::Denied,
        })
    }

    /// How this command is authorized. The single table both sides read.
    pub fn gate(&self) -> Gate {
        Self::gate_for_kind(self.kind())
    }

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
    /// Non-collecting protocol/config command (stop, ack, lifecycle, tunables).
    Protocol,
    /// `disable_module`: accepted by the agent itself; the server only sends a
    /// request that matches a persisted disable request.
    DisableModule,
    /// Not a known/current command.
    Denied,
}

// ── Lifecycle and clipboard ─────────────────────────────────────────────────

/// `disable_module`: ask the agent to revoke its grant if it is still at
/// `expected_revision`; answered with a `module_disable_ack` carrying `command_id`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DisableModule {
    pub module: Module,
    pub expected_revision: u64,
    pub command_id: uuid::Uuid,
}

impl DisableModule {
    pub fn new(module: Module, expected_revision: u64, command_id: uuid::Uuid) -> Self {
        Self {
            module,
            expected_revision,
            command_id,
        }
    }
}

/// `history_frame_ack`: the frame was stored, or rejected with a reason.
#[derive(Debug, Serialize, Deserialize)]
pub struct HistoryFrameAck {
    pub uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl HistoryFrameAck {
    pub fn accepted(uid: &str) -> Self {
        Self {
            uid: uid.to_owned(),
            rejected: None,
            reason: None,
        }
    }

    pub fn rejected(uid: &str, reason: &str) -> Self {
        Self {
            uid: uid.to_owned(),
            rejected: Some(true),
            reason: Some(reason.to_owned()),
        }
    }
}

/// `ClipboardRead` / `ClipboardCancel`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardRequest {
    pub request_id: uuid::Uuid,
}

impl ClipboardRequest {
    pub fn new(request_id: uuid::Uuid) -> Self {
        Self { request_id }
    }
}

/// `ClipboardWrite`. `Debug` hides the text: clipboard data must not reach logs.
#[derive(Default, Serialize, Deserialize)]
pub struct ClipboardWrite {
    pub request_id: uuid::Uuid,
    pub text: String,
}

impl Default for ClipboardRequest {
    fn default() -> Self {
        Self {
            request_id: uuid::Uuid::nil(),
        }
    }
}

impl std::fmt::Debug for ClipboardWrite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClipboardWrite")
            .field("request_id", &self.request_id)
            .field("text", &"<redacted>")
            .finish()
    }
}

impl ClipboardWrite {
    pub fn new(request_id: uuid::Uuid, text: &str) -> Self {
        Self {
            request_id,
            text: text.to_owned(),
        }
    }
}

// ── Terminal ────────────────────────────────────────────────────────────────

/// `TerminalStart` / `TerminalResize`. Sizes are clamped by the handler; an
/// omitted size is a current, legitimate "use the default" value.
#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalSize {
    pub session_id: uuid::Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
}

impl TerminalSize {
    pub fn new(session_id: uuid::Uuid, cols: u64, rows: u64) -> Self {
        Self {
            session_id,
            cols: Some(cols),
            rows: Some(rows),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalInput {
    pub session_id: uuid::Uuid,
    pub data: String,
}

impl TerminalInput {
    pub fn new(session_id: uuid::Uuid, data: &str) -> Self {
        Self {
            session_id,
            data: data.to_owned(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalSession {
    pub session_id: uuid::Uuid,
}

impl TerminalSession {
    pub fn new(session_id: uuid::Uuid) -> Self {
        Self { session_id }
    }
}

// ── Policy and settings ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SetAutoUpdate {
    pub enabled: bool,
}

impl SetAutoUpdate {
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetNetworkPolicy {
    pub blocked: bool,
}

impl SetNetworkPolicy {
    pub fn new(blocked: bool) -> Self {
        Self { blocked }
    }
}

/// Each rule stays raw JSON for the agent's own rule types; the whole `rules`
/// field is required and must be an array.
#[derive(Debug, Serialize, Deserialize)]
pub struct BlockRules {
    pub rules: Vec<serde_json::Value>,
}

impl BlockRules {
    pub fn new<T: Serialize>(rules: &[T]) -> Self {
        Self {
            rules: rules
                .iter()
                .map(|rule| serde_json::to_value(rule).expect("a block rule always serializes"))
                .collect(),
        }
    }
}

/// `set_recall_settings`: `settings` is required; the agent validates its body.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetRecallSettings {
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

/// `start_capture`. All tunables are legitimately optional; an outer `Option`
/// records presence of an explicitly-null alias (`jpeg_q`, `monitor_index`).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StartCapture {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub live_tuning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jpeg_q: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<Option<serde_json::Number>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor: Option<Option<u64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_index: Option<Option<u64>>,
}

impl StartCapture {
    /// The request the server builds: `monitor` is always present (`null` for
    /// primary) and the aliases are never sent.
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ListLogSources {
    pub request_id: String,
}

impl ListLogSources {
    pub fn new(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_owned(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadLogTail {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Serialize, Deserialize)]
pub struct FilePath {
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Mkdir {
    pub request_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PathPair {
    pub request_id: String,
    pub src: String,
    pub dst: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeletePath {
    pub request_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WriteFileChunk {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_chunks: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_index: Option<u64>,
    pub data: Option<String>,
}

// ── Scripts ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct RunScript {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    pub script: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    use serde_json::{json, Value};

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
    fn every_wire_kind_has_its_gate_without_a_payload() {
        for (kind, module) in GATED {
            assert_eq!(ServerCommand::gate_for_kind(kind), Gate::Module(*module), "{kind}");
        }
        for kind in UNGATED {
            assert_eq!(ServerCommand::gate_for_kind(kind), Gate::Protocol, "{kind}");
        }
        assert_eq!(ServerCommand::gate_for_kind("disable_module"), Gate::DisableModule);
        assert_eq!(ServerCommand::gate_for_kind("nope"), Gate::Denied);
    }

    #[test]
    fn unknown_and_untagged_frames_are_rejected() {
        for kind in ["", "lockhost", "set_ui_password", "TerminalOpen"] {
            let frame = json!({"type": kind});
            assert!(ServerCommand::try_parse(&frame).is_err());
            assert!(matches!(ServerCommand::parse(&frame), ServerCommand::Unknown));
        }
        for frame in [json!({}), json!({"type":5}), json!({"type":null}), json!("LockHost")] {
            assert!(ServerCommand::try_parse(&frame).is_err());
            assert!(matches!(ServerCommand::parse(&frame), ServerCommand::Unknown));
        }
    }

    #[test]
    fn wrong_typed_and_missing_fields_are_rejected_not_defaulted() {
        let sid = uuid::Uuid::from_u128(0x1234_5678);
        for frame in [
            json!({"type":"TerminalStart","session_id":sid.to_string(),"cols":"120","rows":-1}),
            json!({"type":"TerminalInput","session_id":"not-a-uuid","data":7}),
            json!({"type":"set_network_policy","blocked":"yes"}),
            json!({"type":"set_app_block_rules","rules":{"id":1}}),
            json!({"type":"set_auto_update","enabled":"true"}),
            json!({"type":"disable_module","module":"live_screen","expected_revision":7}),
            json!({"type":"clipboard_result"}),
            json!({"type":"software_inventory","items":"x","captured_at":1}),
        ] {
            assert!(ServerCommand::try_parse(&frame).is_err(), "{frame}");
        }
    }

    #[test]
    fn start_capture_keeps_legit_optional_fields_and_alias_presence() {
        let ServerCommand::StartCapture(capture) = ServerCommand::try_parse(&json!({
            "type": "start_capture", "jpeg_quality": null, "jpeg_q": 80,
            "interval_ms": 12.5, "fps": "30", "monitor_index": 2
        }))
        .unwrap() else {
            panic!("not start_capture");
        };
        assert_eq!(capture.jpeg_quality, Some(None));
        assert_eq!(capture.jpeg_q, Some(Some(80)));
        assert_eq!(capture.interval_ms.flatten().and_then(|n| n.as_f64()), Some(12.5));
        assert_eq!(capture.fps, None);
        assert_eq!((capture.monitor, capture.monitor_index), (None, Some(Some(2))));
    }

    /// Serialize, pin the JSON, and check it parses back to the same JSON.
    fn pin(command: ServerCommand, expected: Value) {
        let wire = command.to_value();
        assert_eq!(wire, expected);
        assert_eq!(ServerCommand::try_parse(&wire).unwrap().to_value(), expected);
    }

    const ID: uuid::Uuid = uuid::Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
    const ID_STR: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn bare_commands_serialize_as_just_their_type() {
        for (command, kind) in [
            (ServerCommand::StartCapture(StartCapture::default()), "start_capture"),
            (ServerCommand::StopCapture, "stop_capture"),
            (ServerCommand::StartAudio, "start_audio"),
            (ServerCommand::StopAudio, "stop_audio"),
            (ServerCommand::CollectSoftware, "CollectSoftware"),
            (ServerCommand::UpdateNow, "update_now"),
            (ServerCommand::RequestInfo, "RequestInfo"),
            (ServerCommand::LockHost, "LockHost"),
        ] {
            assert_eq!(command.to_value(), json!({"type":kind}), "{kind}");
        }
    }

    #[test]
    fn policy_pushes_keep_their_wire_fields() {
        pin(ServerCommand::SetAutoUpdate(SetAutoUpdate::new(true)), json!({"type":"set_auto_update","enabled":true}));
        pin(ServerCommand::SetNetworkPolicy(SetNetworkPolicy::new(false)), json!({"type":"set_network_policy","blocked":false}));
        let rules = [json!({"id":1,"days":[1,2]}), json!({"id":2})];
        pin(ServerCommand::SetInternetBlockRules(BlockRules::new(&rules)), json!({"type":"set_internet_block_rules","rules":rules}));
        pin(ServerCommand::SetAppBlockRules(BlockRules::new(&rules)), json!({"type":"set_app_block_rules","rules":rules}));
        pin(ServerCommand::SetRecallSettings(SetRecallSettings::new(&json!({"enabled":true}))), json!({"type":"set_recall_settings","settings":{"enabled":true}}));
    }

    #[test]
    fn history_acks_omit_rejection_fields_when_accepted() {
        pin(ServerCommand::HistoryFrameAck(HistoryFrameAck::accepted("u1")), json!({"type":"history_frame_ack","uid":"u1"}));
        pin(ServerCommand::HistoryFrameAck(HistoryFrameAck::rejected("u1","too_large")), json!({"type":"history_frame_ack","uid":"u1","rejected":true,"reason":"too_large"}));
    }

    #[test]
    fn capture_commands_keep_a_null_monitor() {
        pin(ServerCommand::StartCapture(StartCapture::new(None,40,200)), json!({"type":"start_capture","monitor":null,"jpeg_quality":40,"interval_ms":200}));
        pin(ServerCommand::StartCapture(StartCapture::new(Some(2),80,33)), json!({"type":"start_capture","monitor":2,"jpeg_quality":80,"interval_ms":33}));
    }

    #[test]
    fn clipboard_commands_carry_the_request_id() {
        pin(ServerCommand::ClipboardRead(ClipboardRequest::new(ID)), json!({"type":"ClipboardRead","request_id":ID_STR}));
        pin(ServerCommand::ClipboardWrite(ClipboardWrite::new(ID,"hi")), json!({"type":"ClipboardWrite","request_id":ID_STR,"text":"hi"}));
        pin(ServerCommand::ClipboardCancel(ClipboardRequest::new(ID)), json!({"type":"ClipboardCancel","request_id":ID_STR}));
    }

    #[test]
    fn terminal_commands_carry_the_session_id() {
        pin(ServerCommand::TerminalStart(TerminalSize::new(ID,80,24)), json!({"type":"TerminalStart","session_id":ID_STR,"cols":80,"rows":24}));
        pin(ServerCommand::TerminalResize(TerminalSize::new(ID,120,40)), json!({"type":"TerminalResize","session_id":ID_STR,"cols":120,"rows":40}));
        pin(ServerCommand::TerminalInput(TerminalInput::new(ID,"ls\r")), json!({"type":"TerminalInput","session_id":ID_STR,"data":"ls\r"}));
        pin(ServerCommand::TerminalClose(TerminalSession::new(ID)), json!({"type":"TerminalClose","session_id":ID_STR}));
    }

    #[test]
    fn request_reply_commands_carry_their_request_id() {
        pin(ServerCommand::RunScript(RunScript::new(ID_STR,"powershell","dir",120)), json!({"type":"RunScript","request_id":ID_STR,"shell":"powershell","script":"dir","timeout_secs":120}));
        pin(ServerCommand::ListLogSources(ListLogSources::new(ID_STR)), json!({"type":"ListLogSources","request_id":ID_STR}));
        pin(ServerCommand::ReadLogTail(ReadLogTail::new(ID_STR,"local_agent",512)), json!({"type":"ReadLogTail","request_id":ID_STR,"kind":"local_agent","max_kb":512}));
    }

    #[test]
    fn disable_module_carries_its_binding() {
        pin(ServerCommand::DisableModule(DisableModule::new(Module::LiveScreen,7,ID)), json!({"type":"disable_module","module":"live_screen","expected_revision":7,"command_id":ID_STR}));
    }
}
