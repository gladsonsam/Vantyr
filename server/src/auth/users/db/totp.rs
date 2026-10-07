//! Dashboard two-factor authentication: TOTP secrets and recovery codes.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::secrets::verify_dashboard_password;

/// Returns `(totp_secret, totp_enabled)` for a user.
pub async fn dashboard_user_totp_get(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<(Option<String>, bool)> {
    let row = sqlx::query!(
        "SELECT totp_secret, totp_enabled FROM dashboard_users WHERE id = $1",
        user_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some(r) => (r.totp_secret, r.totp_enabled),
        None => (None, false),
    })
}

/// Store a pending (not-yet-verified) TOTP secret; clears the enabled flag.
pub async fn dashboard_user_totp_set_pending(
    pool: &PgPool,
    user_id: Uuid,
    secret_b32: &str,
) -> Result<()> {
    sqlx::query!(
        "UPDATE dashboard_users SET totp_secret = $2, totp_enabled = FALSE WHERE id = $1",
        user_id,
        secret_b32
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_user_totp_enable(pool: &PgPool, user_id: Uuid) -> Result<()> {
    sqlx::query!(
        "UPDATE dashboard_users SET totp_enabled = TRUE WHERE id = $1",
        user_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Disable 2FA and drop the secret + all recovery codes.
pub async fn dashboard_user_totp_disable(pool: &PgPool, user_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE dashboard_users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = $1",
        user_id
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM dashboard_user_recovery_codes WHERE user_id = $1",
        user_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Replace the user's recovery codes with the given Argon2 hashes.
pub async fn dashboard_recovery_codes_replace(
    pool: &PgPool,
    user_id: Uuid,
    hashes: &[String],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "DELETE FROM dashboard_user_recovery_codes WHERE user_id = $1",
        user_id
    )
    .execute(&mut *tx)
    .await?;
    for h in hashes {
        sqlx::query!(
            "INSERT INTO dashboard_user_recovery_codes (user_id, code_hash) VALUES ($1, $2)",
            user_id,
            h
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Consume one matching unused recovery code; returns true if a code was burned.
pub async fn dashboard_recovery_code_consume(
    pool: &PgPool,
    user_id: Uuid,
    code: &str,
) -> Result<bool> {
    let rows = sqlx::query!(
        "SELECT id, code_hash FROM dashboard_user_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
        user_id
    )
    .fetch_all(pool)
    .await?;
    for r in rows {
        if verify_dashboard_password(&r.code_hash, code) {
            sqlx::query!(
                "UPDATE dashboard_user_recovery_codes SET used_at = NOW() WHERE id = $1",
                r.id
            )
            .execute(pool)
            .await?;
            return Ok(true);
        }
    }
    Ok(false)
}
