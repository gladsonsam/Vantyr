//! Agents: the device directory and everything administered per device.

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;
use uuid::Uuid;

mod analytics;
pub mod auto_update;
pub mod capabilities;
pub mod db;
pub mod enrollment;
mod fleet_summary;
pub mod groups;
mod info_shape;
pub mod lifecycle;
mod list;
mod logs;
pub mod modules;
pub mod telemetry;
pub mod wol;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents", get(list::list_agents))
        .route("/agents/overview", get(list::list_agents_overview))
        .route(
            "/agents/:id/revoke-credentials",
            post(lifecycle::revoke_agent_credentials),
        )
        .route("/agents/delete", post(lifecycle::delete_agents_bulk))
        .route(
            "/agents/:id/icon",
            get(list::agent_icon_get).put(list::agent_icon_put),
        )
        .route("/agent-sessions", get(list::agent_sessions_all))
        .route(
            "/agents/:id/update-now",
            post(auto_update::api::agent_update_now),
        )
        .route("/agents/fleet-summary", get(fleet_summary::fleet_summary))
        .route("/agents/:id/modules", get(modules::api::get_modules))
        .route(
            "/agents/:id/modules/disable",
            post(modules::api::disable_module),
        )
        .route("/agents/:id/info", get(telemetry::api::agent_info))
        .route("/agents/:id/logs/sources", get(logs::agent_log_sources))
        .route("/agents/:id/logs/tail", get(logs::agent_log_tail))
        .route("/agents/:id/windows", get(telemetry::api::agent_windows))
        .route("/agents/:id/keys", get(telemetry::api::agent_keys))
        .route("/agents/:id/urls", get(telemetry::api::agent_urls))
        .route(
            "/agents/:id/url-category-stats",
            get(telemetry::api::agent_url_category_stats),
        )
        .route(
            "/agents/:id/url-category-backfill",
            post(telemetry::api::agent_url_category_backfill),
        )
        .route("/agents/:id/metrics", get(analytics::agent_metrics_history))
        .route(
            "/agents/:id/analytics/url-categories",
            get(analytics::agent_url_categories_time),
        )
        .route(
            "/agents/:id/analytics/url-sites",
            get(analytics::agent_url_sites_time),
        )
        .route(
            "/agents/:id/analytics/url-sessions",
            get(analytics::agent_url_sessions),
        )
        .route("/agents/:id/activity", get(telemetry::api::agent_activity))
        .route("/agents/:id/top-urls", get(telemetry::api::agent_top_urls))
        .route(
            "/agents/:id/top-windows",
            get(telemetry::api::agent_top_windows),
        )
        .route(
            "/agents/:id/history/clear",
            post(telemetry::api::clear_agent_history),
        )
        .route("/agents/:id/wake", post(telemetry::api::agent_wake))
        .route(
            "/settings/agent-auto-update",
            get(auto_update::api::agent_auto_update_global_get)
                .put(auto_update::api::agent_auto_update_global_put),
        )
        .route(
            "/agents/:id/auto-update",
            get(auto_update::api::agent_auto_update_agent_get)
                .put(auto_update::api::agent_auto_update_agent_put)
                .delete(auto_update::api::agent_auto_update_agent_delete),
        )
        .merge(enrollment::routes())
        .merge(groups::routes())
}

impl AppState {
    /// Timezone to bucket an agent's Recall days in.
    ///
    /// Prefers the agent's self-reported IANA zone (`agent_info.timezone`), falling
    /// back to the deployment's configured [`crate::state::Settings::scheduler_tz`] for agents too old
    /// to report one, and finally to UTC. A "day summary" is meaningless without
    /// this: bucketing by UTC gives a UTC+8 user a day that runs 8am–8am.
    pub async fn agent_timezone(&self, agent_id: Uuid) -> chrono_tz::Tz {
        match db::agent_timezone(&self.db, agent_id).await {
            Ok(Some(name)) => name.trim().parse::<chrono_tz::Tz>().unwrap_or_else(|_| {
                tracing::debug!(%agent_id, tz = %name, "unrecognized agent timezone; using default");
                self.settings.scheduler_tz
            }),
            Ok(None) => self.settings.scheduler_tz,
            Err(e) => {
                tracing::warn!(%agent_id, error = %e, "agent timezone lookup failed; using default");
                self.settings.scheduler_tz
            }
        }
    }
}
