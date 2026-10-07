//! Windows platform backend.
//!
//! These modules are thin delegates to the current Windows implementation. The
//! point of this layer is to move call sites first, then let future Linux
//! commits fill equivalent backends behind the same names.

pub mod activity_tracker;
mod app_display;
mod app_icons;

pub mod keyboard_monitor;

pub mod process_tree;

pub mod system_control;

pub mod terminal;

pub mod url_provider;
