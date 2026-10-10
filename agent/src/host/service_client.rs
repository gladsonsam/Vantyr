//! Client for the Windows service named pipe (`VantyrAgentService`).
//!
//! The per-user agent asks the LocalSystem service to do the privileged work:
//! install a verified update MSI, apply the network policy, clear a log file.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tracing::{info, warn};

use crate::host::ipc::{ServiceRequest, MAX_SERVICE_PIPE_LINE, SERVICE_PIPE_NAME};
use crate::updater::StagedUpdate;

/// Max wait for JSON reply after sending a pipe command.
const PIPE_REPLY_TIMEOUT: Duration = Duration::from_secs(120);

async fn connect_pipe() -> Result<NamedPipeClient> {
    let mut last_err: Option<anyhow::Error> = None;
    for _ in 0..30 {
        match ClientOptions::new().open(SERVICE_PIPE_NAME) {
            Ok(c) => return Ok(c),
            Err(e) => {
                last_err = Some(anyhow::anyhow!("{e}"));
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("failed to connect updater pipe")))
}

/// Result of asking the elevated service to update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateViaServiceOutcome {
    /// `latest.json` matches this build; no MSI was run.
    UpToDate,
    /// MSI staged and `msiexec` started (service may stop shortly after).
    InstallStarted,
}

async fn read_updater_pipe_reply_line(client: &mut NamedPipeClient) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut reader = BufReader::new(client);
    match tokio::time::timeout(PIPE_REPLY_TIMEOUT, reader.read_until(b'\n', &mut buf)).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => anyhow::bail!(
            "timed out waiting for updater service reply (service likely too old or stuck)"
        ),
    }
    if buf.len() > MAX_SERVICE_PIPE_LINE {
        anyhow::bail!("updater service reply too large");
    }
    while matches!(buf.last().copied(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(buf)
}

fn parse_pipe_reply(buf: &[u8]) -> Result<UpdateViaServiceOutcome> {
    if buf.is_empty() {
        anyhow::bail!("empty reply from updater service");
    }
    let v: serde_json::Value =
        serde_json::from_slice(buf).map_err(|e| anyhow::anyhow!("invalid updater JSON: {e}"))?;
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
            anyhow::bail!("updater service error: {e}");
        }
        anyhow::bail!("updater service returned ok=false");
    }
    Ok(UpdateViaServiceOutcome::InstallStarted)
}

async fn pipe_call_install_msi(msi_path: &Path) -> Result<UpdateViaServiceOutcome> {
    info!(
        "Updater: asking elevated service to run installer ({})",
        msi_path.display()
    );
    let mut client = connect_pipe().await?;
    let req = ServiceRequest::InstallMsi {
        msi_path: msi_path.as_os_str().to_string_lossy().into_owned(),
    }
    .to_line();
    client.write_all(req.as_bytes()).await?;
    client.flush().await?;

    let buf = read_updater_pipe_reply_line(&mut client).await?;
    parse_pipe_reply(&buf)
}

/// Download + verify under `%ProgramData%\\Vantyr\\updates`, then ask the `LocalSystem` service
/// to run `msiexec` via the updater named pipe.
pub async fn update_via_service() -> Result<UpdateViaServiceOutcome> {
    let o = match crate::updater::download_update_msi_to_staging().await? {
        StagedUpdate::UpToDate => UpdateViaServiceOutcome::UpToDate,
        StagedUpdate::Ready(msi_path) => pipe_call_install_msi(&msi_path).await?,
    };

    if o == UpdateViaServiceOutcome::UpToDate {
        info!("Updater: already on published version; not exiting.");
    }
    Ok(o)
}

/// Ask the `LocalSystem` service to apply or remove the Windows Firewall internet block.
///
/// The service runs as SYSTEM so `netsh advfirewall` succeeds without UAC prompts.
/// Falls back gracefully when the service pipe is unavailable.
pub async fn set_network_policy_via_service(
    blocked: bool,
    server_hostname: &str,
    server_port: u16,
    generation: Option<crate::permissions::Generation>,
) -> Result<()> {
    let mut client = connect_pipe().await?;
    let req = ServiceRequest::SetNetworkPolicy {
        generation,
        blocked,
        server_hostname: server_hostname.to_string(),
        server_port,
    }
    .to_line();
    client.write_all(req.as_bytes()).await?;
    client.flush().await?;

    let buf = read_updater_pipe_reply_line(&mut client).await?;
    let v: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| anyhow::anyhow!("invalid JSON from service: {e}"))?;
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let err = v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("service returned ok=false");
        anyhow::bail!("{err}");
    }
    Ok(())
}

/// Ask the `LocalSystem` service to truncate one of its log files (e.g. `service.log`).
///
/// This is needed because some logs are written/owned by the service and a normal
/// user-session process may get "Access is denied" when trying to truncate them.
pub async fn clear_log_file_via_service(kind: &str) -> Result<()> {
    let kind = kind.trim();
    if kind.is_empty() {
        anyhow::bail!("missing log kind");
    }
    let mut client = connect_pipe().await?;
    let req = ServiceRequest::ClearLogFile {
        kind: kind.to_string(),
    }
    .to_line();
    client.write_all(req.as_bytes()).await?;
    client.flush().await?;

    let buf = read_updater_pipe_reply_line(&mut client).await?;
    if buf.is_empty() {
        anyhow::bail!("empty reply from service");
    }
    let v: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| anyhow::anyhow!("invalid JSON from service: {e}"))?;
    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let err = v
            .get("error")
            .and_then(|x| x.as_str())
            .unwrap_or("service returned ok=false");
        anyhow::bail!("{err}");
    }
    Ok(())
}

/// Helper used by the agent when it knows it's going to be replaced.
pub fn exit_for_update() -> ! {
    warn!("Exiting agent for update install.");
    std::process::exit(0);
}
