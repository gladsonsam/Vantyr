//! REST API for the authenticated dashboard (`/api/*`).

mod agent_analytics;
mod agent_enrollment;
pub(crate) mod agent_modules;
pub(crate) mod agents_capture;
mod agents_list;
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
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agents", get(agents_list::list_agents))
        .route("/agents/fleet-summary", get(fleet_summary::fleet_summary))
        .route("/agents/overview", get(agents_list::list_agents_overview))
        .route("/agents/:id/clipboard", post(crate::clipboard::http))
        .route("/agents/:id/modules", get(agent_modules::get_modules))
        .route(
            "/agents/:id/modules/disable",
            post(agent_modules::disable_module),
        )
        .route(
            "/agents/:id/revoke-credentials",
            post(agents_list::revoke_agent_credentials),
        )
        .route("/agents/delete", post(agents_list::delete_agents_bulk))
        .route(
            "/agents/:id/icon",
            get(agents_list::agent_icon_get).put(agents_list::agent_icon_put),
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
        .route("/agents/:id/screen", get(agents_capture::agent_screen))
        .route("/agents/:id/mjpeg", get(agents_capture::agent_mjpeg))
        .route(
            "/agents/:id/mjpeg/leave",
            post(agents_capture::agent_mjpeg_leave),
        )
        .route("/agents/:id/audio", get(agents_capture::agent_audio))
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
        .route(
            "/settings/agent-enrollment-tokens",
            get(agent_enrollment::list_enrollment_tokens)
                .post(agent_enrollment::create_enrollment_token),
        )
        .route(
            "/settings/agent-enrollment-tokens/:id",
            delete(agent_enrollment::revoke_enrollment_token),
        )
        .route(
            "/settings/agent-enrollment-tokens/revoke-all",
            post(agent_enrollment::revoke_all_enrollment_tokens),
        )
        .route(
            "/settings/agent-enrollment-tokens/:id/uses",
            get(agent_enrollment::list_enrollment_token_uses),
        )
        .route(
            "/settings/agent-enrollment-claims",
            get(agent_enrollment::list_enrollment_claims),
        )
        .route(
            "/settings/agent-enrollment-claims/:id/approve",
            post(agent_enrollment::approve_enrollment_claim),
        )
        .route(
            "/settings/agent-enrollment-claims/:id/reject",
            post(agent_enrollment::reject_enrollment_claim),
        )
        .route(
            "/settings/agent-setup-hints",
            get(agent_enrollment::get_agent_setup_hints),
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
        .route(
            "/agents/:id/update-now",
            post(agents_capture::agent_update_now),
        )
        .route("/agent-sessions", get(agents_list::agent_sessions_all))
        .route("/push/vapid-public-key", get(push::vapid_public_key))
        .route("/push/subscribe", post(push::subscribe))
        .route("/push/unsubscribe", post(push::unsubscribe))
}
