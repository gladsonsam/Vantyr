//! The module catalogue and the server command -> module map.
//!
//! Mirrors the server's module list; kept self-contained so it can move to a
//! shared protocol crate.

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
pub fn command_module(kind: &str) -> Option<Module> {
    Some(match kind {
        "start_capture" => Module::LiveScreen,
        "start_audio" => Module::LiveAudio,
        "ClipboardRead" | "ClipboardWrite" => Module::Clipboard,
        "MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp"
        | "MouseScroll" | "Scroll" | "KeyDown" | "KeyUp" | "KeyPress" | "KeyChar" | "TypeText"
        | "Notify" => Module::RemoteInput,
        "TerminalStart" | "TerminalInput" | "TerminalResize" => Module::Terminal,
        "RunScript" => Module::Scripts,
        "ListDir" | "ReadFile" | "WriteFileChunk" | "Mkdir" | "RenamePath" | "DeletePath"
        | "CopyPath" => Module::Files,
        "CollectSoftware" => Module::SoftwareInventory,
        "RequestInfo" => Module::SystemInfo,
        "LockHost" | "RestartHost" | "ShutdownHost" => Module::SystemControl,
        "set_app_block_rules" => Module::AppPolicy,
        "set_network_policy" | "set_internet_block_rules" => Module::NetworkPolicy,
        "ListLogSources" | "ReadLogTail" => Module::Logs,
        _ => return None,
    })
}
