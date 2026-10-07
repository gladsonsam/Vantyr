//! The system snapshot an agent reports (`agent_info`), as the dashboard reads it.
//!
//! The server stores and serves the agent's JSON untyped (`agent_info.info`), and the fleet
//! summary passes it through an allowlist ([`super::fleet_summary::db`]). These structs describe
//! that JSON so the dashboard's TypeScript is generated rather than guessed; they are never
//! built at runtime, and a test checks that the sanitized output still parses into them.
//! Every field is optional because an older agent, or a platform that cannot read it, omits it.

#![allow(dead_code)] // fields exist only to be described by the generated TypeScript

use serde::Deserialize;
use ts_rs::TS;

#[derive(Debug, Default, Deserialize, TS)]
#[ts(export, optional_fields)]
pub struct NetworkAdapterInfo {
    pub name: Option<String>,
    pub description: Option<String>,
    pub mac: Option<String>,
    pub ips: Option<Vec<String>>,
    pub gateways: Option<Vec<String>>,
    pub dns: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize, TS)]
#[ts(export, optional_fields)]
pub struct DriveInfo {
    pub name: Option<String>,
    pub mount_point: Option<String>,
    pub file_system: Option<String>,
    pub total_gb: Option<f64>,
    pub available_gb: Option<f64>,
}

#[derive(Debug, Default, Deserialize, TS)]
#[ts(export, optional_fields)]
pub struct MonitorInfo {
    /// 0-based index; pass this to the MJPEG stream to select the monitor.
    pub index: Option<f64>,
    pub name: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub primary: Option<bool>,
    /// Desktop-space origin and physical size; `null` when the agent could not read them.
    #[ts(optional = nullable)]
    pub x: Option<f64>,
    #[ts(optional = nullable)]
    pub y: Option<f64>,
    #[ts(optional = nullable)]
    pub physical_width: Option<f64>,
    #[ts(optional = nullable)]
    pub physical_height: Option<f64>,
    pub geometry_available: Option<bool>,
}

/// Per-platform feature availability, each `"supported"`, `"unavailable"` or a platform note.
#[derive(Debug, Default, Deserialize, TS)]
#[ts(export, optional_fields)]
pub struct AgentCapabilityInfo {
    pub platform: Option<String>,
    pub session_type: Option<String>,
    pub desktop: Option<String>,
    pub screen_capture: Option<String>,
    pub audio_capture: Option<String>,
    pub remote_input: Option<String>,
    pub clipboard: Option<String>,
    pub keyboard_monitor: Option<String>,
    pub url_tracking: Option<String>,
    pub active_window: Option<String>,
    pub software_inventory: Option<String>,
    pub terminal: Option<String>,
    pub script_execution: Option<String>,
    pub app_blocking: Option<String>,
    pub network_blocking: Option<String>,
    pub system_control: Option<String>,
}

#[derive(Debug, Default, Deserialize, TS)]
#[ts(export, optional_fields)]
pub struct AgentInfo {
    pub agent_version: Option<String>,
    pub hostname: Option<String>,
    /// IANA zone of the machine, `null` when the OS zone could not be mapped.
    #[ts(optional = nullable)]
    pub timezone: Option<String>,
    pub uptime_secs: Option<f64>,
    pub system_model: Option<String>,
    pub system_manufacturer: Option<String>,
    pub system_serial: Option<String>,
    pub motherboard_model: Option<String>,
    pub motherboard_manufacturer: Option<String>,
    pub os_name: Option<String>,
    #[ts(optional = nullable)]
    pub os_version: Option<String>,
    #[ts(optional = nullable)]
    pub os_long_version: Option<String>,
    #[ts(optional = nullable)]
    pub kernel_version: Option<String>,
    pub cpu_brand: Option<String>,
    pub cpu_cores: Option<f64>,
    pub memory_total_mb: Option<f64>,
    pub memory_used_mb: Option<f64>,
    pub adapters: Option<Vec<NetworkAdapterInfo>>,
    pub drives: Option<Vec<DriveInfo>>,
    pub monitors: Option<Vec<MonitorInfo>>,
    pub config_path: Option<String>,
    pub machine_config_path: Option<String>,
    pub machine_connection_policy: Option<bool>,
    #[ts(optional = nullable)]
    pub install_path: Option<String>,
    pub config_server_url: Option<String>,
    pub config_agent_name: Option<String>,
    pub config_ui_password_set: Option<bool>,
    pub current_user: Option<String>,
    pub capabilities: Option<AgentCapabilityInfo>,
    pub ts: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitized_fleet_info_parses_into_the_documented_shape() {
        let raw = json!({
            "agent_version": "1.2.3", "hostname": "PC", "timezone": null, "uptime_secs": 5,
            "os_version": null, "cpu_cores": 8, "config_ui_password_set": true,
            "machine_connection_policy": false, "install_path": null,
            "config_server_url": "https://vantyr.example/",
            "adapters": [{"name": "eth0", "mac": "aa", "ips": ["10.0.0.2"]}],
            "drives": [{"name": "C:", "total_gb": 100.5, "available_gb": 40}],
            "monitors": [{"index": 0, "width": 1920, "height": 1080, "primary": true,
                          "x": 0, "y": null, "geometry_available": true}],
            "capabilities": {"platform": "windows", "screen_capture": "supported"},
            "ts": 1_700_000_000,
        });
        let clean = crate::agents::fleet_summary::db::sanitize_fleet_info(&raw).unwrap();
        let info: AgentInfo = serde_json::from_value(clean).unwrap();
        assert_eq!(info.agent_version.as_deref(), Some("1.2.3"));
        assert_eq!(info.monitors.unwrap()[0].primary, Some(true));
        assert_eq!(
            info.capabilities.unwrap().platform.as_deref(),
            Some("windows")
        );
    }
}
