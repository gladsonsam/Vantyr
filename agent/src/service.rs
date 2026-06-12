use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{error, info, warn};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::LUID;
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LookupPrivilegeValueW, SecurityImpersonation,
    TokenPrimary, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::Security::{GetTokenInformation, TokenUser};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    STARTUPINFOW,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{
    self, ServiceControlHandlerResult, ServiceStatusHandle,
};
use windows_service::service_dispatcher;

use std::sync::OnceLock;
use tokio::sync::watch;
use tokio::sync::{broadcast, mpsc as tokio_mpsc};

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
static SERVICE_STATUS_HANDLE_FOR_MSI_EXIT: OnceLock<ServiceStatusHandle> = OnceLock::new();

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

fn exit_service_process_for_msi_update() -> ! {
    report_service_stopped_to_scm_before_process_exit();
    flush_service_logs_before_exit();
    // Allow the non-blocking worker to finish writing after the guard shutdown signal.
    std::thread::sleep(Duration::from_millis(200));
    std::process::exit(0);
}

const SERVICE_NAME: &str = "VantyrAgentService";
windows_service::define_windows_service!(ffi_service_main, service_main);

/// Must match `PIPE_NAME` in `updater_client.rs`.
const SERVICE_PIPE_NAME: &str = r"\\.\pipe\VantyrAgentService";

/// Persistent duplex channel between the Session 0 service (WS owner) and the user-session companion.
const AGENT_IPC_PIPE_NAME: &str = r"\\.\pipe\VantyrAgentIpc";

/// Max bytes for one service JSON line (see `updater_client::pipe_request_line`).
const MAX_SERVICE_PIPE_LINE: usize = 256 * 1024;

/// Responses must end with `\n` so the user-session client can `read_until` without waiting for EOF.
fn service_pipe_reply(json: serde_json::Value) -> String {
    let mut s = json.to_string();
    s.push('\n');
    s
}

/// Serialize work so concurrent pipe requests don't overlap `msiexec` / netsh calls.
fn service_job_mutex() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Default named-pipe DACL only allows the creator (`LocalSystem`). The user-session agent
/// connects without elevation — grant authenticated users read/write so pipe calls work.
fn create_vantyr_service_pipe_server(
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::ffi::c_void;
    use std::io;
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut p_sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let user_sid = active_console_user_sid_string();
    // Always include AU (Authenticated Users) so the user-session agent can connect
    // even if WTSQueryUserToken fails. The specific console-user SID is additive.
    let sddl = if let Some(ref sid) = user_sid {
        format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)(A;;GRGW;;;{sid})")
    } else {
        warn!("Service pipe: could not resolve active console user SID; falling back to Authenticated Users.");
        "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)".to_string()
    };
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(to_wide_z(&sddl).as_ptr()),
            SDDL_REVISION_1,
            &raw mut p_sd,
            None,
        )
        .map_err(|e| io::Error::other(format!("service pipe SDDL: {e}")))?;
    }

    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: p_sd.0,
        bInheritHandle: false.into(),
    };

    let server = unsafe {
        ServerOptions::new()
            .create_with_security_attributes_raw(SERVICE_PIPE_NAME, (&raw mut sa).cast::<c_void>())
    };

    unsafe {
        if !p_sd.0.is_null() {
            let _ = LocalFree(Some(HLOCAL(p_sd.0)));
        }
    }

    server
}

fn create_agent_ipc_pipe_server(
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::ffi::c_void;
    use std::io;
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut p_sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let user_sid = active_console_user_sid_string();
    // Always include AU so the user-session companion can connect reliably.
    let sddl = if let Some(ref sid) = user_sid {
        format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)(A;;GRGW;;;{sid})")
    } else {
        warn!("Agent IPC pipe: could not resolve active console user SID; falling back to Authenticated Users.");
        "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)".to_string()
    };
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(to_wide_z(&sddl).as_ptr()),
            SDDL_REVISION_1,
            &raw mut p_sd,
            None,
        )
        .map_err(|e| io::Error::other(format!("agent ipc pipe SDDL: {e}")))?;
    }

    let mut sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: p_sd.0,
        bInheritHandle: false.into(),
    };

    let server = unsafe {
        ServerOptions::new().create_with_security_attributes_raw(
            AGENT_IPC_PIPE_NAME,
            (&raw mut sa).cast::<c_void>(),
        )
    };

    unsafe {
        if !p_sd.0.is_null() {
            let _ = LocalFree(Some(HLOCAL(p_sd.0)));
        }
    }

    server
}

