//! App block (kill) rules and events persistence. Callers import the submodule they need
//! (`db::rules`, `db::events`).

pub mod events;
pub mod rules;

// The agent socket still imports these two by their flat path; drop the re-exports once
// `agent_ws` imports the submodules.
pub use events::log_app_block_event;
pub use rules::app_block_rules_effective_for_agent;
