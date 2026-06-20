//! Server-originated control commands from the dashboard (JSON `"type`" field).

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use crate::platform::input_control::InputController;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::Config;

#[cfg(target_os = "windows")]
use crate::updater_client::UpdateViaServiceOutcome;

/// An in-flight chunked upload from the dashboard (`WriteFileChunk`).
struct FileUploadSession {
    next_expected_chunk: usize,
    total_chunks: usize,
    bytes_written: u64,
}

/// In-flight uploads keyed by destination path, so concurrent uploads to different files don't
/// truncate or interleave into each other's session state.
static FILE_UPLOAD_SESSIONS: Mutex<Option<std::collections::HashMap<String, FileUploadSession>>> =
    Mutex::new(None);

/// Raw bytes per `ReadFile` read and per dashboard `WriteFileChunk` payload (before base64).
/// Keep in sync with `REMOTE_FILE_CHUNK_BYTES` in `../../frontend/src/components/tabs/FilesTab.tsx`.
const REMOTE_FILE_CHUNK_BYTES: usize = 3 * 1024 * 1024;

pub struct ServerCommandArgs<'a> {
    pub(crate) text: &'a str,
    pub(crate) frame_tx: &'a mpsc::Sender<Vec<u8>>,
    pub(crate) capture_stop: &'a mut Option<Arc<AtomicBool>>,
    pub(crate) controller: &'a mut InputController,
    pub(crate) shared_cfg: &'a Arc<Mutex<Config>>,
    pub(crate) config_tx: &'a tokio::sync::watch::Sender<Option<Config>>,
    pub(crate) out_tx: mpsc::Sender<Message>,
    pub(crate) shared_rules: &'a crate::app_block::SharedRules,
}

