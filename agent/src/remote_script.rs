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
    cmd.creation_flags(CREATE_NO_WINDOW | 0x00000004);
    #[cfg(unix)]
    cmd.process_group(0);
}

async fn managed_output(cmd: &mut Command) -> std::io::Result<std::process::Output> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("missing child pid"))?;
    let _tree = crate::process_tree::ProcessTree::attach(pid)?;
    #[cfg(windows)]
    crate::process_tree::ProcessTree::resume(pid)?;
    child.wait_with_output().await
}

pub struct RunOutcome {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

#[cfg(target_os = "windows")]
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

#[cfg(target_os = "windows")]
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

#[cfg(not(target_os = "windows"))]
fn shell_available(shell: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {shell}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
async fn run_unix_shell(shell: &str, script: &str, timeout_dur: Duration) -> RunOutcome {
    if shell == "bash" && !shell_available("bash") {
        return RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some("bash is not available on this host".into()),
        };
    }

    let mut cmd = Command::new(shell);
    protect_child_on_timeout(&mut cmd);
    cmd.arg("-c").arg(script);
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

pub async fn run(shell: &str, script: &str, timeout_secs: u64) -> RunOutcome {
    let timeout_dur = Duration::from_secs(timeout_secs.max(1));
    #[cfg(target_os = "windows")]
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

    #[cfg(not(target_os = "windows"))]
    match shell {
        "sh" => run_unix_shell("sh", script, timeout_dur).await,
        "bash" => run_unix_shell("bash", script, timeout_dur).await,
        "powershell" | "cmd" => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(format!("unsupported Linux shell: {shell}")),
        },
        _ => RunOutcome {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(format!("unsupported shell: {shell}")),
        },
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_kills_shell_and_background_group() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("child.pid");
        let child_path = p.clone();
        let task = tokio::spawn(async move {
            let mut cmd = Command::new("sh");
            protect_child_on_timeout(&mut cmd);
            cmd.arg("-c").arg(format!(
                "sleep 60 & echo $! > '{}'; wait",
                child_path.display()
            ));
            managed_output(&mut cmd).await
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !p.exists() {
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = std::fs::read_to_string(&p)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        task.abort();
        let _ = task.await;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            let running = stat.is_ok_and(|s| {
                s.rsplit_once(") ")
                    .is_some_and(|(_, fields)| !fields.starts_with('Z'))
            });
            if !running {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "background process survived cancellation"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
