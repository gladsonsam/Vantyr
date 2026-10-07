//! Windows clipboard: PowerShell `System.Windows.Forms.Clipboard`, pinned to the
//! active console session.

use serde_json::Value;
use tokio::process::Command;

pub(super) fn available() -> bool {
    // The service forwards commands to the desktop companion. Availability
    // describes the backend; execution additionally requires a user session.
    super::executable("powershell.exe").is_some()
}

pub(super) fn command(write: bool) -> anyhow::Result<Command> {
    anyhow::ensure!(
        super::session::matches(
            Some(super::session::active_console()),
            super::session::process_session(std::process::id()),
            super::session::active_console()
        ),
        "active console clipboard session required"
    );
    let mut cmd = Command::new(
        super::executable("powershell.exe")
            .ok_or_else(|| anyhow::anyhow!("clipboard unavailable"))?,
    );
    cmd.creation_flags(0x08000000);
    cmd.args(["-NoProfile","-NonInteractive","-STA","-Command", if write {
        "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $text=[Console]::In.ReadToEnd(); if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text) }"
    } else {
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { throw 'No text' }; [Console]::Write([System.Windows.Forms.Clipboard]::GetText())"
    }]);
    Ok(cmd)
}

/// The request must still target the active console session.
pub(super) fn execution_allowed(value: &Value) -> bool {
    super::session::execution_allowed(value)
}

/// Echo the pinned console session so the service can route the reply.
pub(super) fn pin_reply(reply: &mut Value, value: &Value) {
    reply["__clipboard_session"] = value["__clipboard_session"].clone();
}
