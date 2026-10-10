//! Linux enrollment details: `$USER`/`$LOGNAME`; no LAN auto-discovery.

use crate::config::Config;

pub(super) const OS_LABEL: &str = "Linux";

pub(super) fn current_username() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// mDNS discovery has no Linux backend, so the agent never requests access on
/// its own; it is paired through `enroll.json` or the server URL + token.
pub async fn try_auto_discover_and_request_access() -> anyhow::Result<Option<Config>> {
    Ok(None)
}