fn active_console_user_sid_string() -> Option<String> {
    use std::ffi::c_void;

    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == u32::MAX {
        return None;
    }

    let mut token = HANDLE::default();
    unsafe { WTSQueryUserToken(session, &raw mut token) }.ok()?;

    // Query TokenUser to get the SID.
    let mut needed: u32 = 0;
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &raw mut needed);
    }
    if needed == 0 {
        let _ = unsafe { CloseHandle(token) };
        return None;
    }

    // Allocate and fetch.
    let mut buf = vec![0u8; needed as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast::<c_void>()),
            needed,
            &raw mut needed,
        )
        .is_ok()
    };
    let _ = unsafe { CloseHandle(token) };
    if !ok {
        return None;
    }

    // SAFETY: buffer contains TOKEN_USER.
    let tu = unsafe { &*buf.as_ptr().cast::<windows::Win32::Security::TOKEN_USER>() };
    let mut sid_str: PWSTR = PWSTR::null();
    let sid_ok = unsafe { ConvertSidToStringSidW(tu.User.Sid, &raw mut sid_str).is_ok() };
    if !sid_ok || sid_str.is_null() {
        return None;
    }
    // Convert wide string to Rust String.
    let mut len = 0usize;
    unsafe {
        while *sid_str.0.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(sid_str.0, len);
        let s = String::from_utf16_lossy(slice);
        let _ = LocalFree(Some(HLOCAL(sid_str.0.cast())));
        Some(s)
    }
}

