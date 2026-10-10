//! Device-owned grants. Config/IPC/server policy never grants a module.
//!
//! - [`modules`]: the module catalogue and the command -> module map.
//! - [`store`]: the on-disk grant store, transactions and cache.
//! - [`workers`]: grant generations and worker leases.
//! - [`fence`]: generation tagging, command admission and outbound filtering.

mod fence;
mod modules;
mod store;
#[cfg(test)]
mod tests;
mod workers;

pub use fence::*;
pub use modules::*;
pub use store::*;
pub use workers::*;
