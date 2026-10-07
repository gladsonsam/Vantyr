//! The module catalogue (shared with the server in `vantyr-protocol`) and the
//! server command -> module map.

pub use vantyr_protocol::{Module, MODULES};

/// The module gating a server command `"type"`; `None` for ungated protocol
/// commands. The table itself is `commands::ServerCommand::module`.
pub fn command_module(kind: &str) -> Option<Module> {
    crate::commands::ServerCommand::from_kind(kind).module()
}
