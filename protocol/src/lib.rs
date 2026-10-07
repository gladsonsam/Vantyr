//! The wire protocol shared by the Vantyr server and the endpoint agent.
//!
//! Both sides compile this crate, so a name, tag or field cannot drift between
//! them. See `protocol/README.md` for the compatibility rules.

pub mod frames;
pub mod modules;

pub use modules::{Module, MODULES};
