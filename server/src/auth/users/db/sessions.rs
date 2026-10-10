//! Dashboard login sessions.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn dashboard_session_create(
    pool: &PgPool,
    token_sha256_hex: &str,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
    client_ip: Option<&str>,
    csrf_token: &str,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO dashboard_sessions (token_sha256_hex, user_id, expires_at, client_ip, csrf_token) VALUES ($1, $2, $3, $4, $5)",
        token_sha256_hex,
        user_id,
        expires_at,
        client_ip,
        csrf_token
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_session_delete(pool: &PgPool, token_sha256_hex: &str) -> Result<()> {
    sqlx::query!(
        "DELETE FROM dashboard_sessions WHERE token_sha256_hex = $1",
        token_sha256_hex
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke every active dashboard session for a user. Returns the number of sessions removed.
/// Call this after a password change, role change, or user deletion so stale cookies stop working.
pub async fn dashboard_sessions_delete_for_user(pool: &PgPool, user_id: Uuid) -> Result<u64> {
    let res = sqlx::query!("DELETE FROM dashboard_sessions WHERE user_id = $1", user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn dashboard_session_touch(pool: &PgPool, token_sha256_hex: &str) -> Result<()> {
    sqlx::query!(
        "UPDATE dashboard_sessions SET last_seen_at = NOW() WHERE token_sha256_hex = $1",
        token_sha256_hex
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_session_get_user(
    pool: &PgPool,
    token_sha256_hex: &str,
) -> Result<Option<(Uuid, String, String, String, Option<String>, String)>> {
    // Returns (user_id, username, role, display_name, display_icon, csrf_token) when session exists and is not expired.
    let row = sqlx::query!(
        r"
        SELECT u.id AS user_id, u.username, u.role, u.display_name, u.display_icon, s.csrf_token
        FROM dashboard_sessions s
        JOIN dashboard_users u ON u.id = s.user_id
        WHERE s.token_sha256_hex = $1
          AND s.expires_at > NOW()
        ",
        token_sha256_hex
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        (
            r.user_id,
            r.username,
            r.role,
            r.display_name,
            r.display_icon,
            r.csrf_token,
        )
    }))
}
