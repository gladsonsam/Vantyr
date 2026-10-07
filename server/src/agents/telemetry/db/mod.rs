//! Telemetry persistence. Callers import the submodule they need (`db::events`,
//! `db::app_icons`, `db::metrics`).

pub mod app_icons;
pub mod events;
pub mod metrics;
