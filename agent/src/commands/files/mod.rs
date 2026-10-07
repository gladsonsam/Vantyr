//! Remote file browser commands: listing and mkdir/rename/delete/copy. Chunked
//! download and upload live in [`transfer`].

mod transfer;

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{DeletePath, FilePath, Mkdir, PathPair};
use super::send_reply;
use crate::outbound::replies::{DirEntry, DirList, FsOpResult};
use crate::permissions::Generation;

pub(in crate::commands) use transfer::{read_file, write_file_chunk};

/// `s` trimmed and cut to at most `max` characters.
fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// The error text of a finished file operation; `None` when it succeeded.
fn error_text(res: std::io::Result<()>) -> Option<String> {
    res.err().map(|e| e.to_string())
}

pub(super) fn mkdir(cmd: Mkdir, generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    const MAX_PATH_CHARS: usize = 2048;
    const MAX_NAME_CHARS: usize = 256;
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let base = clip(&cmd.path, MAX_PATH_CHARS);
    let name = clip(&cmd.name, MAX_NAME_CHARS);
    if base.is_empty() || name.is_empty() {
        return;
    }
    // Basic safety: avoid path traversal via separators in the folder name.
    if name.contains('\\') || name.contains('/') {
        return;
    }
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        // Join with the OS path separator (backslash on Windows, slash on
        // Linux). `name` is already guaranteed separator-free above.
        let full = std::path::Path::new(&base)
            .join(&name)
            .to_string_lossy()
            .to_string();
        let error = error_text(tokio::fs::create_dir_all(&full).await);
        let reply = FsOpResult::mkdir(&request_id, &full, error.as_deref());
        send_reply(&out, generation, &reply).await;
    });
}

pub(super) fn rename_path(
    cmd: PathPair,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_PATH_CHARS: usize = 2048;
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let src = clip(&cmd.src, MAX_PATH_CHARS);
    let dst = clip(&cmd.dst, MAX_PATH_CHARS);
    if src.is_empty() || dst.is_empty() {
        return;
    }
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        // Ensure parent dir exists for a move/rename.
        if let Some(parent) = std::path::Path::new(&dst).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let error = error_text(tokio::fs::rename(&src, &dst).await);
        let reply = FsOpResult::rename(&request_id, &src, &dst, error.as_deref());
        send_reply(&out, generation, &reply).await;
    });
}

pub(super) fn delete_path(
    cmd: DeletePath,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_PATH_CHARS: usize = 2048;
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let path = clip(&cmd.path, MAX_PATH_CHARS);
    if path.is_empty() {
        return;
    }
    let recursive = cmd.recursive.unwrap_or(false);
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let meta = tokio::fs::metadata(&path).await;
        let res = match meta {
            Ok(m) if m.is_dir() => {
                if recursive {
                    tokio::fs::remove_dir_all(&path).await
                } else {
                    tokio::fs::remove_dir(&path).await
                }
            }
            Ok(_) => tokio::fs::remove_file(&path).await,
            Err(e) => Err(e),
        };
        let error = error_text(res);
        let reply = FsOpResult::delete(&request_id, &path, recursive, error.as_deref());
        send_reply(&out, generation, &reply).await;
    });
}

pub(super) fn copy_path(
    cmd: PathPair,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_PATH_CHARS: usize = 2048;
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let src = clip(&cmd.src, MAX_PATH_CHARS);
    let dst = clip(&cmd.dst, MAX_PATH_CHARS);
    if src.is_empty() || dst.is_empty() {
        return;
    }
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        // Only support file copy for now (directories require recursive copy).
        let meta = tokio::fs::metadata(&src).await;
        let res = match meta {
            Ok(m) if m.is_dir() => Err(std::io::Error::other(
                "CopyPath for directories is not supported",
            )),
            Ok(_) => {
                if let Some(parent) = std::path::Path::new(&dst).parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                tokio::fs::copy(&src, &dst).await.map(|_| ())
            }
            Err(e) => Err(e),
        };
        let error = error_text(res);
        let reply = FsOpResult::copy(&request_id, &src, &dst, error.as_deref());
        send_reply(&out, generation, &reply).await;
    });
}

pub(super) fn list_dir(
    cmd: FilePath,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_DIR_PATH_CHARS: usize = 1024;
    const MAX_DIR_ENTRIES: usize = 5_000;
    const DRIVES_VANTYR_PATH: &str = "__this_pc__";
    fn default_dir_path() -> String {
        // Prefer a real "Documents" folder (XDG on Linux, Known Folder on
        // Windows); fall back to the home dir, then the filesystem root.
        if let Some(p) = dirs::document_dir() {
            return p.to_string_lossy().to_string();
        }
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
        super::imp::FS_ROOT.to_string()
    }

    let path_in = cmd.path.trim();
    // Empty path => initial landing (Documents). Special vantyr => list drives.
    let is_drives = path_in.eq_ignore_ascii_case(DRIVES_VANTYR_PATH);
    let path = if is_drives {
        DRIVES_VANTYR_PATH.to_string()
    } else if path_in.is_empty() {
        default_dir_path()
    } else {
        path_in.chars().take(MAX_DIR_PATH_CHARS).collect::<String>()
    };
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let mut items: Vec<DirEntry> = Vec::new();
        if is_drives {
            super::imp::list_drives(&mut items).await;
        } else if let Ok(mut entries) = tokio::fs::read_dir(&path).await {
            let mut n = 0usize;
            while let Ok(Some(entry)) = entries.next_entry().await {
                n += 1;
                if n > MAX_DIR_ENTRIES {
                    break;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().await.ok();
                let is_dir = meta.as_ref().is_some_and(std::fs::Metadata::is_dir);
                let size = meta.as_ref().map_or(0, std::fs::Metadata::len);
                items.push(DirEntry { name, is_dir, size });
            }
        }
        items.sort_by(|a, b| {
            if a.is_dir == b.is_dir {
                crate::inventory::software::cmp_str_ascii_case_insensitive(&a.name, &b.name)
            } else {
                b.is_dir.cmp(&a.is_dir)
            }
        });
        let reply = DirList {
            path: &path,
            items: &items,
        };
        send_reply(&out, generation, &reply).await;
    });
}