fn ensure_agent_ipc_pipe_server() -> tokio::net::windows::named_pipe::NamedPipeServer {
    let mut attempts = 0u32;
    loop {
        match create_agent_ipc_pipe_server() {
            Ok(s) => return s,
            Err(e) => {
                attempts += 1;
                if attempts == 1 || attempts.is_multiple_of(25) {
                    warn!("Failed to create agent IPC pipe (attempt {attempts}): {e}");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// Create a listening pipe instance, blocking until it succeeds.
///
/// Must stay **synchronous** (no `.await`) when replacing the listener after a client connects:
/// otherwise the current-thread runtime spends whole minutes inside a pipe handler
/// without ever polling `connect()` on the new instance → clients see error 231 (pipe busy).
fn ensure_vantyr_service_pipe_server() -> tokio::net::windows::named_pipe::NamedPipeServer {
    let mut attempts = 0u32;
    loop {
        match create_vantyr_service_pipe_server() {
            Ok(s) => return s,
            Err(e) => {
                attempts += 1;
                if attempts == 1 || attempts.is_multiple_of(25) {
                    warn!("Failed to create named pipe (attempt {attempts}): {e}");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

pub fn run_windows_service() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

fn service_main(_arguments: Vec<std::ffi::OsString>) {
    if let Err(e) = run_service() {
        error!("Service terminated with error: {e:#}");
    }
}

fn run_service() -> windows_service::Result<()> {
    // Needed on some machines for CreateProcessAsUserW.
    if let Err(e) =
        enable_privileges(&["SeIncreaseQuotaPrivilege", "SeAssignPrimaryTokenPrivilege"])
    {
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

            // Keep user-agent running in the active session.
            let active_session = unsafe { WTSGetActiveConsoleSessionId() };
            if active_session == u32::MAX {
                launched_for_session = None;
            } else if launched_for_session != Some(active_session) {
                match launch_user_agent_in_session(active_session) {
                    Ok(()) => {
                        launched_for_session = Some(active_session);
                        info!("Launched agent process in user session {active_session}.");
                    }
                    Err(e) => warn!("Failed launching agent in session {active_session}: {e:#}"),
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

                            let _job = service_job_mutex().lock().await;

                            // Reply on the pipe before starting msiexec so StopServices cannot tear
                            // down the runtime before the client reads the line.
                            let mut msi_to_run_after_reply: Option<std::path::PathBuf> = None;

                            let resp = if action == "install_msi" {
                                match v.get("msi_path").and_then(|x| x.as_str()) {
                                    None | Some("") => serde_json::json!({
                                        "ok": false,
                                        "error": "install_msi requires msi_path",
                                    })
                                    .to_string(),
                                    Some(path_str) => {
                                        let p = std::path::PathBuf::from(path_str);
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
                            } else if action == "set_network_policy" {
                                // Run netsh from the SYSTEM service so no elevation prompt is needed.
                                let blocked = v.get("blocked").and_then(serde_json::Value::as_bool).unwrap_or(false);
                                let hostname = v.get("server_hostname").and_then(|x| x.as_str()).unwrap_or("").to_string();
                                let port = v.get("server_port").and_then(serde_json::Value::as_u64).unwrap_or(443) as u16;
                                let result = tokio::task::spawn_blocking(move || {
                                    if blocked {
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
                            } else if action == "clear_log_file" {
                                let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                                if kind.is_empty() {
                                    serde_json::json!({"ok": false, "error": "clear_log_file requires kind"}).to_string()
                                } else {
                                    fn resolve(kind: &str) -> Result<std::path::PathBuf, String> {
                                        match kind {
                                            // Keep this allowlisted; do not accept arbitrary paths.
                                            "local_agent" => Ok(crate::config::program_data_vantyr_dir().join("agent.log")),
                                            "user_agent" => Ok(crate::config::program_data_vantyr_dir().join("user-agent.log")),
                                            "service" => Ok(crate::config::program_data_vantyr_dir().join("service.log")),
                                            _ => Err(format!("unknown log source: {kind}")),
                                        }
                                    }
                                    match resolve(&kind) {
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
                            } else {
                                serde_json::json!({
                                    "ok": false,
                                    "error": format!("unknown pipe action: {action:?}"),
                                })
                                .to_string()
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

                        tokio::spawn(async move {
                            let mut reader = BufReader::new(pipe);
                            let mut buf = Vec::new();
                            let mut status_ticker =
                                tokio::time::interval(Duration::from_millis(900));
                            status_ticker.set_missed_tick_behavior(
                                tokio::time::MissedTickBehavior::Skip,
                            );
                            let mut last_status_line = String::new();
                            loop {
                                buf.clear();
                                tokio::select! {
                                    res = reader.read_until(b'\n', &mut buf) => {
                                        match res {
                                            Ok(0) => break,
                                            Ok(_) => {}
                                            Err(e) => {
                                                warn!("Agent IPC pipe read failed: {e:#}");
                                                break;
                                            }
                                        }
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
                                                other => {
                                                    if let Some(frame) = other.into_outbound() {
                                                        let _ = to_ws_tx.send(frame).await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    cmd = cmd_rx.recv() => {
                                        match cmd {
                                            Ok(text) => {
                                                let pipe = reader.get_mut();
                                                let mut s = text;
                                                s.push('\n');
                                                if let Err(e) = pipe.write_all(s.as_bytes()).await {
                                                    warn!("Agent IPC pipe write failed: {e:#}");
                                                    break;
                                                }
                                                let _ = pipe.flush().await;
                                            }
                                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                                            Err(broadcast::error::RecvError::Closed) => break,
                                        }
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

fn launch_user_agent_in_session(session_id: u32) -> Result<()> {
    let mut impersonation_token = HANDLE::default();
    unsafe { WTSQueryUserToken(session_id, &raw mut impersonation_token) }
        .ok()
        .context("WTSQueryUserToken failed")?;

    let mut primary_token = HANDLE::default();
    let access: TOKEN_ACCESS_MASK = TOKEN_ASSIGN_PRIMARY
        | TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    unsafe {
        DuplicateTokenEx(
            impersonation_token,
            access,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &raw mut primary_token,
        )
    }
    .ok()
    .context("DuplicateTokenEx failed")?;

    let creation_flags: PROCESS_CREATION_FLAGS = CREATE_UNICODE_ENVIRONMENT;

    let exe = std::env::current_exe().context("Cannot resolve current executable path")?;
    // Force user-agent logs into a stable location so service-started failures are visible.
    let user_log = program_data_path("user-agent.log");
    let cmdline = format!(
        "\"{}\" --log-file \"{}\"",
        exe.display(),
        user_log.display()
    );
    let mut cmdline_w = to_wide_z(&cmdline);
    let desktop_w = to_wide_z("winsta0\\default");

    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop_w.as_ptr().cast_mut()),
        ..Default::default()
    };

    // Critical: CreateEnvironmentBlock supplies the user profile (incl. LOCALAPPDATA for WebView2).
    // Agent config and MSI staging live under ProgramData, not AppData.
    // When launched from LocalSystem, we must build an environment block for the target user.
    let mut env_block: *mut core::ffi::c_void = std::ptr::null_mut();
    unsafe { CreateEnvironmentBlock(&raw mut env_block, Some(primary_token), false) }
        .ok()
        .context("CreateEnvironmentBlock failed")?;

    let mut proc_info = PROCESS_INFORMATION::default();
    let create_result = unsafe {
        CreateProcessAsUserW(
            Some(primary_token),
            PCWSTR::null(),
            Some(PWSTR(cmdline_w.as_mut_ptr())),
            None,
            None,
            false,
            creation_flags,
            Some(env_block),
            PCWSTR::null(),
            &raw const startup,
            &raw mut proc_info,
        )
    };

    let _ = unsafe { DestroyEnvironmentBlock(env_block) };

    if create_result.is_ok() {
        info!(
            "CreateProcessAsUserW succeeded (pid={}, session={}).",
            proc_info.dwProcessId, session_id
        );
    }

    let _ = unsafe { CloseHandle(proc_info.hProcess) };
    let _ = unsafe { CloseHandle(proc_info.hThread) };
    let _ = unsafe { CloseHandle(primary_token) };
    let _ = unsafe { CloseHandle(impersonation_token) };

    create_result.ok().context("CreateProcessAsUserW failed")?;
    Ok(())
}

pub fn to_wide_z(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Only MSIs under `%ProgramData%\\Vantyr\\updates` (same tree as [`crate::config::updates_staging_dir`]).
fn trusted_staged_msi_path(path: &std::path::Path) -> Result<std::path::PathBuf> {
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
fn kill_vantyr_user_processes_best_effort() {
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
fn launch_msi_detached(msi_path: &std::path::Path) -> Result<()> {
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

fn program_data_path(filename: &str) -> std::path::PathBuf {
    let base = std::env::var_os("ProgramData").map_or_else(
        || std::path::PathBuf::from(r"C:\ProgramData"),
        std::path::PathBuf::from,
    );
    base.join("Vantyr").join(filename)
}

fn enable_privileges(names: &[&str]) -> Result<()> {
    let mut token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &raw mut token,
        )
    }
    .ok()
    .context("OpenProcessToken failed")?;

    for &name in names {
        let mut luid = LUID::default();
        let name_w = to_wide_z(name);
        unsafe { LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(name_w.as_ptr()), &raw mut luid) }
            .ok()
            .with_context(|| format!("LookupPrivilegeValueW failed for {name}"))?;

        let tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [windows::Win32::Security::LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };

        unsafe { AdjustTokenPrivileges(token, false, Some(&raw const tp), 0, None, None) }
            .ok()
            .with_context(|| format!("AdjustTokenPrivileges failed for {name}"))?;
    }

    let _ = unsafe { CloseHandle(token) };
    Ok(())
}
