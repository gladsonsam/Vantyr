//! On-disk log locations for the dashboard WebSocket API and the Tauri Logs tab.
//!
//! Both paths must stay in sync so `kind` from [`list_log_sources`] matches
//! [`resolve_log_kind`] for tail/clear operations.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

// The service-owned logs only exist on Windows.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;
#[cfg(windows)]
pub use self::windows::resolve_fixed_log_kind;

#[derive(Clone, Serialize)]
pub struct LogSourceDesc {
    pub id: String,
    pub label: String,
    pub path: String,
}

/// Known log files for list UIs (`ListLogSources` / `list_log_sources`).
pub fn list_log_sources() -> Vec<LogSourceDesc> {
    let mut out = Vec::new();

    let local = crate::config::config_dir().join("agent.log");
    out.push(LogSourceDesc {
        id: "local_agent".into(),
        label: "Interactive agent (agent.log, with config)".into(),
        path: local.display().to_string(),
    });

    out.extend(imp::service_sources());

    if let Ok(p) = std::env::var("AGENT_LOG_FILE") {
        let t = p.trim();
        if !t.is_empty() {
            out.push(LogSourceDesc {
                id: "env".into(),
                label: "This process (AGENT_LOG_FILE)".into(),
                path: t.to_string(),
            });
        }
    }

    out
}

/// Map a log tab / dashboard `kind` string to a filesystem path.
pub fn resolve_log_kind(kind: &str) -> Result<PathBuf, String> {
    match kind {
        "local_agent" => Ok(crate::config::config_dir().join("agent.log")),
        "service" => imp::service_log("service.log"),
        "user_agent" => imp::service_log("user-agent.log"),
        "env" => std::env::var("AGENT_LOG_FILE")
            .map_err(|_| "AGENT_LOG_FILE is not set in this process".into())
            .map(PathBuf::from),
        _ => Err(format!("unknown log source: {kind}")),
    }
}

pub fn read_file_tail(path: &Path, max_bytes: usize) -> io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes as u64);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Strip CSI `ESC [ … letter` sequences so log tails are readable in the plain-text UI.
pub fn strip_ansi_escapes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(&ch) = chars.peek() {
                chars.next();
                if ch.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Human-readable tail for settings/logs UI (missing file and empty-file messages).
pub fn read_log_tail_display(path: &Path, max_bytes: usize) -> Result<String, String> {
    if !path.exists() {
        return Ok(format!(
            "(File not found: {})\n\nLogs appear here after that component writes its first line.",
            path.display()
        ));
    }
    let s = read_file_tail(path, max_bytes).map_err(|e| e.to_string())?;
    if s.is_empty() {
        return Ok("(Log file is empty.)".into());
    }
    Ok(strip_ansi_escapes(&s))
}
