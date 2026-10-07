//! Linux config store: `$XDG_CONFIG_HOME/vantyr/config.json` with `0600` file
//! permissions. Intentionally explicit JSON until Secret Service support lands.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::{parse_config_json, Config};

/// Primary config file path: `$XDG_CONFIG_HOME/vantyr/config.json` (0600 JSON).
pub fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vantyr")
        .join("config.json")
}

/// Directory for local agent state (spool).
pub(super) fn state_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vantyr")
}

fn legacy_non_windows_config_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("vantyr")
        .join("config.dat")
}

/// There is no machine-wide config on Linux.
pub fn machine_connection_policy_active() -> bool {
    false
}

/// The stored config from the XDG path, or the legacy data-dir path.
pub(super) fn load_stored() -> Option<Config> {
    let path = config_path();
    let legacy_path = legacy_non_windows_config_path();
    for candidate in [&path, &legacy_path] {
        if let Ok(text) = std::fs::read_to_string(candidate) {
            if let Some(c) = parse_config_json(&text) {
                return Some(c);
            }
        }
    }
    None
}

fn persist_config(path: &Path, config: &Config) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    let json = serde_json::to_vec_pretty(config)?;
    std::fs::write(path, json)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

pub(super) fn save(config: &Config) -> anyhow::Result<()> {
    persist_config(&config_path(), config)
}

/// The per-user config is always directly writable; there is no service to retry through.
pub(super) fn save_via_service(_config: &Config, direct_err: anyhow::Error) -> anyhow::Result<()> {
    Err(direct_err)
}

/// Where `--import-machine-config` wrote the config, for the CLI message.
pub(super) fn imported_location() -> String {
    format!("user config to {}", config_path().display())
}
