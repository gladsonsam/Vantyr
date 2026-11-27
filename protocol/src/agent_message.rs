//! The one typed agent -> server message contract.
//!
//! Every agent text frame is a JSON object tagged by `"type"`. [`AgentMessage`]
//! names the current types the server dispatches on and carries the *full*
//! validated payload for the fields the server reads. Parsing is strict: a
//! missing or wrongly-typed field is an error, an unknown `"type"` is an error,
//! and there is no fallback that turns malformed input into a usable message.
//! The `Unknown` variant exists only as the signature-compatible result of
//! [`AgentMessage::parse`]; every owned boundary uses [`AgentMessage::try_parse`]
//! and fails closed.

use serde::{Deserialize, Serialize};

use crate::error::{from_serde, ProtocolError};
use crate::telemetry::{
    AppBlockKillFields, AppIconFields, KeysEvent, MetricsSample, SoftwareInventoryEvent,
    UrlSessionEvent, UrlVisit, WindowFocusEvent,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentMessage {
    /// Agent-side batching: `{type:"batch", events:[...]}`. Batches do not nest.
    #[serde(rename = "batch")]
    Batch(Batch),

    // ── Module protocol (validated by the server's module report types) ──
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

    // ── Telemetry ───────────────────────────────────────────────────────────
    #[serde(rename = "keys")]
    Keys(KeysEvent),
    #[serde(rename = "window_focus")]
    WindowFocus(WindowFocusEvent),
    #[serde(rename = "url")]
    Url(UrlVisit),
    #[serde(rename = "url_session")]
    UrlSession(UrlSessionEvent),
    #[serde(rename = "afk")]
    Afk,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "app_icon")]
    AppIcon(AppIconFields),
    #[serde(rename = "app_block_kill")]
    AppBlockKill(AppBlockKillFields),
    #[serde(rename = "agent_info")]
    AgentInfo,
    #[serde(rename = "metrics")]
    Metrics(MetricsSample),
    #[serde(rename = "software_inventory")]
    SoftwareInventory(SoftwareInventoryEvent),

    /// Only produced by [`AgentMessage::parse`] for a rejected frame.
    #[serde(other)]
    Unknown,
}

impl AgentMessage {
    /// Strict parse: `Err` for an unknown type, a bad tag, or any missing or
    /// wrongly-typed field. Callers must drop the frame on error, before any
    /// mutation or fan-out. The error carries no frame or secret bytes.
    pub fn try_parse(val: &serde_json::Value) -> Result<Self, ProtocolError> {
        let message: Self = serde_json::from_value(val.clone()).map_err(from_serde)?;
        if matches!(message, Self::Unknown) {
            return Err(ProtocolError::UnknownType);
        }
        Ok(message)
    }

    /// Signature-compatible fallback for callers that only need a value. It
    /// returns `Unknown` for any rejected frame; `Unknown` is denied at every
    /// owned boundary. New code must use [`AgentMessage::try_parse`].
    pub fn parse(val: &serde_json::Value) -> Self {
        Self::try_parse(val).unwrap_or(Self::Unknown)
    }

    /// The wire value for a message the agent builds.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("an agent message always serializes")
    }
}

/// `batch`; `events` is required and must be an array. Batch events are parsed
/// one by one by the server, with the same strict rule.
#[derive(Debug, Serialize, Deserialize)]
pub struct Batch {
    pub events: Vec<serde_json::Value>,
}

/// The `request_id` a reply is routed back to its waiting HTTP request by.
#[derive(Debug, Serialize, Deserialize)]
pub struct RequestId {
    pub request_id: uuid::Uuid,
}

impl RequestId {
    pub fn new(request_id: uuid::Uuid) -> Self {
        Self { request_id }
    }
}

/// `terminal_output`: a chunk of shell output, routed to the owning browser session.
#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub session_id: uuid::Uuid,
    /// Base64 of the raw bytes read from the pty.
    pub data_b64: String,
}

impl TerminalOutput {
    pub fn new(session_id: uuid::Uuid, data_b64: String) -> Self {
        Self {
            session_id,
            data_b64,
        }
    }
}

/// `terminal_exit`: the shell ended.
#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalExit {
    pub session_id: uuid::Uuid,
}

