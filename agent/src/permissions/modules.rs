//! The module catalogue (shared with the server in `vantyr-protocol`) and the
//! server command -> module map.

pub use vantyr_protocol::{Module, MODULES};

/// The module gating a server command `"type"`; `None` for ungated or unknown
/// commands. The table itself is `vantyr_protocol::ServerCommand::gate`; this
/// lookup needs no payload, so a raw frame can be gated before it is parsed.
pub fn command_module(kind: &str) -> Option<Module> {
    match crate::commands::ServerCommand::gate_for_kind(kind) {
        vantyr_protocol::Gate::Module(module) => Some(module),
        _ => None,
    }
}
