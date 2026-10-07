//! Logs tab: list, tail, clear and reveal the agent's log files.

use crate::log_sources::LogSourceDesc;

#[tauri::command]
pub fn list_log_sources() -> Vec<LogSourceDesc> {
    crate::log_sources::list_log_sources()
}
#[tauri::command]
pub fn read_log_file_tail(kind: String, max_kb: Option<u32>) -> Result<String, String> {
    let max_bytes = (max_kb.unwrap_or(512).min(2048) as usize).saturating_mul(1024);
    let path = crate::log_sources::resolve_log_kind(kind.trim())?;
    crate::log_sources::read_log_tail_display(&path, max_bytes)
}
/// Truncate the specified log file to zero bytes.
/// Because the logger opens the file with `O_APPEND`, the next write will
/// automatically seek to position 0 (the new EOF), so no null-byte gap appears.
#[tauri::command]
pub async fn clear_log_file(kind: String) -> Result<(), String> {
    let path = crate::log_sources::resolve_log_kind(kind.trim())?;
    let res = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .map(|_| ());

    match res {
        Ok(()) => Ok(()),
        Err(e) => {
            // If a log is owned by the LocalSystem service (e.g. `service.log`), the
            // user-session settings UI may not have permission to truncate it.
            // Fall back to asking the service over the existing updater pipe.
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                crate::service_client::clear_log_file_via_service(kind.trim())
                    .await
                    .map_err(|e| format!("Could not clear log (via service): {e:#}"))?;
                return Ok(());
            }
            Err(format!("Could not clear log: {e}"))
        }
    }
}
/// Open Explorer on the log file (`explorer /select,<path>` highlights it).
#[tauri::command]
pub fn open_log_location(kind: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let path = crate::log_sources::resolve_log_kind(kind.trim())?;
    let select_arg = format!("/select,{}", path.display());
    std::process::Command::new("explorer.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .arg(&select_arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}
