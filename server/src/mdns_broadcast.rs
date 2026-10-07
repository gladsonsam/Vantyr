//! LAN discovery: advertise `_vantyr._tcp` with TXT `wss=<WebSocket URL>`.
//!
//! **Default: on** when a WSS URL can be resolved. **Turn off** with `VANTYR_MDNS=0` (or
//! `false` / `off` / `no`) or `VANTYR_MDNS_DISABLE=1`.
//!
//! **WSS URL:** `VANTYR_MDNS_WSS_URL=wss://host:port/ws/agent` or `PUBLIC_BASE_URL=https://…`
//! (reverse-proxy aware). Without either, registration is skipped (warn log).
//!
//! **Port:** defaults to `LISTEN` port; override with `VANTYR_MDNS_PORT` when TLS terminates
//! elsewhere (e.g. `443` behind nginx).
//!
//! **Troubleshooting when phones / other PCs do not see `_vantyr._tcp`:**
//! - Set `PUBLIC_BASE_URL` or `VANTYR_MDNS_WSS_URL` or mDNS never starts (see logs).
//! - Docker: use host networking (`network_mode: host`) or mDNS packets stay inside the bridge.
//! - Windows: allow **UDP 5353** inbound/outbound for `vantyr-server` (Bonjour / mDNS).
//! - Wi‑Fi **AP / client isolation** or **guest networks** block device-to-device multicast.
//! - Override advertised IPs with `VANTYR_MDNS_ADDRESSES` (comma-separated) if the host picks the wrong NIC.

use std::collections::HashMap;
use std::collections::HashSet;
use std::net::IpAddr;

use mdns_sd::{ServiceDaemon, ServiceInfo};
use tracing::{info, warn};

/// LAN discovery settings, parsed from the environment by `config::ServerConfig::from_env`.
#[derive(Debug, Clone)]
pub struct MdnsConfig {
    /// `VANTYR_MDNS=0` / `VANTYR_MDNS_DISABLE=1`.
    pub disabled: bool,
    /// Agent WebSocket URL to advertise: `VANTYR_MDNS_WSS_URL`, else derived from
    /// `PUBLIC_BASE_URL`. `None` means there is nothing to advertise.
    pub wss_url: Option<String>,
    /// Advertised TCP port: `VANTYR_MDNS_PORT`, else the listen port.
    pub port: u16,
    /// `VANTYR_MDNS_ADDRESSES`: explicit comma-separated IPs for the A/AAAA records.
    pub addresses: Option<String>,
    /// Host label for `<name>.local.` (`COMPUTERNAME` / `HOSTNAME`, default `vantyr`).
    pub computer_name: String,
}

/// Comma-separated IPs for mDNS A/AAAA records. Env override wins; else non-loopback interfaces.
fn mdns_ip_csv_for_registration(addresses: Option<&str>) -> Option<String> {
    if let Some(t) = addresses {
        return Some(t.to_string());
    }

    let mut set: HashSet<IpAddr> = HashSet::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let ip = iface.ip();
        if !ip.is_loopback() {
            set.insert(ip);
        }
    }

    if set.is_empty() {
        return None;
    }

    let mut list: Vec<String> = set.into_iter().map(|ip| ip.to_string()).collect();
    list.sort();
    Some(list.join(","))
}

/// How the server exposes LAN discovery (same rules as [`spawn_vantyr_mdns_if_enabled`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MdnsAdvertisementMode {
    /// mDNS would run with a resolved WSS URL (registration may still fail at runtime).
    Advertising,
    /// `VANTYR_MDNS=0` / `VANTYR_MDNS_DISABLE=1`.
    DisabledByEnv,
    /// No `PUBLIC_BASE_URL` / `VANTYR_MDNS_WSS_URL` — nothing to advertise.
    UnavailableNoWssUrl,
}

