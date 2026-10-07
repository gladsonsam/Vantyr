//! Host power commands: lock, restart and shut down.

use tracing::{info, warn};

pub(super) fn lock_host() {
    match crate::platform::system_control::lock_host() {
        Ok(()) => info!("Received LockHost command; workstation locked."),
        Err(e) => warn!("LockHost command failed: {e}"),
    }
}

pub(super) fn restart_host() {
    match crate::platform::system_control::restart_host() {
        Ok(()) => info!("Received RestartHost command; restart initiated."),
        Err(e) => warn!("RestartHost command failed: {e}"),
    }
}

pub(super) fn shutdown_host() {
    match crate::platform::system_control::shutdown_host() {
        Ok(()) => info!("Received ShutdownHost command; shutdown initiated."),
        Err(e) => warn!("ShutdownHost command failed: {e}"),
    }
}
