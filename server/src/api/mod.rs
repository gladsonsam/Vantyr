//! REST API for the authenticated dashboard (`/api/*`).

mod agent_analytics;
pub(crate) mod agent_modules;
mod agents_logs;
mod agents_telemetry;
mod assets;
mod auto_update;
mod fleet_summary;
mod local_ui;
mod notifications;
mod push;
mod retention;
mod settings;
mod version;

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/agents/:id/update-now",
            post(auto_update::agent_update_now),
        )
        .route("/agents/fleet-summary", get(fleet_summary::fleet_summary))
        .route("/agents/:id/modules", get(agent_modules::get_modules))
        .route(
            "/agents/:id/modules/disable",
            post(agent_modules::disable_module),
        )
        .route("/agents/:id/info", get(agents_telemetry::agent_info))
        .route(
            "/agents/:id/logs/sources",
            get(agents_logs::agent_log_sources),
        )
        .route("/agents/:id/logs/tail", get(agents_logs::agent_log_tail))
        .route("/agents/:id/windows", get(agents_telemetry::agent_windows))
        .route("/agents/:id/keys", get(agents_telemetry::agent_keys))
        .route("/agents/:id/urls", get(agents_telemetry::agent_urls))
        .route(
            "/agents/:id/url-category-stats",
            get(agents_telemetry::agent_url_category_stats),
        )
        .route(
            "/agents/:id/url-category-backfill",
            post(agents_telemetry::agent_url_category_backfill),
        )
        .route(
            "/agents/:id/metrics",
            get(agent_analytics::agent_metrics_history),
        )
        .route(
            "/agents/:id/analytics/url-categories",
            get(agent_analytics::agent_url_categories_time),
        )
        .route(
            "/agents/:id/analytics/url-sites",
            get(agent_analytics::agent_url_sites_time),
        )
        .route(
            "/agents/:id/analytics/url-sessions",
            get(agent_analytics::agent_url_sessions),
        )
        .route(
            "/agents/:id/activity",
            get(agents_telemetry::agent_activity),
        )
        .route(
            "/agents/:id/app-icons/:exe_name",
            get(assets::agent_app_icon),
        )
        .route(
            "/agents/:id/top-urls",
            get(agents_telemetry::agent_top_urls),
        )
        .route(
            "/agents/:id/top-windows",
            get(agents_telemetry::agent_top_windows),
        )
        .route(
            "/agents/:id/history/clear",
            post(agents_telemetry::clear_agent_history),
        )
        .route("/agents/:id/wake", post(agents_telemetry::agent_wake))
        .route(
            "/agents/:id/retention",
            get(retention::agent_retention_get)
                .put(retention::agent_retention_put)
                .delete(retention::agent_retention_delete),
        )
        .route(
            "/settings/retention",
            get(retention::retention_global_get).put(retention::retention_global_put),
        )
        .route(
            "/settings/local-ui-password",
            get(local_ui::local_ui_password_global_get).put(local_ui::local_ui_password_global_put),
        )
        .route(
            "/settings/agent-auto-update",
            get(auto_update::agent_auto_update_global_get)
                .put(auto_update::agent_auto_update_global_put),
        )
        .route("/settings/storage", get(settings::storage_usage))
        .route(
            "/settings/capabilities",
            get(settings::settings_capabilities),
        )
        .route("/settings/version", get(version::settings_version))
        .route("/settings/integration", get(settings::settings_integration))
        .route(
            "/settings/notifications",
            get(notifications::notifications_status),
        )
        .route(
            "/settings/notifications/test",
            post(notifications::notifications_test),
        )
        .route(
            "/agents/:id/local-ui-password",
            get(local_ui::local_ui_password_agent_get)
                .put(local_ui::local_ui_password_agent_put)
                .delete(local_ui::local_ui_password_agent_delete),
        )
        .route(
            "/agents/:id/auto-update",
            get(auto_update::agent_auto_update_agent_get)
                .put(auto_update::agent_auto_update_agent_put)
                .delete(auto_update::agent_auto_update_agent_delete),
        )
        .route("/push/vapid-public-key", get(push::vapid_public_key))
        .route("/push/subscribe", post(push::subscribe))
        .route("/push/unsubscribe", post(push::unsubscribe))
}