pub fn handle_server_command(args: ServerCommandArgs<'_>) {
    let ServerCommandArgs {
        text,
        frame_tx,
        capture_stop,
        controller,
        shared_cfg,
        config_tx,
        out_tx,
        shared_rules,
    } = args;

    let val: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    match val["type"].as_str().unwrap_or("") {
        // ── Interactive terminal (ConPTY); gated server-side ────────────────
        "TerminalStart" => {
            if let Some(sid) = val["session_id"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            {
                let cols = val["cols"].as_u64().unwrap_or(80).clamp(2, 500) as u16;
                let rows = val["rows"].as_u64().unwrap_or(24).clamp(1, 200) as u16;
                crate::platform::terminal::start(sid, cols, rows, out_tx);
            }
        }
        "TerminalInput" => {
            if let Some(sid) = val["session_id"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            {
                if let Some(data) = val["data"].as_str() {
                    crate::platform::terminal::input(sid, data);
                }
            }
        }
        "TerminalResize" => {
            if let Some(sid) = val["session_id"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            {
                let cols = val["cols"].as_u64().unwrap_or(80).clamp(2, 500) as u16;
                let rows = val["rows"].as_u64().unwrap_or(24).clamp(1, 200) as u16;
                crate::platform::terminal::resize(sid, cols, rows);
            }
        }
        "TerminalClose" => {
            if let Some(sid) = val["session_id"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
            {
                crate::platform::terminal::close(sid);
            }
        }
        "RequestInfo" => {
            let payload = crate::platform::system_info::collect_agent_info().to_string();
            let tx = out_tx;
            tokio::spawn(async move {
                let _ = tx.send(Message::Text(payload)).await;
            });
            info!("Received RequestInfo command; pushed fresh system info.");
        }
        "LockHost" => match crate::platform::system_control::lock_host() {
            Ok(()) => info!("Received LockHost command; workstation locked."),
            Err(e) => warn!("LockHost command failed: {e}"),
        },
        "RestartHost" => match crate::platform::system_control::restart_host() {
            Ok(()) => info!("Received RestartHost command; restart initiated."),
            Err(e) => warn!("RestartHost command failed: {e}"),
        },
        "ShutdownHost" => match crate::platform::system_control::shutdown_host() {
            Ok(()) => info!("Received ShutdownHost command; shutdown initiated."),
            Err(e) => warn!("ShutdownHost command failed: {e}"),
        },
        "set_local_ui_password_hash" => {
            if let Some(hash) = val["hash"].as_str() {
                if let Ok(mut c) = shared_cfg.lock() {
                    c.ui_password_hash = hash.to_string();
                    match tokio::task::block_in_place(|| crate::config::save_config(&c)) {
                        Ok(()) => {
                            let new_cfg = c.clone();
                            drop(c);
                            let _ = config_tx.send(Some(new_cfg));
                            info!("Local settings UI password updated from server.");
                        }
                        Err(e) => warn!("Failed to save config (server UI password): {e}"),
                    }
                }
            }
        }
        "set_auto_update" => {
            if let Some(enabled) = val["enabled"].as_bool() {
                if let Ok(mut c) = shared_cfg.lock() {
                    c.auto_update_enabled = enabled;
                    match tokio::task::block_in_place(|| crate::config::save_config(&c)) {
                        Ok(()) => {
                            let new_cfg = c.clone();
                            drop(c);
                            let _ = config_tx.send(Some(new_cfg));
                            info!("Auto-update setting updated from server (enabled={enabled}).");
                        }
                        Err(e) => warn!("Failed to save config (server auto_update): {e}"),
                    }
                }
            }
        }
        "set_network_policy" => {
            let blocked = val["blocked"].as_bool().unwrap_or(false);
            let (hostname, port, was_blocked) = {
                let c = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
                let (h, p) = crate::platform::network_policy::parse_server_host_port(&c.server_url)
                    .unwrap_or_else(|| (String::new(), 443));
                (h, p, c.internet_blocked)
            };
            // Only act when state actually changes (or re-apply on reconnect when already blocked).
            let needs_action = blocked || was_blocked;
            if needs_action {
                let h = hostname;
                tokio::spawn(async move {
                    crate::network_scheduler::apply_network_policy(blocked, h, port).await;
                });
            }
            if let Ok(mut c) = shared_cfg.lock() {
                c.internet_blocked = blocked;
                match tokio::task::block_in_place(|| crate::config::save_config(&c)) {
                    Ok(()) => {
                        let new_cfg = c.clone();
                        drop(c);
                        let _ = config_tx.send(Some(new_cfg));
                        info!("Network policy updated from server (blocked={blocked}).");
                    }
                    Err(e) => warn!("Failed to save config (network policy): {e}"),
                }
            }
        }
        "set_internet_block_rules" => {
            let empty: Vec<serde_json::Value> = Vec::new();
            let rules: Vec<crate::config::StoredInternetBlockRule> = val["rules"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
            let (hostname, port, desired, current) = {
                let mut c = shared_cfg.lock().unwrap_or_else(|e| e.into_inner());
                c.internet_block_rules = rules;
                let (h, p) = crate::platform::network_policy::parse_server_host_port(&c.server_url)
                    .unwrap_or_else(|| (String::new(), 443));
                let desired_now = if c.internet_block_rules.is_empty() {
                    c.internet_blocked
                } else {
                    c.internet_block_rules
                        .iter()
                        .any(|r| crate::schedule::is_active_now_local(&r.schedules))
                };
                let cur = c.internet_blocked;
                if desired_now != cur {
                    c.internet_blocked = desired_now;
                }
                if let Err(e) = tokio::task::block_in_place(|| crate::config::save_config(&c)) {
                    warn!("Failed to save internet block rules to config: {e}");
                } else {
                    info!(
                        "Internet block rules updated from server ({} rules).",
                        c.internet_block_rules.len()
                    );
                }
                (h, p, desired_now, cur)
            };

            if desired != current {
                tokio::spawn(async move {
                    crate::network_scheduler::apply_network_policy(desired, hostname, port).await;
                });
            }
        }
        "set_app_block_rules" => {
            let empty: Vec<serde_json::Value> = Vec::new();
            let rules: Vec<crate::app_block::BlockRule> = val["rules"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect();
            {
                let mut lock = shared_rules.lock().unwrap_or_else(|e| e.into_inner());
                *lock = rules.clone();
            }
            if let Ok(mut c) = shared_cfg.lock() {
                c.app_block_rules = rules
                    .iter()
                    .map(super::app_block::BlockRule::to_stored)
                    .collect();
                match tokio::task::block_in_place(|| crate::config::save_config(&c)) {
                    Ok(()) => {
                        info!(
                            "App block rules updated from server ({} rules).",
                            rules.len()
                        );
                    }
                    Err(e) => warn!("Failed to save app block rules to config: {e}"),
                }
            }
        }
        "update_now" => {
            #[cfg(target_os = "windows")]
            {
                let tx = out_tx;
                tokio::spawn(async move {
                    match crate::updater_client::update_via_service().await {
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
                            crate::updater_client::exit_for_update();
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
                warn!("update_now is not implemented for the Linux headless agent yet.");
            }
        }
        "start_capture" => {
            let settings =
                crate::platform::desktop_capture::CaptureSettings::from_server_command(&val);
            let jpeg_quality = settings.jpeg_quality;
            let interval_ms = settings.interval_ms;

            // Replace any existing capture thread so updated settings apply immediately.
            if let Some(stop) = capture_stop.take() {
                stop.store(true, Ordering::Relaxed);
            }

            let stop = Arc::new(AtomicBool::new(false));
            match crate::platform::desktop_capture::start_capture(
                frame_tx.clone(),
                stop.clone(),
                settings,
            ) {
                Ok(()) => {
                    *capture_stop = Some(stop);
                    info!(
                        "Screen capture started (viewer connected): jpeg_q={}, interval_ms={}",
                        jpeg_quality, interval_ms
                    );
                }
                Err(e) => warn!("Failed to start capture: {e}"),
            }
        }
        "stop_capture" => {
            if let Some(stop) = capture_stop.take() {
                stop.store(true, Ordering::Relaxed);
                info!("Screen capture stopped (no viewers remaining).");
            }
        }
        "ListLogSources" => {
            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let out = out_tx;
            tokio::spawn(async move {
                let sources: Vec<serde_json::Value> = crate::log_sources::list_log_sources()
                    .into_iter()
                    .filter_map(|s| serde_json::to_value(s).ok())
                    .collect();

                let payload = serde_json::json!({
                    "type": "log_sources",
                    "request_id": request_id,
                    "sources": sources,
                })
                .to_string();
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "ReadLogTail" => {
            const MAX_LOG_KIND_CHARS: usize = 64;
            const MAX_KB_DEFAULT: u32 = 512;
            const MAX_KB_LIMIT: u32 = 2048;

            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let kind = val["kind"]
                .as_str()
                .unwrap_or("local_agent")
                .trim()
                .chars()
                .take(MAX_LOG_KIND_CHARS)
                .collect::<String>();
            if kind.is_empty() {
                return;
            }
            let max_kb = val["max_kb"]
                .as_u64()
                .map_or(MAX_KB_DEFAULT, |u| u as u32)
                .min(MAX_KB_LIMIT);
            let max_bytes = (max_kb as usize).saturating_mul(1024);

            let out = out_tx;
            tokio::spawn(async move {
                let path = match crate::log_sources::resolve_log_kind(kind.as_str()) {
                    Ok(p) => p,
                    Err(e) => {
                        let payload = serde_json::json!({
                            "type": "log_tail",
                            "request_id": request_id,
                            "kind": kind,
                            "text": format!("(Could not resolve log source: {e})"),
                        })
                        .to_string();
                        let _ = out.send(Message::Text(payload)).await;
                        return;
                    }
                };

                let read_res = tokio::task::spawn_blocking(move || {
                    match crate::log_sources::read_log_tail_display(&path, max_bytes) {
                        Ok(s) => s,
                        Err(e) => format!("(Could not read log: {e})"),
                    }
                })
                .await;

                let text = match read_res {
                    Ok(s) => s,
                    Err(e) => format!("(Log read task failed: {e})"),
                };

                let payload = serde_json::json!({
                    "type": "log_tail",
                    "request_id": request_id,
                    "kind": kind,
                    "text": text,
                })
                .to_string();
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "Mkdir" => {
            const MAX_PATH_CHARS: usize = 2048;
            const MAX_NAME_CHARS: usize = 256;
            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let base = val["path"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            let name = val["name"]
                .as_str()
                .unwrap_or("")
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
            tokio::spawn(async move {
                let full = if base.ends_with('\\') {
                    format!("{base}{name}")
                } else {
                    format!("{base}\\{name}")
                };
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
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "RenamePath" => {
            const MAX_PATH_CHARS: usize = 2048;
            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let src = val["src"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            let dst = val["dst"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            if src.is_empty() || dst.is_empty() {
                return;
            }
            let out = out_tx;
            tokio::spawn(async move {
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
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "DeletePath" => {
            const MAX_PATH_CHARS: usize = 2048;
            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let path = val["path"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            if path.is_empty() {
                return;
            }
            let recursive = val["recursive"].as_bool().unwrap_or(false);
            let out = out_tx;
            tokio::spawn(async move {
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
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "CopyPath" => {
            const MAX_PATH_CHARS: usize = 2048;
            let request_id = val["request_id"].as_str().unwrap_or("").trim().to_string();
            if request_id.is_empty() {
                return;
            }
            let src = val["src"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            let dst = val["dst"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_PATH_CHARS)
                .collect::<String>();
            if src.is_empty() || dst.is_empty() {
                return;
            }
            let out = out_tx;
            tokio::spawn(async move {
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
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "ListDir" => {
            const MAX_DIR_PATH_CHARS: usize = 1024;
            const MAX_DIR_ENTRIES: usize = 5_000;
            const DRIVES_VANTYR_PATH: &str = "__this_pc__";
            fn default_dir_path() -> String {
                // Prefer a real "Documents" folder; fall back safely.
                if let Some(p) = dirs::document_dir() {
                    return p.to_string_lossy().to_string();
                }
                if let Ok(up) = std::env::var("USERPROFILE") {
                    let up = up.trim();
                    if !up.is_empty() {
                        return format!("{up}\\Documents");
                    }
                }
                "C:\\".to_string()
            }

            let path_in = val["path"].as_str().unwrap_or("").trim();
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
            tokio::spawn(async move {
                let mut items = Vec::new();
                if is_drives {
                    #[cfg(target_os = "windows")]
                    {
                        use windows::Win32::Storage::FileSystem::GetLogicalDrives;
                        let mask = unsafe { GetLogicalDrives() };
                        // Bits 0..25 correspond to A..Z.
                        for i in 0..26u32 {
                            if (mask & (1u32 << i)) != 0 {
                                let letter = (b'A' + (i as u8)) as char;
                                let name = format!("{letter}:\\");
                                items.push(serde_json::json!({
                                    "name": name,
                                    "is_dir": true,
                                    "size": 0
                                }));
                            }
                        }
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        // Non-Windows builds aren't expected for this agent.
                    }
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
                        crate::platform::software_inventory::cmp_str_ascii_case_insensitive(na, nb)
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
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "CollectSoftware" => {
            let out = out_tx;
            tokio::spawn(async move {
                crate::platform::software_inventory::send_inventory(out).await;
            });
            info!("CollectSoftware scheduled.");
        }
        "RunScript" => {
            let request_id = val["request_id"].as_str().unwrap_or("").to_string();
            if request_id.is_empty() {
                warn!("RunScript missing request_id");
                return;
            }
            let shell = val["shell"].as_str().unwrap_or("powershell").to_lowercase();
            let script = val["script"].as_str().unwrap_or("").to_string();
            if script.len() > 256 * 1024 {
                warn!("RunScript rejected: script too large");
                return;
            }
            let timeout_secs = val["timeout_secs"].as_u64().unwrap_or(120).clamp(5, 300);
            let out = out_tx;
            tokio::spawn(async move {
                let r = crate::platform::script_execution::run(&shell, &script, timeout_secs).await;
                let payload = serde_json::json!({
                    "type": "script_result",
                    "request_id": request_id,
                    "ok": r.ok,
                    "exit_code": r.exit_code,
                    "stdout": r.stdout,
                    "stderr": r.stderr,
                    "error": r.error,
                })
                .to_string();
                let _ = out.send(Message::Text(payload)).await;
            });
        }
        "ReadFile" => {
            const MAX_FILE_PATH_CHARS: usize = 2048;
            let path = val["path"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_FILE_PATH_CHARS)
                .collect::<String>();
            let out = out_tx;
            tokio::spawn(async move {
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
                        let _ = out.send(Message::Text(payload)).await;
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
                        let _ = out.send(Message::Text(payload)).await;
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
                    let _ = out.send(Message::Text(payload)).await;
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
                            let _ = out.send(Message::Text(payload)).await;
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
                    let _ = out.send(Message::Text(payload)).await;
                    idx += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            });
        }
        "WriteFileChunk" => {
            const MAX_FILE_PATH_CHARS: usize = 2048;
            use base64::{engine::general_purpose, Engine as _};
            use std::io::Write;

            let path: String = val["path"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_FILE_PATH_CHARS)
                .collect();
            let total_chunks = val["total_chunks"].as_u64().unwrap_or(0) as usize;
            let chunk_index = val["chunk_index"].as_u64().unwrap_or(0) as usize;
            let data_b64 = val["data"].as_str().unwrap_or("");

            let push_result =
                |path_s: String, ok: bool, err: String, out: mpsc::Sender<Message>| {
                    let payload = serde_json::json!({
                        "type": "file_upload_result",
                        "path": path_s,
                        "ok": ok,
                        "error": err,
                    })
                    .to_string();
                    tokio::spawn(async move {
                        let _ = out.send(Message::Text(payload)).await;
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
                    },
                );
            }
            // Validate this chunk against the open session for *this path* only.
            let prior_bytes = match map.get(&path) {
                Some(s)
                    if s.next_expected_chunk == chunk_index && s.total_chunks == total_chunks =>
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
                None => {
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
        _ => {
            if let Err(e) = controller.handle_command(text) {
                warn!("Control command error: {e:#}");
            }
        }
    }
}
