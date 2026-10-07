//! Windows enrollment details: `%USERNAME%` and mDNS auto-discovery.

use tracing::{info, warn};

use crate::config::Config;

pub(super) const OS_LABEL: &str = "Windows";

pub(super) fn current_username() -> Option<String> {
    std::env::var("USERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// With no token yet, request access from the configured `wss://` server or,
/// failing that, from servers found over mDNS, and wait for admin approval.
pub async fn try_auto_discover_and_request_access() -> anyhow::Result<Option<Config>> {
    let cfg = crate::config::load_config();
    if !cfg.agent_token.trim().is_empty() {
        return Ok(None);
    }

    let agent_name = if cfg.agent_name.trim().is_empty() {
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "agent".to_string())
    } else {
        cfg.agent_name.trim().to_string()
    };

    let mut candidates = Vec::new();
    if cfg.server_url.trim().starts_with("wss://") {
        candidates.push(cfg.server_url.trim().to_string());
    } else {
        let discovered = crate::connection::mdns::discover_vantyr_servers(4_000);
        candidates.extend(discovered.into_iter().map(|server| server.wss_url));
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    for wss_url in candidates {
        info!("Requesting Vantyr access via discovered server {wss_url}");
        match super::request_access_and_wait(&wss_url, None, &agent_name).await {
            Ok(cfg) => return Ok(Some(cfg)),
            Err(e) => warn!("Automatic access request via {wss_url} failed: {e:#}"),
        }
    }

    Ok(None)
}
