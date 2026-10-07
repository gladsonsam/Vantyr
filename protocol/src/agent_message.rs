//! The typed agent -> server message protocol.
//!
//! Every agent text frame is a JSON object tagged by `"type"`. [`AgentMessage`]
//! names the types the server dispatches on and carries the few fields the
//! server reads *to route or validate* a message. It is a view, not the full
//! payload: persistence and the dashboard fan-out keep working on the raw JSON
//! (unknown fields and future additions flow through untouched), so payload
//! fields only appear here when dispatch itself needs them.
//!
//! Parsing never fails a message. A missing or wrongly-typed field reads as
//! absent, exactly like the `val["x"].as_str()` reads this replaced, and a
//! frame with an unknown or non-string `"type"` is [`AgentMessage::Unknown`]
//! (the server still logs and fans it out).
//!
//! Only the variants that carry a payload struct with every wire field
//! ([`TerminalOutput`], [`TerminalExit`]) are meant to be built and serialized,
//! by the agent; the other variants describe what the server reads.

use serde::{Deserialize, Serialize};

use crate::lenient;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentMessage {
    /// Agent-side batching: `{type:"batch", events:[...]}`. Batches do not nest.
    #[serde(rename = "batch")]
    Batch(Batch),

    // ── Module protocol (payload parsed by the server's module report types) ──
    #[serde(rename = "module_states")]
    ModuleStates,
    #[serde(rename = "module_disable_ack")]
    ModuleDisableAck,

    // ── One-shot replies to a server command ────────────────────────────────
    #[serde(rename = "clipboard_result")]
    ClipboardResult,
    #[serde(rename = "log_tail")]
    LogTail(RequestId),
    #[serde(rename = "log_sources")]
    LogSources(RequestId),
    #[serde(rename = "script_result")]
    ScriptResult(RequestId),
    /// Replies the server accepts and drops: the dashboard reads them off the fan-out.
    #[serde(rename = "dir_list")]
    DirList,
    #[serde(rename = "file_chunk")]
    FileChunk,
    #[serde(rename = "file_upload_result")]
    FileUploadResult,

    // ── Interactive terminal ────────────────────────────────────────────────
    #[serde(rename = "terminal_output")]
    TerminalOutput(TerminalOutput),
    #[serde(rename = "terminal_exit")]
    TerminalExit(TerminalExit),

    // ── Recall ──────────────────────────────────────────────────────────────
    /// Legacy base64 keyframe (superseded by the binary `HST\0` frame).
    #[serde(rename = "history_frame")]
    HistoryFrame,

    // ── Telemetry ───────────────────────────────────────────────────────────
    #[serde(rename = "keys")]
    Keys(Keys),
    #[serde(rename = "window_focus")]
    WindowFocus(WindowFocus),
    #[serde(rename = "url")]
    Url(Url),
    #[serde(rename = "url_session")]
    UrlSession,
    #[serde(rename = "afk")]
    Afk,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "app_icon")]
    AppIcon(AppIcon),
    #[serde(rename = "app_block_kill")]
    AppBlockKill(AppBlockKill),
    #[serde(rename = "agent_info")]
    AgentInfo,
    #[serde(rename = "metrics")]
    Metrics,
    /// The `items` array stays raw JSON (up to thousands of entries).
    #[serde(rename = "software_inventory")]
    SoftwareInventory(SoftwareInventory),

    /// Any other `"type"`, or a frame with no string `"type"`.
    #[serde(other)]
    Unknown,
}

impl AgentMessage {
    /// Parse an agent frame. Unknown or untagged frames become
    /// [`AgentMessage::Unknown`] rather than an error.
    pub fn parse(val: &serde_json::Value) -> Self {
        Self::deserialize(val).unwrap_or(Self::Unknown)
    }

    /// The wire value for a message the agent builds.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("an agent message always serializes")
    }
}

/// `batch`; events that are not objects are carried through and fall to `Unknown`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Batch {
    #[serde(default, deserialize_with = "lenient::array")]
    pub events: Vec<serde_json::Value>,
}

/// The `request_id` a reply is routed back to its waiting HTTP request by.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RequestId {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub request_id: Option<uuid::Uuid>,
}

/// `terminal_output`: a chunk of shell output, routed to the owning browser session.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TerminalOutput {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_id: Option<uuid::Uuid>,
    /// Base64 of the raw bytes read from the pty.
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub data_b64: Option<String>,
}

impl TerminalOutput {
    pub fn new(session_id: uuid::Uuid, data_b64: String) -> Self {
        Self {
            session_id: Some(session_id),
            data_b64: Some(data_b64),
        }
    }
}

/// `terminal_exit`: the shell ended.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TerminalExit {
    #[serde(
        default,
        deserialize_with = "lenient::uuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_id: Option<uuid::Uuid>,
}

impl TerminalExit {
    pub fn new(session_id: uuid::Uuid) -> Self {
        Self {
            session_id: Some(session_id),
        }
    }
}

/// `keys`: typed text, dropped by the server when over its length cap.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Keys {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub text: Option<String>,
}

