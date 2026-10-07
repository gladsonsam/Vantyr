//! Running a staged update MSI from the SYSTEM service.

use anyhow::{Context, Result};
use tracing::info;

use super::program_data_path;

/// Only MSIs under `%ProgramData%\\Vantyr\\updates` (same tree as [`crate::config::updates_staging_dir`]).
pub(super) fn trusted_staged_msi_path(path: &std::path::Path) -> Result<std::path::PathBuf> {
    use anyhow::bail;
    let meta =
        std::fs::metadata(path).with_context(|| format!("MSI not found at {}", path.display()))?;
    if !meta.is_file() {
        bail!("MSI path is not a regular file");
    }
    let canon = path
        .canonicalize()
        .with_context(|| format!("could not canonicalize {}", path.display()))?;
    if !msi_path_has_allowed_staging_prefix(&canon) {
        bail!("refusing msiexec outside staging dirs: {}", canon.display());
    }
    Ok(canon)
}

/// `canonicalize()` yields a `\\?\` verbatim path; `msiexec` is happier with a normal `C:\...` string.
fn msi_path_for_msiexec_argument(canon: &std::path::Path) -> std::path::PathBuf {
    let lossy = canon.as_os_str().to_string_lossy();
    if let Some(rest) = lossy.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        canon.to_path_buf()
    }
}

fn msi_path_has_allowed_staging_prefix(canon: &std::path::Path) -> bool {
    fn normalize_verbatim(p: &std::path::Path) -> String {
        let mut s = p.as_os_str().to_string_lossy().to_ascii_lowercase();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            s = rest.to_string();
        }
        s.replace('/', "\\")
    }

    let Ok(staging) = crate::config::updates_staging_dir().canonicalize() else {
        return false;
    };
    let prefix = normalize_verbatim(&staging);
    let mut prefix = prefix.trim_end_matches('\\').to_string();
    prefix.push('\\');

    let target = normalize_verbatim(canon);
    target.ends_with(".msi") && !target.contains("..") && target.starts_with(&prefix)
}

/// After the pipe reply is flushed; do not run while the updater client is still blocked on read.
/// Uses `spawn` without waiting so a wedged `taskkill` cannot block the service exit path.
pub(super) fn kill_vantyr_user_processes_best_effort() {
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    let _ = std::process::Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW.0)
        .args(["/F", "/IM", "Vantyr Agent.exe"])
        .spawn();
    let _ = std::process::Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW.0)
        .args(["/F", "/IM", "vantyr-agent.exe"])
        .spawn();
}

/// Spawn `%SystemRoot%\\System32\\msiexec.exe /i … /qn /norestart` (no wait on this thread).
/// Call only after the pipe reply is flushed; caller then exits the service process.
pub(super) fn launch_msi_detached(msi_path: &std::path::Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    let msi_arg = msi_path_for_msiexec_argument(msi_path);
    info!("Updater: launching MSI {}", msi_arg.display());

    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let msiexec = std::path::Path::new(&system_root)
        .join("System32")
        .join("msiexec.exe");

    // Log to ProgramData so silent update failures are diagnosable on locked-down systems.
    // Keep it stable (overwritten each run) to avoid unbounded growth.
    let log_path = program_data_path("msi-install.log");

    let _child = std::process::Command::new(&msiexec)
        .creation_flags(CREATE_NO_WINDOW.0)
        .arg("/i")
        .arg(&msi_arg)
        .args([
            // Silent install
            "/qn",
            "/norestart",
            // REINSTALL=* is wrong for MajorUpgrade installs (new ProductCode): MSI can exit 0 without
            // installing files (REMOVE=ALL, features Request Null).
            // Verbose MSI log
            "/l*v",
        ])
        .arg(log_path.as_os_str())
        .spawn()
        .context("msiexec spawn")?;
    info!("Updater: msiexec process started");
    Ok(())
}
