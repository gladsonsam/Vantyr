//! `agent_info`: the host description the dashboard shows, in the three shapes the
//! agent sends depending on what the local `system_info` grant allows.

use serde::Serialize;

/// `capabilities` when the system-info grant is off: only what does not reveal the host.
#[derive(Serialize)]
pub struct ClipboardCapability {
    pub clipboard: &'static str,
}

/// `agent_info` while the system-info grant is off: the version, the timezone (so the
/// server buckets Recall into the right local day) and the clipboard capability.
#[derive(Serialize)]
#[serde(tag = "type", rename = "agent_info")]
pub struct AgentInfoRestricted {
    pub agent_version: &'static str,
    pub timezone: Option<String>,
    pub capabilities: ClipboardCapability,
}

/// `agent_info` when the grant is on at the time of the check but its generation could
/// not be captured: the version and clipboard capability only.
#[derive(Serialize)]
#[serde(tag = "type", rename = "agent_info")]
pub struct AgentInfoMinimal {
    pub agent_version: &'static str,
    pub capabilities: ClipboardCapability,
}

/// One disk in [`AgentInfo::drives`].
#[derive(Serialize)]
pub struct Drive {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub total_gb: f64,
    pub available_gb: f64,
}

/// The full `agent_info`. `adapters`, `capabilities` and `monitors` differ per OS and
/// stay raw JSON.
#[derive(Serialize)]
#[serde(tag = "type", rename = "agent_info")]
pub struct AgentInfo {
    pub agent_version: &'static str,
    pub hostname: String,
    /// IANA timezone (e.g. `Australia/Perth`); `null` when the OS zone cannot be mapped.
    pub timezone: Option<String>,
    pub uptime_secs: u64,
    pub os_name: String,
    pub os_version: Option<String>,
    pub os_long_version: Option<String>,
    pub system_model: Option<String>,
    pub system_manufacturer: Option<String>,
    pub system_serial: Option<String>,
    pub motherboard_model: Option<String>,
    pub motherboard_manufacturer: Option<String>,
    pub cpu_brand: String,
    pub cpu_cores: u32,
    pub memory_total_mb: u64,
    pub memory_used_mb: u64,
    pub drives: Vec<Drive>,
    pub adapters: Vec<serde_json::Value>,
    pub config_path: String,
    pub machine_config_path: String,
    pub machine_connection_policy: bool,
    pub install_path: Option<String>,
    pub config_server_url: String,
    pub config_agent_name: String,
    pub config_ui_password_set: bool,
    pub current_user: String,
    pub capabilities: serde_json::Value,
    pub monitors: Vec<serde_json::Value>,
    pub ts: u64,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::outbound::to_value;

    /// The typed message and the `json!` literal it replaced must serialize identically.
    fn same(typed: serde_json::Value, literal: serde_json::Value) {
        assert_eq!(typed.to_string(), literal.to_string());
    }

    #[test]
    fn restricted_and_minimal_match_the_json_shape() {
        same(
            to_value(&AgentInfoRestricted {
                agent_version: "1.2.3",
                timezone: Some("Australia/Perth".into()),
                capabilities: ClipboardCapability {
                    clipboard: "supported",
                },
            }),
            json!({"type": "agent_info", "agent_version": "1.2.3", "timezone": "Australia/Perth", "capabilities": {"clipboard": "supported"}}),
        );
        same(
            to_value(&AgentInfoRestricted {
                agent_version: "1.2.3",
                timezone: None,
                capabilities: ClipboardCapability {
                    clipboard: "unavailable",
                },
            }),
            json!({"type": "agent_info", "agent_version": "1.2.3", "timezone": null, "capabilities": {"clipboard": "unavailable"}}),
        );
        same(
            to_value(&AgentInfoMinimal {
                agent_version: "1.2.3",
                capabilities: ClipboardCapability {
                    clipboard: "supported",
                },
            }),
            json!({"type": "agent_info", "agent_version": "1.2.3", "capabilities": {"clipboard": "supported"}}),
        );
    }

    #[test]
    fn full_agent_info_matches_the_json_shape() {
        let adapters = vec![json!({"name": "eth0"})];
        let monitors = vec![json!({"index": 0})];
        let capabilities = json!({"screen_capture": "supported"});
        same(
            to_value(&AgentInfo {
                agent_version: "1.2.3",
                hostname: "host".into(),
                timezone: None,
                uptime_secs: 9,
                os_name: "Linux".into(),
                os_version: Some("6".into()),
                os_long_version: None,
                system_model: Some("m".into()),
                system_manufacturer: None,
                system_serial: None,
                motherboard_model: None,
                motherboard_manufacturer: Some("mb".into()),
                cpu_brand: "cpu".into(),
                cpu_cores: 8,
                memory_total_mb: 16000,
                memory_used_mb: 4000,
                drives: vec![Drive {
                    name: "sda".into(),
                    mount_point: "/".into(),
                    file_system: "ext4".into(),
                    total_gb: 100.5,
                    available_gb: 40.25,
                }],
                adapters: adapters.clone(),
                config_path: "/c.json".into(),
                machine_config_path: "/m.json".into(),
                machine_connection_policy: false,
                install_path: Some("/opt".into()),
                config_server_url: "wss://s".into(),
                config_agent_name: "a".into(),
                config_ui_password_set: true,
                current_user: "sam".into(),
                capabilities: capabilities.clone(),
                monitors: monitors.clone(),
                ts: 5,
            }),
            json!({
                "type": "agent_info",
                "agent_version": "1.2.3",
                "hostname": "host",
                "timezone": null,
                "uptime_secs": 9,
                "os_name": "Linux",
                "os_version": "6",
                "os_long_version": null,
                "system_model": "m",
                "system_manufacturer": null,
                "system_serial": null,
                "motherboard_model": null,
                "motherboard_manufacturer": "mb",
                "cpu_brand": "cpu",
                "cpu_cores": 8,
                "memory_total_mb": 16000,
                "memory_used_mb": 4000,
                "drives": [{"name": "sda", "mount_point": "/", "file_system": "ext4", "total_gb": 100.5, "available_gb": 40.25}],
                "adapters": adapters,
                "config_path": "/c.json",
                "machine_config_path": "/m.json",
                "machine_connection_policy": false,
                "install_path": "/opt",
                "config_server_url": "wss://s",
                "config_agent_name": "a",
                "config_ui_password_set": true,
                "current_user": "sam",
                "capabilities": capabilities,
                "monitors": monitors,
                "ts": 5,
            }),
        );
    }
}
