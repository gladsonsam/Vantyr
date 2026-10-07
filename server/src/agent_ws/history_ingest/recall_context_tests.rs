use super::*;
use crate::agents::modules::db as modules_db;
use crate::{
    agents::modules::Module,
    state::AgentControl,
    test_support::recall::{fixture, frame_header as header},
};
use serde_json::{json, Value};
use sqlx::Row;

async fn row(s: &AppState, agent: Uuid, uid: &Value) -> Value {
    let r=sqlx::query("SELECT capture_context,context_app,context_title,context_url_host,capture_duration_ms,blob_ref FROM screen_frames WHERE agent_id=$1 AND client_uid=$2")
        .bind(agent).bind(uid.as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&s.db).await.unwrap();
    json!({"context":r.get::<Option<Value>,_>("capture_context"),"app":r.get::<Option<String>,_>("context_app"),
        "title":r.get::<Option<String>,_>("context_title"),"host":r.get::<Option<String>,_>("context_url_host"),
        "duration":r.get::<Option<i32>,_>("capture_duration_ms"),"blob":r.get::<String,_>("blob_ref")})
}
fn files(s: &AppState, agent: Uuid) -> usize {
    std::fs::read_dir(s.settings.screen_history_dir.join(agent.to_string()))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|day| std::fs::read_dir(day.path()).into_iter().flatten().count())
        .sum()
}
#[sqlx::test(migrations = false)]
async fn recall_context_ingest_retries_are_first_wins_scoped_and_cleanup_blobs(db: sqlx::PgPool) {
    let (s, agent, conn, mut queue) = fixture(db).await;
    let lease = Arc::new(s.agents.lifecycle.for_agent(agent).read_owned().await);
    let h = header();
    let jpeg = b"\xff\xd8raw-jpeg\xff\xd9".to_vec();
    store_history_frame(agent, conn, &h, jpeg.clone(), &s, &lease).await;
    let original = row(&s, agent, &h["uid"]).await;
    assert_eq!(original["app"], "editor.exe");
    assert_eq!(original["host"], "example.com");
    assert_eq!(original["duration"], 24);
    assert!(!original["context"].to_string().contains("grant_revisions"));
    assert_eq!(
        std::fs::read(
            s.settings
                .screen_history_dir
                .join(original["blob"].as_str().unwrap())
        )
        .unwrap(),
        jpeg
    );
    s.agents
        .modules
        .lock()
        .get_mut(&agent)
        .unwrap()
        .report
        .modules
        .iter_mut()
        .find(|m| m.module == Module::WindowActivity)
        .unwrap()
        .revision = 13;
    let mut retry = h.clone();
    retry["ocr_text"] = json!("changed");
    store_history_frame(agent, conn, &retry, b"retry".to_vec(), &s, &lease).await;
    assert_eq!(row(&s, agent, &h["uid"]).await, original);
    assert_eq!(files(&s, agent), 1);
    for _ in 0..2 {
        let AgentControl::Text(ack) = queue.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(
            serde_json::from_str::<Value>(&ack).unwrap()["uid"],
            h["uid"]
        );
    }
    let other = Uuid::new_v4();
    crate::test_support::insert_agent(&s.db, other)
        .await
        .unwrap();
    let (other_conn, _, _) = crate::test_support::control::connect(&s, other, 16);
    let other_lease = Arc::new(s.agents.lifecycle.for_agent(other).read_owned().await);
    store_history_frame(other, other_conn, &h, jpeg, &s, &other_lease).await;
    assert_eq!(files(&s, other), 1);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM screen_frames WHERE client_uid=$1")
        .bind(h["uid"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(count, 2);
    drop(lease);
    drop(other_lease);
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}
#[sqlx::test(migrations = false)]
async fn recall_context_legacy_binary_json_malformed_and_invalid_identity(db: sqlx::PgPool) {
    let (s, agent, conn, mut queue) = fixture(db).await;
    let lease = Arc::new(s.agents.lifecycle.for_agent(agent).read_owned().await);
    let jpeg = b"\xff\xd8legacy\xff\xd9";
    let mut legacy = header();
    legacy.as_object_mut().unwrap().remove("context");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("capture_duration_ms");
    legacy["captured_at"] = json!("invalid legacy timestamp");
    legacy["jpeg_b64"] = json!(base64::engine::general_purpose::STANDARD.encode(jpeg));
    ingest_history_frame(agent, conn, &legacy, &s, &lease).await;
    assert!(row(&s, agent, &legacy["uid"]).await["context"].is_null());
    let mut h = header();
    h["context"]["window"]["app"] = json!(true);
    let bytes = serde_json::to_vec(&h).unwrap();
    let mut frame = b"HST\0".to_vec();
    frame.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    frame.extend_from_slice(&bytes);
    frame.extend_from_slice(jpeg);
    ingest_history_frame_binary(agent, conn, &frame, &s, &lease).await;
    let r = row(&s, agent, &h["uid"]).await;
    assert!(r["app"].is_null());
    assert_eq!(r["host"], "example.com");
    while queue.try_recv().is_ok() {}
    for invalid in ["missing", "bad"] {
        h = header();
        h["captured_at"] = json!(invalid);
        store_history_frame(agent, conn, &h, jpeg.to_vec(), &s, &lease).await;
        let AgentControl::Text(ack) = queue.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(
            serde_json::from_str::<Value>(&ack).unwrap()["rejected"],
            true
        );
    }
    h = header();
    h["uid"] = json!("invalid uuid");
    store_history_frame(agent, conn, &h, jpeg.to_vec(), &s, &lease).await;
    let AgentControl::Text(ack) = queue.try_recv().unwrap() else {
        panic!()
    };
    assert_eq!(
        serde_json::from_str::<Value>(&ack).unwrap()["rejected"],
        true
    );
    assert_eq!(files(&s, agent), 2);
    drop(lease);
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}
#[sqlx::test(migrations = false)]
async fn recall_context_current_connection_pending_stop_and_disabled_grants(db: sqlx::PgPool) {
    let (s, agent, conn, _) = fixture(db).await;
    let lease = Arc::new(s.agents.lifecycle.for_agent(agent).read_owned().await);
    let pending = modules_db::ModuleDisableRequest {
        command_id: Uuid::new_v4(),
        agent_id: agent,
        module: Module::WindowActivity,
        expected_revision: 12,
        status: "queued".into(),
        error: None,
        created_at: chrono::Utc::now(),
        acknowledged_at: None,
        persisted: false,
        stopped: false,
        stop_status: "unconfirmed".into(),
        pending: true,
    };
    s.agents
        .modules
        .lock()
        .get_mut(&agent)
        .unwrap()
        .pending
        .insert(pending.command_id, pending);
    let h = header();
    store_history_frame(agent, conn, &h, b"jpeg".to_vec(), &s, &lease).await;
    let r = row(&s, agent, &h["uid"]).await;
    assert!(r["app"].is_null());
    assert_eq!(r["host"], "example.com");
    s.agents
        .modules
        .lock()
        .get_mut(&agent)
        .unwrap()
        .report
        .modules
        .iter_mut()
        .find(|m| m.module == Module::BrowserUrls)
        .unwrap()
        .enabled = false;
    let h = header();
    store_history_frame(agent, conn, &h, b"jpeg".to_vec(), &s, &lease).await;
    let r = row(&s, agent, &h["uid"]).await;
    assert!(r["app"].is_null() && r["host"].is_null());
    let h = header();
    store_history_frame(agent, Uuid::new_v4(), &h, b"jpeg".to_vec(), &s, &lease).await;
    assert_eq!(files(&s, agent), 2);
    s.agents.modules.lock().get_mut(&agent).unwrap().conn_id = Uuid::new_v4();
    let h = header();
    store_history_frame(agent, conn, &h, b"jpeg".to_vec(), &s, &lease).await;
    assert_eq!(files(&s, agent), 2);
    s.agents.modules.lock().get_mut(&agent).unwrap().conn_id = conn;
    s.agents
        .modules
        .lock()
        .get_mut(&agent)
        .unwrap()
        .report
        .modules
        .iter_mut()
        .find(|m| m.module == Module::Recall)
        .unwrap()
        .enabled = false;
    let h = header();
    store_history_frame(agent, conn, &h, b"jpeg".to_vec(), &s, &lease).await;
    assert_eq!(files(&s, agent), 2);
    assert!(s.agents.lifecycle.for_agent(agent).try_write().is_err());
    drop(lease);
    std::fs::remove_dir_all(&s.settings.screen_history_dir).unwrap();
}
