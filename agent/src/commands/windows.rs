//! Windows parts of the command handlers: loopback audio, updates through the
//! service, and drive letters for the file browser.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::host::service_client::UpdateViaServiceOutcome;
use crate::outbound::replies::{DirEntry, Notify};
use crate::permissions::Generation;

/// Last-resort file browser landing directory.
pub(super) const FS_ROOT: &str = "C:\\";

/// "This PC": the present drive letters.
pub(super) async fn list_drives(items: &mut Vec<DirEntry>) {
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    // Bits 0..25 correspond to A..Z.
    for i in 0..26u32 {
        if (mask & (1u32 << i)) != 0 {
            let letter = (b'A' + (i as u8)) as char;
            let name = format!("{letter}:\\");
            items.push(DirEntry::drive(name));
        }
    }
}

pub(super) fn start_audio(
    command_generation: Generation,
    frame_tx: &mpsc::Sender<Vec<u8>>,
    audio_stop: &mut Option<Arc<AtomicBool>>,
) {
    // Replace any running audio capture so the viewer refcount stays correct.
    if let Some(stop) = audio_stop.take() {
        stop.store(true, Ordering::Relaxed);
    }
    let stop = Arc::new(AtomicBool::new(false));
    crate::capture::audio::start_audio_capture(frame_tx.clone(), stop.clone(), command_generation);
    *audio_stop = Some(stop);
    info!("Audio capture started.");
}

pub(super) fn update_now(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    let tx = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        match crate::host::service_client::update_via_service().await {
            Ok(UpdateViaServiceOutcome::InstallStarted) => {
                let notice = Notify {
                    level: "info",
                    message: "Update downloaded; installing...",
                };
                let _ = tx
                    .send(Message::Text(crate::outbound::to_text(&notice)))
                    .await;
                crate::host::service_client::exit_for_update();
            }
            Ok(UpdateViaServiceOutcome::UpToDate) => {
                let notice = Notify {
                    level: "info",
                    message: "Already running the latest published version (no install needed).",
                };
                let _ = tx
                    .send(Message::Text(crate::outbound::to_text(&notice)))
                    .await;
            }
            Err(e) => {
                warn!("Update via service failed: {e:#}");
            }
        }
    });
}
