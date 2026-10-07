//! The service's named-pipe listeners: DACLs scoped to the console user, and
//! caller identification for privileged requests.

use std::sync::OnceLock;
use std::time::Duration;

use tracing::warn;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};

use super::to_wide_z;
use crate::ipc::{AGENT_IPC_PIPE_NAME, SERVICE_PIPE_NAME};

/// Responses must end with `\n` so the user-session client can `read_until` without waiting for EOF.
pub(super) fn service_pipe_reply(json: serde_json::Value) -> String {
    let mut s = json.to_string();
    s.push('\n');
    s
}

/// Serialize work so concurrent pipe requests don't overlap `msiexec` / netsh calls.
pub(super) fn service_job_mutex() -> &'static tokio::sync::Mutex<()> {
    static M: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    M.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Default named-pipe DACL only allows the creator (`LocalSystem`). The user-session agent
/// connects without elevation, so we grant read/write to SYSTEM, admins, and the active
/// console-user SID only. We deliberately do NOT grant Authenticated Users when the SID resolves,
/// so arbitrary logged-in processes can't poke the privileged service pipe.
fn create_vantyr_service_pipe_server(
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::ffi::c_void;
    use std::io;
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut p_sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let user_sid = active_console_user_sid_string();
    let sddl = if let Some(ref sid) = user_sid {
        format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{sid})")
    } else {
        // Last resort only: without the console-user SID the user-session agent couldn't connect.
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
    // Grant the console-user SID only; omit Authenticated Users so other logged-in
    // processes can't connect. AU is kept solely as a fallback when the SID can't be resolved.
    let sddl = if let Some(ref sid) = user_sid {
        format!("D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{sid})")
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

/// Full image path of the process on the other end of a connected named pipe.
fn pipe_client_image_path(
    pipe: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> Result<std::path::PathBuf, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let pipe_handle = HANDLE(pipe.as_raw_handle());
    let mut pid: u32 = 0;
    unsafe { GetNamedPipeClientProcessId(pipe_handle, &raw mut pid) }
        .map_err(|e| format!("GetNamedPipeClientProcessId: {e}"))?;

    let proc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|e| format!("OpenProcess({pid}): {e}"))?;

    let mut buf = vec![0u16; 1024];
    let mut size = buf.len() as u32;
    let res = unsafe {
        QueryFullProcessImageNameW(
            proc,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &raw mut size,
        )
    };
    let _ = unsafe { CloseHandle(proc) };
    res.map_err(|e| format!("QueryFullProcessImageNameW: {e}"))?;
    buf.truncate(size as usize);
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(&buf)))
}

/// Whether the pipe caller is one of our own agent binaries (same image as this SYSTEM service).
/// Privileged service-pipe actions (`set_network_policy`, `clear_log_file`) require this, so a
/// non-agent process that obtains a pipe handle can't drive network/log changes.
pub(super) fn pipe_caller_is_trusted_agent(
    pipe: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> bool {
    let client = match pipe_client_image_path(pipe) {
        Ok(p) => p,
        Err(e) => {
            warn!("Service pipe: cannot identify caller image; denying privileged action: {e}");
            return false;
        }
    };
    let Ok(expected) = std::env::current_exe() else {
        warn!("Service pipe: current_exe() failed; denying privileged action.");
        return false;
    };
    let norm = |p: &std::path::Path| {
        p.canonicalize()
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .to_lowercase()
    };
    norm(&client) == norm(&expected)
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

pub(super) fn ensure_agent_ipc_pipe_server() -> tokio::net::windows::named_pipe::NamedPipeServer {
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
pub(super) fn ensure_vantyr_service_pipe_server() -> tokio::net::windows::named_pipe::NamedPipeServer
{
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
