//! Run `PowerShell` or cmd.exe scripts from server commands (high privilege — gated on server).

use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MAX_IO_BYTES: usize = 64 * 1024;

fn truncate_output(bytes: &[u8]) -> String {
    if bytes.len() > MAX_IO_BYTES {
        let s = String::from_utf8_lossy(&bytes[..MAX_IO_BYTES]);
        format!("{s}\n… (truncated)")
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn protect_child_on_timeout(cmd: &mut Command) {
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub struct RunOutcome {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
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

    let fut = cmd
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&path)
        .output();

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

        let fut = cmd.args(["/C", p]).output();
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

    let fut = cmd.args(["/C", script]).output();
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

pub async fn run(shell: &str, script: &str, timeout_secs: u64) -> RunOutcome {
    let timeout_dur = Duration::from_secs(timeout_secs.max(1));
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
