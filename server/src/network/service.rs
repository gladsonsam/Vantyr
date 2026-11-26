//! Atomic bootstrap: create the one default household and the bootstrap admin's
//! explicit network_admin grant in a single transaction.
//!
//! A transaction-scoped advisory lock serializes concurrent bootstrap attempts;
//! the partial unique index on `network_households.is_default` is the second
//! line of defence. Nothing here touches agent tokens, module grants, Recall
//! settings, remote scripts or any runtime/worker state.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::network::authz::NetworkGrant;
use crate::network::db;

/// Fixed lock key for the one-time network bootstrap (avoids a DB-wide lock).
const BOOTSTRAP_LOCK_KEY: i64 = 7_432_100_198_831;

pub async fn bootstrap_default_household(
    pool: &PgPool,
    actor: &AuthUser,
    name: &str,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(BOOTSTRAP_LOCK_KEY)
        .execute(&mut *tx)
        .await?;

    if db::count_default_households(&mut tx).await? > 0 {
        return Err(ApiError::conflict(
            "The default network household already exists; bootstrap is one-time",
        ));
    }

    let household_id = db::insert_default_household(&mut tx, name, actor.user_id).await?;
    db::insert_grant_on_conn(
        &mut tx,
        household_id,
        actor.user_id,
        NetworkGrant::Admin,
        actor.user_id,
    )
    .await?;
    tx.commit().await?;
    Ok(household_id)
}

/// Create an additional household and give the authenticated creator an
/// explicit grant on it. Never grants access to any other household.
pub async fn create_household(pool: &PgPool, actor: &AuthUser, name: &str) -> ApiResult<Uuid> {
    let household_id = db::insert_household(pool, name, actor.user_id).await?;
    db::insert_grant(
        pool,
        household_id,
        actor.user_id,
        NetworkGrant::Admin,
        actor.user_id,
    )
    .await?;
    Ok(household_id)
}
