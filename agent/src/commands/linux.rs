//! Linux parts of the command handlers: mount points for the file browser;
//! audio streaming and updates are not available.

use std::sync::{atomic::AtomicBool, Arc};

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::permissions::Generation;

/// Last-resort file browser landing directory.
pub(super) const FS_ROOT: &str = "/";

/// "This PC" on Linux: the filesystem root plus user-relevant
/// mount points (home + removable/extra disks) from /proc/mounts.
/// Pseudo/virtual filesystems are skipped.
pub(super) async fn list_drives(items: &mut Vec<serde_json::Value>) {
    items.push(serde_json::json!({ "name": "/", "is_dir": true, "size": 0 }));
    if let Ok(mounts) = tokio::fs::read_to_string("/proc/mounts").await {
        const SKIP_FS: &[&str] = &[
            "proc",
            "sysfs",
            "devtmpfs",
            "tmpfs",
            "cgroup",
            "cgroup2",
            "devpts",
            "mqueue",
            "debugfs",
            "tracefs",
            "securityfs",
            "pstore",
            "bpf",
            "configfs",
            "fusectl",
            "hugetlbfs",
            "autofs",
            "binfmt_misc",
            "ramfs",
            "efivarfs",
        ];
        let mut seen = std::collections::HashSet::new();
        for line in mounts.lines() {
            let mut f = line.split_whitespace();
            let _dev = f.next();
            let Some(mount_point) = f.next() else {
                continue;
            };
            let fstype = f.next().unwrap_or("");
            if mount_point == "/" || SKIP_FS.contains(&fstype) {
                continue;
            }
            let interesting = mount_point.starts_with("/mnt")
                || mount_point.starts_with("/media")
                || mount_point.starts_with("/run/media")
                || mount_point.starts_with("/home");
            if !interesting {
                continue;
            }
            if seen.insert(mount_point.to_string()) {
                items.push(serde_json::json!({
                    "name": mount_point,
                    "is_dir": true,
                    "size": 0
                }));
            }
        }
    }
}

pub(super) fn start_audio(
    command_generation: Generation,
    frame_tx: &mpsc::Sender<Vec<u8>>,
    audio_stop: &mut Option<Arc<AtomicBool>>,
) {
    let _ = (audio_stop, command_generation, frame_tx);
    warn!("start_audio is only supported on Windows.");
}

pub(super) fn update_now(generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    let _ = (generation, out_tx);
    warn!("update_now is not implemented for the Linux headless agent yet.");
}
