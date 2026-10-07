//! Remote script execution (`RunScript`).

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use super::protocol::RunScript;
use super::send_reply;
use crate::outbound::replies::ScriptResult;
use crate::permissions::Generation;

mod runner;

// The shells and how their children are contained differ per OS.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux as imp;
#[cfg(windows)]
use self::windows as imp;

pub(super) fn run_script(
    cmd: RunScript,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    let request_id = cmd.request_id;
    if request_id.is_empty() {
        warn!("RunScript missing request_id");
        return;
    }
    let shell = cmd.shell.as_deref().unwrap_or("powershell").to_lowercase();
    let script = cmd.script;
    if script.len() > 256 * 1024 {
        warn!("RunScript rejected: script too large");
        return;
    }
    let timeout_secs = cmd.timeout_secs.unwrap_or(120).clamp(5, 300);
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let r = runner::run(&shell, &script, timeout_secs).await;
        let reply = ScriptResult {
            request_id: &request_id,
            ok: r.ok,
            exit_code: r.exit_code,
            stdout: &r.stdout,
            stderr: &r.stderr,
            error: r.error.as_deref(),
        };
        send_reply(&out, generation, &reply).await;
    });
}
