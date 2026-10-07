//! Windows self-update: read the published release manifest ([`manifest`]),
//! download the MSI into `%ProgramData%\Vantyr\updates` and check its minisign
//! signature ([`verify`]). The LocalSystem service installs it
//! (`host::service_client::update_via_service`).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tracing::info;

pub mod manifest;
pub mod verify;

/// Settings UI: compare running build to `latest.json` (no download until user confirms).
#[derive(Debug, Clone)]
pub struct ManualUpdateCheckResult {
    pub update_available: bool,
    pub published_version: Option<String>,
    pub running_version: String,
}

pub async fn check_manual_update_available() -> Result<ManualUpdateCheckResult> {
    let latest = manifest::fetch_latest_info().await?;
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

/// Machine-wide staging under `%ProgramData%\Vantyr\updates`. Service and user agent must be
/// able to read/write this folder (MSI ACLs).
fn update_staging_dir() -> PathBuf {
    crate::config::updates_staging_dir()
}

/// Outcome of [`download_update_msi_to_staging`].
pub enum StagedUpdate {
    UpToDate,
    Ready(PathBuf),
}

/// 1–2: fetch manifest, download MSI to `ProgramData` staging, verify signature.
pub async fn download_update_msi_to_staging() -> Result<StagedUpdate> {
    let latest = manifest::fetch_latest_info().await?;
    let current = env!("CARGO_PKG_VERSION");
    let pub_v = latest.version.trim_start_matches('v');
    let run_v = current.trim_start_matches('v');
    if pub_v == run_v {
        info!(
            "Updater: published {} matches this build {}; nothing to download.",
            latest.version, current
        );
        return Ok(StagedUpdate::UpToDate);
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
    verify::verify_msi_signature(&bytes, &latest.signature)?;
    if msi_path.exists() {
        let _ = tokio::fs::remove_file(&msi_path).await;
    }
    tokio::fs::rename(&tmp_path, &msi_path).await?;

    info!("Updater: verified MSI staged at {}", msi_path.display());
    Ok(StagedUpdate::Ready(msi_path))
}
