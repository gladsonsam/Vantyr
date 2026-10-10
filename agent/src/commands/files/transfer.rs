//! Chunked file transfer: `ReadFile` downloads and `WriteFileChunk` uploads.

use std::sync::Mutex;

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::clip;
use crate::commands::protocol::{FilePath, WriteFileChunk};
use crate::commands::send_reply;
use crate::outbound::replies::{FileChunk, FileUploadResult};
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

/// Send one `file_chunk` of a download: `Ok` is the base64 slice, `Err` the message
/// that ended the download.
async fn send_chunk(
    out: &mpsc::Sender<Message>,
    generation: Option<Generation>,
    path: &str,
    chunk_index: usize,
    total_chunks: usize,
    body: Result<&str, &str>,
) {
    let (data, is_error) = match body {
        Ok(data) => (data, false),
        Err(message) => (message, true),
    };
    let reply = FileChunk {
        path,
        data,
        chunk_index,
        total_chunks,
        is_error,
    };
    send_reply(out, generation, &reply).await;
}

pub(in crate::commands) fn read_file(
    cmd: FilePath,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_FILE_PATH_CHARS: usize = 2048;
    let path = clip(&cmd.path, MAX_FILE_PATH_CHARS);
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        use base64::{engine::general_purpose, Engine as _};
        use tokio::io::AsyncReadExt;

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(e) => {
                send_chunk(&out, generation, &path, 0, 1, Err(&e.to_string())).await;
                return;
            }
        };
        let file_len = meta.len();

        let mut f = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                send_chunk(&out, generation, &path, 0, 1, Err(&e.to_string())).await;
                return;
            }
        };

        let total_chunks = if file_len == 0 {
            1usize
        } else {
            (file_len as usize).div_ceil(REMOTE_FILE_CHUNK_BYTES)
        };

        if file_len == 0 {
            send_chunk(&out, generation, &path, 0, 1, Ok("")).await;
            return;
        }

        let mut idx: usize = 0;
        let mut buf = vec![0u8; REMOTE_FILE_CHUNK_BYTES];
        loop {
            let n = match f.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    send_chunk(
                        &out,
                        generation,
                        &path,
                        idx,
                        total_chunks,
                        Err(&e.to_string()),
                    )
                    .await;
                    return;
                }
            };
            let data = general_purpose::STANDARD.encode(&buf[..n]);
            send_chunk(&out, generation, &path, idx, total_chunks, Ok(&data)).await;
            idx += 1;
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    });
}

pub(in crate::commands) fn write_file_chunk(
    cmd: WriteFileChunk,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_FILE_PATH_CHARS: usize = 2048;
    use base64::{engine::general_purpose, Engine as _};
    use std::io::Write;

    let path = clip(&cmd.path, MAX_FILE_PATH_CHARS);
    let total_chunks = cmd.total_chunks.unwrap_or(0) as usize;
    let chunk_index = cmd.chunk_index.unwrap_or(0) as usize;
    let data_b64 = cmd.data.as_str();

    let push_result = |path_s: String, ok: bool, err: String, out: mpsc::Sender<Message>| {
        crate::permissions::spawn_for_command(generation, async move {
            let reply = FileUploadResult {
                path: &path_s,
                ok,
                error: &err,
            };
            send_reply(&out, generation, &reply).await;
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
