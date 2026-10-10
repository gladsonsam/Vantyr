//! Run scripts from server commands (high privilege — gated on server): `PowerShell`
//! or cmd.exe on Windows, sh or bash on Linux.

use std::time::Duration;

use tokio::process::Command;

use super::imp;

const MAX_IO_BYTES: usize = 64 * 1024;

pub(super) fn truncate_output(bytes: &[u8]) -> String {
    if bytes.len() > MAX_IO_BYTES {
        let s = String::from_utf8_lossy(&bytes[..MAX_IO_BYTES]);
        format!("{s}\n… (truncated)")
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub(super) fn protect_child_on_timeout(cmd: &mut Command) {
    cmd.kill_on_drop(true);
    imp::contain(cmd);
}

pub(super) async fn managed_output(cmd: &mut Command) -> std::io::Result<std::process::Output> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("missing child pid"))?;
    let _tree = crate::platform::process_tree::ProcessTree::attach(pid)?;
    imp::resume(pid)?;
    child.wait_with_output().await
}

pub struct RunOutcome {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

pub async fn run(shell: &str, script: &str, timeout_secs: u64) -> RunOutcome {
    let timeout_dur = Duration::from_secs(timeout_secs.max(1));
    imp::run_shell(shell, script, timeout_dur).await
}
