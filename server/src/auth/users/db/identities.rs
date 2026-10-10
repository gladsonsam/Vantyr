//! OIDC identities linked to dashboard users.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

pub async fn dashboard_identity_get_user_id(
    pool: &PgPool,
    issuer: &str,
    subject: &str,
) -> Result<Option<Uuid>> {
    let v: Option<Uuid> = sqlx::query_scalar!(
        "SELECT user_id FROM dashboard_identities WHERE issuer = $1 AND subject = $2",
        issuer,
        subject
    )
    .fetch_optional(pool)
    .await?;
    Ok(v)
}

pub async fn dashboard_identity_upsert(
    pool: &PgPool,
    issuer: &str,
    subject: &str,
    user_id: Uuid,
    preferred_username: Option<&str>,
    email: Option<&str>,
    name: Option<&str>,
) -> Result<()> {
    sqlx::query!(
        r"
        INSERT INTO dashboard_identities (issuer, subject, user_id, preferred_username, email, name, last_login_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (issuer, subject) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            preferred_username = EXCLUDED.preferred_username,
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            last_login_at = NOW()
        ",
        issuer,
        subject,
        user_id,
        preferred_username,
        email,
        name
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct DashboardIdentityRow {
    pub id: i64,
    pub issuer: String,
    pub subject: String,
    pub preferred_username: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub last_login_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

pub async fn dashboard_identities_for_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<DashboardIdentityRow>> {
    Ok(sqlx::query_as!(
        DashboardIdentityRow,
        r"
        SELECT id, issuer, subject, preferred_username, email, name, last_login_at, created_at
        FROM dashboard_identities
        WHERE user_id = $1
        ORDER BY last_login_at DESC
        ",
        user_id
    )
    .fetch_all(pool)
    .await?)
}

pub async fn dashboard_identity_unlink(pool: &PgPool, identity_id: i64) -> Result<()> {
    sqlx::query!(
        "DELETE FROM dashboard_identities WHERE id = $1",
        identity_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_identity_link(
    pool: &PgPool,
    issuer: &str,
    subject: &str,
    user_id: Uuid,
) -> Result<()> {
    sqlx::query!(
        r"
        INSERT INTO dashboard_identities (issuer, subject, user_id, last_login_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (issuer, subject) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            last_login_at = NOW()
        ",
        issuer,
        subject,
        user_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
