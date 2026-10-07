//! Persistent configuration and shared runtime state for the agent.
//!
//! ## Windows — machine-wide (`%ProgramData%\\Vantyr\\config.dat`)
//!
//! The agent is built for **machine-wide deployment**: one encrypted file for the whole PC,
//! DPAPI **machine** scope (any local user session on this box can decrypt it; other PCs
//! cannot). Connection settings, local UI password hash, and auto-update preference are all
//! stored here. The Windows agent does **not** read or write under `%LOCALAPPDATA%`.
//!
//! Imaging / MDM: run `vantyr-agent --import-machine-config deploy.json` elevated, or use
//! the settings UI (requires write access to `%ProgramData%\\Vantyr`, per your MSI ACLs).
//!
//! ## Linux and other Unix-like platforms
//!
//! Uses `$XDG_CONFIG_HOME/vantyr/config.json` (usually
//! `~/.config/vantyr/config.json`) with `0600` file permissions. This store is
//! intentionally explicit JSON until Linux Secret Service support lands.
//!
//! ## Pairing (`enroll.json`)
//!
//! Place `%ProgramData%\\Vantyr\\enroll.json` (plaintext JSON) with the **6-digit pairing
//! code** from the dashboard. On startup the agent creates a pending claim, polls for approval,
//! receives a **per-device** WebSocket token, writes `config.dat`, and deletes `enroll.json`.
//!
//! [`CryptProtectData`]: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// The store (path, encryption, permissions) is the only part that differs per OS.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as store;
#[cfg(windows)]
use self::windows as store;

pub use store::{config_path, machine_connection_policy_active};
#[cfg(windows)]
pub use store::{
    machine_config_path, program_data_vantyr_dir, request_reopen_settings_ui_after_restart,
    take_reopen_settings_ui_after_restart, updates_staging_dir,
};

// ─── Configuration ────────────────────────────────────────────────────────────

/// Agent connection + security configuration, persisted to disk as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Full WebSocket URL of the Vantyr server.
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

    /// Locally managed Argon2 PHC string guarding settings and module grants.
    /// Empty means no lock. Remote password policy commands are denied.
    #[serde(default)]
    pub ui_password_hash: String,

    /// Legacy remote-password provenance, retained only for config compatibility.
    /// No remote command applies this value to local authentication.
    #[serde(default)]
    pub server_ui_password_hash: String,

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
    /// The agent's own connection to the Vantyr server is always permitted.
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

    /// When true, the strategic screen-history ("Recall") capture pipeline runs:
    /// periodic deduped keyframes + on-device OCR streamed to the server for
    /// timeline replay. **On by default** (named serde default so existing
    /// configs written before this field also enable it). A later phase adds a
    /// server-pushed per-agent disable.
    #[serde(default = "default_screen_history_enabled")]
    pub screen_history_enabled: bool,

    /// Capture tunables pushed by the server (`set_recall_settings`). Cached here so
    /// a cadence change or the operator kill switch survives restarts and keeps
    /// applying while the agent is offline. `None` = never pushed; use built-in
    /// defaults.
    #[serde(default)]
    pub recall_settings: Option<crate::capture::history::HistorySettings>,
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
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "agent".into())
}

const fn default_auto_update_enabled() -> bool {
    false
}

const fn default_tray_icon_enabled() -> bool {
    true
}

const fn default_screen_history_enabled() -> bool {
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
            server_ui_password_hash: String::new(),
            auto_update_enabled: default_auto_update_enabled(),
            tray_icon_enabled: default_tray_icon_enabled(),
            internet_blocked: false,
            internet_block_rules: Vec::new(),
            app_block_rules: Vec::new(),
            screen_history_enabled: default_screen_history_enabled(),
            recall_settings: None,
        }
    }
}

/// Durable spool for screen-history ("Recall") keyframes awaiting server ack.
///
/// Lives beside the rest of the machine-wide state so keyframes captured while
/// the agent is disconnected survive both reconnects and agent restarts. On
/// non-Windows builds (dev/test) it falls back to the local data dir.
pub fn screen_spool_dir() -> PathBuf {
    store::state_dir().join("recall-spool")
}

fn parse_config_json(s: &str) -> Option<Config> {
    serde_json::from_str::<Config>(s).ok()
}

/// Read plain JSON (UTF-8) and persist it as the config. **Windows:** machine-wide
/// `config.dat` using DPAPI machine scope; **Linux:** the per-user XDG config JSON.
pub fn import_machine_config_from_json_file(json_path: &Path) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(json_path)?;
    let config: Config = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("invalid JSON in {}: {e}", json_path.display()))?;
    save_config(&config)
}

/// Where [`import_machine_config_from_json_file`] wrote the config, e.g.
/// `user config to /home/me/.config/vantyr/config.json`.
pub fn imported_location() -> String {
    store::imported_location()
}

/// Load configuration from disk; falls back to `Config::default()` on any error.
pub fn load_config() -> Config {
    let mut cfg = store::load_stored().unwrap_or_default();

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

/// Persist configuration. **Windows:** `%ProgramData%\Vantyr\config.dat`, machine DPAPI.
/// **Other platforms:** per-user XDG config JSON with restrictive permissions.
pub fn save_config(config: &Config) -> anyhow::Result<()> {
    store::save(config)
}

/// Persist config from the (possibly unprivileged) user-session agent process.
///
/// On Windows the machine-wide `config.dat` lives under `%ProgramData%\Vantyr`, which is
/// writable only by SYSTEM/admins under the default MSI ACLs. The user-session companion
/// (which handles server-pushed settings and enrollment) therefore cannot write it directly
/// and would log `Access is denied (os error 5)` on every settings push.
///
/// We try a direct write first — it succeeds when the caller is the SYSTEM service, is
/// elevated, or the deployment's ACLs grant the user write access — and only on failure
/// delegate the write to the Session 0 service over IPC. On non-Windows platforms the
/// per-user config is always directly writable, so this is just [`save_config`].
pub fn save_config_from_user_session(config: &Config) -> anyhow::Result<()> {
    match save_config(config) {
        Ok(()) => Ok(()),
        Err(direct_err) => store::save_via_service(config, direct_err),
    }
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

#[cfg(test)]
mod tests {
    use super::Config;
    #[test]
    fn legacy_server_password_metadata_remains_readable() {
        // Kept only for config compatibility; no remote setter consumes it.
        let cfg: Config = serde_json::from_str(
            r#"{"ui_password_hash":"local", "server_ui_password_hash":"legacy"}"#,
        )
        .unwrap();
        assert_eq!(cfg.ui_password_hash, "local");
        assert_eq!(cfg.server_ui_password_hash, "legacy");
    }
}
