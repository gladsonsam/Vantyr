//! Fixtures shared by unit tests across features (compiled only under `cfg(test)`).
//!
//! Database-backed tests use `#[sqlx::test]`: each test gets its own fresh database on the
//! server named by `DATABASE_URL`, with every migration in `server/migrations` applied, and
//! receives its pool. See `server/docs/testing.md`.

pub mod control;
pub mod recall;

use std::sync::Arc;

use sqlx::PgPool;
use uuid::Uuid;

use crate::http::AuthUser;
use crate::state::{AppState, Settings};

/// A dashboard admin; tests adjust `role` or `user_id` where they need another actor.
pub fn admin() -> AuthUser {
    AuthUser {
        user_id: Uuid::new_v4(),
        username: "lifecycle-test".into(),
        role: "admin".into(),
        display_name: "Test".into(),
        display_icon: None,
        csrf_token: "test".into(),
    }
}

/// `AppState` over `db` with a unique screen-history root that does not exist yet.
pub fn app_state(db: PgPool) -> Arc<AppState> {
    let settings = Settings {
        screen_history_dir: std::env::temp_dir().join(format!("vantyr-test-{}", Uuid::new_v4())),
        ..Settings::for_tests()
    };
    Arc::new(AppState::new(
        db,
        settings,
        None,
        crate::notify::NotifyHub::new(vec![]),
    ))
}

/// `AppState` over a migrated database holding one enrolled device named `device` whose
/// API token is `old-token`. Returns the state, the device id and its token hash.
pub async fn state(db: PgPool) -> anyhow::Result<(Arc<AppState>, Uuid, String)> {
    let hash = crate::auth::secrets::hash_dashboard_password("old-token")?;
    let id = sqlx::query_scalar(
        "INSERT INTO agents (name, api_token_hash) VALUES ('device', $1) RETURNING id",
    )
    .bind(&hash)
    .fetch_one(&db)
    .await?;
    Ok((app_state(db), id, hash))
}

/// Insert a device row (named after its id) so rows referencing `agents` can be stored for it.
pub async fn insert_agent(db: &PgPool, id: Uuid) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO agents (id, name) VALUES ($1, $1::text) ON CONFLICT DO NOTHING")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Delete every device (dependent rows follow through foreign keys), so a test that loops
/// over cases can call [`state`] again on the same database.
pub async fn delete_agents(db: &PgPool) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM agents").execute(db).await?;
    Ok(())
}
