//! Dashboard user accounts: lookup, profile fields, roles, and password hashes.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct DashboardUserRow {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub display_icon: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub async fn dashboard_user_count(pool: &PgPool) -> Result<i64> {
    let n: i64 = sqlx::query_scalar!(r#"SELECT COUNT(*) AS "count!" FROM dashboard_users"#)
        .fetch_one(pool)
        .await?;
    Ok(n)
}

pub async fn dashboard_admin_count(pool: &PgPool) -> Result<i64> {
    let n: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM dashboard_users WHERE role = 'admin'"#
    )
    .fetch_one(pool)
    .await?;
    Ok(n)
}

pub async fn dashboard_user_is_admin(pool: &PgPool, user_id: Uuid) -> Result<bool> {
    let v: Option<String> =
        sqlx::query_scalar!("SELECT role FROM dashboard_users WHERE id = $1", user_id)
            .fetch_optional(pool)
            .await?;
    Ok(v.as_deref() == Some("admin"))
}

/// Returns `(username, display_icon)` when the row exists.
pub async fn dashboard_username_taken_by_other(
    pool: &PgPool,
    username: &str,
    exclude_id: Uuid,
) -> Result<bool> {
    let n: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*)::bigint AS "count!" FROM dashboard_users WHERE lower(username) = lower($1) AND id <> $2"#,
        username,
        exclude_id
    )
    .fetch_one(pool)
    .await?;
    Ok(n > 0)
}

pub async fn dashboard_user_get_profile_bits(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Option<(String, Option<String>, String)>> {
    let row = sqlx::query!(
        "SELECT username, display_icon, display_name FROM dashboard_users WHERE id = $1",
        user_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.username, r.display_icon, r.display_name)))
}

pub async fn dashboard_user_get_by_username(
    pool: &PgPool,
    username: &str,
) -> Result<Option<(Uuid, String, String)>> {
    // Returns (id, password_hash, role)
    let row = sqlx::query!(
        "SELECT id, password_hash, role FROM dashboard_users WHERE lower(username) = lower($1)",
        username
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| (r.id, r.password_hash, r.role)))
}

pub async fn dashboard_user_list(pool: &PgPool) -> Result<Vec<DashboardUserRow>> {
    Ok(sqlx::query_as!(
        DashboardUserRow,
        "SELECT id, username, display_name, role, display_icon, created_at FROM dashboard_users ORDER BY lower(username) ASC"
    )
    .fetch_all(pool)
    .await?)
}

pub async fn dashboard_user_create(
    pool: &PgPool,
    username: &str,
    password_hash: &str,
    role: &str,
    display_name: &str,
) -> Result<Uuid> {
    let id: Uuid = sqlx::query_scalar!(
        "INSERT INTO dashboard_users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id",
        username,
        password_hash,
        role,
        display_name
    )
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn dashboard_user_set_password(
    pool: &PgPool,
    user_id: Uuid,
    password_hash: &str,
) -> Result<()> {
    sqlx::query!(
        "UPDATE dashboard_users SET password_hash = $2 WHERE id = $1",
        user_id,
        password_hash
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_user_set_role(pool: &PgPool, user_id: Uuid, role: &str) -> Result<()> {
    sqlx::query!(
        "UPDATE dashboard_users SET role = $2 WHERE id = $1",
        user_id,
        role
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_user_delete(pool: &PgPool, user_id: Uuid) -> Result<()> {
    sqlx::query!("DELETE FROM dashboard_users WHERE id = $1", user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_user_set_username(
    pool: &PgPool,
    user_id: Uuid,
    username: &str,
) -> Result<()> {
    let n = sqlx::query!(
        "UPDATE dashboard_users SET username = $2 WHERE id = $1",
        user_id,
        username
    )
    .execute(pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(anyhow::anyhow!("user not found"));
    }
    Ok(())
}

pub async fn dashboard_user_set_display_icon(
    pool: &PgPool,
    user_id: Uuid,
    display_icon: Option<&str>,
) -> Result<()> {
    let n = sqlx::query!(
        "UPDATE dashboard_users SET display_icon = $2 WHERE id = $1",
        user_id,
        display_icon
    )
    .execute(pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(anyhow::anyhow!("user not found"));
    }
    Ok(())
}

pub async fn dashboard_user_set_display_name(
    pool: &PgPool,
    user_id: Uuid,
    display_name: &str,
) -> Result<()> {
    let n = sqlx::query!(
        "UPDATE dashboard_users SET display_name = $2 WHERE id = $1",
        user_id,
        display_name
    )
    .execute(pool)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(anyhow::anyhow!("user not found"));
    }
    Ok(())
}
