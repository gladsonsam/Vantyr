//! Recall (screen history) fixtures: a connected device with context grants and frame headers.

use std::borrow::Cow;
use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::migrate::Migrator;
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::agents::modules::Module;
use crate::state::{AgentControl, AppState};

/// First migration that adds capture context to `screen_frames`.
const RECALL_CONTEXT_MIGRATION: i64 = 71;

/// A connected device (`super::state`) whose Window Activity grant is at revision 12 and
/// Browser URLs grant at revision 9, matching [`context_header`]'s grant revisions.
///
/// The database is migrated in two steps around `0071_recall_context`, with a frame stored in
/// between: that retained pre-migration row proves the migration backfills no context. Tests
/// using this fixture therefore need `#[sqlx::test(migrations = false)]`.
pub async fn fixture(db: PgPool) -> (Arc<AppState>, Uuid, Uuid, mpsc::Receiver<AgentControl>) {
    let all = sqlx::migrate!("./migrations");
    let before_context = Migrator {
        migrations: Cow::Owned(
            all.iter()
                .filter(|m| m.version < RECALL_CONTEXT_MIGRATION)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    before_context
        .run(&db)
        .await
        .expect("the recall fixture needs #[sqlx::test(migrations = false)]");
    let (s, agent, _) = super::state(db).await.unwrap();
    sqlx::query("INSERT INTO screen_frames(agent_id,captured_at,monitor,w,h,phash,blob_ref) VALUES ($1,'2025-01-01',0,10,10,0,'legacy.jpg')")
        .bind(agent).execute(&s.db).await.unwrap();
    all.run(&s.db).await.unwrap();
    let (conn, queue, _) = super::control::connect(&s, agent, 64);
    {
        let mut modules = s.agents.modules.lock();
        let report = &mut modules.get_mut(&agent).unwrap().report;
        report.revision = 12;
        for module in &mut report.modules {
            if module.module == Module::WindowActivity {
                module.revision = 12;
            }
            if module.module == Module::BrowserUrls {
                module.revision = 9;
            }
        }
    }
    (s, agent, conn, queue)
}

/// The capture-context part of a history frame header, granted at revisions 12 and 9.
pub fn context_header() -> Value {
    json!({"capture_duration_ms":24,"context":{"version":1,"scope":"session_foreground","bracket_ms":48,"monitor_relation":"unknown",
        "window":{"status":"observed","reason":null,"source":"win32","app":"Editor.EXE","title":"文档 100%_done"},
        "browser":{"status":"observed","reason":null,"source":"uia_hwnd","url":null,"url_host":"EXAMPLE.COM."},
        "grant_revisions":{"window_activity":12,"browser_urls":9}}})
}

/// A complete history frame header with a fresh client uid and OCR text `needle`.
pub fn frame_header() -> Value {
    let mut h = context_header();
    h["uid"] = json!(Uuid::new_v4());
    h["captured_at"] = json!("2026-01-01T00:00:00.123456Z");
    h["monitor"] = json!(0);
    h["w"] = json!(100);
    h["h"] = json!(100);
    h["phash"] = json!("0");
    h["ocr_text"] = json!("needle");
    h
}
