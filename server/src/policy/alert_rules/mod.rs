//! Alert rules: admin CRUD, match evaluation against agent telemetry (`engine`), and the
//! event history with optional screenshots.

use std::sync::Arc;

use axum::{
    routing::{get, put},
    Router,
};

use crate::state::AppState;

mod api;
pub mod db;
mod engine;

pub use engine::{
    evaluate_offline_alerts, on_metrics_event, on_url_category_event, on_url_or_keys_event,
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/agents/:id/alert-rule-events",
            get(api::agent_alert_rule_events),
        )
        .route(
            "/alert-rule-events/:id/screenshot",
            get(api::alert_rule_event_screenshot),
        )
        .route("/alert-rule-events", get(api::alert_rule_events_all_h))
        .route(
            "/alert-rules",
            get(api::alert_rules_list_h).post(api::alert_rules_create_h),
        )
        .route(
            "/alert-rules/:rule_id/events",
            get(api::alert_rule_events_for_rule_h),
        )
        .route(
            "/alert-rules/:rule_id",
            put(api::alert_rules_update_h).delete(api::alert_rules_delete_h),
        )
}
