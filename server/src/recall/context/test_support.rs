//! Temporary relations only. Never migrate or write the shared database schema.
use crate::{
    agent_modules::Module,
    state::{AgentControl, AppState},
};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

pub async fn fixture() -> (Arc<AppState>, Uuid, Uuid, mpsc::Receiver<AgentControl>) {
    let (s, agent, _) = crate::state::agent_lifecycle::test_support::state()
        .await
        .unwrap();
    sqlx::raw_sql(r"
        CREATE TEMP TABLE screen_frames (
            id BIGSERIAL, agent_id UUID NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
            monitor INT NOT NULL, w INT NOT NULL, h INT NOT NULL, phash BIGINT NOT NULL,
            blob_ref TEXT NOT NULL, ocr_text TEXT, ocr_tsv TSVECTOR, client_uid UUID, ocr_words JSONB,
            PRIMARY KEY(captured_at,id));
        CREATE UNIQUE INDEX idx_screen_frames_client_uid ON screen_frames(captured_at,client_uid);
        CREATE INDEX ON screen_frames(agent_id,captured_at DESC,id DESC);
    ").execute(&s.db).await.unwrap();
    // A retained pre-migration row proves there is no automatic backfill.
    sqlx::query("INSERT INTO screen_frames(agent_id,captured_at,monitor,w,h,phash,blob_ref) VALUES ($1,'2025-01-01',0,10,10,0,'legacy.jpg')")
        .bind(agent).execute(&s.db).await.unwrap();
    sqlx::raw_sql(include_str!("../../../migrations/0071_recall_context.sql"))
        .execute(&s.db)
        .await
        .unwrap();
    let (conn, queue, _) = crate::control_runtime::tests::connect(&s, agent, 64);
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
pub fn header() -> serde_json::Value {
    let mut h = super::tests::header();
    h["uid"] = serde_json::json!(Uuid::new_v4());
    h["captured_at"] = serde_json::json!("2026-01-01T00:00:00.123456Z");
    h["monitor"] = serde_json::json!(0);
    h["w"] = serde_json::json!(100);
    h["h"] = serde_json::json!(100);
    h["phash"] = serde_json::json!("0");
    h["ocr_text"] = serde_json::json!("needle");
    h
}
