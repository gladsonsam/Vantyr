use super::*;
use crate::agents::modules::db as modules_db;
use crate::agents::modules::RuntimeModules;
use crate::test_support::control::{connect, module_report, offline_state, tagged_frame, user};
use sqlx::PgPool;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

fn request(agent: Uuid, kind: &str, token: Option<Uuid>) -> Value {
    let mut value = json!({"type":kind, "agent_id":agent, "capture_session":agent, "request_id":Uuid::new_v4()});
    if let Some(token) = token {
        value["lease_token"] = token.to_string().into();
    }
    value
}
fn acquire(s: &AppState, agent: Uuid, viewer: Uuid, user: &AuthUser, now: Instant) -> Uuid {
    s.media.store_frame(agent, tagged_frame(0));
    let conn = s.agents.connections.lock().get(&agent).unwrap().conn_id;
    s.media
        .mjpeg_sessions
        .lock()
        .entry(agent)
        .or_insert(crate::state::MjpegSession {
            requested_monitor: Some(0),
            agent_id: agent,
            user_id: user.user_id,
            conn_id: conn,
            prefs: crate::state::MjpegViewerPrefs {
                monitor: Some(0),
                jpeg_quality: 40,
                interval_ms: 200,
            },
        });
    // Registration rotates these synthetic streams exactly as real HTTP admission would.
    s.media
        .mjpeg_sessions
        .lock()
        .get_mut(&agent)
        .unwrap()
        .conn_id = conn;
    s.media.mjpeg_active_capture.lock().insert(
        agent,
        crate::control::capture_arbitration::ActiveCapture {
            generation: Uuid::new_v4(),
            retired_capture_ids: [None; 32],
            wire_monitor: Some(0),
            conn_id: conn,
            prefs: crate::state::MjpegViewerPrefs {
                monitor: Some(0),
                jpeg_quality: 40,
                interval_ms: 200,
            },
        },
    );
    let event =
        s.control_lease_message(viewer, user, &request(agent, "control_acquire", None), now);
    assert_eq!(event["status"], "granted", "{event}");
    assert_eq!(event["expires_in_ms"], 15000);
    event["lease_token"].as_str().unwrap().parse().unwrap()
}
async fn message(
    s: &Arc<AppState>,
    viewer: Uuid,
    user: &AuthUser,
    envelope: Value,
) -> Option<Value> {
    // These dispatcher fixtures describe a connected, capable device. Supply
    // its capabilities explicitly instead of depending on a local PostgreSQL
    // service: failed connection attempts can outlive the frame/lease deadline.
    // Unavailable-capability and database tests use their own explicit fixtures.
    let mut cache = crate::viewer::ws::CapabilityCache::new();
    if let Some(agent) = envelope["agent_id"].as_str().and_then(|id| id.parse().ok()) {
        if let Some(connection) = s.agents.connections.lock().get(&agent) {
            for capability in ["remote_input", "system_control", "software_inventory"] {
                cache.insert(
                    (agent, connection.conn_id, capability),
                    Some("supported".into()),
                );
            }
        }
    }
    crate::viewer::ws::viewer_message(&envelope.to_string(), s, user, viewer, &mut cache).await
}
fn input(agent: Uuid, token: Option<Uuid>, cmd: Value) -> Value {
    let mut value = json!({"type":"control", "agent_id":agent, "cmd":cmd});
    if let Some(token) = token {
        value["lease_token"] = token.to_string().into();
    }
    value
}
#[tokio::test]
async fn actual_dispatcher_contract_permission_current_connection_and_shape() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let mut actor = user();
    let (conn, mut queue, _) = connect(&s, agent, 32);
    let mut req = request(agent, "control_acquire", None);
    let id = req["request_id"].clone();
    req["user_id"] = Uuid::new_v4().to_string().into(); // never trusted
    req["viewer_connection_id"] = Uuid::new_v4().to_string().into();
    actor.role = "viewer".into();
    let event = message(&s, viewer, &actor, req.clone()).await.unwrap();
    assert_eq!(event["code"], "permission_denied");
    assert!(event.get("lease_token").is_none());
    actor.role = "operator".into();
    s.agents.modules.lock().remove(&agent);
    assert_eq!(
        message(&s, viewer, &actor, req.clone()).await.unwrap()["code"],
        "module_report_required"
    );
    s.agents.modules.lock().insert(
        agent,
        RuntimeModules {
            conn_id: conn,
            report: module_report(1, false),
            pending: HashMap::new(),
            sent: HashSet::new(),
            last_sent: HashMap::new(),
        },
    );
    assert_eq!(
        message(&s, viewer, &actor, req.clone()).await.unwrap()["code"],
        "module_not_authorized"
    );
    s.agents.modules.lock().get_mut(&agent).unwrap().conn_id = Uuid::new_v4();
    assert_eq!(
        message(&s, viewer, &actor, req.clone()).await.unwrap()["code"],
        "module_report_required"
    );
    s.agents.modules.lock().get_mut(&agent).unwrap().conn_id = conn;
    s.agents.modules.lock().get_mut(&agent).unwrap().report = module_report(2, true);
    let event = message(&s, viewer, &actor, req.clone()).await.unwrap();
    assert_eq!(event["request_id"], id);
    assert_eq!(event["status"], "granted");
    let token = event["lease_token"].as_str().unwrap().parse().unwrap();
    let cmd = json!({"type":"MouseMove","x":1,"y":2});
    assert_eq!(
        message(&s, viewer, &actor, input(agent, None, cmd.clone()))
            .await
            .unwrap()["code"],
        "control_lease_required"
    );
    assert_eq!(
        message(
            &s,
            Uuid::new_v4(),
            &actor,
            input(agent, Some(token), cmd.clone())
        )
        .await
        .unwrap()["code"],
        "control_lease_mismatch"
    );
    assert!(message(
        &s,
        viewer,
        &actor,
        input(
            agent,
            Some(token),
            json!({"type":"MouseMove","x":1.5,"y":2})
        )
    )
    .await
    .is_none());
    assert!(queue.try_recv().is_err());
    assert!(message(&s, viewer, &actor, input(agent, Some(token), cmd))
        .await
        .is_none());
    let AgentControl::Text(command) = queue.try_recv().unwrap() else {
        panic!()
    };
    let command: Value = serde_json::from_str(&command).unwrap();
    assert_eq!(command["__module_generation"]["revision"], 2);
    assert!(s.command_deliverable(agent, conn, &command));
    req["request_id"] = "bad".into();
    assert_eq!(
        message(&s, viewer, &actor, req).await.unwrap()["code"],
        "invalid_request"
    );
    assert_eq!(
        message(
            &s,
            viewer,
            &actor,
            request(Uuid::new_v4(), "control_acquire", None)
        )
        .await
        .unwrap()["code"],
        "agent_offline"
    );
}
#[tokio::test]
async fn every_physical_input_requires_a_lease_and_generic_send_cannot_bypass() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (_, mut queue, _) = connect(&s, agent, 32);
    for cmd in [
        json!({"type":"MouseMove","x":0,"y":0}),
        json!({"type":"MouseDown","x":0,"y":0}),
        json!({"type":"MouseUp","x":0,"y":0}),
        json!({"type":"MouseClick","x":0,"y":0}),
        json!({"type":"MouseDoubleClick","x":0,"y":0}),
        json!({"type":"MouseScroll","delta_x":0,"delta_y":1}),
        json!({"type":"KeyDown","key":"shift"}),
        json!({"type":"KeyUp","key":"shift"}),
        json!({"type":"KeyPress","key":"enter"}),
        json!({"type":"KeyChar","char":"a"}),
        json!({"type":"TypeText","text":"文字"}),
    ] {
        assert_eq!(
            message(&s, viewer, &actor, input(agent, None, cmd.clone()))
                .await
                .unwrap()["code"],
            "control_lease_required"
        );
        assert_eq!(
            s.agents
                .send_agent_command_json(agent, &cmd)
                .unwrap_err()
                .code,
            "control_lease_required"
        );
    }
    assert!(queue.try_recv().is_err());
    // Files/system controls retain module rules and do not acquire physical input.
    assert!(message(
        &s,
        viewer,
        &actor,
        input(agent, None, json!({"type":"ListDir"}))
    )
    .await
    .is_none());
    assert!(matches!(queue.try_recv().unwrap(), AgentControl::Text(_)));
}
#[tokio::test]
async fn competing_viewers_idempotence_heartbeat_stale_release_and_user_binding() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let other = Uuid::new_v4();
    let actor = user();
    connect(&s, agent, 32);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    let duplicate = s.control_lease_message(
        viewer,
        &actor,
        &request(agent, "control_acquire", None),
        now + Duration::from_secs(1),
    );
    assert_eq!(duplicate["lease_token"], token.to_string());
    assert_eq!(duplicate["expires_in_ms"], 14000);
    assert_eq!(
        s.control_lease_message(other, &actor, &request(agent, "control_acquire", None), now)
            ["code"],
        "control_conflict"
    );
    for (v, u, t) in [
        (other, actor.clone(), token),
        (viewer, crate::test_support::admin(), token),
        (viewer, actor.clone(), Uuid::new_v4()),
    ] {
        for kind in ["control_heartbeat", "control_release"] {
            let event = s.control_lease_message(v, &u, &request(agent, kind, Some(t)), now);
            assert_eq!(event["code"], "control_lease_mismatch");
            assert!(event.get("lease_token").is_none());
        }
    }
    let renewed = s.control_lease_message(
        viewer,
        &actor,
        &request(agent, "control_heartbeat", Some(token)),
        now + Duration::from_secs(10),
    );
    assert_eq!(renewed["expires_in_ms"], 15000);
    assert_eq!(renewed["lease_token"], token.to_string());
    s.expire_control(now + Duration::from_secs(15));
    assert_eq!(
        s.control_lease_message(
            other,
            &actor,
            &request(agent, "control_acquire", None),
            now + Duration::from_secs(15)
        )["code"],
        "control_conflict"
    );
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_release", Some(token)),
            now + Duration::from_secs(20)
        )["status"],
        "released"
    );
    let next = acquire(&s, agent, other, &actor, now + Duration::from_secs(20));
    assert_ne!(token, next);
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_release", Some(token)),
            now + Duration::from_secs(20)
        )["code"],
        "control_lease_mismatch"
    );
}
#[tokio::test]
async fn idle_expiry_drains_once_privately_before_successor_input() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (conn, mut queue, _) = connect(&s, agent, 32);
    let mut events = s.tx.subscribe();
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"control"}),
        now,
    )
    .unwrap();
    queue.try_recv().unwrap();
    s.expire_control(now + DEFAULT_LEASE_TTL);
    let event = events.try_recv().unwrap();
    assert!(
        matches!(event,Broadcast::PrivateText(v, ref e) if v==viewer && serde_json::from_str::<Value>(e).unwrap()["code"]=="control_lease_expired")
    );
    let successor = Uuid::new_v4();
    let next = acquire(&s, agent, successor, &actor, now + DEFAULT_LEASE_TTL);
    s.send_viewer_input(
        agent,
        successor,
        &actor,
        Some(next),
        &json!({"type":"TypeText","text":"x"}),
        now + DEFAULT_LEASE_TTL,
    )
    .unwrap();
    assert!(
        matches!(queue.try_recv().unwrap(),AgentControl::InputCleanup {conn_id, ref command} if conn_id==conn && command==&json!({"type":"KeyUp","key":"control"}))
    );
    assert!(matches!(queue.try_recv().unwrap(), AgentControl::Text(_)));
    s.expire_control(now + DEFAULT_LEASE_TTL);
    assert!(queue.try_recv().is_err());
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_heartbeat", Some(token)),
            now + DEFAULT_LEASE_TTL
        )["code"],
        "control_lease_mismatch"
    );
}
#[tokio::test]
async fn authorization_expiry_cleanup_is_consumed_even_on_error() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (_, mut queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"MouseDown","button":"left","x":1,"y":2}),
        now,
    )
    .unwrap();
    queue.try_recv().unwrap();
    assert_eq!(
        s.send_viewer_input(
            agent,
            viewer,
            &actor,
            Some(token),
            &json!({"type":"MouseMove","x":3,"y":4}),
            now + DEFAULT_LEASE_TTL
        )
        .unwrap_err()
        .code,
        "control_lease_expired"
    );
    assert!(
        matches!(queue.try_recv().unwrap(),AgentControl::InputCleanup {ref command,..} if command["type"]=="MouseUp")
    );
    assert!(queue.try_recv().is_err());
}
#[tokio::test]
async fn reconnect_viewer_disconnect_and_cleanup_delivery_are_fenced() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (old_conn, mut old_queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    let old = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(old),
        &json!({"type":"KeyDown","key":"alt"}),
        now,
    )
    .unwrap();
    old_queue.try_recv().unwrap();
    let (new_conn, mut new_queue, _) = connect(&s, agent, 32);
    assert!(
        matches!(old_queue.try_recv().unwrap(),AgentControl::InputCleanup{conn_id,..} if conn_id==old_conn)
    );
    let token = acquire(&s, agent, viewer, &actor, now);
    {
        let mut control = s.control.lock();
        s.revoke_agent_control_locked(&mut control, agent, old_conn);
    }
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_heartbeat", Some(old)),
            now
        )["code"],
        "control_lease_mismatch"
    );
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"shift"}),
        now,
    )
    .unwrap();
    new_queue.try_recv().unwrap();
    assert!(!s.control_cleanup_deliverable(
        agent,
        new_conn,
        old_conn,
        &json!({"type":"KeyUp","key":"alt"})
    ));
    assert!(!s.control_cleanup_deliverable(
        agent,
        new_conn,
        new_conn,
        &json!({"type":"KeyDown","key":"shift"})
    ));
    s.revoke_viewer_control(viewer);
    s.revoke_viewer_control(viewer);
    let AgentControl::InputCleanup { conn_id, command } = new_queue.try_recv().unwrap() else {
        panic!()
    };
    assert!(s.control_cleanup_deliverable(agent, new_conn, conn_id, &command));
    assert!(new_queue.try_recv().is_err());
}
#[tokio::test]
async fn cleanup_overflow_forces_out_of_band_close_and_blocks_successor() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (conn, mut queue, shutdown) = connect(&s, agent, 1);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"control"}),
        now,
    )
    .unwrap();
    // Queue holds the down; the release cannot enter it.
    s.revoke_viewer_control(viewer);
    assert_eq!(*shutdown.borrow(), Some(""));
    assert_eq!(
        s.control_lease_message(
            Uuid::new_v4(),
            &actor,
            &request(agent, "control_acquire", None),
            now
        )["code"],
        "agent_offline"
    );
    let AgentControl::Text(command) = queue.try_recv().unwrap() else {
        panic!()
    };
    assert!(!s.command_deliverable(agent, conn, &serde_json::from_str(&command).unwrap()));
}
#[tokio::test]
async fn failed_up_enqueue_closes_even_after_tracking_was_cleared() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (_, mut queue, shutdown) = connect(&s, agent, 1);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"shift"}),
        now,
    )
    .unwrap();
    queue.try_recv().unwrap();
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"MouseMove","x":1,"y":1}),
        now,
    )
    .unwrap();
    assert_eq!(
        s.send_viewer_input(
            agent,
            viewer,
            &actor,
            Some(token),
            &json!({"type":"KeyUp","key":"shift"}),
            now
        )
        .unwrap_err()
        .code,
        "command_queue_full"
    );
    assert_eq!(*shutdown.borrow(), Some(""));
}
#[tokio::test]
async fn expired_acquire_with_cleanup_overflow_never_grants_successor() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let now = Instant::now();
    let (_, mut queue, shutdown2) = connect(&s, agent, 1);
    let token2 = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token2),
        &json!({"type":"KeyDown","key":"alt"}),
        now,
    )
    .unwrap();
    let reply = s.control_lease_message(
        Uuid::new_v4(),
        &actor,
        &request(agent, "control_acquire", None),
        now + DEFAULT_LEASE_TTL,
    );
    assert_eq!(reply["status"], "denied");
    assert_eq!(reply["code"], "control_cleanup_failed");
    assert!(reply.get("lease_token").is_none());
    assert_eq!(*shutdown2.borrow(), Some(""));
    queue.try_recv().unwrap();
}

