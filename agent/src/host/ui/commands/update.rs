//! Manual update check/apply from the settings UI.

#[derive(serde::Serialize)]
pub struct ManualUpdateCheckResponse {
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_version: Option<String>,
    pub running_version: String,
}
#[derive(serde::Serialize)]
pub struct ManualApplyUpdateResponse {
    pub outcome: String,
}
#[tauri::command]
pub async fn check_manual_update() -> Result<ManualUpdateCheckResponse, String> {
    let r = crate::updater::check_manual_update_available()
        .await
        .map_err(|e| format!("{e:#}"))?;
    Ok(ManualUpdateCheckResponse {
        update_available: r.update_available,
        published_version: r.published_version,
        running_version: r.running_version,
    })
}
#[tauri::command]
pub async fn apply_manual_update() -> Result<ManualApplyUpdateResponse, String> {
    use crate::host::service_client::{
        exit_for_update, update_via_service, UpdateViaServiceOutcome,
    };
    use std::time::Duration;
    match update_via_service().await {
        Ok(UpdateViaServiceOutcome::UpToDate) => Ok(ManualApplyUpdateResponse {
            outcome: "up_to_date".into(),
        }),
        Ok(UpdateViaServiceOutcome::InstallStarted) => {
            crate::config::request_reopen_settings_ui_after_restart();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                exit_for_update();
            });
            Ok(ManualApplyUpdateResponse {
                outcome: "install_started".into(),
            })
        }
        Err(e) => Err(format!("{e:#}")),
    }
}
