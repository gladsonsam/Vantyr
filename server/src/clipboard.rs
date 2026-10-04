//! Explicit, private, connection- and lease-fenced text clipboard RPCs.
use crate::{
    agent_modules::CommandDenied, auth::AuthUser, control_runtime::ControlRuntime,
    control_sessions::LeaseOwner, state::AppState,
};
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use uuid::Uuid;

pub const MAX_TEXT_BYTES: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

// No Debug: clipboard data must never enter logs through a pending request.
pub(crate) struct PendingClipboard {
    agent: Uuid,
    owner: LeaseOwner,
    token: Uuid,
    deadline: Instant,
    /// Contains only command type, request id, and grant generation; never text.
    fence: Value,
    sender: Option<oneshot::Sender<Value>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    action: String,
    control_token: Uuid,
    text: Option<String>,
}
fn denied(message: &str) -> CommandDenied {
    CommandDenied::new(
        "clipboard_unavailable",
        message,
        Some(crate::agent_modules::Module::Clipboard),
    )
}
impl Request {
    fn command(&self, id: Uuid) -> Result<Value, CommandDenied> {
        match (self.action.as_str(), self.text.as_deref()) {
            ("read", None) => Ok(json!({"type":"ClipboardRead", "request_id":id})),
            ("write", Some(text)) if text.len() <= MAX_TEXT_BYTES && !text.contains('\0') =>
                Ok(json!({"type":"ClipboardWrite", "request_id":id,"text":text})),
            _ => Err(CommandDenied::new("invalid_request", "Use read without text, or write with text of at most 65,536 UTF-8 bytes and no NUL characters.", None)),
        }
    }
}
impl AppState {
    fn clipboard_valid_locked(&self, control: &mut ControlRuntime, p: &PendingClipboard) -> bool {
        if Instant::now() >= p.deadline
            || !self.agents.lock().get(&p.agent).is_some_and(|c| {
                c.conn_id == p.owner.agent_connection_id && c.shutdown.borrow().is_none()
            })
        {
            return false;
        }
        let transition = control
            .sessions
            .authorize(p.agent, p.owner, p.token, Instant::now());
        self.deliver_control_cleanup(control, transition.cleanup);
        if transition.result.is_err() {
            return false;
        }
        // A lease also depends on remote-input permission, independent of clipboard.
        if self
            .authorize_agent_command(p.agent, &json!({"type":"MouseMove","x":0,"y":0}))
            .is_err()
        {
            return false;
        }
        let mut command = p.fence.clone();
        command
            .as_object_mut()
            .unwrap()
            .remove("__module_generation");
        self.authorize_agent_command(p.agent, &command)
            .is_ok_and(|v| v["__module_generation"] == p.fence["__module_generation"])
    }
    pub(crate) fn clipboard_deliverable_locked(
        &self,
        control: &mut ControlRuntime,
        agent: Uuid,
        conn: Uuid,
        cmd: &Value,
    ) -> bool {
        let Some(id) = cmd["request_id"].as_str().and_then(|s| s.parse().ok()) else {
            return false;
        };
        let Some(p) = control.clipboard.remove(&id) else {
            return false;
        };
        let valid = p.agent == agent
            && p.owner.agent_connection_id == conn
            && p.fence["type"] == cmd["type"]
            && p.fence["__module_generation"] == cmd["__module_generation"]
            && self.clipboard_valid_locked(control, &p);
        control.clipboard.insert(id, p);
        valid
    }
    pub(crate) fn complete_clipboard(&self, agent: Uuid, conn: Uuid, value: Value) {
        let Some(id) = value["request_id"].as_str().and_then(|s| s.parse().ok()) else {
            return;
        };
        let mut control = self.control.lock();
        let Some(mut p) = control.clipboard.remove(&id) else {
            return;
        };
        // A foreign agent/socket cannot consume another request's waiter.
        if p.agent != agent || p.owner.agent_connection_id != conn {
            control.clipboard.insert(id, p);
            return;
        }
        let reply = if !self.clipboard_valid_locked(&mut control, &p) {
            json!({"ok":false,"error":"Clipboard permission, connection, or control lease was revoked."})
        } else if value["ok"] == true {
            if p.fence["type"] == "ClipboardRead" {
                match value["text"]
                    .as_str()
                    .filter(|t| t.len() <= MAX_TEXT_BYTES && !t.contains('\0'))
                {
                    Some(text) => json!({"ok":true,"text":text}),
                    None => {
                        json!({"ok":false,"error":"Agent returned invalid or oversized clipboard text."})
                    }
                }
            } else {
                json!({"ok":true})
            }
        } else {
            // Fixed error vocabulary: never relay arbitrary clipboard-bearing agent strings.
            json!({"ok":false,"error":"Agent could not access clipboard text; permission may have been revoked or the desktop clipboard may be unavailable."})
        };
        if let Some(tx) = p.sender.take() {
            let _ = tx.send(reply);
        }
        control.clipboard.insert(id, p);
    }
}
/// Drop removes outstanding correlation even if the HTTP client disconnects.
struct WaiterGuard {
    state: Arc<AppState>,
    id: Uuid,
}
impl Drop for WaiterGuard {
    fn drop(&mut self) {
        let mut control = self.state.control.lock();
        if let Some(p) = control.clipboard.remove(&self.id) {
            // Best-effort cancellation goes only to the original socket. A write
            // already accepted by the OS cannot be undone by cancelling its RPC.
            let _ = self.state.enqueue_authorized_command(
                p.agent,
                p.owner.agent_connection_id,
                json!({"type":"ClipboardCancel","request_id":self.id}),
            );
        }
    }
}
pub async fn http(
    Path(agent): Path<Uuid>,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(request): Json<Request>,
) -> Response {
    if !user.is_operator() {
        return denied("Operator permission is required.").response();
    }
    let id = Uuid::new_v4();
    let command = match request.command(id) {
        Ok(c) => c,
        Err(e) => return crate::error::api_json_error(StatusCode::BAD_REQUEST, e.code, &e.error),
    };
    let (tx, mut rx) = oneshot::channel();
    {
        let mut control = state.control.lock();
        let Some(owner) = control
            .sessions
            .http_owner(agent, user.user_id, request.control_token)
        else {
            return denied("An active control token belonging to this user is required.")
                .response();
        };
        let authorized = match state.authorize_agent_command(agent, &command) {
            Ok(c) => c,
            Err(e) => return e.response(),
        };
        let mut fence = authorized.clone();
        fence.as_object_mut().unwrap().remove("text");
        let p = PendingClipboard {
            agent,
            owner,
            token: request.control_token,
            deadline: Instant::now() + TIMEOUT,
            fence,
            sender: Some(tx),
        };
        if !state.clipboard_valid_locked(&mut control, &p) {
            return denied("Control lease, connection, or device permission is no longer valid.")
                .response();
        }
        if control.clipboard.len() >= 128 || control.clipboard.values().any(|p| p.agent == agent) {
            return crate::error::api_json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "clipboard_busy",
                "A clipboard request is already in progress.",
            );
        }
        control.clipboard.insert(id, p);
        if let Err(e) =
            state.enqueue_authorized_command(agent, owner.agent_connection_id, authorized)
        {
            control.clipboard.remove(&id);
            return e.response();
        }
    }
    let _guard = WaiterGuard {
        state: state.clone(),
        id,
    };
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            reply = &mut rx => {
                let valid = {
                    let mut control = state.control.lock();
                    let p = control.clipboard.remove(&id);
                    p.is_some_and(|p| state.clipboard_valid_locked(&mut control,&p))
                };
                if !valid { return denied("Clipboard request expired or its control lease, connection, or permission was revoked.").response(); }
                return match reply {
                    Ok(value) if value["ok"] == true => Json(value).into_response(),
                    _ => crate::error::api_json_error(StatusCode::BAD_GATEWAY,"clipboard_failed","Agent could not access bounded clipboard text."),
                };
            },
            _ = tick.tick() => {
                let (valid, expired) = {
                    let mut control = state.control.lock();
                    if let Some(p) = control.clipboard.remove(&id) {
                        let expired = Instant::now() >= p.deadline;
                        let valid = state.clipboard_valid_locked(&mut control,&p);
                        control.clipboard.insert(id,p);
                        (valid,expired)
                    } else { (false,false) }
                };
                if expired { return crate::error::api_json_error(StatusCode::GATEWAY_TIMEOUT,"clipboard_timeout","Timed out waiting for the device clipboard."); }
                if !valid { return denied("Control lease, connection, or clipboard permission was revoked.").response(); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_runtime::tests::{connect, fixture, user};
    fn setup() -> (Arc<AppState>, Uuid, Uuid, LeaseOwner, Uuid) {
        let s = fixture();
        let agent = Uuid::new_v4();
        let (conn, _, _) = connect(&s, agent, 32);
        let owner = LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            user_id: user().user_id,
            agent_connection_id: conn,
        };
        let token = s
            .control
            .lock()
            .sessions
            .acquire(agent, owner, Duration::from_secs(10), Instant::now())
            .result
            .unwrap()
            .token;
        (s, agent, conn, owner, token)
    }
    fn pending(
        s: &AppState,
        agent: Uuid,
        owner: LeaseOwner,
        token: Uuid,
    ) -> (Uuid, Value, oneshot::Receiver<Value>) {
        let id = Uuid::new_v4();
        let fence = s
            .authorize_agent_command(agent, &json!({"type":"ClipboardRead","request_id":id}))
            .unwrap();
        let (tx, rx) = oneshot::channel();
        s.control.lock().clipboard.insert(
            id,
            PendingClipboard {
                agent,
                owner,
                token,
                deadline: Instant::now() + TIMEOUT,
                fence: fence.clone(),
                sender: Some(tx),
            },
        );
        (id, fence, rx)
    }
    #[tokio::test]
    async fn correlation_rejects_foreign_agents_and_stale_sockets() {
        let (s, agent, conn, owner, token) = setup();
        let (id, _, mut rx) = pending(&s, agent, owner, token);
        let value = json!({"type":"clipboard_result","request_id":id,"ok":true,"text":"private"});
        s.complete_clipboard(Uuid::new_v4(), conn, value.clone());
        s.complete_clipboard(agent, Uuid::new_v4(), value.clone());
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        s.complete_clipboard(agent, conn, value);
        assert_eq!(rx.await.unwrap(), json!({"ok":true,"text":"private"}));
    }
    #[tokio::test]
    async fn revoked_regranted_permissions_and_lost_lease_cannot_complete_or_deliver() {
        let (s, agent, conn, owner, token) = setup();
        let (id, cmd, rx) = pending(&s, agent, owner, token);
        assert!(s.command_deliverable(agent, conn, &cmd));
        s.agent_modules
            .lock()
            .get_mut(&agent)
            .unwrap()
            .report
            .modules
            .iter_mut()
            .find(|m| m.module == crate::agent_modules::Module::Clipboard)
            .unwrap()
            .revision += 1;
        assert!(!s.command_deliverable(agent, conn, &cmd));
        s.complete_clipboard(
            agent,
            conn,
            json!({"request_id":id,"ok":true,"text":"private"}),
        );
        assert_eq!(rx.await.unwrap()["ok"], false);
        s.control.lock().clipboard.remove(&id);
        let (id, cmd, rx) = pending(&s, agent, owner, token);
        let transition = s
            .control
            .lock()
            .sessions
            .release(agent, owner, token, Instant::now());
        assert!(transition.result.is_ok());
        assert!(!s.command_deliverable(agent, conn, &cmd));
        s.complete_clipboard(
            agent,
            conn,
            json!({"request_id":id,"ok":true,"text":"private"}),
        );
        assert_eq!(rx.await.unwrap()["ok"], false);
    }
    #[tokio::test]
    async fn expiry_offline_and_wrong_user_fail_closed() {
        let (s, agent, conn, owner, token) = setup();
        assert!(s
            .control
            .lock()
            .sessions
            .http_owner(agent, Uuid::new_v4(), token)
            .is_none());
        let (id, cmd, _) = pending(&s, agent, owner, token);
        s.control.lock().clipboard.get_mut(&id).unwrap().deadline = Instant::now();
        assert!(!s.command_deliverable(agent, conn, &cmd));
        s.control.lock().clipboard.remove(&id);
        let (_, cmd, _) = pending(&s, agent, owner, token);
        s.agents
            .lock()
            .get(&agent)
            .unwrap()
            .shutdown
            .send_replace(Some(""));
        assert!(!s.command_deliverable(agent, conn, &cmd));
    }
    #[tokio::test]
    async fn http_roundtrip_is_private_and_revocation_cancels() {
        let s = fixture();
        let agent = Uuid::new_v4();
        let (conn, mut commands, _shutdown) = connect(&s, agent, 32);
        let owner = LeaseOwner {
            viewer_connection_id: Uuid::new_v4(),
            user_id: user().user_id,
            agent_connection_id: conn,
        };
        let token = s
            .control
            .lock()
            .sessions
            .acquire(agent, owner, Duration::from_secs(10), Instant::now())
            .result
            .unwrap()
            .token;
        let mut broadcasts = s.tx.subscribe();
        let state = s.clone();
        let task = tokio::spawn(async move {
            http(
                Path(agent),
                State(state),
                Extension(user()),
                Json(Request {
                    action: "read".into(),
                    control_token: token,
                    text: None,
                }),
            )
            .await
        });
        let crate::state::AgentControl::Text(command) = commands.recv().await.unwrap() else {
            panic!("expected RPC")
        };
        let command: Value = serde_json::from_str(&command).unwrap();
        assert!(s.command_deliverable(agent, conn, &command));
        s.complete_clipboard(
            agent,
            conn,
            json!({"request_id":command["request_id"],"ok":true,"text":"private"}),
        );
        let response = task.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"ok":true,"text":"private"})
        );
        assert!(matches!(
            broadcasts.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        assert!(s.control.lock().clipboard.is_empty());
        let state = s.clone();
        let task = tokio::spawn(async move {
            http(
                Path(agent),
                State(state),
                Extension(user()),
                Json(Request {
                    action: "write".into(),
                    control_token: token,
                    text: Some("private".into()),
                }),
            )
            .await
        });
        let crate::state::AgentControl::Text(command) = commands.recv().await.unwrap() else {
            panic!("expected RPC")
        };
        assert!(command.contains("ClipboardWrite"));
        s.revoke_viewer_control(owner.viewer_connection_id);
        assert_eq!(task.await.unwrap().status(), StatusCode::FORBIDDEN);
        let crate::state::AgentControl::Text(cancel) = commands.recv().await.unwrap() else {
            panic!("expected cancellation")
        };
        assert!(cancel.contains("ClipboardCancel"));
        assert!(!cancel.contains("private"));
        assert!(s.control.lock().clipboard.is_empty());
    }

    #[test]
    fn wire_validation_is_strict_and_counts_bytes() {
        let token = Uuid::new_v4();
        let parse = |value: Value| {
            serde_json::from_value::<Request>(value)
                .unwrap()
                .command(Uuid::new_v4())
        };
        assert!(parse(json!({"action":"read","control_token":token})).is_ok());
        assert!(parse(json!({"action":"write","control_token":token,"text":""})).is_ok());
        assert!(parse(
            json!({"action":"write","control_token":token,"text":"é".repeat(MAX_TEXT_BYTES/2)})
        )
        .is_ok());
        assert!(parse(
            json!({"action":"write","control_token":token,"text":"é".repeat(MAX_TEXT_BYTES/2+1)})
        )
        .is_err());
        assert!(parse(json!({"action":"read","control_token":token,"text":"unexpected"})).is_err());
        assert!(parse(json!({"action":"write","control_token":token,"text":"a\0b"})).is_err());
        assert!(parse(json!({"action":"sync","control_token":token})).is_err());
        assert!(serde_json::from_value::<Request>(
            json!({"action":"read","control_token":token,"viewer_id":Uuid::new_v4()})
        )
        .is_err());
    }
    #[tokio::test]
    async fn oversized_agent_response_is_rejected_without_forwarding_content() {
        let (s, agent, conn, owner, token) = setup();
        let (id, _, rx) = pending(&s, agent, owner, token);
        s.complete_clipboard(
            agent,
            conn,
            json!({"request_id":id,"ok":true,"text":"a".repeat(MAX_TEXT_BYTES+1)}),
        );
        let result = rx.await.unwrap();
        assert_eq!(result["ok"], false);
        assert!(result.get("text").is_none());
    }
    #[tokio::test]
    async fn generic_commands_cannot_bypass_control_lease() {
        let (s, agent, _, _, _) = setup();
        assert_eq!(
            s.send_agent_command_json(agent, &json!({"type":"ClipboardRead"}))
                .unwrap_err()
                .code,
            "control_lease_required"
        );
    }
}
