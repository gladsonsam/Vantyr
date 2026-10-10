//! Remote control of a live agent: exclusive input leases, capture arbitration between
//! viewers, clipboard RPCs, and the live screen/audio HTTP streams.

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

pub mod capture_arbitration;
pub mod clipboard;
mod live_media;
pub mod runtime;
pub mod sessions;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents/:id/clipboard", post(clipboard::http))
        .route("/agents/:id/screen", get(live_media::agent_screen))
        .route("/agents/:id/mjpeg", get(live_media::agent_mjpeg))
        .route(
            "/agents/:id/mjpeg/leave",
            post(live_media::agent_mjpeg_leave),
        )
        .route("/agents/:id/audio", get(live_media::agent_audio))
}