#[tokio::test]
async fn timer_expires_idle_lease_without_viewer_messages() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (_, mut queue, _) = connect(&s, agent, 32);
    let mut events = s.tx.subscribe();
    let past = Instant::now() - DEFAULT_LEASE_TTL;
    let token = acquire(&s, agent, viewer, &actor, past);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"meta"}),
        past,
    )
    .unwrap();
    queue.try_recv().unwrap();
    spawn_expiry(s.clone());
    let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    let Broadcast::PrivateText(owner, event) = event else {
        panic!()
    };
    let event: Value = serde_json::from_str(&event).unwrap();
    assert_eq!(owner, viewer);
    assert_eq!(event["status"], "revoked");
    assert_eq!(event["lease_token"], token.to_string());
    assert!(event.get("request_id").is_none());
    assert!(matches!(
        queue.try_recv().unwrap(),
        AgentControl::InputCleanup { .. }
    ));
}

#[sqlx::test]
async fn real_module_report_generation_revokes_and_cleanup_bypasses_revoked_module(
    db: PgPool,
) -> anyhow::Result<()> {
    let (s, agent, _) = crate::test_support::state(db).await?;
    let viewer = Uuid::new_v4();
    let actor = user();
    let (conn, mut queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"alt"}),
        now,
    )?;
    let AgentControl::Text(old_command) = queue.try_recv()? else {
        panic!()
    };
    let lifecycle = s.agents.lifecycle.for_agent(agent);
    let ingestion = Arc::new(lifecycle.clone().read_owned().await);
    s.accept_module_report(
        agent,
        conn,
        serde_json::to_value(module_report(2, false))?,
        &ingestion,
    )
    .await?;
    assert!(!s.command_deliverable(agent, conn, &serde_json::from_str(&old_command)?));
    let AgentControl::InputCleanup { conn_id, command } = queue.try_recv()? else {
        panic!()
    };
    assert!(s.control_cleanup_deliverable(agent, conn, conn_id, &command));
    s.accept_module_report(
        agent,
        conn,
        serde_json::to_value(module_report(3, true))?,
        &ingestion,
    )
    .await?;
    assert_eq!(
        s.send_viewer_input(
            agent,
            viewer,
            &actor,
            Some(token),
            &json!({"type":"MouseMove","x":0,"y":0}),
            now
        )
        .unwrap_err()
        .code,
        "control_lease_required"
    );
    let next = acquire(&s, agent, viewer, &actor, now);
    assert_ne!(next, token);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(next),
        &json!({"type":"KeyDown","key":"shift"}),
        now,
    )?;
    queue.try_recv()?;
    // Even an immediate local regrant generation must revoke the old owner.
    s.accept_module_report(
        agent,
        conn,
        serde_json::to_value(module_report(4, true))?,
        &ingestion,
    )
    .await?;
    assert!(matches!(
        queue.try_recv()?,
        AgentControl::InputCleanup { .. }
    ));
    Ok(())
}
#[sqlx::test]
async fn real_disable_route_revokes_before_pending_disable_and_ack_preserves_fence(
    db: PgPool,
) -> anyhow::Result<()> {
    use axum::{
        extract::{ConnectInfo, Extension, Path, State},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        Json,
    };
    for disabled_module in [Module::RemoteInput, Module::LiveScreen] {
        crate::test_support::delete_agents(&db).await?;
        let (s, agent, _) = crate::test_support::state(db.clone()).await?;
        let viewer = Uuid::new_v4();
        let actor = user();
        let (conn, mut queue, _) = connect(&s, agent, 32);
        let now = Instant::now();
        modules_db::save_module_report(&s.db, agent, conn, &module_report(1, true)).await?;
        let token = acquire(&s, agent, viewer, &actor, now);
        s.send_viewer_input(
            agent,
            viewer,
            &actor,
            Some(token),
            &json!({"type":"MouseDown","button":"left","x":1,"y":2}),
            now,
        )?;
        queue.try_recv()?;
        let command = Uuid::new_v4();
        let response = crate::agents::modules::api::disable_module(
            Path(agent),
            State(s.clone()),
            Extension(actor.clone()),
            HeaderMap::new(),
            ConnectInfo("127.0.0.1:9000".parse()?),
            Json(crate::agents::modules::api::DisableBody {
                module: disabled_module,
                expected_revision: 1,
                command_id: command,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let AgentControl::InputCleanup {
            conn_id,
            command: release,
        } = queue.try_recv()?
        else {
            panic!()
        };
        assert!(s.control_cleanup_deliverable(agent, conn, conn_id, &release));
        let AgentControl::Text(disable) = queue.try_recv()? else {
            panic!()
        };
        assert_eq!(
            serde_json::from_str::<Value>(&disable)?["type"],
            "disable_module"
        );
        assert_eq!(
            s.control_lease_message(
                viewer,
                &actor,
                &request(agent, "control_acquire", None),
                now
            )["code"],
            "module_disable_pending"
        );
        let ingestion = Arc::new(s.agents.lifecycle.for_agent(agent).read_owned().await);
        s.accept_module_disable_ack(agent,conn,json!({"type":"module_disable_ack","module":disabled_module,"command_id":command,"ok":true,"status":"disabled","persisted":true,"stopped":false,"state":module_report(2,false)}),&ingestion).await?;
        assert_eq!(
            s.control_lease_message(
                viewer,
                &actor,
                &request(agent, "control_heartbeat", Some(token)),
                now
            )["code"],
            "module_not_authorized"
        );
        assert!(queue.try_recv().is_err());
    }
    Ok(())
}
#[sqlx::test]
async fn real_registration_disconnect_and_rotation_revoke_without_reentrant_lock(
    db: PgPool,
) -> anyhow::Result<()> {
    let (s, agent, hash) = crate::test_support::state(db).await?;
    let viewer = Uuid::new_v4();
    let actor = user();
    let auth = crate::agent_ws::connection::AuthenticatedAgent {
        id: agent,
        token_hash: hash,
    };
    let mut old =
        crate::agent_ws::connection::register_authenticated_connection(&auth, "device", &s)
            .await?
            .unwrap();
    s.agents.modules.lock().insert(
        agent,
        RuntimeModules {
            conn_id: old.conn_id,
            report: module_report(1, true),
            pending: HashMap::new(),
            sent: HashSet::new(),
            last_sent: HashMap::new(),
        },
    );
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"control"}),
        now,
    )?;
    old.cmd_rx.try_recv()?;
    let mut new = tokio::time::timeout(
        Duration::from_secs(3),
        crate::agent_ws::connection::register_authenticated_connection(&auth, "device", &s),
    )
    .await??
    .unwrap();
    assert_eq!(*old.shutdown_rx.borrow(), Some(""));
    let AgentControl::InputCleanup { conn_id, .. } = old.cmd_rx.try_recv()? else {
        panic!()
    };
    assert_eq!(conn_id, old.conn_id);
    s.agents.modules.lock().insert(
        agent,
        RuntimeModules {
            conn_id: new.conn_id,
            report: module_report(1, true),
            pending: HashMap::new(),
            sent: HashSet::new(),
            last_sent: HashMap::new(),
        },
    );
    let next = acquire(&s, agent, viewer, &actor, now);
    assert_ne!(token, next);
    // A late old disconnect must not revoke the new connection's lease.
    crate::agent_ws::connection::cleanup_connection(agent, old.conn_id, old.session_id, &s).await;
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_heartbeat", Some(next)),
            now
        )["status"],
        "granted"
    );
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(next),
        &json!({"type":"KeyDown","key":"shift"}),
        now,
    )?;
    new.cmd_rx.try_recv()?;
    let _gate = new.lifecycle.clone().write_owned().await;
    tokio::time::timeout(
        Duration::from_secs(3),
        s.invalidate_agent_connection(agent, "agent_credentials_revoked"),
    )
    .await?;
    assert!(matches!(
        new.cmd_rx.try_recv()?,
        AgentControl::InputCleanup { .. }
    ));
    assert_eq!(*new.shutdown_rx.borrow(), Some("agent_credentials_revoked"));
    assert_eq!(
        s.control_lease_message(
            viewer,
            &actor,
            &request(agent, "control_acquire", None),
            now
        )["code"],
        "agent_offline"
    );
    Ok(())
}
#[sqlx::test]
async fn expired_deleted_and_downgraded_dashboard_sessions_revoke_input(
    db: PgPool,
) -> anyhow::Result<()> {
    let (s, agent, _) = crate::test_support::state(db).await?;
    let viewer = Uuid::new_v4();
    let mut actor = user();
    sqlx::query("INSERT INTO dashboard_users(id,username,password_hash,role,display_name) VALUES($1,'operator','','operator','Operator')").bind(actor.user_id).execute(&s.db).await?;
    sqlx::query(
        "INSERT INTO dashboard_sessions(token_sha256_hex,user_id,expires_at,csrf_token) VALUES('session-hash',$1,NOW()+INTERVAL '1 hour','csrf')",
    )
    .bind(actor.user_id)
    .execute(&s.db)
    .await?;
    let (_, mut queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    for mode in ["expired", "downgraded", "deleted"] {
        actor.role = "operator".into();
        let token = acquire(&s, agent, viewer, &actor, now);
        s.send_viewer_input(
            agent,
            viewer,
            &actor,
            Some(token),
            &json!({"type":"KeyDown","key":"control"}),
            now,
        )?;
        queue.try_recv()?;
        match mode {
            "expired" => {
                sqlx::query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'")
                    .execute(&s.db)
                    .await?;
            }
            "downgraded" => {
                sqlx::query("UPDATE dashboard_sessions SET expires_at=NOW()+INTERVAL '1 hour';")
                    .execute(&s.db)
                    .await?;
                sqlx::query("UPDATE dashboard_users SET role='viewer'")
                    .execute(&s.db)
                    .await?;
            }
            _ => {
                sqlx::query("DELETE FROM dashboard_sessions")
                    .execute(&s.db)
                    .await?;
            }
        }
        let valid =
            crate::viewer::ws::refresh_viewer_session(&s, viewer, &mut actor, Some("session-hash"))
                .await;
        assert_eq!(valid, mode == "downgraded");
        assert!(matches!(
            queue.try_recv()?,
            AgentControl::InputCleanup { .. }
        ));
        if mode == "downgraded" {
            assert!(!actor.is_operator());
        }
    }
    Ok(())
}

#[tokio::test]
async fn unavailable_cached_capability_denies_acquire_heartbeat_notify_and_input() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (conn, mut queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    let mut cache = crate::viewer::ws::CapabilityCache::from([(
        (agent, conn, "remote_input"),
        Some("unsupported".into()),
    )]);
    let request = request(agent, "control_acquire", None);
    let event =
        crate::viewer::ws::viewer_message(&request.to_string(), &s, &actor, viewer, &mut cache)
            .await
            .unwrap();
    assert_eq!(event["request_id"], request["request_id"]);
    assert_eq!(event["code"], "capability_unavailable");
    assert!(event.get("lease_token").is_none());
    let token = acquire(&s, agent, viewer, &actor, now);
    for envelope in [
        self::request(agent, "control_heartbeat", Some(token)),
        input(
            agent,
            Some(token),
            json!({"type":"Notify","title":"Test","message":"Test"}),
        ),
        input(agent, Some(token), json!({"type":"MouseMove","x":0,"y":0})),
    ] {
        let event = crate::viewer::ws::viewer_message(
            &envelope.to_string(),
            &s,
            &actor,
            viewer,
            &mut cache,
        )
        .await
        .unwrap();
        assert_eq!(event["code"], "capability_unavailable");
    }
    // Explicit release must work even when capabilities become unavailable.
    assert_eq!(
        crate::viewer::ws::viewer_message(
            &self::request(agent, "control_release", Some(token)).to_string(),
            &s,
            &actor,
            viewer,
            &mut cache
        )
        .await
        .unwrap()["status"],
        "released"
    );
    assert!(queue.try_recv().is_err());
    let notification = json!({"type":"Notify","title":"Test","message":"Test"});
    assert_eq!(
        s.agents
            .send_agent_command_json(agent, &notification)
            .unwrap_err()
            .code,
        "control_lease_required"
    );
    cache.insert((agent, conn, "remote_input"), None);
    assert_eq!(
        crate::viewer::ws::viewer_message(
            &input(agent, None, notification).to_string(),
            &s,
            &actor,
            viewer,
            &mut cache
        )
        .await
        .unwrap()["code"],
        "control_lease_required"
    );
}

#[tokio::test]
async fn explicit_protocol_release_drains_once_before_new_owner_commands() {
    let s = offline_state();
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let actor = user();
    let (conn, mut queue, _) = connect(&s, agent, 32);
    let now = Instant::now();
    let token = acquire(&s, agent, viewer, &actor, now);
    s.send_viewer_input(
        agent,
        viewer,
        &actor,
        Some(token),
        &json!({"type":"KeyDown","key":"control"}),
        now,
    )
    .unwrap();
    queue.try_recv().unwrap();
    let response = message(
        &s,
        viewer,
        &actor,
        request(agent, "control_release", Some(token)),
    )
    .await
    .unwrap();
    assert_eq!(response["status"], "released");
    assert!(response.get("lease_token").is_none());
    assert_eq!(
        message(
            &s,
            viewer,
            &actor,
            request(agent, "control_release", Some(token))
        )
        .await
        .unwrap()["code"],
        "control_lease_required"
    );
    let successor = Uuid::new_v4();
    let next = acquire(&s, agent, successor, &actor, now);
    assert!(message(
        &s,
        successor,
        &actor,
        input(
            agent,
            Some(next),
            json!({"type":"Notify","title":"Test","message":"Test"})
        )
    )
    .await
    .is_none());
    let AgentControl::InputCleanup { conn_id, command } = queue.try_recv().unwrap() else {
        panic!()
    };
    assert_eq!(conn_id, conn);
    assert_eq!(command, json!({"type":"KeyUp","key":"control"}));
    assert!(matches!(queue.try_recv().unwrap(), AgentControl::Text(_)));
    assert!(queue.try_recv().is_err());
}

#[tokio::test]
async fn audit_backpressure_is_bounded_and_secret_debug_is_redacted() {
    let s = offline_state();
    let actor = user();
    let semaphore = s.control.lock().audit_inflight.clone();
    let occupied = semaphore.clone().acquire_many_owned(64).await.unwrap();
    s.audit_control_lease(&actor, Uuid::new_v4(), "control_acquire", None);
    assert!(s.control.lock().audit_seen.is_empty());
    drop(occupied);
    assert_eq!(semaphore.available_permits(), 64);
    // Even a Debug log of a private broadcast must not expose its lease token.
    let token = Uuid::new_v4();
    let event = Broadcast::PrivateText(Uuid::new_v4(), json!({"lease_token":token}).to_string());
    assert!(!format!("{event:?}").contains(&token.to_string()));
    let agent = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    connect(&s, agent, 1);
    let lease = acquire(&s, agent, viewer, &actor, Instant::now());
    let cleanup = s.control.lock().sessions.revoke_viewer(viewer);
    assert!(!format!("{cleanup:?}").contains(&lease.to_string()));
}
