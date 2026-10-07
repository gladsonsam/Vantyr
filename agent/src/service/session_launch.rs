//! Launching the user-session companion and the SYSTEM capture worker into
//! the active console session.

use anyhow::{Context, Result};
use tracing::{info, warn};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LookupPrivilegeValueW, SecurityImpersonation,
    SetTokenInformation, TokenPrimary, TokenSessionId, SE_PRIVILEGE_ENABLED, TOKEN_ACCESS_MASK,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, OpenProcessToken, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
};

use super::{program_data_path, to_wide_z};

/// Which console session the companion and the capture worker were last
/// launched into.
#[derive(Default)]
pub(super) struct ConsoleSessionProcesses {
    launched_for_session: Option<u32>,
    // The SYSTEM capture worker is launched into the console session separately:
    // it does not need a signed-in user (so it is present at the lock/sign-in
    // screen), whereas the user-session companion does.
    worker_launched_for_session: Option<u32>,
}

impl ConsoleSessionProcesses {
    /// Keep the user companion and the SYSTEM capture worker running in the
    /// active console session. Called on every service loop tick.
    pub(super) fn ensure_running(&mut self) {
        let active_session = unsafe { WTSGetActiveConsoleSessionId() };
        if active_session == u32::MAX {
            // No console session attached (e.g. RDP-only / transitioning).
            self.launched_for_session = None;
            self.worker_launched_for_session = None;
            return;
        }

        // User-session companion: only possible once a user is signed in
        // (WTSQueryUserToken). Retries every tick until then.
        if self.launched_for_session != Some(active_session) {
            match launch_user_agent_in_session(active_session) {
                Ok(()) => {
                    self.launched_for_session = Some(active_session);
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
        if self.worker_launched_for_session != Some(active_session) {
            match launch_capture_worker_in_session(active_session) {
                Ok(()) => {
                    self.worker_launched_for_session = Some(active_session);
                    info!("Launched SYSTEM capture worker in session {active_session}.");
                }
                Err(e) => {
                    warn!("Failed launching capture worker in session {active_session}: {e:#}")
                }
            }
        }
    }
}

/// Stop the user-session agents best-effort when the service stops (waits for
/// `taskkill`).
pub(super) fn stop_user_agents() {
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    let _ = std::process::Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW.0)
        .args(["/F", "/IM", "Vantyr Agent.exe"])
        .status();
    let _ = std::process::Command::new("taskkill")
        .creation_flags(CREATE_NO_WINDOW.0)
        .args(["/F", "/IM", "vantyr-agent.exe"])
        .status();
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
        "\"{}\" --service-managed --log-file \"{}\"",
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

/// Launch the SYSTEM capture worker into the console session `session_id`.
///
/// Unlike [`launch_user_agent_in_session`], this needs no signed-in user: it
/// duplicates the service's own LocalSystem token and retargets it at the
/// session (`SetTokenInformation`/`TokenSessionId`, which requires
/// `SeTcbPrivilege`), so the worker is present from the sign-in/lock screen
/// onward. The worker attaches its own threads to the live input desktop; the
/// process-level `winsta0\default` here is only the initial desktop.
fn launch_capture_worker_in_session(session_id: u32) -> Result<()> {
    use std::ffi::c_void;
    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    // 1. Open the service's own (LocalSystem) process token.
    let mut proc_token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            &raw mut proc_token,
        )
    }
    .ok()
    .context("OpenProcessToken(service) failed")?;

    // 2. Duplicate it into a primary token we can retarget and assign.
    let access: TOKEN_ACCESS_MASK = TOKEN_ASSIGN_PRIMARY
        | TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID;
    let mut primary_token = HANDLE::default();
    let dup = unsafe {
        DuplicateTokenEx(
            proc_token,
            access,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &raw mut primary_token,
        )
    };
    let _ = unsafe { CloseHandle(proc_token) };
    dup.ok().context("DuplicateTokenEx(service token) failed")?;

    // 3. Retarget the token at the console session (requires SeTcbPrivilege).
    let sid: u32 = session_id;
    if let Err(e) = unsafe {
        SetTokenInformation(
            primary_token,
            TokenSessionId,
            (&raw const sid).cast::<c_void>(),
            std::mem::size_of::<u32>() as u32,
        )
    } {
        let _ = unsafe { CloseHandle(primary_token) };
        return Err(anyhow::anyhow!("SetTokenInformation(TokenSessionId): {e}"));
    }

    // 4. Command line + a SYSTEM environment block for the target session.
    let exe = std::env::current_exe().context("Cannot resolve current executable path")?;
    let worker_log = program_data_path("capture-worker.log");
    let cmdline = format!(
        "\"{}\" --capture-worker --no-ui --log-file \"{}\"",
        exe.display(),
        worker_log.display()
    );
    let mut cmdline_w = to_wide_z(&cmdline);
    let desktop_w = to_wide_z("winsta0\\default");

    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop_w.as_ptr().cast_mut()),
        ..Default::default()
    };

    let mut env_block: *mut core::ffi::c_void = std::ptr::null_mut();
    unsafe { CreateEnvironmentBlock(&raw mut env_block, Some(primary_token), false) }
        .ok()
        .context("CreateEnvironmentBlock(worker) failed")?;

    let creation_flags: PROCESS_CREATION_FLAGS = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;

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
            "Capture worker CreateProcessAsUserW ok (pid={}, session={}).",
            proc_info.dwProcessId, session_id
        );
    }

    let _ = unsafe { CloseHandle(proc_info.hProcess) };
    let _ = unsafe { CloseHandle(proc_info.hThread) };
    let _ = unsafe { CloseHandle(primary_token) };

    create_result
        .ok()
        .context("CreateProcessAsUserW(worker) failed")?;
    Ok(())
}

pub(super) fn enable_privileges(names: &[&str]) -> Result<()> {
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
