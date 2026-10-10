//! Dashboard user logic that sits between the handlers and `db`: password hashing before
//! storage, first-boot admin bootstrap and recovery-code verification.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

use super::db::totp::UnusedRecoveryCode;
use super::db::{totp, users};
use crate::auth::secrets::{hash_dashboard_password, verify_dashboard_password};

/// Create a dashboard user, storing an Argon2 hash of `password_plain`.
pub async fn create_user(
    pool: &PgPool,
    username: &str,
    password_plain: &str,
    role: &str,
    display_name: &str,
) -> Result<Uuid> {
    let hash = hash_dashboard_password(password_plain)?;
    users::dashboard_user_create(pool, username, &hash, role, display_name).await
}

/// Replace a user's password with an Argon2 hash of `password_plain`.
pub async fn set_password(pool: &PgPool, user_id: Uuid, password_plain: &str) -> Result<()> {
    let hash = hash_dashboard_password(password_plain)?;
    users::dashboard_user_set_password(pool, user_id, &hash).await
}

/// First boot: create the initial admin when no dashboard user exists yet.
pub async fn bootstrap_default_admin(
    pool: &PgPool,
    username: &str,
    password_plain: &str,
) -> Result<()> {
    if users::dashboard_user_count(pool).await? > 0 {
        return Ok(());
    }
    create_user(pool, username, password_plain, "admin", "").await?;
    Ok(())
}

/// Id of the first unused recovery code that matches `code`.
fn matching_recovery_code(codes: &[UnusedRecoveryCode], code: &str) -> Option<i64> {
    codes
        .iter()
        .find(|c| verify_dashboard_password(&c.code_hash, code))
        .map(|c| c.id)
}

/// Consume one matching unused recovery code; returns true if a code was burned.
pub async fn consume_recovery_code(pool: &PgPool, user_id: Uuid, code: &str) -> Result<bool> {
    let codes = totp::dashboard_recovery_codes_unused(pool, user_id).await?;
    let Some(id) = matching_recovery_code(&codes, code) else {
        return Ok(false);
    };
    totp::dashboard_recovery_code_mark_used(pool, id).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(id: i64, plain: &str) -> UnusedRecoveryCode {
        UnusedRecoveryCode {
            id,
            code_hash: hash_dashboard_password(plain).unwrap(),
        }
    }

    #[test]
    fn matching_recovery_code_picks_the_row_whose_hash_verifies() {
        let codes = [
            code(1, "aaaa-1111"),
            code(2, "bbbb-2222"),
            code(3, "cccc-3333"),
        ];
        assert_eq!(
            matching_recovery_code(&codes, "bbbb-2222"),
            Some(codes[1].id)
        );
        assert_eq!(
            matching_recovery_code(&codes, "aaaa-1111"),
            Some(codes[0].id)
        );
    }

    #[test]
    fn matching_recovery_code_rejects_unknown_and_empty() {
        let codes = [code(1, "aaaa-1111")];
        assert_eq!(matching_recovery_code(&codes, "zzzz-9999"), None);
        assert_eq!(matching_recovery_code(&codes, ""), None);
        assert_eq!(matching_recovery_code(&[], "aaaa-1111"), None);
    }

    #[sqlx::test]
    async fn create_user_stores_a_verifiable_hash_not_the_password(pool: PgPool) -> Result<()> {
        let id = create_user(&pool, "alice", "s3cret-pw", "viewer", "Alice").await?;
        let (found, hash, role) = users::dashboard_user_get_by_username(&pool, "ALICE")
            .await?
            .unwrap();
        assert_eq!(found, id);
        assert_eq!(role, "viewer");
        assert_ne!(hash, "s3cret-pw");
        assert!(verify_dashboard_password(&hash, "s3cret-pw"));

        set_password(&pool, id, "new-pw-123").await?;
        let (_, hash, _) = users::dashboard_user_get_by_username(&pool, "alice")
            .await?
            .unwrap();
        assert!(verify_dashboard_password(&hash, "new-pw-123"));
        assert!(!verify_dashboard_password(&hash, "s3cret-pw"));
        Ok(())
    }

    #[sqlx::test]
    async fn bootstrap_default_admin_only_runs_on_an_empty_table(pool: PgPool) -> Result<()> {
        bootstrap_default_admin(&pool, "root", "first-pw").await?;
        bootstrap_default_admin(&pool, "other", "second-pw").await?;
        assert_eq!(users::dashboard_user_count(&pool).await?, 1);
        let (_, hash, role) = users::dashboard_user_get_by_username(&pool, "root")
            .await?
            .unwrap();
        assert_eq!(role, "admin");
        assert!(verify_dashboard_password(&hash, "first-pw"));
        Ok(())
    }

    #[sqlx::test]
    async fn consume_recovery_code_burns_a_code_once(pool: PgPool) -> Result<()> {
        let id = create_user(&pool, "bob", "pw-123456", "viewer", "").await?;
        let hashes = vec![
            hash_dashboard_password("one-code")?,
            hash_dashboard_password("two-code")?,
        ];
        totp::dashboard_recovery_codes_replace(&pool, id, &hashes).await?;

        assert!(!consume_recovery_code(&pool, id, "nope").await?);
        assert!(consume_recovery_code(&pool, id, "two-code").await?);
        assert!(!consume_recovery_code(&pool, id, "two-code").await?);
        assert!(consume_recovery_code(&pool, id, "one-code").await?);
        Ok(())
    }
}
