//! The wire protocol shared by the Vantyr server and the endpoint agent.
//!
//! Both sides compile this crate, so a name, tag or field cannot drift between
//! them. There is one current contract: required fields are required, wrong
//! types are rejected, and `Option` means the current sender legitimately
//! omits or nulls the field. See `protocol/README.md`.

pub mod agent_message;
pub mod commands;
pub mod error;
pub mod frames;
pub mod modules;
pub mod recall_context;
pub mod telemetry;

pub use agent_message::AgentMessage;
pub use commands::{Gate, ServerCommand};
pub use error::ProtocolError;
pub use modules::{Module, MODULES};
