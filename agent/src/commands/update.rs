//! On-demand agent update (`update_now`), installed through the Windows service.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::permissions::Generation;

pub(super) fn update_now(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    super::imp::update_now(generation, out_tx);
}
