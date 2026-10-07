//! Service Control Manager glue: dispatcher entry point, status reporting and
//! the process exit used when an MSI update replaces the service.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tracing::{error, info, warn};
use windows_service::service::{
    ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::ServiceStatusHandle;
use windows_service::service_dispatcher;

/// `std::process::exit` does not run `Drop`; `tracing_appender::non_blocking` only flushes when its
/// `WorkerGuard` is dropped. Register the guard from `--service` `main` so we can drop it before
/// `process::exit` during MSI self-update.
static SERVICE_LOG_GUARD: Mutex<Option<tracing_appender::non_blocking::WorkerGuard>> =
    Mutex::new(None);

pub fn set_service_log_guard(guard: tracing_appender::non_blocking::WorkerGuard) {
    let mut slot = SERVICE_LOG_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *slot = Some(guard);
}

fn flush_service_logs_before_exit() {
    let mut slot = SERVICE_LOG_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    slot.take();
}

/// Windows Installer / SCM may wait until the service reports `SERVICE_STOPPED` before continuing.
pub(super) static SERVICE_STATUS_HANDLE_FOR_MSI_EXIT: OnceLock<ServiceStatusHandle> =
    OnceLock::new();

fn report_service_stopped_to_scm_before_process_exit() {
    if let Some(h) = SERVICE_STATUS_HANDLE_FOR_MSI_EXIT.get() {
        let status = ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        };
        match h.set_service_status(status) {
            Ok(()) => info!("Updater: reported SERVICE_STOPPED to SCM."),
            Err(e) => warn!("Updater: could not report SERVICE_STOPPED before exit ({e:#}); MSI may appear idle."),
        }
    }
}

pub(super) fn exit_service_process_for_msi_update() -> ! {
    report_service_stopped_to_scm_before_process_exit();
    flush_service_logs_before_exit();
    // Allow the non-blocking worker to finish writing after the guard shutdown signal.
    std::thread::sleep(Duration::from_millis(200));
    std::process::exit(0);
}

pub(super) const SERVICE_NAME: &str = "VantyrAgentService";
windows_service::define_windows_service!(ffi_service_main, service_main);

pub fn run_windows_service() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

fn service_main(_arguments: Vec<std::ffi::OsString>) {
    if let Err(e) = super::run_service() {
        error!("Service terminated with error: {e:#}");
    }
}
