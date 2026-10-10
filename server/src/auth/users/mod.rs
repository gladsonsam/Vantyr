//! Dashboard user accounts: admin CRUD, profile, OIDC identity links, and `/me`.

use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};

use tracing::info;

use crate::config::ServerConfig;
use crate::state::AppState;

mod api;
pub mod db;
pub mod service;

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

/// Ensure a dashboard admin exists at startup. Returns whether the dashboard may run without
/// users (debug builds with `ALLOW_INSECURE_DASHBOARD_OPEN` only).
pub async fn bootstrap_dashboard_users(
    pool: &sqlx::PgPool,
    cfg: &ServerConfig,
) -> anyhow::Result<bool> {
    let allow_insecure_dashboard_open_env = cfg.allow_insecure_dashboard_open;
    let allow_insecure_dashboard_open = if cfg!(debug_assertions) {
        allow_insecure_dashboard_open_env
    } else {
        if allow_insecure_dashboard_open_env {
            tracing::warn!("Ignoring ALLOW_INSECURE_DASHBOARD_OPEN in release builds (insecure).");
        }
        false
    };

    let admin_username = &cfg.admin_username;
    let admin_password = cfg.admin_password.as_ref();

    let users = db::users::dashboard_user_count(pool).await.unwrap_or(0);
    if users == 0 {
        match admin_password {
            Some(pw) => {
                service::bootstrap_default_admin(pool, admin_username, pw).await?;
                info!("Bootstrapped default dashboard user '{admin_username}' (role: admin).");
            }
            None => {
                if allow_insecure_dashboard_open {
                    info!("No dashboard users exist yet; dashboard is open (ALLOW_INSECURE_DASHBOARD_OPEN=true).");
                } else {
                    return Err(anyhow::anyhow!(
                        "No dashboard users exist. Set ADMIN_PASSWORD (or UI_PASSWORD) to bootstrap the default admin."
                    ));
                }
            }
        }
    }

    if allow_insecure_dashboard_open {
        info!("Dashboard can run without users (insecure opt-in).");
    }

    Ok(allow_insecure_dashboard_open)
}
