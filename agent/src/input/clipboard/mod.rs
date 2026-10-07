//! Explicit TEXT clipboard only. No polling, telemetry, persistence, or content logs.
// The console-session pinning is Windows behaviour, but its matching rules are
// unit-tested on every platform.
#[cfg(any(windows, test))]
pub mod session;

use crate::permissions::{Generation, Module};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::mpsc,
};
use tokio_tungstenite::tungstenite::Message;
const MAX_BYTES: usize = 64 * 1024;
static REQUESTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<uuid::Uuid, tokio::sync::watch::Sender<bool>>>,
> = std::sync::OnceLock::new();
fn requests() -> &'static std::sync::Mutex<
    std::collections::HashMap<uuid::Uuid, tokio::sync::watch::Sender<bool>>,
> {
    REQUESTS.get_or_init(Default::default)
}
pub fn cancel(value: &Value) {
    if let Some(id) = value["request_id"]
        .as_str()
        .and_then(|s| s.parse::<uuid::Uuid>().ok())
    {
        if let Some(tx) = requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
        {
            tx.send_replace(true);
        }
    }
}
struct RequestGuard(uuid::Uuid);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

fn executable(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join(name))
            .find(|p| p.is_file())
    })
}
#[cfg(target_os = "linux")]
fn backend() -> Option<&'static str> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        (executable("wl-paste").is_some() && executable("wl-copy").is_some()).then_some("wayland")
    } else if std::env::var_os("DISPLAY").is_some() {
        executable("xclip").map(|_| "x11")
    } else {
        None
    }
}
pub fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        backend().is_some()
    }
    #[cfg(target_os = "windows")]
    {
        // The service forwards commands to the desktop companion. Availability
        // describes the backend; execution additionally requires a user session.
        executable("powershell.exe").is_some()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        false
    }
}
fn command(write: bool) -> anyhow::Result<Command> {
    anyhow::ensure!(available(), "clipboard unavailable");
    #[cfg(target_os = "windows")]
    {
        anyhow::ensure!(
            crate::input::clipboard::session::matches(
                Some(crate::input::clipboard::session::active_console()),
                crate::input::clipboard::session::process_session(std::process::id()),
                crate::input::clipboard::session::active_console()
            ),
            "active console clipboard session required"
        );
    }
    #[cfg(target_os = "linux")]
    {
        let (name, args): (&str, &[&str]) = match (backend(), write) {
            (Some("wayland"), false) => ("wl-paste", &["--no-newline", "--type", "text"]),
            // Clipboard owners must survive to serve the selection. wl-copy/xclip
            // fork their selection owner after consuming stdin; no text on argv.
            (Some("wayland"), true) => ("wl-copy", &["--type", "text/plain;charset=utf-8"]),
            (Some("x11"), false) => (
                "xclip",
                &["-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
            ),
            (Some("x11"), true) => (
                "xclip",
                &["-selection", "clipboard", "-in", "-target", "UTF8_STRING"],
            ),
            _ => anyhow::bail!("clipboard unavailable"),
        };
        let mut cmd =
            Command::new(executable(name).ok_or_else(|| anyhow::anyhow!("clipboard unavailable"))?);
        cmd.args(args);
        Ok(cmd)
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new(
            executable("powershell.exe").ok_or_else(|| anyhow::anyhow!("clipboard unavailable"))?,
        );
        cmd.creation_flags(0x08000000);
        cmd.args(["-NoProfile","-NonInteractive","-STA","-Command", if write {
            "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $text=[Console]::In.ReadToEnd(); if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text) }"
        } else {
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { throw 'No text' }; [Console]::Write([System.Windows.Forms.Clipboard]::GetText())"
        }]);
        Ok(cmd)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        anyhow::bail!("unsupported clipboard")
    }
}
fn validate_text(text: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        text.len() <= MAX_BYTES && !text.contains('\0'),
        "invalid clipboard text"
    );
    Ok(())
}
fn remaining(value: &Value) -> anyhow::Result<std::time::Duration> {
    let deadline = value["__clipboard_deadline_ms"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing clipboard deadline"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    anyhow::ensure!(now < deadline, "clipboard deadline expired");
    Ok(std::time::Duration::from_millis((deadline - now).min(4000)))
}
fn current(value: &Value, generation: Generation) -> anyhow::Result<()> {
    remaining(value)?;
    #[cfg(target_os = "windows")]
    anyhow::ensure!(
        crate::input::clipboard::session::execution_allowed(value),
        "clipboard console session changed or unavailable"
    );
    anyhow::ensure!(generation.valid_fresh(), "clipboard revoked");
    Ok(())
}
async fn operate(value: &Value, generation: Generation) -> anyhow::Result<Option<String>> {
    let _worker = crate::permissions::command_worker(generation, Module::Clipboard)?;
    current(value, generation)?;
    let write = match value["type"].as_str() {
        Some("ClipboardRead") => false,
        Some("ClipboardWrite") => true,
        _ => anyhow::bail!("invalid clipboard action"),
    };
    let text = if write {
        let text = value["text"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("text required"))?;
        validate_text(text)?;
        Some(text)
    } else {
        None
    };
    let mut cmd = command(write)?;
    cmd.stdin(if write { Stdio::piped() } else { Stdio::null() })
        .stdout(if write { Stdio::null() } else { Stdio::piped() })
        .stderr(Stdio::null())
        .kill_on_drop(true);
    current(value, generation)?;
    let mut child = cmd.spawn()?;
    if let Some(text) = text {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("clipboard stdin unavailable"))?;
        current(value, generation)?;
        stdin.write_all(text.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
    }
    let mut bytes = Vec::new();
    if !write {
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("clipboard stdout unavailable"))?
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        anyhow::ensure!(bytes.len() <= MAX_BYTES, "clipboard text too large");
    }
    anyhow::ensure!(child.wait().await?.success(), "clipboard operation failed");
    current(value, generation)?;
    if write {
        Ok(None)
    } else {
        let text = String::from_utf8(bytes)?;
        validate_text(&text)?;
        Ok(Some(text))
    }
}
pub fn spawn(value: Value, generation: Generation, tx: mpsc::Sender<Message>) {
    let Some(id) = value["request_id"]
        .as_str()
        .and_then(|s| s.parse::<uuid::Uuid>().ok())
    else {
        return;
    };
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut active = requests().lock().unwrap_or_else(|e| e.into_inner());
        if active.len() >= 128 || active.contains_key(&id) {
            return;
        }
        active.insert(id, cancel_tx);
    }
    let guard = RequestGuard(id);
    if remaining(&value).is_err() {
        return;
    }
    let worker = crate::permissions::WorkerLease::new(generation);
    tokio::spawn(async move {
        let _worker = worker;
        let _guard = guard;
        let Ok(timeout) = remaining(&value) else {
            return;
        };
        let operation = tokio::time::timeout(timeout, operate(&value, generation));
        let result = tokio::select! {
            biased;
            _ = cancel_rx.changed() => None,
            result = operation => result.ok().and_then(Result::ok),
            _ = async { loop {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if current(&value,generation).is_err() || tx.is_closed() { break; }
            }} => None,
        };
        let mut reply = json!({"type":"clipboard_result","request_id":value["request_id"],"ok":result.is_some()});
        #[cfg(target_os = "windows")]
        {
            reply["__clipboard_session"] = value["__clipboard_session"].clone();
        }
        if let Some(Some(text)) = result {
            reply["text"] = text.into();
        }
        // Final network/IPC writer rechecks the generation, including regrants.
        if current(&value, generation).is_err() {
            return;
        }
        let _ = tx.try_send(crate::permissions::tag_message(
            Message::Text(reply.to_string()),
            Some(generation),
        ));
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_and_missing_deadlines_fail_closed() {
        assert!(remaining(&json!({})).is_err());
        assert!(remaining(&json!({"__clipboard_deadline_ms":0})).is_err());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(remaining(&json!({"__clipboard_deadline_ms":now})).is_err());
        assert!(
            remaining(&json!({"__clipboard_deadline_ms":now+10000})).unwrap()
                <= std::time::Duration::from_secs(4)
        );
    }
    #[test]
    fn cancellation_targets_only_its_request_and_guard_removes_registration() {
        let id = uuid::Uuid::new_v4();
        let (tx, rx) = tokio::sync::watch::channel(false);
        requests().lock().unwrap().insert(id, tx);
        let guard = RequestGuard(id);
        cancel(&json!({"request_id":uuid::Uuid::new_v4().to_string()}));
        assert!(!*rx.borrow());
        cancel(&json!({"request_id":id.to_string()}));
        assert!(*rx.borrow());
        drop(guard);
        assert!(!requests().lock().unwrap().contains_key(&id));
    }
    #[test]
    fn text_limit_counts_utf8_bytes_and_rejects_nul() {
        assert!(validate_text(&"a".repeat(MAX_BYTES)).is_ok());
        assert!(validate_text(&"é".repeat(MAX_BYTES / 2)).is_ok());
        assert!(validate_text(&"é".repeat(MAX_BYTES / 2 + 1)).is_err());
        assert!(validate_text("a\0b").is_err());
        assert!(validate_text("").is_ok());
    }
}
