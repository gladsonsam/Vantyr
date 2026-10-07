//! Windows service (`--service`, LocalSystem, Session 0).
//!
//! Owns the agent WebSocket, keeps the user-session companion and the SYSTEM
//! capture worker running in the console session, and serves two named pipes:
//! the persistent companion IPC pipe and the one-shot privileged request pipe.
//!
//! - [`scm`]: Service Control Manager entry point and status reporting.
//! - [`pipe_server`]: pipe listeners, DACLs and caller identification.
//! - [`session_launch`]: process launch into the console session.
//! - [`msi_install`]: running a staged update MSI.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::mpsc;
use std::time::Duration;

use tokio::sync::watch;
use tokio::sync::{broadcast, mpsc as tokio_mpsc};
use tracing::{info, warn};
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};

use crate::ipc::{ServiceRequest, MAX_SERVICE_PIPE_LINE};

mod msi_install;
mod pipe_server;
mod scm;
mod session_launch;

pub use scm::{run_windows_service, set_service_log_guard};

use msi_install::{
    kill_vantyr_user_processes_best_effort, launch_msi_detached, trusted_staged_msi_path,
};
use pipe_server::{
    ensure_agent_ipc_pipe_server, ensure_vantyr_service_pipe_server, pipe_caller_is_trusted_agent,
    service_job_mutex, service_pipe_reply,
};
use scm::{exit_service_process_for_msi_update, SERVICE_NAME, SERVICE_STATUS_HANDLE_FOR_MSI_EXIT};
use session_launch::{
    enable_privileges, launch_capture_worker_in_session, launch_user_agent_in_session,
};

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
    let status_handle =
        service_control_handler::register(SERVICE_NAME, move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                info!("Service stop requested ({:?}).", control);
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })?;
    let _ = SERVICE_STATUS_HANDLE_FOR_MSI_EXIT.set(status_handle);

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    info!("Service started; waiting for user sessions and update requests.");
    let mut launched_for_session: Option<u32> = None;
    // The SYSTEM capture worker is launched into the console session separately:
    // it does not need a signed-in user (so it is present at the lock/sign-in
    // screen), whereas the user-session companion does.
    let mut worker_launched_for_session: Option<u32> = None;

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(windows_service::Error::Winapi)?;

    rt.block_on(async move {
        use std::os::windows::process::CommandExt;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;

        // WebSocket owner (Session 0): accepts frames from user-session companion via IPC
        // and forwards to the server, while also staying online at lock screen.
        let ws_status: std::sync::Arc<std::sync::Mutex<crate::config::AgentStatus>> =
            std::sync::Arc::new(std::sync::Mutex::new(crate::config::AgentStatus::Disconnected));
        let shared_cfg = std::sync::Arc::new(std::sync::Mutex::new(crate::config::load_config()));
        let (ws_stop_tx, ws_stop_rx) = watch::channel(false);
        let (config_changed_tx, config_changed_rx) = watch::channel(0_u64);
        let (to_ws_tx, to_ws_rx) = tokio_mpsc::channel::<crate::ipc::OutboundFrame>(1024);
        let (from_ws_tx, _from_ws_rx_unused) = broadcast::channel::<String>(256);
        let clipboard_routes = std::sync::Arc::new(std::sync::Mutex::new(crate::clipboard_session::Routes::default()));
        tokio::spawn(crate::ws_client::run_ws_client(
            shared_cfg.clone(),
            ws_status.clone(),
            to_ws_rx,
            from_ws_tx.clone(),
            ws_stop_rx,
            config_changed_rx,
            crate::ws_client::WsClientOpts::default(),
        ));

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

            // Keep the user companion and the SYSTEM capture worker running in the
            // active console session.
            let active_session = unsafe { WTSGetActiveConsoleSessionId() };
            if active_session == u32::MAX {
                // No console session attached (e.g. RDP-only / transitioning).
                launched_for_session = None;
                worker_launched_for_session = None;
            } else {
                // User-session companion: only possible once a user is signed in
                // (WTSQueryUserToken). Retries every tick until then.
                if launched_for_session != Some(active_session) {
                    match launch_user_agent_in_session(active_session) {
                        Ok(()) => {
                            launched_for_session = Some(active_session);
                            info!("Launched agent process in user session {active_session}.");
                        }
                        Err(e) => {
                            warn!("Failed launching agent in session {active_session}: {e:#}");
                        }
                    }
                }

                // SYSTEM capture worker: launched with the service's own token
                // retargeted at the console session, so it comes up at the
                // sign-in/lock screen before any user token exists.
                if worker_launched_for_session != Some(active_session) {
                    match launch_capture_worker_in_session(active_session) {
                        Ok(()) => {
                            worker_launched_for_session = Some(active_session);
                            info!("Launched SYSTEM capture worker in session {active_session}.");
                        }
                        Err(e) => warn!(
                            "Failed launching capture worker in session {active_session}: {e:#}"
                        ),
                    }
                }
            }

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
                        // below are refused unless the caller is one of our own agent binaries.
                        let caller_trusted = pipe_caller_is_trusted_agent(&pipe);

                        tokio::spawn(async move {
                            let mut reader = BufReader::new(pipe);
                            let mut buf = Vec::new();
                            match reader.read_until(b'\n', &mut buf).await {
                                Ok(0) => {
                                    warn!("Service pipe: EOF before request line");
                                    let mut pipe = reader.into_inner();
                                    let resp = service_pipe_reply(serde_json::json!({
                                        "ok": false,
                                        "error": "empty service pipe request",
                                    }));
                                    let _ = pipe.write_all(resp.as_bytes()).await;
                                    let _ = pipe.flush().await;
                                    return;
                                }
                                Ok(_) => {}
                                Err(e) => {
                                    warn!("Service pipe: read failed: {e:#}");
                                    let mut pipe = reader.into_inner();
                                    let resp = service_pipe_reply(serde_json::json!({
                                        "ok": false,
                                        "error": format!("pipe read: {e:#}"),
                                    }));
                                    let _ = pipe.write_all(resp.as_bytes()).await;
                                    let _ = pipe.flush().await;
                                    return;
                                }
                            }
                            while matches!(buf.last().copied(), Some(b'\n' | b'\r')) {
                                buf.pop();
                            }
                            if buf.is_empty() {
                                warn!("Service pipe: empty request line");
                                let mut pipe = reader.into_inner();
                                    let resp = service_pipe_reply(serde_json::json!({
                                        "ok": false,
                                        "error": "empty service pipe request",
                                    }));
                                let _ = pipe.write_all(resp.as_bytes()).await;
                                let _ = pipe.flush().await;
                                return;
                            }
                            if buf.len() > MAX_SERVICE_PIPE_LINE {
                                warn!("Service pipe: request line too large ({})", buf.len());
                                let mut pipe = reader.into_inner();
                                    let resp = service_pipe_reply(serde_json::json!({
                                        "ok": false,
                                        "error": "service pipe request too large",
                                    }));
                                let _ = pipe.write_all(resp.as_bytes()).await;
                                let _ = pipe.flush().await;
                                return;
                            }

                            let v: serde_json::Value = match serde_json::from_slice(&buf) {
                                Ok(v) => v,
                                Err(e) => {
                                    let mut pipe = reader.into_inner();
                                    let resp = service_pipe_reply(serde_json::json!({
                                        "ok": false,
                                        "error": format!("invalid JSON on service pipe: {e}"),
                                    }));
                                    let _ = pipe.write_all(resp.as_bytes()).await;
                                    let _ = pipe.flush().await;
                                    return;
                                }
                            };
                            let mut pipe = reader.into_inner();
                            let action = v
                                .get("action")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let request = serde_json::from_value::<ServiceRequest>(v);

                            let _job = service_job_mutex().lock().await;

                            // Reply on the pipe before starting msiexec so StopServices cannot tear
                            // down the runtime before the client reads the line.
                            let mut msi_to_run_after_reply: Option<std::path::PathBuf> = None;

                            let resp = match request {
                                Ok(ServiceRequest::InstallMsi { msi_path }) => {
                                    if msi_path.is_empty() {
                                        serde_json::json!({
                                            "ok": false,
                                            "error": "install_msi requires msi_path",
                                        })
                                        .to_string()
                                    } else {
                                        let p = std::path::PathBuf::from(msi_path);
                                        match trusted_staged_msi_path(&p) {
                                            Ok(canon) => {
                                                msi_to_run_after_reply = Some(canon);
                                                serde_json::json!({
                                                    "ok": true,
                                                    "status": "install_started",
                                                })
                                                .to_string()
                                            }
                                            Err(e) => serde_json::json!({"ok": false, "error": format!("{e:#}")})
                                                .to_string(),
                                        }
                                    }
                                }
                                Ok(ServiceRequest::SetNetworkPolicy { generation, blocked, server_hostname: hostname, server_port: port }) => {
                                if !caller_trusted {
                                    serde_json::json!({"ok": false, "error": "unauthorized caller"}).to_string()
                                } else {
                                // Run netsh from the SYSTEM service so no elevation prompt is needed.
                                let lease=generation.map(crate::permissions::WorkerLease::new);
                                let result = tokio::task::spawn_blocking(move || {
                                    let _lease=lease;
                                    if blocked && !generation.is_some_and(|g|g.module==crate::permissions::Module::NetworkPolicy && g.valid_fresh()) {
                                        Err(anyhow::anyhow!("network policy not locally authorized"))
                                    } else if blocked {
                                        crate::network_policy::apply_block(&hostname, port)
                                    } else {
                                        crate::network_policy::remove_block()
                                    }
                                }).await;
                                match result {
                                    Ok(Ok(())) => serde_json::json!({"ok": true}).to_string(),
                                    Ok(Err(e)) => serde_json::json!({"ok": false, "error": format!("{e:#}")}).to_string(),
                                    Err(e) => serde_json::json!({"ok": false, "error": format!("spawn_blocking: {e}")}).to_string(),
                                }
                                }
                                }
                                Ok(ServiceRequest::ClearLogFile { kind }) => {
                                if !caller_trusted {
                                    serde_json::json!({"ok": false, "error": "unauthorized caller"}).to_string()
                                } else {
                                let kind = kind.trim();
                                if kind.is_empty() {
                                    serde_json::json!({"ok": false, "error": "clear_log_file requires kind"}).to_string()
                                } else {
                                    // Allowlisted kinds only; never an arbitrary path.
                                    match crate::log_sources::resolve_fixed_log_kind(kind) {
                                        Err(e) => serde_json::json!({"ok": false, "error": e}).to_string(),
                                        Ok(path) => {
                                            // Truncate from the SYSTEM service so ownership/ACL doesn't block the user UI.
                                            match std::fs::OpenOptions::new().write(true).truncate(true).open(&path) {
                                                Ok(_) => serde_json::json!({"ok": true}).to_string(),
                                                Err(e) => serde_json::json!({"ok": false, "error": format!("Could not clear log: {e}")}).to_string(),
                                            }
                                        }
                                    }
                                }
                                }
                                }
                                Err(_) if !ServiceRequest::ACTIONS.contains(&action.as_str()) => {
                                    serde_json::json!({
                                        "ok": false,
                                        "error": format!("unknown pipe action: {action:?}"),
                                    })
                                    .to_string()
                                }
                                Err(e) => serde_json::json!({
                                    "ok": false,
                                    "error": format!("invalid {action} request: {e}"),
                                })
                                .to_string(),
                            };

                            let mut resp = resp;
                            if !resp.ends_with('\n') {
                                resp.push('\n');
                            }
                            let _ = pipe.write_all(resp.as_bytes()).await;
                            let _ = pipe.flush().await;
                            if msi_to_run_after_reply.is_some() {
                                info!("Updater: pipe reply flushed; starting msiexec");
                            }

                            if let Some(msi_path) = msi_to_run_after_reply {
                                match launch_msi_detached(&msi_path) {
                                    Ok(()) => {
                                        kill_vantyr_user_processes_best_effort();
                                        info!("Updater: exiting service process for MSI install");
                                        exit_service_process_for_msi_update();
                                    }
                                    Err(e) => {
                                        warn!(
                                            "Updater: msiexec spawn failed after pipe reply; client may have exited ({e:#})"
                                        );
                                    }
                                }
                            }
                        });
                    }
                }
                res = agent_ipc_server.connect() => {
                    if let Err(e) = res {
                        warn!("Agent IPC pipe connect failed: {e}");
                        agent_ipc_server = ensure_agent_ipc_pipe_server();
                    } else {
                        let pipe = agent_ipc_server;
                        agent_ipc_server = ensure_agent_ipc_pipe_server();
                        let to_ws_tx = to_ws_tx.clone();
                        let shared_cfg = shared_cfg.clone();
                        let config_changed_tx = config_changed_tx.clone();
                        let mut cmd_rx = from_ws_tx.subscribe();
                        let ws_status = ws_status.clone();
                        let clipboard_routes = clipboard_routes.clone();
                        let clipboard_client = uuid::Uuid::new_v4();
                        let clipboard_trusted = pipe_caller_is_trusted_agent(&pipe);

                        tokio::spawn(async move {
                            let _clipboard_connection = crate::clipboard_session::ConnectionGuard {
                                client: clipboard_client, routes: clipboard_routes.clone(),
                            };
                            let mut clipboard_ticker = tokio::time::interval(Duration::from_millis(20));
                            let mut reader = BufReader::new(pipe);
                            let mut buf = Vec::new();
                            let mut status_ticker =
                                tokio::time::interval(Duration::from_millis(900));
                            status_ticker.set_missed_tick_behavior(
                                tokio::time::MissedTickBehavior::Skip,
                            );
                            let mut last_status_line = String::new();
                            loop {
                                tokio::select! {
                                    // `read_until` appends, so keeping `buf` across iterations makes this
                                    // branch cancel-safe: a partial line survives when another branch wins.
                                    res = reader.read_until(b'\n', &mut buf) => {
                                        match res {
                                            Ok(0) => break,
                                            Ok(_) => {}
                                            Err(e) => {
                                                warn!("Agent IPC pipe read failed: {e:#}");
                                                break;
                                            }
                                        }
                                        let mut buf = std::mem::take(&mut buf);
                                        while matches!(buf.last().copied(), Some(b'\n' | b'\r')) { buf.pop(); }
                                        if buf.is_empty() { continue; }

                                        if let Some(line) = crate::ipc::IpcLine::from_slice(&buf) {
                                            match line {
                                                crate::ipc::IpcLine::ConfigChanged => {
                                                    // Reload machine config so WS URL/auth changes apply without service restart.
                                                    if let Ok(mut g) = shared_cfg.lock() {
                                                        *g = crate::config::load_config();
                                                    }
                                                    let next = {
                                                        let current = *config_changed_tx.borrow();
                                                        current.wrapping_add(1)
                                                    };
                                                    let _ = config_changed_tx.send(next);
                                                }
                                                crate::ipc::IpcLine::PersistConfig { config } => {
                                                    // The unprivileged user session can't write %ProgramData%\Vantyr;
                                                    // persist on its behalf with the service's SYSTEM rights. Do NOT
                                                    // bump `config_changed` here: policy/UI-password/auto-update pushes
                                                    // don't affect the service-owned WS connection, and the server
                                                    // re-pushes them on every connect — reconnecting on each would
                                                    // flap the socket. Connection-relevant changes (URL/token) arrive
                                                    // with a separate ConfigChanged nudge that does reload + reconnect.
                                                    match crate::config::save_config(&config) {
                                                        Ok(()) => {
                                                            if let Ok(mut g) = shared_cfg.lock() {
                                                                *g = *config;
                                                            }
                                                            info!("Persisted machine config on behalf of user session.");
                                                        }
                                                        Err(e) => warn!(
                                                            "Failed to persist config from user session: {e:#}"
                                                        ),
                                                    }
                                                }
                                                other => {
                                                    if let Some(frame) = other.into_outbound() {
                                                        if let crate::ipc::OutboundFrame::Text(ref text) = frame {
                                                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                                                                if crate::clipboard_session::contains_result(&value) {
                                                                    // Kernel-derived pipe identity, not fields supplied by the companion.
                                                                    let session = if clipboard_trusted { crate::clipboard_session::pipe_user_session(reader.get_ref()) } else { None };
                                                                    let allowed = clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).result_allowed(
                                                                        &value, clipboard_client, session,
                                                                        crate::clipboard_session::active_console(), crate::clipboard_session::now_ms());
                                                                    if allowed && crate::clipboard_session::console_current(&value) {
                                                                        // Never wait with sensitive content queued behind telemetry.
                                                                        let _ = to_ws_tx.try_send(frame);
                                                                    }
                                                                    continue;
                                                                }
                                                            }
                                                        }
                                                        let _ = to_ws_tx.send(frame).await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    cmd = cmd_rx.recv() => {
                                        match cmd {
                                            Ok(text) => {
                                                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue; };
                                                // Only clipboard routing consults the pipe identity; skip the Win32 lookups for input/telemetry.
                                                let routed = matches!(value["type"].as_str(), Some("ClipboardRead" | "ClipboardWrite" | "ClipboardCancel"));
                                                let session = if clipboard_trusted && routed { crate::clipboard_session::pipe_user_session(reader.get_ref()) } else { None };
                                                let allowed = clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).command_allowed(
                                                    &value, clipboard_client, session,
                                                    crate::clipboard_session::active_console(), crate::clipboard_session::now_ms());
                                                // Filter BEFORE any bytes (including write text) reach the pipe.
                                                if !allowed { continue; }
                                                let clipboard = matches!(value["type"].as_str(),Some("ClipboardRead" | "ClipboardWrite"));
                                                let pipe = reader.get_mut();
                                                let mut s = text;
                                                s.push('\n');
                                                if clipboard {
                                                    let id = value["request_id"].as_str().and_then(|id|id.parse::<uuid::Uuid>().ok()).unwrap();
                                                    let deadline = value["__clipboard_deadline_ms"].as_u64().unwrap_or(0);
                                                    let remaining = deadline.saturating_sub(crate::clipboard_session::now_ms());
                                                    let result = tokio::select! {
                                                        result = tokio::time::timeout(Duration::from_millis(remaining), pipe.write_all(s.as_bytes())) => matches!(result,Ok(Ok(()))),
                                                        _ = async { loop {
                                                            tokio::time::sleep(Duration::from_millis(20)).await;
                                                            if !clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).owns(id,clipboard_client,session,
                                                                crate::clipboard_session::active_console(),crate::clipboard_session::now_ms()) { break; }
                                                        }} => false,
                                                    };
                                                    if !result { break; }
                                                } else if let Err(e) = pipe.write_all(s.as_bytes()).await {
                                                    warn!("Agent IPC pipe write failed: {e:#}");
                                                    break;
                                                }
                                                let _ = pipe.flush().await;
                                            }
                                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                                            Err(broadcast::error::RecvError::Closed) => break,
                                        }
                                    }
                                    _ = clipboard_ticker.tick() => {
                                        clipboard_routes.lock().unwrap_or_else(|e|e.into_inner()).refresh(
                                            crate::clipboard_session::active_console(),crate::clipboard_session::now_ms());
                                    }
                                    _ = status_ticker.tick() => {
                                        let status_snapshot = ws_status
                                            .lock()
                                            .map(|s| s.clone())
                                            .unwrap_or_else(|e| e.into_inner().clone());
                                        let line = crate::ipc::IpcLine::ws_status(&status_snapshot).to_line();
                                        if line != last_status_line {
                                            let pipe = reader.get_mut();
                                            if let Err(e) = pipe.write_all(line.as_bytes()).await {
                                                warn!("Agent IPC status write failed: {e:#}");
                                                break;
                                            }
                                            let _ = pipe.flush().await;
                                            last_status_line = line;
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        // Stop user agent best-effort.
        let _ = std::process::Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW.0)
            .args(["/F", "/IM", "Vantyr Agent.exe"])
            .status();
        let _ = std::process::Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW.0)
            .args(["/F", "/IM", "vantyr-agent.exe"])
            .status();
    });

    status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    })?;

    info!("Service stopped.");
    Ok(())
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