/// `window_focus`: foreground window; the server caps `title` and `app`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WindowFocus {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub app: Option<String>,
}

/// `url`: a page visit; the server caps `url`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Url {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub url: Option<String>,
}

/// `app_icon`: `{exe_name, png_base64}`; ignored unless both are usable.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppIcon {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub exe_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub png_base64: Option<String>,
}

/// `app_block_kill`: an app-block rule ended a process; ignored without an `exe_name`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AppBlockKill {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rule_id: Option<i64>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub rule_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub exe_name: Option<String>,
}

/// `software_inventory`: a full snapshot; only the capture time is read here.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SoftwareInventory {
    #[serde(
        default,
        deserialize_with = "lenient::opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub captured_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: uuid::Uuid = uuid::Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
    const ID_STR: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn every_dispatched_type_parses_from_just_its_tag() {
        for kind in [
            "batch",
            "module_states",
            "module_disable_ack",
            "clipboard_result",
            "log_tail",
            "log_sources",
            "script_result",
            "dir_list",
            "file_chunk",
            "file_upload_result",
            "terminal_output",
            "terminal_exit",
            "history_frame",
            "keys",
            "window_focus",
            "url",
            "url_session",
            "afk",
            "active",
            "app_icon",
            "app_block_kill",
            "agent_info",
            "metrics",
            "software_inventory",
        ] {
            let msg = AgentMessage::parse(&json!({ "type": kind }));
            assert!(!matches!(msg, AgentMessage::Unknown), "{kind}");
        }
    }

    #[test]
    fn unknown_or_untagged_frames_parse_as_unknown() {
        for frame in [
            json!({ "type": "fs_op_result" }),
            json!({ "type": "Keys" }),
            json!({ "type": 5 }),
            json!({ "type": null }),
            json!({}),
            json!("keys"),
            json!([1, 2]),
        ] {
            assert!(matches!(AgentMessage::parse(&frame), AgentMessage::Unknown));
        }
    }

    #[test]
    fn wrong_typed_fields_read_as_absent_instead_of_dropping_the_message() {
        let AgentMessage::Keys(keys) = AgentMessage::parse(&json!({ "type": "keys", "text": 7 }))
        else {
            panic!("not keys");
        };
        assert_eq!(keys.text, None);
        let AgentMessage::WindowFocus(focus) = AgentMessage::parse(
            &json!({ "type": "window_focus", "title": ["t"], "app": "editor.exe" }),
        ) else {
            panic!("not window_focus");
        };
        assert_eq!(
            (focus.title, focus.app.as_deref()),
            (None, Some("editor.exe"))
        );
        let AgentMessage::AppBlockKill(kill) = AgentMessage::parse(
            &json!({ "type": "app_block_kill", "rule_id": 1.5, "rule_name": null, "exe_name": "a.exe" }),
        ) else {
            panic!("not app_block_kill");
        };
        assert_eq!(kill.rule_id, None);
        assert_eq!(kill.rule_name, None);
        assert_eq!(kill.exe_name.as_deref(), Some("a.exe"));
        let AgentMessage::LogTail(reply) =
            AgentMessage::parse(&json!({ "type": "log_tail", "request_id": "nope" }))
        else {
            panic!("not log_tail");
        };
        assert_eq!(reply.request_id, None);
        let AgentMessage::Batch(batch) =
            AgentMessage::parse(&json!({ "type": "batch", "events": "x" }))
        else {
            panic!("not batch");
        };
        assert!(batch.events.is_empty());
    }

    #[test]
    fn routing_fields_are_read() {
        let AgentMessage::ScriptResult(reply) = AgentMessage::parse(
            &json!({ "type": "script_result", "request_id": ID_STR, "output": "x" }),
        ) else {
            panic!("not script_result");
        };
        assert_eq!(reply.request_id, Some(ID));
        let AgentMessage::Batch(batch) = AgentMessage::parse(
            &json!({ "type": "batch", "events": [{ "type": "afk" }, { "type": "batch" }] }),
        ) else {
            panic!("not batch");
        };
        assert_eq!(batch.events.len(), 2);
        let AgentMessage::SoftwareInventory(inv) = AgentMessage::parse(
            &json!({ "type": "software_inventory", "captured_at": 12, "items": [] }),
        ) else {
            panic!("not software_inventory");
        };
        assert_eq!(inv.captured_at, Some(12));
    }

    #[test]
    fn terminal_frames_keep_their_wire_fields() {
        let output = AgentMessage::TerminalOutput(TerminalOutput::new(ID, "aGk=".into()));
        assert_eq!(
            output.to_value(),
            json!({ "type": "terminal_output", "session_id": ID_STR, "data_b64": "aGk=" })
        );
        let exit = AgentMessage::TerminalExit(TerminalExit::new(ID));
        assert_eq!(
            exit.to_value(),
            json!({ "type": "terminal_exit", "session_id": ID_STR })
        );
        let AgentMessage::TerminalOutput(back) = AgentMessage::parse(&output.to_value()) else {
            panic!("not terminal_output");
        };
        assert_eq!(back.session_id, Some(ID));
    }
}
