//! Clipboard-only session routing. Contains identities and deadlines, never text.
use std::collections::HashMap;
use uuid::Uuid;

// The session/token lookups are Win32 calls; the matching rules below are
// unit-tested on every platform.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::{
    active_console, console_current, execution_allowed, now_ms, pipe_user_session, process_session,
};

pub fn matches(pinned: Option<u32>, client: Option<u32>, active: u32) -> bool {
    active != 0 && active != u32::MAX && pinned == Some(active) && client == Some(active)
}

pub fn user_session_matches(session: Option<u32>, active: u32, same_user: bool) -> bool {
    same_user && matches(Some(active), session, active)
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
