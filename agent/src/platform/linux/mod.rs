//! Linux platform backend.
//!
//! Linux desktop integration is intentionally capability-driven. Features that
//! need compositor support, portal consent, or elevated privileges fail closed
//! when the current session cannot provide them; the capability block in
//! `system_info` advertises each capability's real status to the dashboard.
//!
//! One file per capability so the Linux agent can be brought to Windows parity
//! feature-by-feature. Every module here must satisfy the platform contract in
//! `super::contract` — the compiler enforces that on the `agent (linux)` CI job.

pub mod activity_tracker;
pub mod config_store;
pub mod desktop_capture;
pub mod input_control;
pub mod keyboard_monitor;
pub mod network_policy;
pub mod script_execution;
/// Session/desktop detection (Wayland vs X11, wlroots, binary presence) used by
/// the capture/input/activity backends for runtime dispatch.
pub mod session;
pub mod software_inventory;
pub mod system_control;
pub mod system_info;
pub mod terminal;
pub mod url_provider;
