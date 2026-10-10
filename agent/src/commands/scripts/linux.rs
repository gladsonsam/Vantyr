//! Linux script shells: sh and bash (Windows shell values are rejected).

use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use super::runner::{managed_output, protect_child_on_timeout, truncate_output, RunOutcome};

/// Run the child in its own process group so cancellation kills its background jobs.
pub(super) fn contain(cmd: &mut Command) {
    cmd.process_group(0);
}

/// Linux children are not spawned suspended; nothing to resume.
pub(super) fn resume(_pid: u32) -> std::io::Result<()> {
    Ok(())
}

pub(super) async fn run_shell(shell: &str, script: &str, timeout_dur: Duration) -> RunOutcome {
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

async fn shell_available(shell: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {shell}")])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn run_unix_shell(shell: &str, script: &str, timeout_dur: Duration) -> RunOutcome {
    if shell == "bash" && !shell_available("bash").await {
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

#[cfg(test)]
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
