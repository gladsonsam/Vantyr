//! Linux system facts: SMBIOS/DMI from `/sys`, adapters from `/sys`, `ip` and
//! `/etc/resolv.conf`, capabilities from the detected desktop session.

use serde_json::json;

use super::HardwareIdentity;

pub(super) const OS_NAME: &str = "Linux";

fn linux_text_file(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Read a SMBIOS/DMI field exposed by the kernel at `/sys/class/dmi/id/<field>`
/// (e.g. `product_name`, `sys_vendor`, `board_name`). Returns None when absent
/// or unreadable (serial fields are typically root-only).
fn linux_dmi(field: &str) -> Option<String> {
    linux_text_file(&format!("/sys/class/dmi/id/{field}"))
}

pub(super) fn network_adapters() -> Vec<serde_json::Value> {
    let dns: Vec<String> = std::fs::read_to_string("/etc/resolv.conf")
        .ok()
        .map(|s| {
            s.lines()
                .filter_map(|line| line.trim().strip_prefix("nameserver "))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let ips_by_iface = linux_interface_ips();
    let gateways_by_iface = linux_default_gateways();

    let Ok(entries) = std::fs::read_dir("/sys/class/net") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let base = entry.path();
            let mac = std::fs::read_to_string(base.join("address"))
                .unwrap_or_default()
                .trim()
                .to_string();
            let operstate = std::fs::read_to_string(base.join("operstate"))
                .unwrap_or_default()
                .trim()
                .to_string();
            let ips = ips_by_iface.get(&name).cloned().unwrap_or_default();
            let gateways = gateways_by_iface.get(&name).cloned().unwrap_or_default();
            Some(json!({
                "name": name,
                "description": operstate,
                "mac": mac,
                "ips": ips,
                "gateways": gateways,
                "dns": dns,
            }))
        })
        .collect()
}

fn linux_interface_ips() -> std::collections::HashMap<String, Vec<String>> {
    let mut out = std::collections::HashMap::new();
    let output = std::process::Command::new("ip")
        .args(["-j", "addr", "show"])
        .output()
        .ok();
    let Some(output) = output.filter(|o| o.status.success()) else {
        return out;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return out;
    };
    for iface in value.as_array().into_iter().flatten() {
        let Some(name) = iface.get("ifname").and_then(|v| v.as_str()) else {
            continue;
        };
        let ips: Vec<String> = iface
            .get("addr_info")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|addr| addr.get("local").and_then(|v| v.as_str()))
            .filter(|ip| !ip.trim().is_empty())
            .map(str::to_string)
            .collect();
        out.insert(name.to_string(), ips);
    }
    out
}

fn linux_default_gateways() -> std::collections::HashMap<String, Vec<String>> {
    let mut out: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let output = std::process::Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .ok();
    let Some(output) = output.filter(|o| o.status.success()) else {
        return out;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        let gateway = parts
            .windows(2)
            .find(|pair| pair[0] == "via")
            .map(|pair| pair[1].to_string());
        let iface = parts
            .windows(2)
            .find(|pair| pair[0] == "dev")
            .map(|pair| pair[1].to_string());
        if let (Some(iface), Some(gateway)) = (iface, gateway) {
            out.entry(iface).or_default().push(gateway);
        }
    }
    out
}

/// No CIM equivalent; the active user comes from the environment fallback.
pub(super) fn active_console_user() -> Option<String> {
    None
}

/// No WMI hostname on Linux; callers fall back to `sysinfo`.
pub(super) fn wmi_hostname() -> Option<String> {
    None
}

/// Linux identity comes from SMBIOS/DMI under /sys/class/dmi/id. Note
/// `product_serial`/`board_serial` are usually root-only (0400), so they
/// return None for an unprivileged agent — reported honestly as null.
pub(super) fn hardware_identity() -> HardwareIdentity {
    HardwareIdentity {
        system_model: linux_dmi("product_name"),
        system_manufacturer: linux_dmi("sys_vendor"),
        system_serial: linux_dmi("product_serial"),
        motherboard_model: linux_dmi("board_name"),
        motherboard_manufacturer: linux_dmi("board_vendor"),
    }
}

/// There is no machine-wide config on Linux.
pub(super) fn machine_config_path() -> String {
    String::new()
}

pub(super) fn capabilities() -> serde_json::Value {
    // Prefer the explicit env var, but fall back to runtime detection so a
    // service environment that doesn't export XDG_SESSION_TYPE still reports
    // the real session (Wayland is detected via WAYLAND_DISPLAY).
    let session_type = match std::env::var("XDG_SESSION_TYPE") {
        Ok(s) if !s.trim().is_empty() => s.to_ascii_lowercase(),
        _ => match crate::platform::linux::session::detect() {
            crate::platform::linux::session::SessionKind::Wayland => "wayland".into(),
            crate::platform::linux::session::SessionKind::X11 => "x11".into(),
            crate::platform::linux::session::SessionKind::Headless => "unknown".into(),
        },
    };
    let desktop = if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
        "hyprland".to_string()
    } else {
        std::env::var("XDG_CURRENT_DESKTOP")
            .or_else(|_| std::env::var("DESKTOP_SESSION"))
            .unwrap_or_else(|_| "unknown".into())
            .to_ascii_lowercase()
    };
    // Wayland: wlroots compositors (Hyprland/sway) capture natively via
    // wlr-screencopy (libwayshot), with a `grim` fallback — supported with or
    // without grim installed. GNOME/KDE need the XDG ScreenCast portal +
    // PipeWire, which is not implemented yet. X11 uses xcap directly.
    let screen_capture = if session_type == "wayland" {
        if crate::platform::linux::session::is_wlroots() {
            "supported"
        } else {
            "unsupported"
        }
    } else if session_type == "x11" {
        "supported"
    } else {
        "unsupported"
    };
    json!({
        "clipboard": if crate::input::clipboard::available() { "supported" } else { "unavailable" },
        "platform": "linux",
        "session_type": session_type,
        "desktop": desktop,
        "screen_capture": screen_capture,
        // Remote input injection: enigo works on X11; Wayland needs uinput
        // (privileged) or the RemoteDesktop portal + libei, not yet wired up.
        "remote_input": if session_type == "x11" { "supported" } else { "unsupported" },
        // Keyboard/AFK capture reads /dev/input/event* (evdev) directly, which
        // works on Wayland and X11 but needs read access (input group / root).
        "keyboard_monitor": if crate::platform::linux::keyboard_monitor::can_read_input_devices() {
            "supported"
        } else {
            "needs_privilege"
        },
        "url_tracking": "unsupported",
        "active_window": if desktop == "hyprland" { "supported" } else { "limited" },
        "software_inventory": "supported",
        "terminal": "supported",
        "script_execution": "supported",
        "app_blocking": "limited",
        "network_blocking": "needs_privilege",
        "system_control": "limited",
    })
}
