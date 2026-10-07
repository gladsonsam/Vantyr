use super::*;
use crate::test_support::control::{connect, offline_state, user};
fn setup() -> (Arc<AppState>, Uuid, Uuid, LeaseOwner, Uuid) {
    let s = offline_state();
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
        .agents
        .authorize_agent_command(
            agent,
            &ServerCommand::ClipboardRead(ClipboardRequest::new(id)).to_value(),
        )
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
    s.agents
        .modules
        .lock()
        .get_mut(&agent)
        .unwrap()
        .report
        .modules
        .iter_mut()
        .find(|m| m.module == crate::agents::modules::Module::Clipboard)
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
        .connections
        .lock()
        .get(&agent)
        .unwrap()
        .shutdown
        .send_replace(Some(""));
    assert!(!s.command_deliverable(agent, conn, &cmd));
}
#[tokio::test]
async fn http_roundtrip_is_private_and_revocation_cancels() {
    let s = offline_state();
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
async fn audit_records_direction_length_and_outcome_but_never_text() {
    let (s, agent, _, _, _) = setup();
    let mut audit = ClipboardAudit {
        state: s,
        actor: user().username,
        agent,
        direction: "read",
        bytes: Some("private".len()),
        http_status: None,
    };
    let (status, detail) = audit.detail();
    assert_eq!(status, "rejected");
    assert_eq!(detail["outcome"], "cancelled");
    audit.http_status = Some(StatusCode::OK);
    let (status, detail) = audit.detail();
    assert_eq!(status, "ok");
    assert_eq!(
        detail,
        json!({"direction":"read","bytes":7,"outcome":"ok","http_status":200})
    );
    assert!(!detail.to_string().contains("private"));
    audit.http_status = Some(StatusCode::FORBIDDEN);
    assert_eq!(audit.detail().1["outcome"], "denied");
}
#[tokio::test]
async fn generic_commands_cannot_bypass_control_lease() {
    let (s, agent, _, _, _) = setup();
    assert_eq!(
        s.agents
            .send_agent_command_json(agent, &json!({"type":"ClipboardRead"}))
            .unwrap_err()
            .code,
        "control_lease_required"
    );
}
