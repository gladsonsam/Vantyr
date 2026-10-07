//! Windows system facts: CIM queries through PowerShell, `ipconfig` adapters.

use std::os::windows::process::CommandExt;
use std::process::Command;

use serde_json::json;

use super::HardwareIdentity;

pub(super) const OS_NAME: &str = "Windows";

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows-only: the Linux adapter enumeration reads MACs already formatted
/// from `/sys`, so only the `ipconfig`-style Windows path needs this.
fn format_mac(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Windows-only: parses the `ConvertTo-Json` output of the CIM queries below.
/// Linux reads the same facts straight out of `/sys/class/dmi/id`.
fn parse_first_json_string(raw: &[u8], key: &str) -> Option<String> {
    let val: serde_json::Value = serde_json::from_slice(raw).ok()?;
    let obj = if val.is_array() {
        val.as_array()?.first()?.clone()
    } else {
        val
    };
    obj.get(key)?
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn powershell_cim_value(class_name: &str, property: &str) -> Option<String> {
    let script = format!(
        "Get-CimInstance {class_name} | Select-Object -First 1 {property} | ConvertTo-Json -Compress"
    );
    let out = Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_first_json_string(&out.stdout, property)
}

/// Active console user from `Win32_ComputerSystem.UserName`.
pub(super) fn active_console_user() -> Option<String> {
    powershell_cim_value("Win32_ComputerSystem", "UserName")
}

/// Prefer a WMI/CIM hostname so casing matches Windows (NetBIOS env vars are often ALL CAPS).
pub(super) fn wmi_hostname() -> Option<String> {
    powershell_cim_value("Win32_ComputerSystem", "DNSHostName")
        .or_else(|| powershell_cim_value("Win32_ComputerSystem", "Name"))
}

pub(super) fn hardware_identity() -> HardwareIdentity {
    HardwareIdentity {
        system_model: powershell_cim_value("Win32_ComputerSystem", "Model"),
        system_manufacturer: powershell_cim_value("Win32_ComputerSystem", "Manufacturer"),
        system_serial: powershell_cim_value("Win32_BIOS", "SerialNumber"),
        motherboard_model: powershell_cim_value("Win32_BaseBoard", "Product"),
        motherboard_manufacturer: powershell_cim_value("Win32_BaseBoard", "Manufacturer"),
    }
}

pub(super) fn network_adapters() -> Vec<serde_json::Value> {
    ipconfig::get_adapters()
        .ok()
        .map(|list| {
            list.into_iter()
                .map(|a| {
                    let ips: Vec<String> = a
                        .ip_addresses()
                        .iter()
                        .map(std::string::ToString::to_string)
                        .collect();
                    let gateways: Vec<String> = a
                        .gateways()
                        .iter()
                        .map(std::string::ToString::to_string)
                        .collect();
                    let dns: Vec<String> = a
                        .dns_servers()
                        .iter()
                        .map(std::string::ToString::to_string)
                        .collect();
                    let mac = a.physical_address().map(format_mac).unwrap_or_default();

                    json!({
                        "name": a.friendly_name(),
                        "description": a.description(),
                        "mac": mac,
                        "ips": ips,
                        "gateways": gateways,
                        "dns": dns,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn machine_config_path() -> String {
    crate::config::machine_config_path()
        .to_string_lossy()
        .to_string()
}

pub(super) fn capabilities() -> serde_json::Value {
    json!({
        "clipboard": if crate::clipboard::available() { "supported" } else { "unavailable" },
        "platform": "windows",
        "session_type": "desktop",
        "desktop": "windows",
        "screen_capture": "supported",
        "audio_capture": "supported",
        "remote_input": "supported",
        "keyboard_monitor": "supported",
        "url_tracking": "supported",
        "active_window": "supported",
        "software_inventory": "supported",
        "terminal": "supported",
        "script_execution": "supported",
        "app_blocking": "supported",
        "network_blocking": "supported",
        "system_control": "supported",
    })
}
