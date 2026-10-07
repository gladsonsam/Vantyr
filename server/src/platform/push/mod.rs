//! Web Push (PWA) subscriptions and the VAPID public key.

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

mod api;
pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/push/vapid-public-key", get(api::vapid_public_key))
        .route("/push/subscribe", post(api::subscribe))
        .route("/push/unsubscribe", post(api::unsubscribe))
}
