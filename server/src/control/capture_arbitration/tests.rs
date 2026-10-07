use super::*;
use crate::{
    control::runtime::tests::{connect, fixture, tagged_frame, user},
    state::AgentControl,
};
use std::time::Duration;
fn prefs(monitor: Option<u32>, q: u8) -> MjpegViewerPrefs {
    MjpegViewerPrefs {
        monitor,
        jpeg_quality: q,
        interval_ms: 200,
    }
}
fn setup() -> (
    std::sync::Arc<AppState>,
    Uuid,
    Uuid,
    tokio::sync::mpsc::Receiver<AgentControl>,
) {
    let s = fixture();
    let agent = Uuid::new_v4();
    let (conn, queue, _) = connect(&s, agent, 32);
    s.media.mjpeg_sessions.lock().clear();
    s.media.mjpeg_active_capture.lock().clear();
    (s, agent, conn, queue)
}
fn acquire(s: &AppState, agent: Uuid, session: Uuid, viewer: Uuid) -> Value {
    s.control_lease_message(viewer,&user(),&json!({"type":"control_acquire","agent_id":agent,"capture_session":session,"request_id":Uuid::new_v4()}),Instant::now())
}
#[tokio::test]
async fn same_user_second_tab_cannot_switch_or_retune_and_conflict_is_transactional() {
    let (s, agent, _, mut queue) = setup();
    let session = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, tagged_frame(0));
    assert_eq!(acquire(&s, agent, session, viewer)["status"], "granted");
    let old = s.media.mjpeg_active_capture.lock()[&agent];
    let frame = s.media.frames.lock()[&agent].jpeg.clone();
    let conflict = Uuid::new_v4();
    assert_eq!(
        s.begin_mjpeg_session(agent, conflict, user().user_id, prefs(Some(1), 85), Some(1))
            .unwrap_err()
            .code,
        "capture_selection_locked"
    );
    assert!(!s.media.mjpeg_sessions.lock().contains_key(&conflict));
    assert_eq!(s.media.capture_viewers.lock()[&agent], 1);
    assert_eq!(s.media.mjpeg_active_capture.lock()[&agent], old);
    assert_eq!(s.media.frames.lock()[&agent].jpeg, frame);
    assert!(queue.try_recv().is_err());
    let compatible = Uuid::new_v4();
    s.begin_mjpeg_session(
        agent,
        compatible,
        user().user_id,
        prefs(Some(0), 85),
        Some(0),
    )
    .unwrap();
    assert!(queue.try_recv().is_err());
    assert_eq!(s.media.mjpeg_active_capture.lock()[&agent], old);
    assert_eq!(
        acquire(&s, agent, compatible, Uuid::new_v4())["code"],
        "control_conflict"
    );
    s.end_mjpeg_session(agent, compatible, Some(user().user_id));
    assert!(queue.try_recv().is_err());
    s.revoke_viewer_control(viewer);
    s.begin_mjpeg_session(agent, conflict, user().user_id, prefs(Some(1), 85), Some(1))
        .unwrap();
    assert!(matches!(queue.try_recv().unwrap(), AgentControl::Text(_)));
    assert_eq!(
        acquire(&s, agent, session, viewer)["code"],
        "capture_selection_stale"
    );
}
#[test]
fn default_resolution_explicit_primary_and_invalid_indices() {
    let info = json!({"monitors":[{"primary":false},{"primary":true}]});
    assert_eq!(resolve_monitor(None, Some(&info)).unwrap(), Some(1));
    assert_eq!(resolve_monitor(Some(1), Some(&info)).unwrap(), Some(1));
    assert!(resolve_monitor(Some(2), Some(&info)).is_err());
    assert!(resolve_monitor(Some(64), None).is_err());
    assert_eq!(resolve_monitor(None, None).unwrap(), None);
}
#[tokio::test]
async fn primary_wire_default_preserved_and_unknown_inventory_needs_confirmed_geometry() {
    let (s, agent, _, mut queue) = setup();
    let session = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(None, 40), None)
        .unwrap();
    let AgentControl::Text(cmd) = queue.try_recv().unwrap() else {
        panic!()
    };
    assert!(serde_json::from_str::<Value>(&cmd).unwrap()["monitor"].is_null());
    assert_eq!(
        acquire(&s, agent, session, viewer)["code"],
        "capture_frame_required"
    );
    s.media
        .store_frame(agent, bytes::Bytes::from_static(&[0xff, 0xd8, 0xff, 0xd9]));
    assert_eq!(
        acquire(&s, agent, session, viewer)["code"],
        "capture_geometry_required"
    );
    s.media.store_frame(agent, tagged_frame(1));
    assert_eq!(acquire(&s, agent, session, viewer)["monitor"], 1);
    s.begin_mjpeg_session(
        agent,
        Uuid::new_v4(),
        user().user_id,
        prefs(Some(1), 85),
        Some(1),
    )
    .unwrap();
    assert!(queue.try_recv().is_err());
    s.begin_mjpeg_session(agent, Uuid::new_v4(), user().user_id, prefs(None, 40), None)
        .unwrap();
    assert!(queue.try_recv().is_err());
}
#[tokio::test]
async fn frame_and_session_fences_reject_foreign_stale_and_mismatched_selections() {
    let (s, agent, conn, mut queue) = setup();
    let session = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(1), 40), Some(1))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, tagged_frame(0));
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_selection_stale"
    );
    s.media.store_frame(agent, tagged_frame(1));
    s.media.frames.lock().get_mut(&agent).unwrap().last_update =
        Instant::now() - Duration::from_secs(11);
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_frame_required"
    );
    s.media.store_frame(agent, tagged_frame(1));
    s.media
        .mjpeg_sessions
        .lock()
        .get_mut(&session)
        .unwrap()
        .user_id = Uuid::new_v4();
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_session_stale"
    );
    s.media
        .mjpeg_sessions
        .lock()
        .get_mut(&session)
        .unwrap()
        .user_id = user().user_id;
    s.media
        .mjpeg_sessions
        .lock()
        .get_mut(&session)
        .unwrap()
        .conn_id = Uuid::new_v4();
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_session_stale"
    );
    s.media
        .mjpeg_sessions
        .lock()
        .get_mut(&session)
        .unwrap()
        .conn_id = conn;
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["status"],
        "granted"
    );
}
#[tokio::test]
async fn ending_bound_stream_drains_lease_once_and_stale_drop_cannot_stop_replacement() {
    let (s, agent, conn, mut queue) = setup();
    let session = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, tagged_frame(0));
    let event = acquire(&s, agent, session, viewer);
    let token = event["lease_token"].as_str().unwrap().parse().unwrap();
    s.send_viewer_input(
        agent,
        viewer,
        &user(),
        Some(token),
        &json!({"type":"KeyDown","key":"shift"}),
        Instant::now(),
    )
    .unwrap();
    queue.try_recv().unwrap();
    assert!(!s.end_mjpeg_session(agent, session, Some(Uuid::new_v4())));
    assert!(s.end_mjpeg_session(agent, session, Some(user().user_id)));
    assert!(!s.end_mjpeg_session(agent, session, None));
    assert!(matches!(
        queue.try_recv().unwrap(),
        AgentControl::InputCleanup { .. }
    ));
    assert!(matches!(queue.try_recv().unwrap(), AgentControl::Text(_)));
    assert!(s.media.capture_viewers.lock().is_empty());
    assert!(s.control.lock().capture.is_empty());
    let new = Uuid::new_v4();
    s.begin_mjpeg_session(agent, new, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    {
        let mut control = s.control.lock();
        s.revoke_agent_control_locked(&mut control, agent, conn);
        s.clear_capture_connection_locked(agent, conn);
    }
    assert!(!s.end_mjpeg_session(agent, new, None));
    assert!(s.media.mjpeg_sessions.lock().is_empty());
    assert!(queue.try_recv().is_err());
}
#[tokio::test]
async fn expiry_releases_freeze_even_when_old_http_viewer_remains() {
    let (s, agent, _, mut queue) = setup();
    let session = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, tagged_frame(0));
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["status"],
        "granted"
    );
    s.expire_control(Instant::now() + Duration::from_secs(16));
    s.begin_mjpeg_session(
        agent,
        Uuid::new_v4(),
        user().user_id,
        prefs(Some(1), 40),
        Some(1),
    )
    .unwrap();
    assert_eq!(
        s.media.mjpeg_active_capture.lock()[&agent].prefs.monitor,
        Some(1)
    );
}
#[test]
fn bounded_marker_parser_keeps_raw_app15_and_rejects_invalid_geometry() {
    let jpeg = tagged_frame(0);
    let original = jpeg.clone();
    assert_eq!(frame_geometry(&jpeg).unwrap()["monitor_index"], 0);
    assert_eq!(jpeg, original);
    for invalid in [
        &jpeg[..4],
        &[0xff, 0xd8, 0xff, 0xef, 0, 1][..],
        &[0xff, 0xd8, 0xff, 0xef, 255, 255][..],
    ] {
        assert!(frame_geometry(invalid).is_none());
    }
}

