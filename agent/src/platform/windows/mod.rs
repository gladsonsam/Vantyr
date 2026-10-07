//! Windows platform backend: one file per capability exposed by the facade in
//! [`super`], plus the Windows-only helpers they share.

pub mod activity_tracker;
/// Friendly app names from executable version resources (activity + keystroke context).
mod app_display;
/// Executable icon extraction (PNG) for the activity tracker.
mod app_icons;
pub mod keyboard_monitor;
pub mod process_tree;
pub mod system_control;
pub mod terminal;
pub mod url_provider;
