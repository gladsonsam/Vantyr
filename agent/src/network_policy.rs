//! Platform network kill-switch for parental controls.
//!
//! Windows uses named Windows Firewall rules and restores the outbound default
//! policy on cleanup. Linux uses a dedicated nftables `inet` table that allows
//! loopback, established traffic, DNS/DHCP, and the Vantyr server endpoint.

use anyhow::Result;
use tracing::info;

const RULE_SERVER: &str = "VantyrAllowServer";
const RULE_DNS: &str = "VantyrAllowDNS";
const RULE_DHCP: &str = "VantyrAllowDHCP";

/// Parse `wss://hostname:port/path` or `ws://hostname/path` into `(hostname, port)`.
pub fn parse_server_host_port(server_url: &str) -> Option<(String, u16)> {
    let url = url::Url::parse(server_url.trim()).ok()?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return None;
    }
    let host = url
        .host_str()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default()?;
    Some((host, port))
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
fn delete_vantyr_rules() {
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

/// Block all outbound internet traffic while keeping the Vantyr server reachable.
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

        // Remove any previous Vantyr rules so we start clean.
        delete_vantyr_rules();

        // Allow outbound TCP to the Vantyr server.
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
        let server_ip = resolve_server_ip(server_hostname, server_port)?;
        apply_nft_block(server_ip, server_port)?;
        info!("Network block applied with nftables (server={server_ip}:{server_port}).");
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

        delete_vantyr_rules();

        info!("Network block removed.");
    }
    #[cfg(not(windows))]
    {
        let _ = run_nft(&["delete", "table", "inet", "vantyr_next"]);
        let _ = run_nft(&["delete", "table", "inet", "vantyr"]);
        info!("Network block removed with nftables.");
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_nft(args: &[&str]) -> Result<()> {
    let output = std::process::Command::new("nft").args(args).output()?;
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
        anyhow::bail!("nft: {detail}");
    }
    Ok(())
}

#[cfg(not(windows))]
fn resolve_server_ip(server_hostname: &str, server_port: u16) -> Result<std::net::IpAddr> {
    if let Ok(ip) = server_hostname.parse::<std::net::IpAddr>() {
        return Ok(ip);
    }

    use std::net::ToSocketAddrs;
    let addr_str = format!("{server_hostname}:{server_port}");
    let mut addrs: Vec<_> = addr_str
        .to_socket_addrs()
        .map_err(|e| anyhow::anyhow!("resolve Vantyr server hostname {server_hostname}: {e}"))?
        .collect();
    addrs.sort_by_key(|addr| if addr.ip().is_ipv4() { 0 } else { 1 });
    addrs
        .into_iter()
        .next()
        .map(|addr| addr.ip())
        .ok_or_else(|| anyhow::anyhow!("no addresses resolved for {server_hostname}"))
}

#[cfg(not(windows))]
fn add_nft_rule(args: &[&str]) -> Result<()> {
    run_nft(args).map_err(|e| anyhow::anyhow!("add nftables rule: {}: {e}", args.join(" ")))
}

#[cfg(not(windows))]
fn apply_nft_block(server_ip: std::net::IpAddr, server_port: u16) -> Result<()> {
    let table = "vantyr_next";
    let _ = run_nft(&["delete", "table", "inet", table]);
    run_nft(&["add", "table", "inet", table])?;
    run_nft(&[
        "add", "chain", "inet", table, "output", "{", "type", "filter", "hook", "output",
        "priority", "0", ";", "policy", "drop", ";", "}",
    ])?;
    add_nft_rule(&[
        "add",
        "rule",
        "inet",
        table,
        "output",
        "ct",
        "state",
        "established,related",
        "accept",
    ])?;
    add_nft_rule(&[
        "add", "rule", "inet", table, "output", "oif", "lo", "accept",
    ])?;
    let family = if server_ip.is_ipv4() { "ip" } else { "ip6" };
    let server_ip = server_ip.to_string();
    let server_port = server_port.to_string();
    add_nft_rule(&[
        "add",
        "rule",
        "inet",
        table,
        "output",
        family,
        "daddr",
        &server_ip,
        "tcp",
        "dport",
        &server_port,
        "accept",
    ])?;
    add_nft_rule(&[
        "add", "rule", "inet", table, "output", "udp", "dport", "53", "accept",
    ])?;
    add_nft_rule(&[
        "add", "rule", "inet", table, "output", "tcp", "dport", "53", "accept",
    ])?;
    add_nft_rule(&[
        "add", "rule", "inet", table, "output", "udp", "dport", "67", "accept",
    ])?;

    let _ = run_nft(&["delete", "table", "inet", "vantyr"]);
    run_nft(&["rename", "table", "inet", table, "vantyr"])
        .map_err(|e| anyhow::anyhow!("activate staged nftables policy: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_server_host_port() {
        assert_eq!(
            parse_server_host_port("wss://vantyr.gladsonsam.com/ws/agent"),
            Some(("vantyr.gladsonsam.com".to_string(), 443))
        );
        assert_eq!(
            parse_server_host_port("wss://192.168.1.100:9000/ws/agent"),
            Some(("192.168.1.100".to_string(), 9000))
        );
        assert_eq!(
            parse_server_host_port("ws://localhost:8080/ws/agent"),
            Some(("localhost".to_string(), 8080))
        );
        assert_eq!(
            parse_server_host_port("wss://[2001:db8::1]:9443/ws/agent"),
            Some(("2001:db8::1".to_string(), 9443))
        );
        assert_eq!(parse_server_host_port("https://not-a-ws-url"), None);
    }
}
