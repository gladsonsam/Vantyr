//! Telemetry persistence. Callers import the submodule they need (`db::events`,
//! `db::app_icons`, `db::metrics`).

pub mod app_icons;
pub mod events;
pub mod metrics;

// The agent socket still imports these by their flat path; drop the re-exports once
// `agent_ws` imports the submodules.
pub use app_icons::upsert_app_icon;
pub use events::{insert_activity, insert_window, upsert_keys};
pub use metrics::insert_agent_metrics;
