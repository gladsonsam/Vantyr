//! Device policy: app blocking, internet blocking, and alert rules.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod alert_rules;
pub mod app_block;
pub mod internet_block;

/// Weekly active window shared by app-block and internet-block rules.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RuleScheduleJson {
    pub day_of_week: i32,
    pub start_minute: i32,
    pub end_minute: i32,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .merge(alert_rules::routes())
        .merge(app_block::routes())
        .merge(internet_block::routes())
}
