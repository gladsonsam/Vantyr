//! URL categorization (UT1 blacklists): list import, the categorization queue worker, admin
//! settings, overrides, custom rollup categories, and re-categorization.

use std::sync::Arc;

use axum::{
    routing::{get, post, put},
    Router,
};

use crate::state::AppState;

mod api;
mod custom;
pub mod db;
mod engine;
mod overrides;
mod recalc;

pub use engine::{
    categorize_url_now, extract_hostname_from_url, looks_like_complete_navigation_url, spawn,
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/settings/url-categorization",
            get(api::get_status).put(api::put_settings),
        )
        .route(
            "/settings/url-categorization/update-now",
            post(api::post_update_now),
        )
        .route(
            "/settings/url-categorization/categories",
            get(api::list_categories).put(api::put_categories),
        )
        .route(
            "/settings/url-categorization/overrides",
            get(overrides::list_overrides)
                .post(overrides::add_override)
                .delete(overrides::delete_override),
        )
        .route(
            "/settings/url-categorization/custom-categories",
            get(custom::list_custom_categories).post(custom::create_custom_category),
        )
        .route(
            "/settings/url-categorization/custom-categories/:id",
            put(custom::update_custom_category).delete(custom::delete_custom_category),
        )
        .route(
            "/settings/url-categorization/custom-categories/:id/members",
            put(custom::put_custom_category_members),
        )
        .route(
            "/settings/url-categorization/recalc/url-visits",
            post(recalc::recalc_url_visits),
        )
        .route(
            "/settings/url-categorization/recalc/url-sessions",
            post(recalc::recalc_url_sessions),
        )
}
