//! Explicit, private, connection- and lease-fenced text clipboard RPCs.
use crate::platform::audit;
use crate::{
    agents::modules::CommandDenied, control::runtime::ControlRuntime,
    control::sessions::LeaseOwner, http::AuthUser, state::AppState,
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
        Some(crate::agents::modules::Module::Clipboard),
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
            || !self
                .agents
                .connections
                .lock()
                .get(&p.agent)
                .is_some_and(|c| {
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
            .agents
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
        self.agents
            .authorize_agent_command(p.agent, &command)
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
            let _ = self.state.agents.enqueue_authorized_command(
                p.agent,
                p.owner.agent_connection_id,
                json!({"type":"ClipboardCancel","request_id":self.id}),
            );
        }
    }
}
/// One audit row per HTTP request, written on drop so a disconnected client is
/// still recorded. Records direction and byte length only, never clipboard text.
struct ClipboardAudit {
    state: Arc<AppState>,
    actor: String,
    agent: Uuid,
    direction: &'static str,
    bytes: Option<usize>,
    http_status: Option<StatusCode>,
}
impl ClipboardAudit {
    fn detail(&self) -> (&'static str, Value) {
        let outcome = match self.http_status {
            None => "cancelled",
            Some(status) if status.is_success() => "ok",
            Some(StatusCode::GATEWAY_TIMEOUT) => "timeout",
            Some(
                StatusCode::FORBIDDEN
                | StatusCode::CONFLICT
                | StatusCode::TOO_MANY_REQUESTS
                | StatusCode::SERVICE_UNAVAILABLE,
            ) => "denied",
            Some(StatusCode::BAD_REQUEST) => "invalid",
            Some(_) => "failed",
        };
        let status = if outcome == "ok" { "ok" } else { "rejected" };
        let detail = json!({"direction":self.direction, "bytes":self.bytes, "outcome":outcome,
            "http_status":self.http_status.map(|s| s.as_u16())});
        (status, detail)
    }
}
impl Drop for ClipboardAudit {
    fn drop(&mut self) {
        let (status, detail) = self.detail();
        let pool = self.state.db.clone();
        let actor = std::mem::take(&mut self.actor);
        let agent = self.agent;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                audit::insert_audit_log_traced(
                    &pool,
                    &actor,
                    Some(agent),
                    "clipboard",
                    status,
                    &detail,
                    None,
                )
                .await;
            });
        }
    }
}
pub async fn http(
    Path(agent): Path<Uuid>,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(request): Json<Request>,
) -> Response {
    let mut audit = ClipboardAudit {
        state: state.clone(),
        actor: user.username.clone(),
        agent,
        direction: match request.action.as_str() {
            "read" => "read",
            "write" => "write",
            _ => "invalid",
        },
        // Write length is known up front; read length is set from the reply.
        bytes: request.text.as_ref().map(String::len),
        http_status: None,
    };
    let response = exchange(agent, state, &user, request, &mut audit).await;
    audit.http_status = Some(response.status());
    response
}
async fn exchange(
    agent: Uuid,
    state: Arc<AppState>,
    user: &AuthUser,
    request: Request,
    audit: &mut ClipboardAudit,
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
        let authorized = match state.agents.authorize_agent_command(agent, &command) {
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
            state
                .agents
                .enqueue_authorized_command(agent, owner.agent_connection_id, authorized)
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
                    Ok(value) if value["ok"] == true => {
                        if let Some(text) = value["text"].as_str() {
                            audit.bytes = Some(text.len());
                        }
                        Json(value).into_response()
                    }
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
mod tests;
