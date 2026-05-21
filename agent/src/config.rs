//! Persistent configuration and shared runtime state for the agent.
//!
//! ## Windows — machine-wide (`%ProgramData%\\Sentinel\\config.dat`)
//!
//! The agent is built for **machine-wide deployment**: one encrypted file for the whole PC,
//! DPAPI **machine** scope (any local user session on this box can decrypt it; other PCs
//! cannot). Connection settings, local UI password hash, and auto-update preference are all
//! stored here. The Windows agent does **not** read or write under `%LOCALAPPDATA%`.
//!
//! Imaging / MDM: run `sentinel-agent --import-machine-config deploy.json` elevated, or use
//! the settings UI (requires write access to `%ProgramData%\\Sentinel`, per your MSI ACLs).
//!
//! ## Non-Windows
//!
//! Uses `%LOCALAPPDATA%/sentinel/config.dat` with DPAPI **user** scope (same as before).
//!
//! ## Pairing (`enroll.json`)
//!
//! Place `%ProgramData%\\Sentinel\\enroll.json` (plaintext JSON) with the **6-digit pairing
//! code** from the dashboard. On startup the agent creates a pending claim, polls for approval,
//! receives a **per-device** WebSocket token, writes `config.dat`, and deletes `enroll.json`.
//!
//! [`CryptProtectData`]: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use windows_dpapi::{decrypt_data, encrypt_data, Scope};

// ─── Configuration ────────────────────────────────────────────────────────────

/// Agent connection + security configuration, persisted to disk as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Full WebSocket URL of the Sentinel server.
    /// Example: `ws://192.168.1.100:9000/ws/agent`
    #[serde(default)]
    pub server_url: String,

    /// Friendly name sent to the server as `?name=<agent_name>`.
    /// Defaults to the Windows `COMPUTERNAME` environment variable.
    #[serde(default = "default_agent_name")]
    pub agent_name: String,

    /// Per-device bearer token issued after admin approval.
    #[serde(default, alias = "agent_password")]
    pub agent_token: String,

    /// Stable random local ID used only for enrollment claim de-duplication.
    #[serde(default)]
    pub install_id: String,

    /// Argon2 PHC string from the server (`set_local_ui_password_hash`). Empty means no lock.
    #[serde(default)]
    pub ui_password_hash: String,

    /// When true, checks for updates ~45s after startup and every 6 hours (default off).
    /// Windows: silent MSI via `update_via_service`; other platforms: Tauri updater. Server
    /// `update_now` and the **Agent | v…** link still work regardless. Toggle locally or via
    /// `set_auto_update`.
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,

    /// When true (default), show the system tray icon for quick access to settings.
    /// When false, the agent still runs but will not create a tray icon.
    #[serde(default = "default_tray_icon_enabled")]
    pub tray_icon_enabled: bool,

    /// When true, all outbound internet access is blocked via Windows Firewall.
    /// The agent's own connection to the Sentinel server is always permitted.
    /// Controlled remotely via `set_network_policy` from the dashboard.
    #[serde(default)]
    pub internet_blocked: bool,

    /// Effective internet block rules pushed from the server (schedule-aware).
    /// Persisted so curfews continue offline across reboots.
    #[serde(default)]
    pub internet_block_rules: Vec<StoredInternetBlockRule>,

    /// App blocking rules pushed from the server. Persisted so enforcement
    /// resumes across reboots before the server reconnects.
    #[serde(default)]
    pub app_block_rules: Vec<StoredBlockRule>,
}

/// Time window in agent-local time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredScheduleWindow {
    /// Sunday=0 .. Saturday=6
    pub day_of_week: u8,
    pub start_minute: u16,
    pub end_minute: u16,
}

/// Minimal representation of an internet block rule stored in config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredInternetBlockRule {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub schedules: Vec<StoredScheduleWindow>,
}

/// Minimal representation of an app block rule stored in config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBlockRule {
    pub id: i64,
    pub exe_pattern: String,
    pub match_mode: String,
    #[serde(default)]
    pub schedules: Vec<StoredScheduleWindow>,
}

fn default_agent_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "agent".into())
}

const fn default_auto_update_enabled() -> bool {
    false
}

const fn default_tray_icon_enabled() -> bool {
    true
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            agent_name: default_agent_name(),
            agent_token: String::new(),
            install_id: String::new(),
            ui_password_hash: String::new(),
            auto_update_enabled: default_auto_update_enabled(),
            tray_icon_enabled: default_tray_icon_enabled(),
            internet_blocked: false,
            internet_block_rules: Vec::new(),
            app_block_rules: Vec::new(),
        }
    }
}

/// Argon2 PHC string for a **new** local UI password set in the Tauri settings UI.
/// Matches the server’s `hash_dashboard_password` / `hash_agent_local_ui_password` defaults.
pub fn hash_ui_password_argon2(plain: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Optional app-specific entropy so unrelated DPAPI blobs are never mistaken for ours.
const CONFIG_DPAPI_ENTROPY: &[u8] = b"sentinel-agent-config\0";

/// `%ProgramData%\Sentinel` (Windows). Shared config, logs, update staging, markers.
#[cfg(windows)]
pub fn program_data_sentinel_dir() -> PathBuf {
    std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from)
        .join("Sentinel")
}

/// Verified MSI downloads before `msiexec` (Windows). Under `ProgramData` with everything else.
#[cfg(windows)]
pub fn updates_staging_dir() -> PathBuf {
    program_data_sentinel_dir().join("updates")
}

