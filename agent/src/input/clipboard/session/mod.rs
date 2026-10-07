//! Clipboard-only session routing. Contains identities and deadlines, never text.
use std::collections::HashMap;
use uuid::Uuid;

pub fn matches(pinned: Option<u32>, client: Option<u32>, active: u32) -> bool {
    active != 0 && active != u32::MAX && pinned == Some(active) && client == Some(active)
}

#[cfg(target_os = "windows")]
pub fn active_console() -> u32 {
    unsafe { windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId() }
}
#[cfg(target_os = "windows")]
pub fn process_session(pid: u32) -> Option<u32> {
    let mut session = 0;
    unsafe { windows::Win32::System::RemoteDesktop::ProcessIdToSessionId(pid, &mut session) }
        .ok()
        .map(|()| session)
}
#[cfg(target_os = "windows")]
pub fn console_current(value: &serde_json::Value) -> bool {
    let pinned = value["__clipboard_session"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok());
    matches(pinned, pinned, active_console())
}
pub fn user_session_matches(session: Option<u32>, active: u32, same_user: bool) -> bool {
    same_user && matches(Some(active), session, active)
}
#[cfg(target_os = "windows")]
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
    if !matches(Some(active), Some(session), active) {
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
    user_session_matches(Some(session), active_console(), same_user).then_some(session)
}
#[cfg(target_os = "windows")]
pub fn execution_allowed(value: &serde_json::Value) -> bool {
    let pinned = value["__clipboard_session"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok());
    matches(
        pinned,
        process_session(std::process::id()),
        active_console(),
    )
}

