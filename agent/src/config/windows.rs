//! Windows config store: machine-wide `%ProgramData%\Vantyr\config.dat`, DPAPI
//! machine scope.

use std::path::{Path, PathBuf};

use windows_dpapi::{decrypt_data, encrypt_data, Scope};

use super::{parse_config_json, Config};

/// Optional app-specific entropy so unrelated DPAPI blobs are never mistaken for ours.
const CONFIG_DPAPI_ENTROPY: &[u8] = b"vantyr-agent-config\0";

/// `%ProgramData%\Vantyr` (Windows). Shared config, logs, update staging, markers.
pub fn program_data_vantyr_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from)
        .join("Vantyr")
}

/// Verified MSI downloads before `msiexec` (Windows). Under `ProgramData` with everything else.
pub fn updates_staging_dir() -> PathBuf {
    program_data_vantyr_dir().join("updates")
}

/// Machine-wide encrypted config (Windows). Alias for [`config_path`] on Windows.
pub fn machine_config_path() -> PathBuf {
    program_data_vantyr_dir().join("config.dat")
}

/// Primary config file path: `%ProgramData%\Vantyr\config.dat` (machine DPAPI).
pub fn config_path() -> PathBuf {
    machine_config_path()
}

/// Directory for machine-wide agent state (spool, markers).
pub(super) fn state_dir() -> PathBuf {
    program_data_vantyr_dir()
}

/// Try DPAPI-encrypted JSON (Windows `config.dat` only).
fn try_load_dpapi_dat_machine(bytes: &[u8]) -> Option<Config> {
    try_load_dpapi_dat_scoped(bytes, Scope::Machine)
}

fn try_load_dpapi_dat_scoped(bytes: &[u8], scope: Scope) -> Option<Config> {
    let dec = decrypt_data(bytes, scope, Some(CONFIG_DPAPI_ENTROPY)).ok()?;
    let s = String::from_utf8(dec).ok()?;
    parse_config_json(&s)
}

fn try_load_machine_config_bytes(bytes: &[u8]) -> Option<Config> {
    if bytes.is_empty() {
        return None;
    }
    try_load_dpapi_dat_machine(bytes)
}

/// `true` when the machine-wide config file exists and decrypts successfully.
pub fn machine_connection_policy_active() -> bool {
    let path = machine_config_path();
    std::fs::read(&path)
        .ok()
        .filter(|b| !b.is_empty())
        .and_then(|b| try_load_machine_config_bytes(&b))
        .is_some()
}

/// The stored config, if `config.dat` exists and decrypts.
pub(super) fn load_stored() -> Option<Config> {
    let mpath = machine_config_path();
    std::fs::read(&mpath)
        .ok()
        .and_then(|bytes| try_load_machine_config_bytes(&bytes))
}

fn persist_config(path: &Path, config: &Config, scope: Scope) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(config)?;
    let encrypted = encrypt_data(json.as_bytes(), scope, Some(CONFIG_DPAPI_ENTROPY))?;
    std::fs::write(path, encrypted)?;
    Ok(())
}

pub(super) fn save(config: &Config) -> anyhow::Result<()> {
    persist_config(&config_path(), config, Scope::Machine)
}

/// The user-session companion usually cannot write `%ProgramData%\Vantyr`, so a
/// failed direct write is retried by the Session 0 service over IPC.
pub(super) fn save_via_service(config: &Config, direct_err: anyhow::Error) -> anyhow::Result<()> {
    crate::ipc::request_service_persist_config(config).map_err(|ipc_err| {
        anyhow::anyhow!("direct write failed ({direct_err}); service persist failed ({ipc_err})")
    })
}

/// Where `--import-machine-config` wrote the config, for the CLI message.
pub(super) fn imported_location() -> String {
    format!(
        "machine-wide config to {} (DPAPI machine scope)",
        machine_config_path().display()
    )
}

// ─── Settings UI reopen after MSI update (from "Download and install" in the webview) ─────

fn reopen_settings_ui_marker_path() -> PathBuf {
    program_data_vantyr_dir().join("reopen_settings_ui.marker")
}

/// Call before exiting for an update started from the settings UI so the next launch shows the window.
pub fn request_reopen_settings_ui_after_restart() {
    let path = reopen_settings_ui_marker_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::File::create(&path);
}

/// If the marker exists, remove it and return true (next launch should show settings).
pub fn take_reopen_settings_ui_after_restart() -> bool {
    std::fs::remove_file(reopen_settings_ui_marker_path()).is_ok()
}
