//! Windows host roles: the Session 0 service, the SYSTEM capture worker, the
//! service-managed companion, and the Tauri settings UI.

use std::sync::{Arc, Mutex};

use tracing::{error, info};

use super::Launch;
use crate::config::{AgentStatus, Config};

/// `%ProgramData%\Vantyr\<filename>`: a stable, shared location for the logs of
/// the service and the processes it launches. `%ProgramData%` is writable for
/// LocalSystem and readable by admins.
fn program_data_log_path(filename: &str) -> std::path::PathBuf {
    crate::config::program_data_vantyr_dir().join(filename)
}

/// Run the `--service` or `--capture-worker` role, if requested. Returns `false`
/// when this process should run the agent itself.
pub(super) fn run_service_role(launch: &Launch) -> bool {
    if launch.flag("--service") {
        let log_guard = super::logging::init_logging(Some(program_data_log_path("service.log")));
        if let Some(g) = log_guard {
            super::service::set_service_log_guard(g);
        }
        info!("Vantyr agent v{}", env!("CARGO_PKG_VERSION"));
        info!("Starting in Windows service mode.");
        if let Err(e) = super::service::run_windows_service() {
            error!("Windows service failed: {e}");
        }
        return true;
    }

    // SYSTEM capture worker: launched by the service into the console session to
    // capture + drive the input desktop (including the lock/sign-in screen).
    // Distinct log file, no UI, no single-instance mutex (it coexists with the
    // user-session companion, which is the same binary).
    if launch.flag("--capture-worker") {
        let _log_guard =
            super::logging::init_logging(Some(program_data_log_path("capture-worker.log")));
        info!(
            "Vantyr agent v{} — capture worker (SYSTEM, session-attached).",
            env!("CARGO_PKG_VERSION")
        );
        super::role::set_role(super::role::AgentRole::CaptureWorker);
        crate::capture::worker::run();
        return true;
    }
    false
}

/// Set the companion role when launched by the service, and keep a single
/// interactive agent per machine.
pub(super) fn prepare_interactive(launch: &Launch) {
    // Companion launched by the service into the user session: user-context
    // telemetry only. Live capture + remote input are owned by the SYSTEM capture
    // worker, so suppress them here (see `role`) to avoid double-capturing.
    if launch.flag("--service-managed") {
        super::role::set_role(super::role::AgentRole::Companion);
        info!("Running as service-managed companion (capture/input delegated to worker).");
    }

    super::single_instance::enforce_single_instance();
}

/// `--show-ui`, `AGENT_SHOW_UI`, or a pending reopen after an in-app update.
pub(super) fn show_ui_on_startup(launch: &Launch) -> bool {
    launch.flag("--show-ui")
        || super::launch::env_flag("AGENT_SHOW_UI")
        || crate::config::take_reopen_settings_ui_after_restart()
}

pub(super) fn log_config_state() {
    info!(
        "Machine-wide config on disk (readable): {}",
        crate::config::machine_connection_policy_active()
    );
}

/// Tauri settings window (main thread; Tauri owns the event loop).
pub(super) fn run_ui(
    initial_config: Config,
    config_tx: tokio::sync::watch::Sender<Option<Config>>,
    shared_cfg: Arc<Mutex<Config>>,
    agent_status: Arc<Mutex<AgentStatus>>,
    show_ui_on_startup: bool,
) {
    super::ui::run_tauri(
        initial_config,
        config_tx,
        shared_cfg,
        agent_status,
        show_ui_on_startup,
    );
}
