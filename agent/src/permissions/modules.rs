//! The module catalogue and the server command -> module map.
//!
//! Mirrors the server's module list; kept self-contained (apart from the
//! command table in `commands::protocol`) so both can move to a shared
//! protocol crate.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Module {
    KeyboardText,
    IdleActivity,
    WindowActivity,
    BrowserUrls,
    Recall,
    LiveScreen,
    LiveAudio,
    RemoteInput,
    Clipboard,
    Files,
    Terminal,
    Scripts,
    SoftwareInventory,
    ResourceMetrics,
    SystemInfo,
    SystemControl,
    AppPolicy,
    NetworkPolicy,
    Logs,
}
pub const MODULES: &[Module] = &[
    Module::KeyboardText,
    Module::IdleActivity,
    Module::WindowActivity,
    Module::BrowserUrls,
    Module::Recall,
    Module::LiveScreen,
    Module::LiveAudio,
    Module::RemoteInput,
    Module::Clipboard,
    Module::Files,
    Module::Terminal,
    Module::Scripts,
    Module::SoftwareInventory,
    Module::ResourceMetrics,
    Module::SystemInfo,
    Module::SystemControl,
    Module::AppPolicy,
    Module::NetworkPolicy,
    Module::Logs,
];
/// The module gating a server command `"type"`; `None` for ungated protocol
/// commands. The table itself is `commands::ServerCommand::module`.
pub fn command_module(kind: &str) -> Option<Module> {
    crate::commands::ServerCommand::from_kind(kind).module()
}
