//! Settings: config read/save, connection status, module permissions.

use std::sync::atomic::{AtomicI64, Ordering};

use tauri::{AppHandle, State};
use tracing::info;

use super::auth::{hash_ui_password_argon2, LAST_UI_AUTH_OK_AT};
use crate::config::{AgentStatus, Config};
use crate::host::ui::tray::ensure_tray_matches_config;
use crate::host::ui::{SharedConfigTx, SharedStatus, StoredConfig};

#[derive(serde::Serialize)]
pub struct StatusResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
/// Extended save payload: normal Config fields + an optional new plaintext password.
#[derive(serde::Deserialize)]
pub struct SaveConfigPayload {
    pub server_url: String,
    pub agent_name: String,
    pub agent_token: String,
    #[serde(default)]
    pub install_id: String,
    pub ui_password_hash: String,
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    #[serde(default = "default_tray_icon_enabled")]
    pub tray_icon_enabled: bool,
    /// Present only when the user is changing the UI password.
    pub new_password: Option<String>,
}
const fn default_auto_update_enabled() -> bool {
    false
}
const fn default_tray_icon_enabled() -> bool {
    true
}
#[tauri::command]
pub fn get_config(stored: State<StoredConfig>) -> Config {
    stored.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
#[tauri::command]
pub fn save_config(
    config: SaveConfigPayload,
    stored: State<StoredConfig>,
    config_tx: State<SharedConfigTx>,
    app: AppHandle,
) -> Result<(), String> {
    // Lock once to avoid deadlocks (multiple lock() calls in one expression can re-lock).
    let (
        preserve_internet_blocked,
        preserve_internet_block_rules,
        preserve_app_block_rules,
        preserve_screen_history_enabled,
        preserve_recall_settings,
        preserve_server_ui_password_hash,
    ) = {
        let cur = stored.0.lock().unwrap_or_else(|e| e.into_inner());
        (
            cur.internet_blocked,
            cur.internet_block_rules.clone(),
            cur.app_block_rules.clone(),
            cur.screen_history_enabled,
            cur.recall_settings,
            cur.server_ui_password_hash.clone(),
        )
    };

    let ui_hash = if let Some(ref pw) = config.new_password {
        if pw.is_empty() {
            // Empty new_password → remove password (clear hash)
            String::new()
        } else {
            hash_ui_password_argon2(pw)?
        }
    } else {
        config.ui_password_hash.clone()
    };

    let new_cfg = Config {
        server_url: config.server_url.trim().to_string(),
        agent_name: config.agent_name.trim().to_string(),
        agent_token: config.agent_token,
        install_id: config.install_id,
        ui_password_hash: ui_hash,
        // Provenance of the server-pushed password, not something the settings UI
        // sets. Keeping it means a password set here reads as locally-owned and is
        // no longer wiped by the empty policy the server pushes on every connect.
        server_ui_password_hash: preserve_server_ui_password_hash,
        auto_update_enabled: config.auto_update_enabled,
        tray_icon_enabled: config.tray_icon_enabled,
        // Preserve the server-managed internet block state; the settings UI does not touch it.
        internet_blocked: preserve_internet_blocked,
        // Preserve internet block rules; managed remotely.
        internet_block_rules: preserve_internet_block_rules,
        // Preserve app block rules; managed remotely.
        app_block_rules: preserve_app_block_rules,
        // Preserve screen-history toggle and capture tunables; managed remotely.
        screen_history_enabled: preserve_screen_history_enabled,
        recall_settings: preserve_recall_settings,
    };

    crate::config::save_config_from_user_session(&new_cfg).map_err(|e| e.to_string())?;

    // Hot-reload: wake the agent loop with the new config.
    let _ = config_tx.0.send(Some(new_cfg.clone()));
    tauri::async_runtime::spawn(async {
        crate::host::ipc::notify_config_changed_best_effort().await;
    });

    // Update the in-memory copy so subsequent get_config() reads are fresh.
    *stored.0.lock().unwrap_or_else(|e| e.into_inner()) = new_cfg;

    // Apply tray visibility preference immediately.
    ensure_tray_matches_config(&app);

    info!("Config saved and hot-reloaded.");
    Ok(())
}
#[tauri::command]
pub fn get_module_permissions() -> Result<serde_json::Value, String> {
    crate::permissions::load()
        .map(|s| s.wire())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn set_module_permission(
    module: crate::permissions::Module,
    enabled: bool,
    stored: State<StoredConfig>,
) -> Result<serde_json::Value, String> {
    let has_pw = !stored
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ui_password_hash
        .is_empty();
    if has_pw {
        let last = LAST_UI_AUTH_OK_AT
            .get_or_init(|| AtomicI64::new(0))
            .load(Ordering::Relaxed);
        if last <= 0 || (crate::unix_timestamp_secs() as i64 - last).abs() > 60 {
            return Err("Unlock settings again to change module permissions".into());
        }
    }
    crate::permissions::local_set(module, enabled)
        .map(|s| s.wire())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_status(status: State<SharedStatus>) -> StatusResponse {
    let s = status.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match s {
        AgentStatus::Connected => StatusResponse {
            status: "Connected".into(),
            message: None,
        },
        AgentStatus::Connecting => StatusResponse {
            status: "Connecting".into(),
            message: None,
        },
        AgentStatus::Disconnected => StatusResponse {
            status: "Disconnected".into(),
            message: None,
        },
        AgentStatus::Error(msg) => StatusResponse {
            status: "Error".into(),
            message: Some(msg),
        },
    }
}
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
