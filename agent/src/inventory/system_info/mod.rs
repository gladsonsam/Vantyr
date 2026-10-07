use sysinfo::{Disks, System};

use crate::outbound::agent_info::{
    AgentInfo, AgentInfoMinimal, AgentInfoRestricted, ClipboardCapability, Drive,
};

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

/// SMBIOS identity of the machine; `None` where the OS does not expose a field.
struct HardwareIdentity {
    system_model: Option<String>,
    system_manufacturer: Option<String>,
    system_serial: Option<String>,
    motherboard_model: Option<String>,
    motherboard_manufacturer: Option<String>,
}

/// Best-effort active console user (Windows: `Win32_ComputerSystem.UserName`).
///
/// Returns values like `DOMAIN\\Username` or `COMPUTER\\Username` when available.
pub fn active_username() -> Option<String> {
    if ![
        crate::permissions::Module::SystemInfo,
        crate::permissions::Module::IdleActivity,
        crate::permissions::Module::WindowActivity,
        crate::permissions::Module::BrowserUrls,
        crate::permissions::Module::KeyboardText,
    ]
    .into_iter()
    .any(crate::permissions::allowed)
    {
        return None;
    }
    imp::active_console_user()
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
///
/// `None` when the metrics grant is off, so nothing is sent.
pub fn collect_resource_metrics(sys: &mut System) -> Option<serde_json::Value> {
    if !crate::permissions::allowed(crate::permissions::Module::ResourceMetrics) {
        return None;
    }
    let generation =
        crate::permissions::Generation::capture(crate::permissions::Module::ResourceMetrics)?;
    let _lease = crate::permissions::WorkerLease::new(generation);
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
            (pct, bytes_to_gb(used), bytes_to_gb(total))
        })
        .unwrap_or((0.0, 0.0, 0.0));

    Some(crate::outbound::stamped(
        &crate::outbound::telemetry::Metrics {
            cpu_pct,
            mem_used_mb,
            mem_total_mb,
            mem_pct,
            disk_pct,
            disk_used_gb,
            disk_total_gb,
            uptime_secs: System::uptime(),
            ts: crate::unix_timestamp_secs(),
        },
        Some(generation),
    ))
}

/// Bytes as gigabytes, rounded to two decimals.
fn bytes_to_gb(bytes: u64) -> f64 {
    ((bytes as f64) / 1024.0 / 1024.0 / 1024.0 * 100.0).round() / 100.0
}

/// What the agent may say about clipboard support without the system-info grant.
fn clipboard_capability() -> ClipboardCapability {
    ClipboardCapability {
        clipboard: if crate::input::clipboard::available() {
            "supported"
        } else {
            "unavailable"
        },
    }
}

/// [`collect_agent_info`] on the blocking pool. On Windows it runs several PowerShell/CIM
/// queries that take seconds, so async code must not call it directly. `None` if the
/// collection task panicked.
pub async fn collect_agent_info_async() -> Option<serde_json::Value> {
    tokio::task::spawn_blocking(collect_agent_info).await.ok()
}

pub fn collect_agent_info() -> serde_json::Value {
    if !crate::permissions::allowed(crate::permissions::Module::SystemInfo) {
        return crate::outbound::to_value(&AgentInfoRestricted {
            agent_version: env!("CARGO_PKG_VERSION"),
            timezone: iana_time_zone::get_timezone().ok(),
            capabilities: clipboard_capability(),
        });
    }
    let generation =
        crate::permissions::Generation::capture(crate::permissions::Module::SystemInfo);
    let Some(generation) = generation else {
        return crate::outbound::to_value(&AgentInfoMinimal {
            agent_version: env!("CARGO_PKG_VERSION"),
            capabilities: clipboard_capability(),
        });
    };
    let _lease = crate::permissions::WorkerLease::new(generation);
    let mut sys = System::new_all();
    sys.refresh_all();

    // Prefer a WMI/CIM hostname so casing matches Windows (NetBIOS env vars are often ALL CAPS).
    let hostname = imp::wmi_hostname()
        .or_else(System::host_name)
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into());
    let os_name = System::name().unwrap_or_else(|| imp::OS_NAME.into());
    let os_version = System::os_version();
    let os_long_version = System::long_os_version();
    let HardwareIdentity {
        system_model,
        system_manufacturer,
        system_serial,
        motherboard_model,
        motherboard_manufacturer,
    } = imp::hardware_identity();

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
    let drives: Vec<Drive> = disks
        .list()
        .iter()
        .map(|d| Drive {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_string_lossy().to_string(),
            file_system: d.file_system().to_string_lossy().to_string(),
            total_gb: bytes_to_gb(d.total_space()),
            available_gb: bytes_to_gb(d.available_space()),
        })
        .collect();

    let adapters = imp::network_adapters();

    // Install / config info (avoid including any secrets).
    let cfg = crate::config::load_config();
    let config_path = crate::config::config_path();
    let config_path_str = config_path.to_string_lossy().to_string();
    let machine_config_path_str = imp::machine_config_path();
    let machine_connection_policy = crate::config::machine_connection_policy_active();
    let install_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string()));
    let ui_password_set =
        !cfg.ui_password_hash.is_empty() && cfg.ui_password_hash.starts_with("$argon2");

    let current_user = active_username()
        .or_else(env_username_fallback)
        .unwrap_or_default();

    // IANA timezone of this machine (e.g. "Australia/Perth"). The server uses it to
    // bucket Recall activity into the user's *local* day; without it a day summary
    // for anyone east or west of UTC covers the wrong 24 hours and splits their
    // real day across two rows. `None` if the OS timezone can't be mapped.
    let timezone = iana_time_zone::get_timezone().ok();

    crate::outbound::stamped(
        &AgentInfo {
            agent_version: env!("CARGO_PKG_VERSION"),
            hostname,
            timezone,
            uptime_secs,
            os_name,
            os_version,
            os_long_version,
            system_model,
            system_manufacturer,
            system_serial,
            motherboard_model,
            motherboard_manufacturer,
            cpu_brand,
            cpu_cores,
            memory_total_mb: total_mem_mb,
            memory_used_mb: used_mem_mb,
            drives,
            adapters,
            config_path: config_path_str,
            machine_config_path: machine_config_path_str,
            machine_connection_policy,
            install_path,
            config_server_url: cfg.server_url,
            config_agent_name: cfg.agent_name,
            config_ui_password_set: ui_password_set,
            current_user,
            capabilities: imp::capabilities(),
            // Connected monitors for the dashboard's screen-viewer monitor picker.
            // Best-effort: empty when there's no interactive desktop (e.g. the
            // Session-0 service), which the server preserves across snapshots.
            monitors: crate::capture::screen::list_monitors(),
            ts: crate::unix_timestamp_secs(),
        },
        Some(generation),
    )
}