#[cfg(target_os = "windows")]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}
pub struct ConnectionGuard {
    pub client: Uuid,
    pub routes: std::sync::Arc<std::sync::Mutex<Routes>>,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .disconnected(self.client);
    }
}
struct Route {
    client: Uuid,
    session: u32,
    deadline: u64,
    live: bool,
}
#[derive(Default)]
pub struct Routes {
    requests: HashMap<Uuid, Route>,
}
impl Routes {
    /// Keep dead bindings until their deadline: a second companion must never
    /// claim a request that was sent to a client which subsequently disconnected.
    pub fn refresh(&mut self, active: u32, now: u64) {
        self.requests.retain(|_, r| r.deadline > now);
        for r in self.requests.values_mut() {
            if !matches(Some(r.session), Some(r.session), active) {
                r.live = false;
            }
        }
    }
    #[allow(clippy::too_many_arguments)] // Explicit identity and deadline inputs at the privacy boundary.
    pub fn claim(
        &mut self,
        id: Uuid,
        client: Uuid,
        session: Option<u32>,
        pinned: Option<u32>,
        active: u32,
        deadline: u64,
        now: u64,
    ) -> bool {
        self.refresh(active, now);
        if deadline <= now
            || !matches(pinned, session, active)
            || self.requests.contains_key(&id)
            || self.requests.len() >= 128
        {
            return false;
        }
        self.requests.insert(
            id,
            Route {
                client,
                session: active,
                deadline,
                live: true,
            },
        );
        true
    }
    pub fn owns(
        &mut self,
        id: Uuid,
        client: Uuid,
        session: Option<u32>,
        active: u32,
        now: u64,
    ) -> bool {
        self.refresh(active, now);
        self.requests.get(&id).is_some_and(|r| {
            r.live && r.client == client && matches(Some(r.session), session, active)
        })
    }
    pub fn complete(
        &mut self,
        id: Uuid,
        client: Uuid,
        session: Option<u32>,
        active: u32,
        now: u64,
    ) -> bool {
        if !self.owns(id, client, session, active, now) {
            return false;
        }
        self.requests.get_mut(&id).unwrap().live = false;
        true
    }
    pub fn command_allowed(
        &mut self,
        value: &serde_json::Value,
        client: Uuid,
        session: Option<u32>,
        active: u32,
        now: u64,
    ) -> bool {
        let kind = value["type"].as_str().unwrap_or("");
        if !matches!(kind, "ClipboardRead" | "ClipboardWrite" | "ClipboardCancel") {
            return true;
        }
        let Some(id) = value["request_id"].as_str().and_then(|s| s.parse().ok()) else {
            return false;
        };
        if kind == "ClipboardCancel" {
            return self.complete(id, client, session, active, now);
        }
        let pinned = value["__clipboard_session"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok());
        let Some(deadline) = value["__clipboard_deadline_ms"].as_u64() else {
            return false;
        };
        self.claim(id, client, session, pinned, active, deadline, now)
    }
    pub fn result_allowed(
        &mut self,
        value: &serde_json::Value,
        client: Uuid,
        session: Option<u32>,
        active: u32,
        now: u64,
    ) -> bool {
        // Responses are direct. Reject a wrapped response rather than allowing
        // batching to bypass the per-pipe identity check.
        if value["type"] != "clipboard_result" {
            return !contains_result(value);
        }
        let Some(id) = value["request_id"].as_str().and_then(|s| s.parse().ok()) else {
            return false;
        };
        let pinned = value["__clipboard_session"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok());
        matches(pinned, session, active) && self.complete(id, client, session, active, now)
    }
    pub fn disconnected(&mut self, client: Uuid) {
        for r in self.requests.values_mut().filter(|r| r.client == client) {
            r.live = false;
        }
    }
}
pub fn contains_result(value: &serde_json::Value) -> bool {
    value["type"] == "clipboard_result"
        || value["events"]
            .as_array()
            .is_some_and(|events| events.iter().any(contains_result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_console_user_is_eligible_even_in_the_same_session() {
        assert!(user_session_matches(Some(7), 7, true));
        assert!(!user_session_matches(Some(7), 7, false)); // SYSTEM/different user.
        assert!(!user_session_matches(None, 7, true));
        assert!(!user_session_matches(Some(6), 7, true));
        assert!(!user_session_matches(Some(0), 0, true));
        assert!(!user_session_matches(Some(u32::MAX), u32::MAX, true));
    }
    #[test]
    fn dispatch_wrappers_filter_writes_results_cancellation_and_batches() {
        use serde_json::json;
        let mut routes = Routes::default();
        let id = Uuid::new_v4().to_string();
        let owner = Uuid::new_v4();
        let inactive = Uuid::new_v4();
        let write = json!({"type":"ClipboardWrite","request_id":id,"text":"private","__clipboard_session":7,"__clipboard_deadline_ms":500});
        assert!(!routes.command_allowed(&write, inactive, Some(6), 7, 100));
        assert!(!routes.command_allowed(&write, inactive, None, 7, 100)); // Ineligible token SID.
        assert!(routes.command_allowed(&write, owner, Some(7), 7, 100));
        assert!(!routes.command_allowed(&write, inactive, Some(7), 7, 100));
        let response =
            json!({"type":"clipboard_result","request_id":id,"__clipboard_session":7,"ok":true});
        assert!(!routes.result_allowed(&response, inactive, Some(7), 7, 101));
        assert!(!routes.result_allowed(&response, owner, None, 7, 101));
        assert!(!routes.result_allowed(
            &json!({"type":"batch","events":[response.clone()]}),
            owner,
            Some(7),
            7,
            101
        ));
        assert!(!routes.result_allowed(
            &json!({"type":"batch","events":[{"type":"batch","events":[response.clone()]}]}),
            owner,
            Some(7),
            7,
            101
        ));
        let cancel = json!({"type":"ClipboardCancel","request_id":id});
        assert!(!routes.command_allowed(&cancel, inactive, Some(7), 7, 101));
        assert!(routes.command_allowed(&cancel, owner, Some(7), 7, 102));
        assert!(!routes.result_allowed(&response, owner, Some(7), 7, 103));
        let id = Uuid::new_v4().to_string();
        let read = json!({"type":"ClipboardRead","request_id":id,"__clipboard_session":7,"__clipboard_deadline_ms":500});
        assert!(routes.command_allowed(&read, owner, Some(7), 7, 104));
        assert!(routes.result_allowed(
            &json!({"type":"clipboard_result","request_id":id,"__clipboard_session":7}),
            owner,
            Some(7),
            7,
            105
        ));
        assert!(!routes.command_allowed(&json!({"type":"ClipboardWrite","request_id":Uuid::new_v4().to_string(),"__clipboard_deadline_ms":500}),owner,Some(7),7,104));
    }
    #[test]
    fn connection_drop_expires_exact_routes_and_expired_reply_is_denied() {
        let routes = std::sync::Arc::new(std::sync::Mutex::new(Routes::default()));
        let owner = Uuid::new_v4();
        let id = Uuid::new_v4();
        let guard = ConnectionGuard {
            client: owner,
            routes: routes.clone(),
        };
        assert!(routes
            .lock()
            .unwrap()
            .claim(id, owner, Some(7), Some(7), 7, 500, 100));
        drop(guard);
        assert!(!routes.lock().unwrap().complete(id, owner, Some(7), 7, 101));
        let id = Uuid::new_v4();
        assert!(routes
            .lock()
            .unwrap()
            .claim(id, owner, Some(7), Some(7), 7, 500, 100));
        assert!(!routes.lock().unwrap().complete(id, owner, Some(7), 7, 500));
    }
    #[test]
    fn execution_requires_exact_active_nonzero_console_session() {
        assert!(matches(Some(1), Some(1), 1));
        for (p, c, a) in [
            (None, Some(1), 1),
            (Some(1), None, 1),
            (Some(0), Some(0), 0),
            (Some(u32::MAX), Some(u32::MAX), u32::MAX),
            (Some(1), Some(2), 2),
            (Some(1), Some(1), 2),
        ] {
            assert!(!matches(p, c, a));
        }
    }
    #[test]
    fn inactive_client_never_receives_payload_or_consumes_result() {
        let mut routes = Routes::default();
        let id = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        assert!(!routes.claim(id, other, Some(1), Some(2), 2, 500, 100));
        assert!(routes.claim(id, owner, Some(2), Some(2), 2, 500, 100));
        assert!(!routes.claim(id, other, Some(2), Some(2), 2, 500, 100));
        assert!(!routes.complete(id, other, Some(2), 2, 101));
        assert!(routes.complete(id, owner, Some(2), 2, 102));
        assert!(!routes.complete(id, owner, Some(2), 2, 103));
    }
    #[test]
    fn switch_disconnect_unknown_session_and_deadline_fail_closed_without_rebinding() {
        let mut routes = Routes::default();
        let id = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        assert!(routes.claim(id, owner, Some(1), Some(1), 1, 500, 100));
        assert!(!routes.owns(id, owner, Some(1), 2, 101));
        assert!(!routes.complete(id, owner, Some(1), 1, 102));
        assert!(!routes.claim(id, other, Some(1), Some(1), 1, 500, 103));
        let id = Uuid::new_v4();
        assert!(routes.claim(id, owner, Some(1), Some(1), 1, 500, 100));
        routes.disconnected(owner);
        assert!(!routes.claim(id, other, Some(1), Some(1), 1, 500, 103));
        assert!(!routes.complete(id, owner, Some(1), 1, 104));
        assert!(!routes.claim(Uuid::new_v4(), owner, None, Some(1), 1, 500, 100));
        assert!(!routes.claim(Uuid::new_v4(), owner, Some(1), Some(1), 1, 100, 100));
    }
}
