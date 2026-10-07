//! Installed software inventory (`software_inventory` frames).
//!
//! Windows reads the Uninstall registry keys; Linux asks the package managers
//! (pacman / dpkg / rpm / flatpak). Both produce the same item shape.

use std::cmp::Ordering;

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::outbound::telemetry::SoftwareInventory;

#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

/// Send a fresh snapshot to the server in answer to `CollectSoftware`.
pub async fn send_inventory(
    out_tx: mpsc::Sender<Message>,
    generation: crate::permissions::Generation,
) {
    let Ok(lease) = crate::permissions::command_worker(
        generation,
        crate::permissions::Module::SoftwareInventory,
    ) else {
        return;
    };
    let items = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        if generation.valid_fresh() {
            imp::collect_items()
        } else {
            Vec::new()
        }
    })
    .await
    .unwrap_or_default();
    let n = items.len();
    if send_snapshot(&out_tx, &items, generation).await {
        info!("Sent software_inventory ({n} entries)");
    }
}

/// Collect and send a fresh snapshot only when it differs from the last sent fingerprint.
pub async fn send_inventory_if_changed(
    out_tx: mpsc::Sender<Message>,
    last_fingerprint: &tokio::sync::Mutex<Option<(u64, crate::permissions::Generation)>>,
) {
    if !crate::permissions::allowed(crate::permissions::Module::SoftwareInventory) {
        return;
    }
    let generation =
        crate::permissions::Generation::capture(crate::permissions::Module::SoftwareInventory);
    let lease = generation.map(crate::permissions::WorkerLease::new);
    let items = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        if generation.is_some_and(|g| g.valid()) {
            imp::collect_items()
        } else {
            Vec::new()
        }
    })
    .await
    .unwrap_or_default();
    let n = items.len();
    let fp = imp::fingerprint_items(&items);

    let mut g = last_fingerprint.lock().await;
    let Some(generation) = generation.filter(|g| g.valid()) else {
        return;
    };
    if g.as_ref() == Some(&(fp, generation)) {
        return;
    }
    *g = Some((fp, generation));
    drop(g);

    if send_snapshot(&out_tx, &items, generation).await {
        info!("Sent software_inventory ({n} entries; changed)");
    }
}

/// Send one `software_inventory` frame; `false` (after a warning) when the writer is gone.
async fn send_snapshot(
    out_tx: &mpsc::Sender<Message>,
    items: &[serde_json::Value],
    generation: crate::permissions::Generation,
) -> bool {
    let payload = crate::outbound::to_text(&SoftwareInventory {
        items,
        captured_at: crate::unix_timestamp_secs(),
    });
    let sent = out_tx
        .send(crate::permissions::tag_message(
            Message::Text(payload),
            Some(generation),
        ))
        .await
        .is_ok();
    if !sent {
        warn!("Failed to send software_inventory (writer closed)");
    }
    sent
}

/// ASCII-only case folding; avoids per-comparison `to_lowercase()` allocations (MSRV-safe).
pub fn cmp_str_ascii_case_insensitive(a: &str, b: &str) -> Ordering {
    let mut ab = a.bytes().map(|x| x.to_ascii_lowercase());
    let mut bb = b.bytes().map(|x| x.to_ascii_lowercase());
    loop {
        match (ab.next(), bb.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => {}
                o => return o,
            },
        }
    }
}
