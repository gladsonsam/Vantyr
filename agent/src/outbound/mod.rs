//! Typed builders for the agent -> server text frames that have a small, fixed shape.
//!
//! Every frame is a JSON object tagged by `"type"`. The server dispatches on the
//! typed `AgentMessage` in the shared `vantyr-protocol` crate, which carries only
//! the routing and validation fields; it persists and fans out the raw JSON. The
//! structs here build the full payload, so a misspelled or missing field is a
//! compile error instead of a silent gap in the dashboard.
//!
//! Each struct pins the exact wire shape of the `json!` object it replaced: the
//! tests in [`telemetry`], [`replies`] and [`agent_info`] compare against that literal. They are
//! kept next to the agent (not in the protocol crate) until the crate takes over
//! the payload types; moving a struct there is then a copy, since none of them
//! depend on agent internals beyond [`Generation`](crate::permissions::Generation).
//!
//! Left as raw JSON on purpose: the per-OS blocks inside `agent_info` (adapters,
//! capabilities, monitors), the software `items`, the `log_sources` entries and the
//! binary-frame headers (`HST\0` keyframes, `capture_geometry`), plus the IPC replies
//! between the service and the companion, which are not agent -> server frames.

use serde::Serialize;

use crate::permissions::Generation;

pub mod agent_info;
pub mod replies;
pub mod telemetry;

/// The wire value of a message: its fields plus the `"type"` tag.
///
/// Serialized through [`serde_json::Value`] so keys come out sorted, exactly as the
/// `json!` objects these structs replaced did.
pub fn to_value<T: Serialize>(msg: &T) -> serde_json::Value {
    // A plain struct of strings, numbers and options cannot fail to serialize; a
    // failure would be a bug in the struct, which the pinned-JSON tests catch.
    serde_json::to_value(msg).unwrap_or(serde_json::Value::Null)
}

/// The wire value with the module generation the outbound fence checks.
pub fn stamped<T: Serialize>(msg: &T, generation: Option<Generation>) -> serde_json::Value {
    crate::permissions::stamp(to_value(msg), generation)
}

/// The text of a frame, ready for `Message::Text`.
pub fn to_text<T: Serialize>(msg: &T) -> String {
    to_value(msg).to_string()
}
