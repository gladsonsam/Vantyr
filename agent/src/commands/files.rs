//! Remote file browser commands: listing, chunked download/upload, and
//! mkdir/rename/delete/copy.

use std::sync::Mutex;

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{DeletePath, FilePath, Mkdir, PathPair, WriteFileChunk};
use crate::permissions::Generation;

/// An in-flight chunked upload from the dashboard (`WriteFileChunk`).
struct FileUploadSession {
    next_expected_chunk: usize,
    total_chunks: usize,
    bytes_written: u64,
    generation: Option<crate::permissions::Generation>,
}

/// In-flight uploads keyed by destination path, so concurrent uploads to different files don't
/// truncate or interleave into each other's session state.
static FILE_UPLOAD_SESSIONS: Mutex<Option<std::collections::HashMap<String, FileUploadSession>>> =
    Mutex::new(None);

/// Raw bytes per `ReadFile` read and per dashboard `WriteFileChunk` payload (before base64).
/// Keep in sync with `REMOTE_FILE_CHUNK_BYTES` in `../../frontend/src/components/tabs/FilesTab.tsx`.
const REMOTE_FILE_CHUNK_BYTES: usize = 3 * 1024 * 1024;

pub(super) fn mkdir(cmd: Mkdir, generation: Option<Generation>, out_tx: mpsc::Sender<Message>) {
    const MAX_PATH_CHARS: usize = 2048;
    const MAX_NAME_CHARS: usize = 256;
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let base = cmd
        .path
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
    let name = cmd
        .name
        .trim()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect::<String>();
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
        let res = tokio::fs::create_dir_all(&full).await;
        let (ok, error) = match res {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let payload = serde_json::json!({
            "type": "fs_op_result",
            "request_id": request_id,
            "op": "mkdir",
            "ok": ok,
            "path": full,
            "error": error,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
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
    let src = cmd
        .src
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
    let dst = cmd
        .dst
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
    if src.is_empty() || dst.is_empty() {
        return;
    }
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        // Ensure parent dir exists for a move/rename.
        if let Some(parent) = std::path::Path::new(&dst).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let res = tokio::fs::rename(&src, &dst).await;
        let (ok, error) = match res {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let payload = serde_json::json!({
            "type": "fs_op_result",
            "request_id": request_id,
            "op": "rename",
            "ok": ok,
            "src": src,
            "dst": dst,
            "error": error,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
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
    let path = cmd
        .path
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
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
        let (ok, error) = match res {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let payload = serde_json::json!({
            "type": "fs_op_result",
            "request_id": request_id,
            "op": "delete",
            "ok": ok,
            "path": path,
            "recursive": recursive,
            "error": error,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
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
    let src = cmd
        .src
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
    let dst = cmd
        .dst
        .trim()
        .chars()
        .take(MAX_PATH_CHARS)
        .collect::<String>();
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
        let (ok, error) = match res {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e.to_string())),
        };
        let payload = serde_json::json!({
            "type": "fs_op_result",
            "request_id": request_id,
            "op": "copy",
            "ok": ok,
            "src": src,
            "dst": dst,
            "error": error,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
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
        let mut items = Vec::new();
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
                items.push(serde_json::json!({
                    "name": name,
                    "is_dir": is_dir,
                    "size": size
                }));
            }
        }
        items.sort_by(|a, b| {
            let a_dir = a["is_dir"].as_bool().unwrap_or(false);
            let b_dir = b["is_dir"].as_bool().unwrap_or(false);
            if a_dir == b_dir {
                let na = a["name"].as_str().unwrap_or("");
                let nb = b["name"].as_str().unwrap_or("");
                crate::inventory::software::cmp_str_ascii_case_insensitive(na, nb)
            } else {
                b_dir.cmp(&a_dir)
            }
        });
        let payload = serde_json::json!({
            "type": "dir_list",
            "path": path,
            "items": items
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
    });
}

pub(super) fn read_file(
    cmd: FilePath,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_FILE_PATH_CHARS: usize = 2048;
    let path = cmd
        .path
        .trim()
        .chars()
        .take(MAX_FILE_PATH_CHARS)
        .collect::<String>();
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        use base64::{engine::general_purpose, Engine as _};
        use tokio::io::AsyncReadExt;

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(e) => {
                let payload = serde_json::json!({
                    "type": "file_chunk",
                    "path": path,
                    "data": e.to_string(),
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "is_error": true
                })
                .to_string();
                let _ = out
                    .send(crate::permissions::tag_message(
                        Message::Text(payload),
                        generation,
                    ))
                    .await;
                return;
            }
        };
        let file_len = meta.len();

        let mut f = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                let payload = serde_json::json!({
                    "type": "file_chunk",
                    "path": path,
                    "data": e.to_string(),
                    "chunk_index": 0,
                    "total_chunks": 1,
                    "is_error": true
                })
                .to_string();
                let _ = out
                    .send(crate::permissions::tag_message(
                        Message::Text(payload),
                        generation,
                    ))
                    .await;
                return;
            }
        };

        let total_chunks = if file_len == 0 {
            1usize
        } else {
            (file_len as usize).div_ceil(REMOTE_FILE_CHUNK_BYTES)
        };

        if file_len == 0 {
            let payload = serde_json::json!({
                "type": "file_chunk",
                "path": path,
                "data": "",
                "chunk_index": 0,
                "total_chunks": 1,
                "is_error": false
            })
            .to_string();
            let _ = out
                .send(crate::permissions::tag_message(
                    Message::Text(payload),
                    generation,
                ))
                .await;
            return;
        }

        let mut idx: usize = 0;
        let mut buf = vec![0u8; REMOTE_FILE_CHUNK_BYTES];
        loop {
            let n = match f.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    let payload = serde_json::json!({
                        "type": "file_chunk",
                        "path": path,
                        "data": e.to_string(),
                        "chunk_index": idx,
                        "total_chunks": total_chunks,
                        "is_error": true
                    })
                    .to_string();
                    let _ = out
                        .send(crate::permissions::tag_message(
                            Message::Text(payload),
                            generation,
                        ))
                        .await;
                    return;
                }
            };
            let data = general_purpose::STANDARD.encode(&buf[..n]);
            let payload = serde_json::json!({
                "type": "file_chunk",
                "path": path,
                "data": data,
                "chunk_index": idx,
                "total_chunks": total_chunks,
                "is_error": false
            })
            .to_string();
            let _ = out
                .send(crate::permissions::tag_message(
                    Message::Text(payload),
                    generation,
                ))
                .await;
            idx += 1;
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    });
}

pub(super) fn write_file_chunk(
    cmd: WriteFileChunk,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_FILE_PATH_CHARS: usize = 2048;
    use base64::{engine::general_purpose, Engine as _};
    use std::io::Write;

    let path: String = cmd.path.trim().chars().take(MAX_FILE_PATH_CHARS).collect();
    let total_chunks = cmd.total_chunks.unwrap_or(0) as usize;
    let chunk_index = cmd.chunk_index.unwrap_or(0) as usize;
    let data_b64 = cmd.data.as_str();

    let push_result = |path_s: String, ok: bool, err: String, out: mpsc::Sender<Message>| {
        let payload = serde_json::json!({
            "type": "file_upload_result",
            "path": path_s,
            "ok": ok,
            "error": err,
        })
        .to_string();
        crate::permissions::spawn_for_command(generation, async move {
            let _ = out
                .send(crate::permissions::tag_message(
                    Message::Text(payload),
                    generation,
                ))
                .await;
        });
    };

    if path.is_empty() || total_chunks == 0 || chunk_index >= total_chunks {
        push_result(path, false, "invalid upload parameters".to_string(), out_tx);
        return;
    }

    let decoded = match general_purpose::STANDARD.decode(data_b64) {
        Ok(b) => b,
        Err(e) => {
            let mut g = FILE_UPLOAD_SESSIONS
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(map) = g.as_mut() {
                map.remove(&path);
            }
            push_result(path, false, format!("base64 decode: {e}"), out_tx);
            return;
        }
    };

    let mut g = FILE_UPLOAD_SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    if chunk_index == 0 {
        map.insert(
            path.clone(),
            FileUploadSession {
                next_expected_chunk: 0,
                total_chunks,
                bytes_written: 0,
                generation,
            },
        );
    }
    // Validate this chunk against the open session for *this path* only.
    let prior_bytes = match map.get(&path) {
        Some(s)
            if s.next_expected_chunk == chunk_index
                && s.total_chunks == total_chunks
                && s.generation == generation =>
        {
            s.bytes_written
        }
        Some(_) => {
            map.remove(&path);
            drop(g);
            push_result(
                path,
                false,
                "upload chunk out of sequence or total mismatch".to_string(),
                out_tx,
            );
            return;
        }
        _ => {
            drop(g);
            push_result(
                path,
                false,
                "missing upload session; send chunk 0 first".to_string(),
                out_tx,
            );
            return;
        }
    };

    let new_total = prior_bytes.saturating_add(decoded.len() as u64);

    // Disk write + fsync are blocking; hand other tasks to the second worker so telemetry
    // isn't stalled. Kept synchronous (not spawn_blocking) to preserve chunk ordering.
    let write_res = tokio::task::block_in_place(|| {
        if !generation.is_some_and(|g| g.valid_fresh()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "stale file generation",
            ));
        }
        if chunk_index == 0 {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)?;
            f.write_all(&decoded)?;
            f.sync_all()?;
        } else {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path)?;
            f.write_all(&decoded)?;
            f.sync_all()?;
        }
        Ok::<(), std::io::Error>(())
    });

    if let Err(e) = write_res {
        map.remove(&path);
        drop(g);
        push_result(path, false, e.to_string(), out_tx);
        return;
    }

    let done = chunk_index + 1 == total_chunks;
    if done {
        map.remove(&path);
    } else if let Some(s) = map.get_mut(&path) {
        s.bytes_written = new_total;
        s.next_expected_chunk = chunk_index + 1;
    }
    drop(g);

    if done {
        push_result(path, true, String::new(), out_tx);
    }
}
