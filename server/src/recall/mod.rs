//! Recall (screen history): the frame index and blob store, OCR/context search, capture
//! settings, the day narrative, and retention.

use std::sync::Arc;

use axum::{routing::get, Router};

use crate::state::AppState;

mod api;
pub mod blob_store;
pub mod context;
pub mod db;
pub mod narrative;
pub mod retention;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents/history/devices", get(api::history_devices))
        .route("/agents/:id/history/frames", get(api::history_frames))
        .route("/agents/:id/history/frame", get(api::history_frame_at))
        .route("/agents/:id/history/search", get(api::history_search))
        .route("/agents/:id/history/activity", get(api::history_activity))
        .route("/agents/:id/history/days", get(api::history_days))
        .route("/agents/:id/history/monitors", get(api::history_monitors))
        .route("/agents/:id/history/segments", get(api::history_segments))
        .route(
            "/agents/:id/history/day-summary",
            get(api::history_day_summary),
        )
        .route("/agents/:id/history/blob/:frame_id", get(api::history_blob))
        .route(
            "/agents/:id/history/text/:frame_id",
            get(api::history_frame_text),
        )
        // Recall capture tunables: global defaults + per-agent overrides.
        .route(
            "/settings/recall",
            get(api::recall_settings_get).put(api::recall_settings_put),
        )
        .route(
            "/agents/:id/history/settings",
            get(api::agent_recall_settings_get)
                .put(api::agent_recall_settings_put)
                .delete(api::agent_recall_settings_delete),
        )
}