/// Machine-wide encrypted config (Windows). Alias for [`config_path`] on Windows.
#[cfg(windows)]
pub fn machine_config_path() -> PathBuf {
    program_data_sentinel_dir().join("config.dat")
}

/// Primary config file path.
///
/// - **Windows:** `%ProgramData%\Sentinel\config.dat` (machine DPAPI).
/// - **Other:** `%LOCALAPPDATA%/sentinel/config.dat` (user DPAPI).
pub fn config_path() -> PathBuf {
    #[cfg(windows)]
    {
        machine_config_path()
    }
    #[cfg(not(windows))]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("sentinel")
            .join("config.dat")
    }
}

fn parse_config_json(s: &str) -> Option<Config> {
    serde_json::from_str::<Config>(s).ok()
}

/// Try DPAPI-encrypted JSON (user scope — non-Windows `config.dat` only).
#[cfg(not(windows))]
fn try_load_dpapi_dat_user(bytes: &[u8]) -> Option<Config> {
    try_load_dpapi_dat_scoped(bytes, Scope::User)
}

#[cfg(windows)]
fn try_load_dpapi_dat_machine(bytes: &[u8]) -> Option<Config> {
    try_load_dpapi_dat_scoped(bytes, Scope::Machine)
}

fn try_load_dpapi_dat_scoped(bytes: &[u8], scope: Scope) -> Option<Config> {
    let dec = decrypt_data(bytes, scope, Some(CONFIG_DPAPI_ENTROPY)).ok()?;
    let s = String::from_utf8(dec).ok()?;
    parse_config_json(&s)
}

#[cfg(windows)]
fn try_load_machine_config_bytes(bytes: &[u8]) -> Option<Config> {
    if bytes.is_empty() {
        return None;
    }
    try_load_dpapi_dat_machine(bytes)
}

/// `true` when the machine-wide config file exists and decrypts successfully.
#[cfg(windows)]
pub fn machine_connection_policy_active() -> bool {
    let path = machine_config_path();
    std::fs::read(&path)
        .ok()
        .filter(|b| !b.is_empty())
        .and_then(|b| try_load_machine_config_bytes(&b))
        .is_some()
}

#[cfg(not(windows))]
pub fn machine_connection_policy_active() -> bool {
    false
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

/// Same as [`save_config`] on Windows (machine-wide `config.dat`). Kept for enrollment call sites.
#[cfg(windows)]
pub fn write_machine_policy_dat(config: &Config) -> anyhow::Result<()> {
    save_config(config)
}

/// Read plain JSON (UTF-8) and write machine-wide `config.dat` using DPAPI machine scope.
#[cfg(windows)]
pub fn import_machine_config_from_json_file(json_path: &Path) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(json_path)?;
    let config: Config = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("invalid JSON in {}: {e}", json_path.display()))?;
    save_config(&config)
}

#[cfg(not(windows))]
pub fn import_machine_config_from_json_file(_json_path: &Path) -> anyhow::Result<()> {
    anyhow::bail!("machine config import is only supported on Windows")
}

/// Load configuration from disk; falls back to `Config::default()` on any error.
pub fn load_config() -> Config {
    let mut cfg = Config::default();

    #[cfg(windows)]
    {
        let mpath = machine_config_path();
        if let Some(c) = std::fs::read(&mpath)
            .ok()
            .and_then(|bytes| try_load_machine_config_bytes(&bytes))
        {
            cfg = c;
        }
    }

    #[cfg(not(windows))]
    {
        let path = config_path();
        if let Ok(bytes) = std::fs::read(&path) {
            if !bytes.is_empty() {
                if let Some(c) = try_load_dpapi_dat_user(&bytes) {
                    cfg = c;
                }
            }
        }
    }

    if let Ok(v) = std::env::var("AGENT_SERVER_URL") {
        let v = v.trim();
        if !v.is_empty() {
            cfg.server_url = v.to_string();
        }
    }
    if let Ok(v) = std::env::var("AGENT_NAME") {
        let v = v.trim();
        if !v.is_empty() {
            cfg.agent_name = v.to_string();
        }
    }
    if let Ok(v) = std::env::var("AGENT_TOKEN").or_else(|_| std::env::var("AGENT_PASSWORD")) {
        let v = v.trim();
        if !v.is_empty() {
            cfg.agent_token = v.to_string();
        }
    }

    cfg
}

/// Persist configuration. **Windows:** `%ProgramData%\Sentinel\config.dat`, machine DPAPI.
/// **Other platforms:** per-user path, user DPAPI.
pub fn save_config(config: &Config) -> anyhow::Result<()> {
    let path = config_path();
    #[cfg(windows)]
    {
        persist_config(&path, config, Scope::Machine)?;
    }
    #[cfg(not(windows))]
    {
        persist_config(&path, config, Scope::User)?;
    }

    Ok(())
}

// ─── Settings UI reopen after MSI update (from "Download and install" in the webview) ─────

fn reopen_settings_ui_marker_path() -> PathBuf {
    #[cfg(windows)]
    {
        program_data_sentinel_dir().join("reopen_settings_ui.marker")
    }
    #[cfg(not(windows))]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("sentinel")
            .join("reopen_settings_ui.marker")
    }
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

// ─── Agent status ─────────────────────────────────────────────────────────────

/// Real-time connection status of the agent, shared between the background
/// tokio thread (writer) and the GUI thread (reader).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum AgentStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    /// A human-readable description of the last error.
    Error(String),
}
