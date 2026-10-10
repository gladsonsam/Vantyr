//! Win32 lookups for clipboard session routing: the active console session, a
//! process's session, and the user behind a named-pipe client.

pub fn active_console() -> u32 {
    unsafe { windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() }
}

pub fn process_session(pid: u32) -> Option<u32> {
    let mut session = 0;
    unsafe { windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(pid, &mut session) }
        .ok()
        .map(|()| session)
}

pub fn console_current(value: &serde_json::Value) -> bool {
    let pinned = value["__clipboard_session"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok());
    super::matches(pinned, pinned, active_console())
}

pub fn pipe_user_session(pipe: &tokio::net::windows::named_pipe::NamedPipeServer) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::{
            Pipes::GetNamedPipeClientProcessId,
            RemoteDesktop::WTSQueryUserToken,
            Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    fn token_user(token: HANDLE) -> Option<Vec<usize>> {
        let mut needed = 0;
        unsafe {
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        }
        if needed < std::mem::size_of::<TOKEN_USER>() as u32 || needed > 65536 {
            return None;
        }
        // TOKEN_USER contains pointers: keep its buffer pointer-aligned.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
        }
        .ok()?;
        Some(buffer)
    }
    let mut pid = 0;
    unsafe { GetNamedPipeClientProcessId(HANDLE(pipe.as_raw_handle()), &mut pid) }.ok()?;
    let session = process_session(pid)?;
    let active = active_console();
    if !super::matches(Some(active), Some(session), active) {
        return None;
    }
    let process =
        Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    let mut client_token = HANDLE::default();
    unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut client_token) }.ok()?;
    let client_token = Owned(client_token);
    let mut console_token = HANDLE::default();
    unsafe { WTSQueryUserToken(active, &mut console_token) }.ok()?;
    let console_token = Owned(console_token);
    let client_user = token_user(client_token.0)?;
    let console_user = token_user(console_token.0)?;
    // The buffers own both TOKEN_USER and the SIDs referenced by their pointers.
    let same_user = unsafe {
        EqualSid(
            (*client_user.as_ptr().cast::<TOKEN_USER>()).User.Sid,
            (*console_user.as_ptr().cast::<TOKEN_USER>()).User.Sid,
        )
        .is_ok()
    };
    super::user_session_matches(Some(session), active_console(), same_user).then_some(session)
}

pub fn execution_allowed(value: &serde_json::Value) -> bool {
    let pinned = value["__clipboard_session"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok());
    super::matches(
        pinned,
        process_session(std::process::id()),
        active_console(),
    )
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}
