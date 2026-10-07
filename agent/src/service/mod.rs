//! Windows service (`--service`, LocalSystem, Session 0).
//!
//! Owns the agent WebSocket, keeps the user-session companion and the SYSTEM
//! capture worker running in the console session, and serves two named pipes:
//! the persistent companion IPC pipe and the one-shot privileged request pipe.
//!
//! - [`scm`]: Service Control Manager entry point and status reporting.
//! - [`pipe_server`]: pipe listeners, DACLs and caller identification.
//! - [`requests`]: the privileged request pipe ([`crate::ipc::ServiceRequest`]).
//! - [`companion`]: one companion connection on the IPC pipe.
//! - [`session_launch`]: process launch into the console session.
//! - [`msi_install`]: running a staged update MSI.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::sync::{broadcast, mpsc as tokio_mpsc};
use tracing::{info, warn};

mod companion;
mod msi_install;
mod pipe_server;
mod requests;
mod scm;
mod session_launch;

pub use scm::{run_windows_service, set_service_log_guard};

use pipe_server::{
    ensure_agent_ipc_pipe_server, ensure_vantyr_service_pipe_server, pipe_caller_is_trusted_agent,
};
use session_launch::{enable_privileges, ConsoleSessionProcesses};

fn run_service() -> windows_service::Result<()> {
    // Needed on some machines for CreateProcessAsUserW. `SeTcbPrivilege` is
    // additionally required to retarget a duplicated token at the console session
    // (SetTokenInformation/TokenSessionId) when launching the SYSTEM capture worker.
    if let Err(e) = enable_privileges(&[
        "SeIncreaseQuotaPrivilege",
        "SeAssignPrimaryTokenPrivilege",
        "SeTcbPrivilege",
    ]) {
        warn!("Failed enabling service privileges: {e:#}");
    }

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let status_handle = scm::register_control_handler(stop_tx)?;
    scm::report_running(status_handle)?;

    info!("Service started; waiting for user sessions and update requests.");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(windows_service::Error::Winapi)?;

    rt.block_on(serve(stop_rx));

    scm::report_stopped(status_handle)?;

    info!("Service stopped.");
    Ok(())
}

/// The service main loop: owns the WebSocket, keeps the console-session
/// processes running and accepts both pipes until the SCM asks us to stop.
async fn serve(stop_rx: mpsc::Receiver<()>) {
    // WebSocket owner (Session 0): accepts frames from user-session companion via IPC
    // and forwards to the server, while also staying online at lock screen.
    let ws_status: Arc<Mutex<crate::config::AgentStatus>> =
        Arc::new(Mutex::new(crate::config::AgentStatus::Disconnected));
    let shared_cfg = Arc::new(Mutex::new(crate::config::load_config()));
    let (ws_stop_tx, ws_stop_rx) = watch::channel(false);
    let (config_changed_tx, config_changed_rx) = watch::channel(0_u64);
    let (to_ws_tx, to_ws_rx) = tokio_mpsc::channel::<crate::ipc::OutboundFrame>(1024);
    let (from_ws_tx, _from_ws_rx_unused) = broadcast::channel::<String>(256);
    let clipboard_routes = Arc::new(Mutex::new(
        crate::input::clipboard::session::Routes::default(),
    ));
    tokio::spawn(crate::ws_client::run_ws_client(
        shared_cfg.clone(),
        ws_status.clone(),
        to_ws_rx,
        from_ws_tx.clone(),
        ws_stop_rx,
        config_changed_rx,
        crate::ws_client::WsClientOpts::default(),
    ));

    let mut session_processes = ConsoleSessionProcesses::default();

    // Create the next pipe instance synchronously after each accept so another client never
    // hits ERROR_PIPE_BUSY (231) while a long handler runs.
    let mut updater_server = ensure_vantyr_service_pipe_server();
    let mut agent_ipc_server = ensure_agent_ipc_pipe_server();

    loop {
        // Stop requested?
        match stop_rx.try_recv() {
            Ok(()) => {
                let _ = ws_stop_tx.send(true);
                break;
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {}
        }

        session_processes.ensure_running();

        tokio::select! {
            () = tokio::time::sleep(Duration::from_millis(250)) => {}
            res = updater_server.connect() => {
                if let Err(e) = res {
                    warn!("Named pipe connect failed: {e}");
                    updater_server = ensure_vantyr_service_pipe_server();
                } else {
                    let pipe = updater_server;
                    updater_server = ensure_vantyr_service_pipe_server();

                    // Identify the caller while the pipe is connected; privileged actions
                    // are refused unless the caller is one of our own agent binaries.
                    let caller_trusted = pipe_caller_is_trusted_agent(&pipe);

                    tokio::spawn(requests::handle_service_request(pipe, caller_trusted));
                }
            }
            res = agent_ipc_server.connect() => {
                if let Err(e) = res {
                    warn!("Agent IPC pipe connect failed: {e}");
                    agent_ipc_server = ensure_agent_ipc_pipe_server();
                } else {
                    let pipe = agent_ipc_server;
                    agent_ipc_server = ensure_agent_ipc_pipe_server();
                    let link = companion::CompanionLink {
                        to_ws_tx: to_ws_tx.clone(),
                        shared_cfg: shared_cfg.clone(),
                        config_changed_tx: config_changed_tx.clone(),
                        ws_status: ws_status.clone(),
                        clipboard_routes: clipboard_routes.clone(),
                        clipboard_client: uuid::Uuid::new_v4(),
                        clipboard_trusted: pipe_caller_is_trusted_agent(&pipe),
                    };
                    tokio::spawn(companion::serve_companion(pipe, link, from_ws_tx.subscribe()));
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    session_launch::stop_user_agents();
}

pub fn to_wide_z(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn program_data_path(filename: &str) -> std::path::PathBuf {
    let base = std::env::var_os("ProgramData").map_or_else(
        || std::path::PathBuf::from(r"C:\ProgramData"),
        std::path::PathBuf::from,
    );
    base.join("Vantyr").join(filename)
}
