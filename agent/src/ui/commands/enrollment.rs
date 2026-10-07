//! Pairing: mDNS server discovery and enrollment-code adoption.

use tauri::State;
use tracing::info;

use crate::ui::{SharedConfigTx, StoredConfig};

/// Quick pairing: request approval, then receive a per-device token.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptEnrollmentPayload {
    pub server_url: String,
    pub enrollment_code: String,
    #[serde(default)]
    pub agent_name: Option<String>,
}
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverMdnsOpts {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}
#[tauri::command]
pub fn discover_vantyr_mdns_servers(
    opts: DiscoverMdnsOpts,
) -> Vec<crate::mdns_discover::DiscoveredServer> {
    crate::mdns_discover::discover_vantyr_servers(opts.timeout_ms.unwrap_or(3500))
}
#[tauri::command]
pub async fn adopt_with_enrollment_code(
    payload: AdoptEnrollmentPayload,
    stored: State<'_, StoredConfig>,
    config_tx: State<'_, SharedConfigTx>,
) -> Result<(), String> {
    let name = payload
        .agent_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_| "agent".into()));
    let cfg = crate::enrollment::adopt_with_enrollment(
        payload.server_url.trim(),
        payload.enrollment_code.trim(),
        &name,
    )
    .await
    .map_err(|e| e.to_string())?;
    *stored.0.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    let watch = if cfg.server_url.is_empty() {
        None
    } else {
        Some(cfg)
    };
    let _ = config_tx.0.send(watch);
    crate::ipc::notify_config_changed_best_effort().await;
    info!("Adopted via pairing code; config hot-reloaded.");
    Ok(())
}
