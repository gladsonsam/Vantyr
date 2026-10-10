//! The typed server -> agent command protocol.
//!
//! The types live in the shared `vantyr-protocol` crate (the server builds
//! commands from the same definitions); this module re-exports them under
//! `commands::protocol` for the per-area handlers. The table of commands,
//! fields and module gates is in `agent/docs/server-commands.md`.

pub use vantyr_protocol::commands::*;
