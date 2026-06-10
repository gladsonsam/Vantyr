use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tracing::{info, warn};

const UPDATER_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkwNkVDQzFDMjkzRjVEN0QKUldSOVhUOHBITXh1a003RnZYUUhqNmdsRkZTMktrbnFnZGRMZUFnaGYwNmxqV0tyL2h3bTlCUkYK";

const PIPE_NAME: &str = r"\\.\pipe\VantyrAgentService";

/// Max wait for JSON reply after sending a pipe command.
const PIPE_REPLY_TIMEOUT: Duration = Duration::from_secs(120);

/// Keep in sync with `MAX_SERVICE_PIPE_LINE` in `service.rs`.
const MAX_SERVICE_PIPE_REPLY_BYTES: usize = 256 * 1024;

/// One JSON object per line, newline-terminated (named-pipe friendly).
fn pipe_request_line(json: serde_json::Value) -> String {
    let mut s = json.to_string();
    s.push('\n');
    s
}

/// `tauri.conf.json` `pubkey` may be either (a) base64 of the raw 42-byte minisign key, or
/// (b) base64 of the full UTF-8 `.pub` file (`untrusted comment` + key line). Accept both.
fn parse_embedded_public_key() -> Result<PublicKey> {
    let s = UPDATER_PUBKEY_B64.trim();
    if let Ok(pk) = PublicKey::from_base64(s) {
        return Ok(pk);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s)
        .context("embedded pubkey: not valid base64")?;
    let text = String::from_utf8(bytes).context("embedded pubkey: base64 is not UTF-8 text")?;
    PublicKey::decode(text.trim())
        .map_err(|e| anyhow::anyhow!("embedded pubkey: not a valid minisign .pub body: {e}"))
}

fn decode_signature(sig: &str) -> Result<Signature> {
    let mut s = sig.trim().to_string();
    // Some `latest.json` generators store literal `\n` instead of newlines.
    if !s.contains('\n') && s.contains("\\n") {
        s = s.replace("\\n", "\n");
    }
    let st = s.trim();
    if st.contains("untrusted comment") || st.contains('\n') {
        return Signature::decode(st).map_err(|e| anyhow::anyhow!("minisign signature: {e}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(st)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(st))
        .map_err(|_| anyhow::anyhow!("signature was not valid base64 and not minisign text"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("decoded signature was not valid UTF-8"))?;
    Signature::decode(text.trim()).map_err(|e| anyhow::anyhow!("minisign signature: {e}"))
}

pub fn verify_msi_signature(msi_bytes: &[u8], signature: &str) -> Result<()> {
    let pk = parse_embedded_public_key()?;
    let sig = decode_signature(signature)?;
    // Tauri bundles use prehashed (BLAKE2b) minisign signatures for large artifacts.
    pk.verify(msi_bytes, &sig, false)
        .map_err(|e| anyhow::anyhow!("signature verify failed: {e}"))?;
    Ok(())
}

/// Machine-wide staging under `%ProgramData%\Vantyr\updates`. Service and user agent must be
/// able to read/write this folder (MSI ACLs).
fn update_staging_dir() -> PathBuf {
    crate::config::updates_staging_dir()
}

enum LocalDownloadResult {
    UpToDate,
    Ready(PathBuf),
}

/// 1–2: fetch manifest, download MSI to `ProgramData` staging, verify signature.
async fn download_update_msi_to_staging() -> Result<LocalDownloadResult> {
    let latest = crate::updater_manifest::fetch_latest_info().await?;
    let current = env!("CARGO_PKG_VERSION");
    let pub_v = latest.version.trim_start_matches('v');
    let run_v = current.trim_start_matches('v');
    if pub_v == run_v {
        info!(
            "Updater: published {} matches this build {}; nothing to download.",
            latest.version, current
        );
        return Ok(LocalDownloadResult::UpToDate);
    }

    let dir = update_staging_dir();
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("create {}", dir.display()))?;

    let msi_path = dir.join(format!("VantyrAgent_{}.msi", latest.version));
    let tmp_path = dir.join(format!("VantyrAgent_{}.msi.part", latest.version));

    info!(
        "Updater: downloading {} → {} into {}",
        current,
        latest.version,
        dir.display()
    );

    let res = reqwest::Client::new()
        .get(&latest.url)
        .timeout(Duration::from_secs(300))
        .send()
        .await?
        .error_for_status()?;
    let mut stream = res.bytes_stream();
    let mut f = tokio::fs::File::create(&tmp_path).await?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        f.write_all(&chunk).await?;
    }
    f.flush().await?;

    let bytes = tokio::fs::read(&tmp_path).await?;
    verify_msi_signature(&bytes, &latest.signature)?;
    if msi_path.exists() {
        let _ = tokio::fs::remove_file(&msi_path).await;
    }
    tokio::fs::rename(&tmp_path, &msi_path).await?;

    info!("Updater: verified MSI staged at {}", msi_path.display());
    Ok(LocalDownloadResult::Ready(msi_path))
}

async fn connect_pipe() -> Result<NamedPipeClient> {
    let mut last_err: Option<anyhow::Error> = None;
    for _ in 0..30 {
        match ClientOptions::new().open(PIPE_NAME) {
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

/// Settings UI: compare running build to `latest.json` (no download until user confirms).
#[derive(Debug, Clone)]
pub struct ManualUpdateCheckResult {
    pub update_available: bool,
    pub published_version: Option<String>,
    pub running_version: String,
}

pub async fn check_manual_update_available() -> Result<ManualUpdateCheckResult> {
    let latest = crate::updater_manifest::fetch_latest_info().await?;
    let current = env!("CARGO_PKG_VERSION");
    let pub_v = latest.version.trim_start_matches('v');
    let run_v = current.trim_start_matches('v');
    let update_available = pub_v != run_v;
    Ok(ManualUpdateCheckResult {
        update_available,
        published_version: update_available.then(|| latest.version.clone()),
        running_version: current.to_string(),
    })
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
    if buf.len() > MAX_SERVICE_PIPE_REPLY_BYTES {
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
    let path_str = msi_path.as_os_str().to_string_lossy();
    let req = pipe_request_line(serde_json::json!({
        "action": "install_msi",
        "msi_path": path_str.as_ref(),
    }));
    client.write_all(req.as_bytes()).await?;
    client.flush().await?;

    let buf = read_updater_pipe_reply_line(&mut client).await?;
    parse_pipe_reply(&buf)
}

/// Download + verify under `%ProgramData%\\Vantyr\\updates`, then ask the `LocalSystem` service
/// to run `msiexec` via the updater named pipe.
pub async fn update_via_service() -> Result<UpdateViaServiceOutcome> {
    let o = match download_update_msi_to_staging().await? {
        LocalDownloadResult::UpToDate => UpdateViaServiceOutcome::UpToDate,
        LocalDownloadResult::Ready(msi_path) => pipe_call_install_msi(&msi_path).await?,
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
) -> Result<()> {
    let mut client = connect_pipe().await?;
    let req = pipe_request_line(serde_json::json!({
        "action": "set_network_policy",
        "blocked": blocked,
        "server_hostname": server_hostname,
        "server_port": server_port,
    }));
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
    let req = pipe_request_line(serde_json::json!({
        "action": "clear_log_file",
        "kind": kind,
    }));
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
