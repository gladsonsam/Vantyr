//! The module catalogue: the device-owned capabilities a server command or an
//! agent event can be gated on.

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

impl Module {
    /// The snake_case wire name (`"live_screen"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeyboardText => "keyboard_text",
            Self::IdleActivity => "idle_activity",
            Self::WindowActivity => "window_activity",
            Self::BrowserUrls => "browser_urls",
            Self::Recall => "recall",
            Self::LiveScreen => "live_screen",
            Self::LiveAudio => "live_audio",
            Self::RemoteInput => "remote_input",
            Self::Clipboard => "clipboard",
            Self::Files => "files",
            Self::Terminal => "terminal",
            Self::Scripts => "scripts",
            Self::SoftwareInventory => "software_inventory",
            Self::ResourceMetrics => "resource_metrics",
            Self::SystemInfo => "system_info",
            Self::SystemControl => "system_control",
            Self::AppPolicy => "app_policy",
            Self::NetworkPolicy => "network_policy",
            Self::Logs => "logs",
        }
    }

    /// [`Module::as_str`] as an owned string.
    pub fn key(self) -> String {
        self.as_str().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_match_serde() {
        for module in MODULES {
            assert_eq!(
                serde_json::to_value(module).unwrap(),
                serde_json::Value::String(module.as_str().into())
            );
        }
    }

    #[test]
    fn catalogue_has_every_module_once() {
        let mut seen = std::collections::BTreeSet::new();
        assert!(MODULES.iter().all(|m| seen.insert(*m)));
        assert_eq!(MODULES.len(), 19);
    }
}
