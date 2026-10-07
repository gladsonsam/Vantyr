//! The wire protocol shared by the Vantyr server and the endpoint agent.
//!
//! Both sides compile this crate, so a name, tag or field cannot drift between
//! them. See `protocol/README.md` for the compatibility rules.

pub mod agent_message;
pub mod commands;
pub mod frames;
/// The shared lenient reader set for agent JSON.
pub mod lenient;
pub mod modules;
pub mod recall_context;

pub use agent_message::AgentMessage;
pub use commands::{Gate, ServerCommand};
pub use modules::{Module, MODULES};
