//! Windows script shells: PowerShell (via a temp `.ps1`) and cmd.exe.

use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use super::runner::{managed_output, protect_child_on_timeout, truncate_output, RunOutcome};

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Hide the console and start suspended (`CREATE_SUSPENDED`) so the child can be
/// put in its job object before it runs.
pub(super) fn contain(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW | 0x00000004);
}

/// Let the suspended child run once it is contained.
pub(super) fn resume(pid: u32) -> std::io::Result<()> {
    crate::platform::process_tree::ProcessTree::resume(pid)
}

pub(super) async fn run_shell(shell: &str, script: &str, timeout_dur: Duration) -> RunOutcome {
    match shell {
        "powershell" => run_powershell(script, timeout_dur).await,
        "cmd" => run_cmd(script, timeout_dur).await,
        _ => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(format!("unsupported shell: {shell}")),
        },
    }
}

async fn run_powershell(script: &str, timeout_dur: Duration) -> RunOutcome {
    let dir = match tempfile::tempdir() {
        Ok(d) => d,
        Err(e) => {
            return RunOutcome {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(e.to_string()),
            };
        }
    };
    let path = dir.path().join("vantyr_run.ps1");
    if let Err(e) = tokio::fs::write(&path, script.as_bytes()).await {
        return RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(e.to_string()),
        };
    }

    let mut cmd = Command::new("powershell.exe");
    protect_child_on_timeout(&mut cmd);

    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(&path);
    let fut = managed_output(&mut cmd);

    match timeout(timeout_dur, fut).await {
        Ok(Ok(output)) => RunOutcome {
            ok: output.status.success(),
            exit_code: output.status.code(),
            stdout: truncate_output(&output.stdout),
            stderr: truncate_output(&output.stderr),
            error: None,
        },
        Ok(Err(e)) => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(e.to_string()),
        },
        Err(_) => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("execution timed out".into()),
        },
    }
}

async fn run_cmd(script: &str, timeout_dur: Duration) -> RunOutcome {
    let needs_file = script.contains('\n') || script.len() > 8_192;
    if needs_file {
        let dir = match tempfile::tempdir() {
            Ok(d) => d,
            Err(e) => {
                return RunOutcome {
                    ok: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    error: Some(e.to_string()),
                };
            }
        };
        let path = dir.path().join("vantyr_run.bat");
        let body = format!("@echo off\r\n{script}");
        if let Err(e) = tokio::fs::write(&path, body.as_bytes()).await {
            return RunOutcome {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(e.to_string()),
            };
        }
        let Some(p) = path.to_str() else {
            return RunOutcome {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("invalid temp path".into()),
            };
        };

        let mut cmd = Command::new("cmd.exe");
        protect_child_on_timeout(&mut cmd);

        cmd.args(["/C", p]);
        let fut = managed_output(&mut cmd);
        return match timeout(timeout_dur, fut).await {
            Ok(Ok(output)) => RunOutcome {
                ok: output.status.success(),
                exit_code: output.status.code(),
                stdout: truncate_output(&output.stdout),
                stderr: truncate_output(&output.stderr),
                error: None,
            },
            Ok(Err(e)) => RunOutcome {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(e.to_string()),
            },
            Err(_) => RunOutcome {
                ok: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some("execution timed out".into()),
            },
        };
    }

    let mut cmd = Command::new("cmd.exe");
    protect_child_on_timeout(&mut cmd);

    cmd.args(["/C", script]);
    let fut = managed_output(&mut cmd);
    match timeout(timeout_dur, fut).await {
        Ok(Ok(output)) => RunOutcome {
            ok: output.status.success(),
            exit_code: output.status.code(),
            stdout: truncate_output(&output.stdout),
            stderr: truncate_output(&output.stderr),
            error: None,
        },
        Ok(Err(e)) => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(e.to_string()),
        },
        Err(_) => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("execution timed out".into()),
        },
    }
}