impl TerminalExit {
    pub fn new(session_id: uuid::Uuid) -> Self {
        Self { session_id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: uuid::Uuid = uuid::Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
    const ID_STR: &str = "01234567-89ab-cdef-0123-456789abcdef";

    #[test]
    fn current_payload_frames_parse() {
        for frame in [
            json!({"type":"batch","events":[]}),
            json!({"type":"module_states"}),
            json!({"type":"module_disable_ack"}),
            json!({"type":"clipboard_result"}),
            json!({"type":"log_tail","request_id":ID_STR}),
            json!({"type":"log_sources","request_id":ID_STR}),
            json!({"type":"script_result","request_id":ID_STR}),
            json!({"type":"dir_list"}),
            json!({"type":"file_chunk"}),
            json!({"type":"file_upload_result"}),
            json!({"type":"terminal_output","session_id":ID_STR,"data_b64":"aGk="}),
            json!({"type":"terminal_exit","session_id":ID_STR}),
            json!({"type":"keys","text":"t","app":"a","app_display":"A","window":"w","ts":1,"user":null}),
            json!({"type":"window_focus","title":"t","app":"a","app_display":"A","hwnd":1,"ts":1,"user":null}),
            json!({"type":"url","url":"u","title":"t","browser":"b","ts":1,"user":null}),
            json!({"type":"url_session","url":"u","title":null,"browser":"b","user":null,"started_at_ts":1,"ended_at_ts":2,"duration_ms":3}),
            json!({"type":"afk"}),
            json!({"type":"active"}),
            json!({"type":"app_icon","exe_name":"a.exe","png_base64":"AAAA"}),
            json!({"type":"app_block_kill","rule_id":1,"rule_name":"r","exe_name":"e.exe"}),
            json!({"type":"agent_info"}),
            json!({"type":"metrics","cpu_pct":1.0,"mem_used_mb":2,"mem_total_mb":3,"mem_pct":4.0,"disk_pct":5.0,"disk_used_gb":6.0,"disk_total_gb":7.0}),
            json!({"type":"software_inventory","items":[],"captured_at":1}),
        ] {
            assert!(
                AgentMessage::try_parse(&frame).is_ok(),
                "current frame rejected: {frame}"
            );
        }
    }

    #[test]
    fn unknown_or_untagged_frames_are_errors() {
        for frame in [
            json!({"type":"fs_op_result"}),
            json!({"type":"history_frame"}),
            json!({"type":"Keys"}),
            json!({"type":5}),
            json!({"type":null}),
            json!({}),
            json!("keys"),
            json!([1, 2]),
        ] {
            assert!(AgentMessage::try_parse(&frame).is_err(), "{frame}");
            assert!(matches!(AgentMessage::parse(&frame), AgentMessage::Unknown));
        }
    }

    #[test]
    fn missing_or_wrong_typed_fields_reject_the_whole_frame() {
        for frame in [
            json!({"type":"keys","text":7,"app":"a","app_display":"A","window":"w","ts":1}),
            json!({"type":"keys","text":"t"}),
            json!({"type":"window_focus","title":"t","app":"a","app_display":"A","hwnd":"1","ts":1}),
            json!({"type":"log_tail","request_id":"nope"}),
            json!({"type":"batch","events":"x"}),
            json!({"type":"metrics","cpu_pct":"high"}),
            json!({"type":"software_inventory","items":"x","captured_at":1}),
            json!({"type":"app_icon","exe_name":1,"png_base64":"AAAA"}),
        ] {
            assert!(AgentMessage::try_parse(&frame).is_err(), "{frame}");
        }
    }

    #[test]
    fn routing_fields_are_read() {
        let AgentMessage::ScriptResult(reply) =
            AgentMessage::try_parse(&json!({"type":"script_result","request_id":ID_STR,"output":"x"}))
                .unwrap()
        else {
            panic!("not script_result");
        };
        assert_eq!(reply.request_id, ID);
        let AgentMessage::Batch(batch) = AgentMessage::try_parse(&json!({
            "type":"batch", "events":[{"type":"afk"}, {"type":"batch"}]
        }))
        .unwrap()
        else {
            panic!("not batch");
        };
        assert_eq!(batch.events.len(), 2);
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
        let AgentMessage::TerminalOutput(back) = AgentMessage::try_parse(&output.to_value()).unwrap()
        else {
            panic!("not terminal_output");
        };
        assert_eq!(back.session_id, ID);
        assert_eq!(back.data_b64, "aGk=");
    }
}
