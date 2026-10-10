//! Windows network kill-switch: named Windows Firewall rules via `netsh`.
//!
//! The user-session companion cannot change the firewall, so policy changes go
//! through the Session 0 service and fall back to `netsh` directly.

use anyhow::Result;
use tracing::{info, warn};

// Windows Firewall rule names.
const RULE_SERVER: &str = "VantyrAllowServer";
const RULE_DNS: &str = "VantyrAllowDNS";
const RULE_DHCP: &str = "VantyrAllowDHCP";

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
    Ok(())
}

/// Restore outbound internet access by reversing `apply_block`.
pub fn remove_block() -> Result<()> {
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
    Ok(())
}

/// Apply or lift the block through the service, falling back to `netsh`.
pub(super) async fn apply_policy(
    blocked: bool,
    hostname: String,
    port: u16,
    generation: Option<crate::permissions::Generation>,
) {
    match crate::host::service_client::set_network_policy_via_service(
        blocked, &hostname, port, generation,
    )
    .await
    {
        Ok(()) => info!("Network policy applied via service (blocked={blocked})."),
        Err(e) => {
            // Service pipe unavailable (e.g. running standalone in dev) — try direct.
            warn!("Service pipe unavailable, falling back to direct netsh: {e}");
            let direct = if blocked && !generation.is_some_and(|g| g.valid_fresh()) {
                return;
            } else if blocked {
                super::run_blocking(move || super::apply_block(&hostname, port)).await
            } else {
                super::run_blocking(super::remove_block).await
            };
            if let Err(e2) = direct {
                warn!("Direct netsh also failed: {e2}");
            } else {
                info!("Network policy applied directly (blocked={blocked}).");
            }
        }
    }
}
