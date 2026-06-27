//! REST API for the authenticated dashboard (`/api/*`).

mod agent_analytics;
mod agent_enrollment;
mod agents_capture;
mod agents_list;
mod agents_logs;
mod agents_telemetry;
mod app_block;
mod assets;
mod audit;
mod auto_update;
mod groups_and_rules;
mod helpers;
mod internet_block;
mod local_ui;
mod notifications;
mod pagination;
mod retention;
pub mod scheduled_scripts;
mod settings;
pub mod software_scripts;
mod twofa;
mod url_categorization;
mod url_categorization_recalc;
mod url_category_overrides;
mod url_custom_categories;
mod users;
mod version;

use std::sync::Arc;

use axum::{
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};

use crate::state::AppState;

/// Unknown `/api/*` paths return a JSON 404 instead of falling through to the SPA fallback
/// (which would serve `index.html` with a `200`, breaking the dashboard's JSON `fetch` clients).
async fn api_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "Unknown API endpoint" })),
    )
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/me", get(agents_list::me))
        .route("/2fa/status", get(twofa::twofa_status))
        .route("/2fa/setup", post(twofa::twofa_setup))
        .route("/2fa/enable", post(twofa::twofa_enable))
        .route("/2fa/disable", post(twofa::twofa_disable))
        .route("/agents", get(agents_list::list_agents))
        .route("/agents/overview", get(agents_list::list_agents_overview))
        .route(
            "/agents/:id/revoke-credentials",
            post(agents_list::revoke_agent_credentials),
        )
        .route("/agents/delete", post(agents_list::delete_agents_bulk))
        .route(
            "/agents/:id/icon",
            get(agents_list::agent_icon_get).put(agents_list::agent_icon_put),
        )
        .route("/users", get(users::users_list).post(users::users_create))
        .route("/users/:id/password", post(users::user_set_password))
        .route("/users/:id/profile", post(users::user_profile_update))
        .route("/users/:id/role", post(users::user_set_role))
        .route("/users/:id/delete", post(users::user_delete))
        .route("/users/:id/identities", get(users::user_identities))
        .route(
            "/users/:id/identities/link",
            post(users::user_identity_link),
        )
        .route("/identities/:id/unlink", post(users::identity_unlink))
        .route(
            "/agents/bulk-script",
            post(software_scripts::agents_bulk_script),
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
        .route("/agents/:id/wake", post(agents_telemetry::agent_wake))
        .route(
            "/agents/:id/software",
            get(software_scripts::agent_software_list),
        )
        .route(
            "/agents/:id/software/collect",
            post(software_scripts::agent_software_collect),
        )
        .route(
            "/agents/:id/script",
            post(software_scripts::agent_run_script),
        )
        .route("/audit", get(audit::audit_log))
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
            "/settings/url-categorization",
            get(url_categorization::get_status).put(url_categorization::put_settings),
        )
        .route(
            "/settings/url-categorization/update-now",
            post(url_categorization::post_update_now),
        )
        .route(
            "/settings/url-categorization/categories",
            get(url_categorization::list_categories).put(url_categorization::put_categories),
        )
        .route(
            "/settings/url-categorization/overrides",
            get(url_category_overrides::list_overrides)
                .post(url_category_overrides::add_override)
                .delete(url_category_overrides::delete_override),
        )
        .route(
            "/settings/url-categorization/custom-categories",
            get(url_custom_categories::list_custom_categories)
                .post(url_custom_categories::create_custom_category),
        )
        .route(
            "/settings/url-categorization/custom-categories/:id",
            put(url_custom_categories::update_custom_category)
                .delete(url_custom_categories::delete_custom_category),
        )
        .route(
            "/settings/url-categorization/custom-categories/:id/members",
            put(url_custom_categories::put_custom_category_members),
        )
        .route(
            "/settings/url-categorization/recalc/url-visits",
            post(url_categorization_recalc::recalc_url_visits),
        )
        .route(
            "/settings/url-categorization/recalc/url-sessions",
            post(url_categorization_recalc::recalc_url_sessions),
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
        .route(
            "/scheduled-scripts",
            get(scheduled_scripts::list_scripts).post(scheduled_scripts::create_script),
        )
        .route(
            "/scheduled-scripts/:id",
            put(scheduled_scripts::update_script).delete(scheduled_scripts::delete_script),
        )
        .route(
            "/scheduled-scripts/:id/events",
            get(scheduled_scripts::events_for_script),
        )
        .route(
            "/scheduled-scripts/:id/trigger",
            post(scheduled_scripts::trigger_script),
        )
        .route(
            "/scheduled-script-events",
            get(scheduled_scripts::events_all),
        )
        .route("/agent-sessions", get(agents_list::agent_sessions_all))
        .fallback(api_not_found)
}
