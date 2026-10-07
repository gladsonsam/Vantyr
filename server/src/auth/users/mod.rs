//! Dashboard user accounts: admin CRUD, profile, OIDC identity links, and `/me`.

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
        .route("/me", get(api::me))
        .route("/users", get(api::users_list).post(api::users_create))
        .route("/users/:id/password", post(api::user_set_password))
        .route("/users/:id/profile", post(api::user_profile_update))
        .route("/users/:id/role", post(api::user_set_role))
        .route("/users/:id/delete", post(api::user_delete))
        .route("/users/:id/identities", get(api::user_identities))
        .route("/users/:id/identities/link", post(api::user_identity_link))
        .route("/identities/:id/unlink", post(api::identity_unlink))
}
