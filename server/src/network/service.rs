//! Atomic bootstrap, household provisioning and grant revocation.
//!
//! Bootstrap and household creation write the household and its initial
//! explicit grant in one transaction. Revocation locks the household row so
//! concurrent deletes cannot remove the last network_admin. Nothing here
//! touches agent tokens, module grants, Recall settings or runtime state.

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
    timezone: &str,
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

    let household_id = db::insert_default_household(&mut tx, name, timezone, actor.user_id).await?;
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

/// Create an additional household and its creator grant atomically: a grant
/// failure rolls the household insert back. No grant to any other household.
pub async fn create_household(
    pool: &PgPool,
    actor: &AuthUser,
    name: &str,
    timezone: &str,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    let household_id = db::insert_household_on_conn(&mut tx, name, timezone, actor.user_id).await?;
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

/// Revoke a grant while holding the household row lock. The last
/// `network_admin` cannot be removed, even by another admin, and two
/// concurrent revokes serialize so one always survives.
pub async fn revoke_grant(
    pool: &PgPool,
    household_id: Uuid,
    user_id: Uuid,
    grant: NetworkGrant,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    if grant == NetworkGrant::Admin
        && db::grant_is_admin(&mut tx, household_id, user_id).await?
        && db::count_admins(&mut tx, household_id).await? <= 1
    {
        return Err(ApiError::conflict(
            "Cannot revoke the last network_admin of a household",
        ));
    }
    let removed = db::delete_grant_on_conn(&mut tx, household_id, user_id, grant).await?;
    tx.commit().await?;
    Ok(removed)
}
