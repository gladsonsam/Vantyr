//! Platform network kill-switch for parental controls.
//!
//! Windows uses named Windows Firewall rules and restores the outbound default
//! policy on cleanup. Linux uses a dedicated nftables `inet` table that allows
//! loopback, established traffic, DNS/DHCP, and the Vantyr server endpoint.

pub mod scheduler;

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

pub use imp::{apply_block, remove_block};

/// Run a firewall change on the blocking pool: it spawns `netsh` / `nft` and may resolve DNS,
/// none of which belongs on an async worker.
pub(crate) async fn run_blocking(
    change: impl FnOnce() -> anyhow::Result<()> + Send + 'static,
) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(change)
        .await
        .unwrap_or_else(|e| Err(anyhow::anyhow!("firewall task failed: {e}")))
}

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
