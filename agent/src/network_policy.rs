//! Windows Firewall-based internet kill-switch for parental controls.
//!
//! `apply_block` sets the outbound default to BLOCK and adds named allow
//! rules so the Sentinel agent can still reach the server.
//! `remove_block` restores the outbound default to ALLOW and removes the
//! named rules.
//!
//! Both functions are no-ops on non-Windows builds.

use anyhow::Result;
use tracing::info;

const RULE_SERVER: &str = "SentinelAllowServer";
const RULE_DNS: &str = "SentinelAllowDNS";
const RULE_DHCP: &str = "SentinelAllowDHCP";

/// Parse `wss://hostname:port/path` or `ws://hostname/path` into `(hostname, port)`.
pub fn parse_server_host_port(server_url: &str) -> Option<(String, u16)> {
    let url = server_url.trim();
    let (scheme, rest) = if let Some(r) = url.strip_prefix("wss://") {
        ("wss", r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        ("ws", r)
    } else {
        return None;
    };
    let host_part = rest.split('/').next()?;
    let default_port: u16 = if scheme == "wss" { 443 } else { 80 };
    if let Some(colon_pos) = host_part.rfind(':') {
        let host = host_part[..colon_pos].to_string();
        let port: u16 = host_part[colon_pos + 1..].parse().ok()?;
        Some((host, port))
    } else {
        Some((host_part.to_string(), default_port))
    }
}

#[cfg(windows)]
fn run_netsh(args: &[&str]) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = std::process::Command::new("netsh")
        .creation_flags(CREATE_NO_WINDOW)
        .args(args)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("exit code {}", output.status)
        };
        anyhow::bail!("netsh: {detail}");
    }
    Ok(())
}

#[cfg(windows)]
fn delete_sentinel_rules() {
    for name in [RULE_SERVER, RULE_DNS, RULE_DHCP] {
        let rule_arg = format!("name={name}");
        let _ = run_netsh(&[
            "advfirewall",
            "firewall",
            "delete",
            "rule",
            rule_arg.as_str(),
        ]);
    }
}

/// Block all outbound internet traffic while keeping the Sentinel server reachable.
///
/// Resolves `server_hostname` to an IP at call time. If resolution fails the
/// hostname itself is used as the `remoteip` value (Windows Firewall does not
/// support FQDNs, so callers should ensure the hostname is already an IP or
/// that DNS resolution succeeds).
pub fn apply_block(server_hostname: &str, server_port: u16) -> Result<()> {
    #[cfg(windows)]
    {
        use std::net::ToSocketAddrs;

        let addr_str = format!("{server_hostname}:{server_port}");
        let server_ip = addr_str
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.next())
            .map_or_else(|| server_hostname.to_string(), |a| a.ip().to_string());

        // Remove any previous Sentinel rules so we start clean.
        delete_sentinel_rules();

        // Allow outbound TCP to the Sentinel server.
        let remoteip_arg = format!("remoteip={server_ip}");
        let remoteport_arg = format!("remoteport={server_port}");
        run_netsh(&[
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={RULE_SERVER}"),
            "dir=out",
            "action=allow",
            "enable=yes",
            "protocol=TCP",
            remoteip_arg.as_str(),
            remoteport_arg.as_str(),
        ])?;

        // Allow outbound UDP for DNS so the agent can resolve its server hostname.
        run_netsh(&[
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={RULE_DNS}"),
            "dir=out",
            "action=allow",
            "enable=yes",
            "protocol=UDP",
            "remoteport=53",
        ])?;

        // Allow outbound UDP for DHCP so the network lease is maintained.
        run_netsh(&[
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={RULE_DHCP}"),
            "dir=out",
            "action=allow",
            "enable=yes",
            "protocol=UDP",
            "remoteport=67",
        ])?;

        // Set default outbound policy to BLOCK on all profiles.
        // The allow rules above act as exceptions.
        run_netsh(&[
            "advfirewall",
            "set",
            "allprofiles",
            "firewallpolicy",
            "blockinbound,blockoutbound",
        ])?;

        info!("Network block applied (server={server_ip}:{server_port}).");
    }
    #[cfg(not(windows))]
    {
        let _ = (server_hostname, server_port);
        info!("Network block requested on non-Windows build; no-op.");
    }
    Ok(())
}

/// Restore outbound internet access by reversing `apply_block`.
pub fn remove_block() -> Result<()> {
    #[cfg(windows)]
    {
        // Restore default outbound policy to ALLOW first so traffic flows
        // immediately, then clean up the exception rules.
        run_netsh(&[
            "advfirewall",
            "set",
            "allprofiles",
            "firewallpolicy",
            "blockinbound,allowoutbound",
        ])?;

        delete_sentinel_rules();

        info!("Network block removed.");
    }
    #[cfg(not(windows))]
    {
        info!("Network unblock requested on non-Windows build; no-op.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_server_host_port() {
        assert_eq!(
            parse_server_host_port("wss://sentinel.gladsonsam.com/ws/agent"),
            Some(("sentinel.gladsonsam.com".to_string(), 443))
        );
        assert_eq!(
            parse_server_host_port("wss://192.168.1.100:9000/ws/agent"),
            Some(("192.168.1.100".to_string(), 9000))
        );
        assert_eq!(
            parse_server_host_port("ws://localhost:8080/ws/agent"),
            Some(("localhost".to_string(), 8080))
        );
        assert_eq!(parse_server_host_port("https://not-a-ws-url"), None);
    }
}