#[tokio::test]
async fn queued_older_restart_and_stop_do_not_override_latest_selection() {
    let (s, agent, conn, mut queue) = setup();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    s.begin_mjpeg_session(agent, first, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    s.begin_mjpeg_session(agent, second, user().user_id, prefs(Some(1), 40), Some(1))
        .unwrap();
    let AgentControl::Text(old) = queue.try_recv().unwrap() else {
        panic!()
    };
    let AgentControl::Text(new) = queue.try_recv().unwrap() else {
        panic!()
    };
    assert!(!s.command_deliverable(agent, conn, &serde_json::from_str(&old).unwrap()));
    assert!(s.command_deliverable(agent, conn, &serde_json::from_str(&new).unwrap()));
    s.end_mjpeg_session(agent, first, None);
    s.end_mjpeg_session(agent, second, None);
    let AgentControl::Text(stop) = queue.try_recv().unwrap() else {
        panic!()
    };
    s.begin_mjpeg_session(
        agent,
        Uuid::new_v4(),
        user().user_id,
        prefs(Some(0), 40),
        Some(0),
    )
    .unwrap();
    assert!(!s.command_deliverable(agent, conn, &serde_json::from_str(&stop).unwrap()));
}
#[tokio::test]
async fn old_same_monitor_frame_cannot_satisfy_new_capture() {
    let (s, agent, _, mut queue) = setup();
    let old = tagged_frame(0);
    s.media.store_frame(agent, old.clone());
    let session = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, old);
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_frame_pending"
    );
    s.media.store_frame(agent, tagged_frame(0));
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["status"],
        "granted"
    );
}
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary tables only"]
async fn actual_http_conflict_drop_leave_and_raw_jpeg_preservation() -> anyhow::Result<()> {
    use axum::{
        extract::{Extension, Path, Query, State},
        http::StatusCode,
        Json,
    };
    use futures_util::StreamExt;
    let (s, agent, _) = crate::state::agent_lifecycle::test_support::state().await?;
    sqlx::raw_sql("CREATE TEMP TABLE agent_info(agent_id UUID PRIMARY KEY,info JSONB);")
        .execute(&s.db)
        .await?;
    sqlx::query("INSERT INTO agent_info VALUES($1,$2)").bind(agent).bind(json!({"capabilities":{"screen_capture":"supported"},"monitors":[{"primary":true},{"primary":false}]})).execute(&s.db).await?;
    let (_, mut queue, _) = connect(&s, agent, 32);
    s.media.mjpeg_sessions.lock().clear();
    s.media.mjpeg_active_capture.lock().clear();
    let session = Uuid::new_v4();
    let call = |session, monitor: Option<u32>, s: std::sync::Arc<AppState>| async move {
        crate::control::live_media::agent_mjpeg(
            Path(agent),
            Query(serde_json::from_value(json!({"session":session,"monitor":monitor})).unwrap()),
            State(s),
            Extension(user()),
        )
        .await
    };
    let response = call(session, None, s.clone()).await;
    assert_eq!(response.status(), StatusCode::OK);
    queue.try_recv()?;
    let jpeg = tagged_frame(0);
    s.media.store_frame(agent, jpeg.clone());
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["status"],
        "granted"
    );
    let rejected = call(Uuid::new_v4(), Some(1), s.clone()).await;
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(rejected.into_body(), 4096).await?;
    assert_eq!(
        serde_json::from_slice::<Value>(&body)?["code"],
        "capture_selection_locked"
    );
    assert_eq!(s.media.capture_viewers.lock()[&agent], 1);
    let mut stream = response.into_body().into_data_stream();
    let part = tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await?
        .unwrap()?;
    let offset = part.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    assert_eq!(&part[offset..offset + jpeg.len()], jpeg.as_ref());
    let snapshot =
        crate::control::live_media::agent_screen(Path(agent), State(s.clone()), Extension(user()))
            .await;
    assert_eq!(
        axum::body::to_bytes(snapshot.into_body(), 10000).await?,
        jpeg
    );
    let compatible = call(Uuid::new_v4(), Some(0), s.clone()).await;
    assert_eq!(compatible.status(), StatusCode::OK);
    drop(compatible);
    assert_eq!(s.media.capture_viewers.lock()[&agent], 1);
    assert!(queue.try_recv().is_err());
    crate::control::live_media::agent_mjpeg_leave(
        Path(agent),
        State(s.clone()),
        Extension(user()),
        Json(serde_json::from_value(json!({"session":session}))?),
    )
    .await;
    assert!(s.media.capture_viewers.lock().is_empty());
    assert!(s.control.lock().capture.is_empty());
    drop(stream);
    assert!(s.media.mjpeg_sessions.lock().is_empty());
    Ok(())
}

