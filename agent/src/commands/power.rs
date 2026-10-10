//! Host power commands: lock, restart and shut down. Each runs the OS tool on the
//! blocking pool so the command dispatcher (the session's select loop) is not held up
//! while the process starts.

use tracing::{info, warn};

pub(super) fn lock_host() {
    tokio::task::spawn_blocking(|| match crate::platform::system_control::lock_host() {
        Ok(()) => info!("Received LockHost command; workstation locked."),
        Err(e) => warn!("LockHost command failed: {e}"),
    });
}

pub(super) fn restart_host() {
    tokio::task::spawn_blocking(|| match crate::platform::system_control::restart_host() {
        Ok(()) => info!("Received RestartHost command; restart initiated."),
        Err(e) => warn!("RestartHost command failed: {e}"),
    });
}

pub(super) fn shutdown_host() {
    tokio::task::spawn_blocking(|| match crate::platform::system_control::shutdown_host() {
        Ok(()) => info!("Received ShutdownHost command; shutdown initiated."),
        Err(e) => warn!("ShutdownHost command failed: {e}"),
    });
}
