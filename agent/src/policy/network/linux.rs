//! Linux network kill-switch: a dedicated nftables `inet` table that allows
//! loopback, established traffic, DNS/DHCP, and the Vantyr server endpoint.
//!
//! nftables requires `CAP_NET_ADMIN` (run the agent elevated); without privilege
//! `apply_block` returns an error and the capability block reports
//! `network_blocking: "needs_privilege"`.

use anyhow::Result;
use tracing::{info, warn};

/// Block all outbound internet traffic while keeping the Vantyr server reachable.
///
/// Resolves `server_hostname` to an IP (preferring IPv4) at call time and fails
/// if it cannot, since the nftables allow rule needs an address.
pub fn apply_block(server_hostname: &str, server_port: u16) -> Result<()> {
    let server_ip = resolve_server_ip(server_hostname, server_port)?;
    apply_nft_block(server_ip, server_port)?;
    info!("Network block applied with nftables (server={server_ip}:{server_port}).");
    Ok(())
}

/// Restore outbound internet access by reversing `apply_block`.
pub fn remove_block() -> Result<()> {
    let _ = run_nft(&["delete", "table", "inet", "vantyr_next"]);
    let _ = run_nft(&["delete", "table", "inet", "vantyr"]);
    info!("Network block removed with nftables.");
    Ok(())
}

/// Apply or lift the block directly.
pub(super) async fn apply_policy(
    blocked: bool,
    hostname: String,
    port: u16,
    _generation: Option<crate::permissions::Generation>,
) {
    if blocked {
        if let Err(e) = apply_block(&hostname, port) {
            warn!("Failed to apply network block: {e}");
        }
    } else if let Err(e) = remove_block() {
        warn!("Failed to remove network block: {e}");
    }
}

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

fn add_nft_rule(args: &[&str]) -> Result<()> {
    run_nft(args).map_err(|e| anyhow::anyhow!("add nftables rule: {}: {e}", args.join(" ")))
}

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
