//! One interactive agent per machine (Windows): a named global mutex.

use tracing::{info, warn};

struct HeldHandle(#[allow(dead_code)] windows::Win32::Foundation::HANDLE);

// HANDLE is just a numeric/opaque OS handle. Holding it for process lifetime is safe.
unsafe impl Send for HeldHandle {}
unsafe impl Sync for HeldHandle {}

static USER_AGENT_MUTEX: std::sync::OnceLock<HeldHandle> = std::sync::OnceLock::new();

/// Exit if another interactive agent already holds the `Global\VantyrAgentMain`
/// mutex; otherwise hold it for the life of the process.
pub fn enforce_single_instance() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows::Win32::System::Threading::CreateMutexW;

    let name = crate::host::service::to_wide_z("Global\\VantyrAgentMain");
    let h: HANDLE = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.unwrap_or_default();
    if h.is_invalid() {
        warn!("CreateMutexW failed; continuing without single-instance guard.");
    } else {
        let err = unsafe { GetLastError() };
        if err == ERROR_ALREADY_EXISTS {
            let _ = unsafe { CloseHandle(h) };
            info!("Another Vantyr agent instance is already running; exiting.");
            std::process::exit(0);
        }
        // Keep mutex held for process lifetime.
        let _ = USER_AGENT_MUTEX.set(HeldHandle(h));
    }
}
