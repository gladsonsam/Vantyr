use serde_json::json;
use sysinfo::{Disks, System};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn format_mac(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

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

#[cfg(not(target_os = "windows"))]
fn linux_text_file(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "windows"))]
fn linux_network_adapters() -> Vec<serde_json::Value> {
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

#[cfg(not(target_os = "windows"))]
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

#[cfg(not(target_os = "windows"))]
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

fn agent_capabilities() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        json!({
            "platform": "windows",
            "session_type": "desktop",
            "desktop": "windows",
            "screen_capture": "supported",
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

    #[cfg(not(target_os = "windows"))]
    {
        let session_type = std::env::var("XDG_SESSION_TYPE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "unknown".into())
            .to_ascii_lowercase();
        let desktop = if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
            "hyprland".to_string()
        } else {
            std::env::var("XDG_CURRENT_DESKTOP")
                .or_else(|_| std::env::var("DESKTOP_SESSION"))
                .unwrap_or_else(|_| "unknown".into())
                .to_ascii_lowercase()
        };
        let portal_capture = if session_type == "wayland" {
            "needs_permission"
        } else {
            "supported"
        };
        json!({
            "platform": "linux",
            "session_type": session_type,
            "desktop": desktop,
            "screen_capture": portal_capture,
            "remote_input": if session_type == "x11" { "supported" } else { "needs_permission" },
            "keyboard_monitor": if session_type == "x11" { "limited" } else { "unsupported" },
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
}

#[cfg(target_os = "windows")]
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

#[cfg(not(target_os = "windows"))]
fn powershell_cim_value(_class_name: &str, _property: &str) -> Option<String> {
    None
}

/// Best-effort active console user (Windows: `Win32_ComputerSystem.UserName`).
///
/// Returns values like `DOMAIN\\Username` or `COMPUTER\\Username` when available.
pub fn active_username() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        powershell_cim_value("Win32_ComputerSystem", "UserName")
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Fast local fallback (may be empty when running as a service / non-interactive).
pub fn env_username_fallback() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Lightweight periodic resource sample (CPU / memory / system disk) for the
/// health-history feature. Reuses a persistent [`System`] so CPU% is averaged
/// over the interval since the previous call (sysinfo needs two refreshes to
/// produce a meaningful percentage). Cheap (no PowerShell) — safe to call on the
/// async loop. Prime once with `sys.refresh_cpu_all()` at session start.
pub fn collect_resource_metrics(sys: &mut System) -> serde_json::Value {
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let cpu_pct = if cpus.is_empty() {
        0.0
    } else {
        let avg = cpus.iter().map(|c| c.cpu_usage() as f64).sum::<f64>() / cpus.len() as f64;
        (avg * 10.0).round() / 10.0
    };

    let mem_total = sys.total_memory(); // bytes (sysinfo 0.37)
    let mem_used = sys.used_memory();
    let mem_total_mb = mem_total / 1024 / 1024;
    let mem_used_mb = mem_used / 1024 / 1024;
    let mem_pct = if mem_total > 0 {
        ((mem_used as f64 / mem_total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    // "System" disk = the largest-capacity fixed drive (usually C:).
    let to_gb = |b: u64| ((b as f64) / 1024.0 / 1024.0 / 1024.0 * 100.0).round() / 100.0;
    let disks = Disks::new_with_refreshed_list();
    let (disk_pct, disk_used_gb, disk_total_gb) = disks
        .list()
        .iter()
        .max_by_key(|d| d.total_space())
        .map(|d| {
            let total = d.total_space();
            let used = total.saturating_sub(d.available_space());
            let pct = if total > 0 {
                ((used as f64 / total as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            };
            (pct, to_gb(used), to_gb(total))
        })
        .unwrap_or((0.0, 0.0, 0.0));

    json!({
        "type": "metrics",
        "cpu_pct": cpu_pct,
        "mem_used_mb": mem_used_mb,
        "mem_total_mb": mem_total_mb,
        "mem_pct": mem_pct,
        "disk_pct": disk_pct,
        "disk_used_gb": disk_used_gb,
        "disk_total_gb": disk_total_gb,
        "uptime_secs": System::uptime(),
        "ts": crate::unix_timestamp_secs(),
    })
}

pub fn collect_agent_info() -> serde_json::Value {
    let mut sys = System::new_all();
    sys.refresh_all();
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    // Prefer a WMI/CIM hostname so casing matches Windows (NetBIOS env vars are often ALL CAPS).
    let hostname = powershell_cim_value("Win32_ComputerSystem", "DNSHostName")
        .or_else(|| powershell_cim_value("Win32_ComputerSystem", "Name"))
        .or_else(System::host_name)
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into());
    let os_name = System::name().unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            "Windows".into()
        } else {
            "Linux".into()
        }
    });
    let os_version = System::os_version();
    let os_long_version = System::long_os_version();
    let system_model = powershell_cim_value("Win32_ComputerSystem", "Model");
    let system_manufacturer = powershell_cim_value("Win32_ComputerSystem", "Manufacturer");
    let system_serial = powershell_cim_value("Win32_BIOS", "SerialNumber");
    let motherboard_model = powershell_cim_value("Win32_BaseBoard", "Product");
    let motherboard_manufacturer = powershell_cim_value("Win32_BaseBoard", "Manufacturer");

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_default();
    let cpu_cores = sys.cpus().len() as u32;

    // sysinfo 0.37 returns memory in bytes; convert to MB for the payload.
    let total_mem_mb = sys.total_memory() / 1024 / 1024;
    let used_mem_mb = sys.used_memory() / 1024 / 1024;
    let uptime_secs = System::uptime();

    let disks = Disks::new_with_refreshed_list();
    let drives: Vec<serde_json::Value> = disks
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let avail = d.available_space();
            json!({
                "name": d.name().to_string_lossy().to_string(),
                "mount_point": d.mount_point().to_string_lossy().to_string(),
                "file_system": d.file_system().to_string_lossy().to_string(),
                "total_gb": ((total as f64) / 1024.0 / 1024.0 / 1024.0 * 100.0).round() / 100.0,
                "available_gb": ((avail as f64) / 1024.0 / 1024.0 / 1024.0 * 100.0).round() / 100.0,
            })
        })
        .collect();

    #[cfg(target_os = "windows")]
    let adapters = ipconfig::get_adapters()
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
        .unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    let adapters = linux_network_adapters();

    // Install / config info (avoid including any secrets).
    let cfg = crate::config::load_config();
    let config_path = crate::config::config_path();
    let config_path_str = config_path.to_string_lossy().to_string();
    #[cfg(windows)]
    let machine_config_path_str = crate::config::machine_config_path()
        .to_string_lossy()
        .to_string();
    #[cfg(not(windows))]
    let machine_config_path_str = String::new();
    let machine_connection_policy = crate::config::machine_connection_policy_active();
    let install_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()));
    let ui_password_set =
        !cfg.ui_password_hash.is_empty() && cfg.ui_password_hash.starts_with("$argon2");

    let current_user = active_username()
        .or_else(env_username_fallback)
        .unwrap_or_default();

    json!({
        "type": "agent_info",
        "agent_version": app_version,
        "hostname": hostname,
        "uptime_secs": uptime_secs,
        "os_name": os_name,
        "os_version": os_version,
        "os_long_version": os_long_version,
        "system_model": system_model,
        "system_manufacturer": system_manufacturer,
        "system_serial": system_serial,
        "motherboard_model": motherboard_model,
        "motherboard_manufacturer": motherboard_manufacturer,
        "cpu_brand": cpu_brand,
        "cpu_cores": cpu_cores,
        "memory_total_mb": total_mem_mb,
        "memory_used_mb": used_mem_mb,
        "drives": drives,
        "adapters": adapters,
        "config_path": config_path_str,
        "machine_config_path": machine_config_path_str,
        "machine_connection_policy": machine_connection_policy,
        "install_path": install_path,
        "config_server_url": cfg.server_url,
        "config_agent_name": cfg.agent_name,
        "config_ui_password_set": ui_password_set,
        "current_user": current_user,
        "capabilities": agent_capabilities(),
        "ts": crate::unix_timestamp_secs(),
    })
}
