//! On-demand agent update (`update_now`), installed through the Windows service.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

#[cfg(target_os = "windows")]
use crate::host::service_client::UpdateViaServiceOutcome;
use crate::permissions::Generation;

pub(super) fn update_now(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    #[cfg(target_os = "windows")]
    {
        let tx = out_tx;
        crate::permissions::spawn_for_command(generation, async move {
            match crate::host::service_client::update_via_service().await {
                Ok(UpdateViaServiceOutcome::InstallStarted) => {
                    let _ = tx
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "notify",
                                "level": "info",
                                "message": "Update downloaded; installing..."
                            })
                            .to_string(),
                        ))
                        .await;
                    crate::host::service_client::exit_for_update();
                }
                Ok(UpdateViaServiceOutcome::UpToDate) => {
                    let _ = tx
                        .send(Message::Text(
                            serde_json::json!({
                                "type": "notify",
                                "level": "info",
                                "message": "Already running the latest published version (no install needed)."
                            })
                            .to_string(),
                        ))
                        .await;
                }
                Err(e) => {
                    warn!("Update via service failed: {e:#}");
                }
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (generation, out_tx);
        warn!("update_now is not implemented for the Linux headless agent yet.");
    }
}
