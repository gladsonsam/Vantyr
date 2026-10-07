//! On-demand host inventory: fresh system info and the installed software list.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::info;

use crate::permissions::Generation;

pub(super) fn request_info(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    let payload = crate::inventory::system_info::collect_agent_info().to_string();
    let tx = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let _ = tx
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
    });
    info!("Received RequestInfo command; pushed fresh system info.");
}

pub(super) fn collect_software(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    let Some(command_generation) = generation else {
        return;
    };
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        crate::inventory::software::send_inventory(out, command_generation).await;
    });
    info!("CollectSoftware scheduled.");
}