#[tokio::test]
async fn observed_retired_frame_ids_remain_bounded_across_restart_and_stop_start() {
    let (s, agent, conn, mut queue) = setup();
    let first = tagged_frame(0);
    let mut session = Uuid::new_v4();
    s.media.store_frame(agent, first.clone());
    for q in 20..60 {
        s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), q), Some(0))
            .unwrap();
        queue.try_recv().unwrap();
        s.media.store_frame(agent, tagged_frame(0));
        s.end_mjpeg_session(agent, session, None);
        queue.try_recv().unwrap();
        session = Uuid::new_v4();
    }
    assert_eq!(
        s.media.mjpeg_retired_captures.lock()[&agent]
            .1
            .iter()
            .flatten()
            .count(),
        32
    );
    let last = s.media.frames.lock()[&agent].jpeg.clone();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 40), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, last);
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "capture_frame_pending"
    );
    s.clear_capture_connection_locked(agent, conn);
    assert!(s.media.mjpeg_retired_captures.lock().is_empty());
}

#[tokio::test]
async fn two_retired_restarts_and_browser_geometry_mismatch_cannot_grant_control() {
    let (s, agent, _, mut queue) = setup();
    let viewer = Uuid::new_v4();
    let mut session = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), 20), Some(0))
        .unwrap();
    queue.try_recv().unwrap();
    let first = tagged_frame(0);
    s.media.store_frame(agent, first.clone());
    for q in [40, 60] {
        session = Uuid::new_v4();
        s.begin_mjpeg_session(agent, session, user().user_id, prefs(Some(0), q), Some(0))
            .unwrap();
        queue.try_recv().unwrap();
        s.media.store_frame(agent, tagged_frame(0));
    }
    s.media.store_frame(agent, first);
    assert_eq!(
        acquire(&s, agent, session, viewer)["code"],
        "capture_frame_pending"
    );
    s.media.store_frame(agent, tagged_frame(0));
    let response=s.control_lease_message(viewer,&user(),&json!({"type":"control_acquire","agent_id":agent,"capture_session":session,"request_id":Uuid::new_v4(),"capture_id":Uuid::new_v4(),"geometry_revision":1}),Instant::now());
    assert_eq!(response["code"], "capture_geometry_stale");
    assert_eq!(acquire(&s, agent, session, viewer)["status"], "granted");
}
#[tokio::test]
async fn conflicting_acquire_does_not_pin_default_monitor() {
    let (s, agent, conn, mut queue) = setup();
    let session = Uuid::new_v4();
    s.begin_mjpeg_session(agent, session, user().user_id, prefs(None, 40), None)
        .unwrap();
    queue.try_recv().unwrap();
    s.media.store_frame(agent, tagged_frame(1));
    let other = LeaseOwner {
        viewer_connection_id: Uuid::new_v4(),
        user_id: user().user_id,
        agent_connection_id: conn,
    };
    let held = s
        .control
        .lock()
        .sessions
        .acquire(agent, other, Duration::from_secs(10), Instant::now())
        .result
        .unwrap()
        .token;
    assert_eq!(
        acquire(&s, agent, session, Uuid::new_v4())["code"],
        "control_conflict"
    );
    assert_eq!(
        s.media.mjpeg_active_capture.lock()[&agent].prefs.monitor,
        None
    );
    assert_eq!(s.media.mjpeg_sessions.lock()[&session].prefs.monitor, None);
    let released = s
        .control
        .lock()
        .sessions
        .release(agent, other, held, Instant::now());
    assert!(released.result.is_ok());
    assert_eq!(acquire(&s, agent, session, Uuid::new_v4())["monitor"], 1);
    assert_eq!(
        s.media.mjpeg_active_capture.lock()[&agent].prefs.monitor,
        Some(1)
    );
    assert_eq!(
        s.media.mjpeg_sessions.lock()[&session].prefs.monitor,
        Some(1)
    );
}

#[tokio::test]
async fn viewers_can_open_the_live_stream() {
    let (s, agent, _, _queue) = setup();
    let mut viewer = user();
    viewer.role = "viewer".into();
    let session = Uuid::new_v4();
    let response = crate::control::live_media::agent_mjpeg(
        axum::extract::Path(agent),
        axum::extract::Query(serde_json::from_value(json!({"session": session})).unwrap()),
        axum::extract::State(s.clone()),
        axum::Extension(viewer),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(s.media.mjpeg_sessions.lock().contains_key(&session));
}
