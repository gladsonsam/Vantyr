//! REST API for the authenticated dashboard (`/api/*`).

mod agent_analytics;
mod agent_enrollment;
pub(crate) mod agent_modules;
pub(crate) mod agents_capture;
mod agents_list;
mod agents_logs;
mod agents_telemetry;
mod app_block;
mod assets;
mod auto_update;
mod fleet_summary;
mod groups_and_rules;
mod internet_block;
mod local_ui;
mod notifications;
mod push;
mod retention;
mod screen_history;
mod settings;
mod version;

use std::sync::Arc;

use axum::{
    routing::{delete, get, post, put},
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
        .route(
            "/agents/:id/alert-rule-events",
            get(agents_telemetry::agent_alert_rule_events),
        )
        .route(
            "/agents/:id/groups",
            get(agents_telemetry::agent_agent_groups_for_agent_h),
        )
        .route(
            "/alert-rule-events/:id/screenshot",
            get(assets::alert_rule_event_screenshot),
        )
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
        .route(
            "/agents/history/devices",
            get(screen_history::history_devices),
        )
        .route(
            "/agents/:id/history/frames",
            get(screen_history::history_frames),
        )
        .route(
            "/agents/:id/history/frame",
            get(screen_history::history_frame_at),
        )
        .route(
            "/agents/:id/history/search",
            get(screen_history::history_search),
        )
        .route(
            "/agents/:id/history/activity",
            get(screen_history::history_activity),
        )
        .route(
            "/agents/:id/history/days",
            get(screen_history::history_days),
        )
        .route(
            "/agents/:id/history/monitors",
            get(screen_history::history_monitors),
        )
        .route(
            "/agents/:id/history/segments",
            get(screen_history::history_segments),
        )
        .route(
            "/agents/:id/history/day-summary",
            get(screen_history::history_day_summary),
        )
        .route(
            "/agents/:id/history/blob/:frame_id",
            get(screen_history::history_blob),
        )
        .route(
            "/agents/:id/history/text/:frame_id",
            get(screen_history::history_frame_text),
        )
        // Recall capture tunables: global defaults + per-agent overrides.
        .route(
            "/settings/recall",
            get(screen_history::recall_settings_get).put(screen_history::recall_settings_put),
        )
        .route(
            "/agents/:id/history/settings",
            get(screen_history::agent_recall_settings_get)
                .put(screen_history::agent_recall_settings_put)
                .delete(screen_history::agent_recall_settings_delete),
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
        .route(
            "/agents/:id/internet-blocked",
            get(internet_block::agent_internet_blocked_get)
                .put(internet_block::agent_internet_blocked_put),
        )
        .route(
            "/internet-block-rules",
            get(internet_block::internet_block_rules_list)
                .post(internet_block::internet_block_rules_create),
        )
        .route(
            "/internet-block-rules/:id",
            put(internet_block::internet_block_rules_update)
                .delete(internet_block::internet_block_rules_delete),
        )
        .route(
            "/agent-groups",
            get(groups_and_rules::agent_groups_list_h)
                .post(groups_and_rules::agent_groups_create_h),
        )
        .route(
            "/agent-groups/:group_id",
            put(groups_and_rules::agent_groups_update_h)
                .delete(groups_and_rules::agent_groups_delete_h),
        )
        .route(
            "/agent-groups/:group_id/members",
            get(groups_and_rules::agent_group_members_list_h)
                .post(groups_and_rules::agent_group_members_add_h),
        )
        .route(
            "/agent-groups/:group_id/members/:agent_id",
            delete(groups_and_rules::agent_group_member_remove_h),
        )
        .route(
            "/alert-rule-events",
            get(agents_telemetry::alert_rule_events_all_h),
        )
        .route(
            "/alert-rules",
            get(groups_and_rules::alert_rules_list_h).post(groups_and_rules::alert_rules_create_h),
        )
        .route(
            "/alert-rules/:rule_id/events",
            get(agents_telemetry::alert_rule_events_for_rule_h),
        )
        .route(
            "/alert-rules/:rule_id",
            put(groups_and_rules::alert_rules_update_h)
                .delete(groups_and_rules::alert_rules_delete_h),
        )
        .route(
            "/app-block-rules",
            get(app_block::app_block_rules_list).post(app_block::app_block_rules_create),
        )
        .route(
            "/app-block-rules/:id",
            put(app_block::app_block_rules_update).delete(app_block::app_block_rules_delete),
        )
        .route(
            "/app-block-rules/protected",
            get(app_block::protected_exes_list),
        )
        .route(
            "/app-block-rules/:id/events",
            get(app_block::rule_app_block_events),
        )
        .route("/app-block-events", get(app_block::all_app_block_events))
        .route(
            "/agents/:id/app-block-events",
            get(app_block::agent_app_block_events),
        )
        .route(
            "/agents/:id/effective-rules",
            get(app_block::agent_effective_rules),
        )
        .route("/agents/:id/known-exes", get(app_block::agent_known_exes))
        .route("/agent-sessions", get(agents_list::agent_sessions_all))
        .route("/push/vapid-public-key", get(push::vapid_public_key))
        .route("/push/subscribe", post(push::subscribe))
        .route("/push/unsubscribe", post(push::unsubscribe))
}