#[derive(serde::Serialize)]
pub struct AgentSetupHints {
    pub mdns: MdnsAdvertisementMode,
    pub agent_wss_url: Option<String>,
    pub mdns_port: u16,
}

/// Dashboard/onboarding: mDNS mode and the agent WebSocket URL when known.
pub fn build_agent_setup_hints(cfg: &MdnsConfig) -> AgentSetupHints {
    let wss = cfg.wss_url.clone();
    let mdns = if cfg.disabled {
        MdnsAdvertisementMode::DisabledByEnv
    } else if wss.is_none() {
        MdnsAdvertisementMode::UnavailableNoWssUrl
    } else {
        MdnsAdvertisementMode::Advertising
    };
    AgentSetupHints {
        mdns,
        agent_wss_url: wss,
        mdns_port: cfg.port,
    }
}

/// Spawn a background thread that keeps an mDNS registration alive.
pub fn spawn_vantyr_mdns_if_enabled(cfg: &MdnsConfig) {
    if cfg.disabled {
        info!("mDNS advertisement disabled (VANTYR_MDNS=0 or VANTYR_MDNS_DISABLE=1).");
        return;
    }

    let Some(wss_url) = cfg.wss_url.clone() else {
        warn!(
            "mDNS skipped: set PUBLIC_BASE_URL=https://… or VANTYR_MDNS_WSS_URL=wss://… (or disable with VANTYR_MDNS=0)."
        );
        return;
    };

    let mdns_port = cfg.port;
    let addresses = cfg.addresses.clone();
    let computer = cfg.computer_name.clone();

    if std::path::Path::new("/.dockerenv").exists() {
        warn!(
            "mDNS in Docker: the default bridge network does not forward multicast to your Wi‑Fi/LAN — phones/agents often cannot discover this service. Set PUBLIC_BASE_URL to your host IP (not localhost) and use wss://<host-ip>:<port>/ws/agent on the agent, or use `network_mode: host` on Linux (see docker-compose.yml)."
        );
    }

    std::thread::spawn(move || {
        let daemon = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "mDNS: could not create daemon");
                return;
            }
        };

        let host_name = format!("{}.local.", computer.trim_end_matches('.'));

        let mut txt: HashMap<String, String> = HashMap::new();
        txt.insert("wss".into(), wss_url.clone());

        let ip_csv = mdns_ip_csv_for_registration(addresses.as_deref());
        let info = match &ip_csv {
            Some(csv) if !csv.is_empty() => match ServiceInfo::new(
                "_vantyr._tcp.local.",
                "Vantyr",
                &host_name,
                csv.as_str(),
                mdns_port,
                txt.clone(),
            ) {
                Ok(i) => {
                    info!(
                        ips = %csv,
                        port = mdns_port,
                        "mDNS: registering _vantyr._tcp with explicit host IPs (A/AAAA)"
                    );
                    i
                }
                Err(e) => {
                    warn!(error = %e, "mDNS: invalid ServiceInfo (explicit IPs)");
                    return;
                }
            },
            _ => {
                warn!(
                    "mDNS: no non-loopback IPs found (set VANTYR_MDNS_ADDRESSES if discovery fails); using addr-auto"
                );
                match ServiceInfo::new(
                    "_vantyr._tcp.local.",
                    "Vantyr",
                    &host_name,
                    (),
                    mdns_port,
                    txt,
                ) {
                    Ok(i) => i.enable_addr_auto(),
                    Err(e) => {
                        warn!(error = %e, "mDNS: invalid ServiceInfo");
                        return;
                    }
                }
            }
        };

        if let Err(e) = daemon.register(info) {
            warn!(error = %e, "mDNS: register failed");
            return;
        }

        info!(
            port = mdns_port,
            wss_len = wss_url.len(),
            "mDNS: registered _vantyr._tcp; phones/agents need same LAN, UDP 5353 allowed, and (Docker) host networking"
        );

        loop {
            std::thread::sleep(std::time::Duration::from_secs(86_400));
        }
    });
}
