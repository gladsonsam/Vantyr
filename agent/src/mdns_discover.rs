//! Browse LAN for Vantyr servers advertising `_vantyr._tcp` (optional; opt-in on server).

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use mdns_sd::{ServiceDaemon, ServiceEvent};
#[cfg(target_os = "windows")]
use tracing::warn;

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub instance_name: String,
    pub wss_url: String,
}

/// Resolve up to `timeout_ms` (cap 8000). Requires `mdns-sd` and LAN mDNS.
#[cfg(target_os = "windows")]
pub fn discover_vantyr_servers(timeout_ms: u64) -> Vec<DiscoveredServer> {
    let timeout_ms = timeout_ms.clamp(500, 8000);
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!(error = %e, "mDNS browse: could not create daemon (firewall or OS restriction?)");
            return Vec::new();
        }
    };
    let receiver = match daemon.browse("_vantyr._tcp.local.") {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "mDNS browse: browse _vantyr._tcp failed");
            return Vec::new();
        }
    };

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut out: Vec<DiscoveredServer> = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    while Instant::now() < deadline {
        let wait = deadline.saturating_duration_since(Instant::now());
        let step = wait.min(Duration::from_millis(250));
        match receiver.recv_timeout(step) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let Some(wss) = info.get_property_val_str("wss") else {
                    continue;
                };
                let wss = wss.trim();
                if wss.is_empty() || !wss.starts_with("wss://") {
                    continue;
                }
                let name = info
                    .get_fullname()
                    .trim_end_matches('.')
                    .rsplit_once('.')
                    .map_or_else(
                        || info.get_fullname().to_string(),
                        |(a, _)| a.replace("\\.", "."),
                    );
                if seen.insert(wss.to_string()) {
                    out.push(DiscoveredServer {
                        instance_name: name,
                        wss_url: wss.to_string(),
                    });
                }
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }

    let _ = daemon.shutdown();
    out
}

#[cfg(not(target_os = "windows"))]
pub fn discover_vantyr_servers(_timeout_ms: u64) -> Vec<DiscoveredServer> {
    Vec::new()
}
