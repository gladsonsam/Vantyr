//! Pairing codes (invites), their use history, and per-device credential revocation and
//! replacement.

use anyhow::Result;
use chrono::{DateTime, Utc};
use rand::Rng;
use sqlx::PgPool;
use uuid::Uuid;

use super::sha256_hex;
use crate::db::pg_is_unique_violation;

/// Issue a short **6-digit** enrollment code (SHA-256 stored). Retries on digest collision.
/// Returns `(row_id, plaintext)` — show once.
pub async fn create_agent_enrollment_token(
    pool: &PgPool,
    uses: i32,
    expires_at: Option<DateTime<Utc>>,
    note: Option<&str>,
) -> Result<(Uuid, String)> {
    let uses = uses.max(1);
    for _ in 0..512 {
        let plaintext = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
        let digest = sha256_hex(&plaintext);
        let res = sqlx::query!(
            r"
            INSERT INTO agent_enrollment_invites
                (secret_digest, kind, uses_remaining, expires_at, auto_approve, note)
            VALUES ($1, 'quick_pair', $2, $3, true, $4)
            RETURNING id
            ",
            &digest,
            uses,
            expires_at,
            note
        )
        .fetch_one(pool)
        .await;
        match res {
            Ok(row) => {
                let id: Uuid = row.id;
                return Ok((id, plaintext));
            }
            Err(e) if pg_is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("could not allocate a unique enrollment code");
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrollmentTokenRow {
    pub id: Uuid,
    pub uses_remaining: i32,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub note: Option<String>,
    pub used_count: i64,
    pub last_used_at: Option<DateTime<Utc>>,
}

pub async fn list_agent_enrollment_tokens(pool: &PgPool) -> Result<Vec<EnrollmentTokenRow>> {
    Ok(sqlx::query_as!(
        EnrollmentTokenRow,
        r#"
        SELECT
            t.id,
            t.uses_remaining,
            t.created_at,
            t.expires_at,
            t.note,
            COALESCE(u.used_count, 0)::BIGINT AS "used_count!",
            u.last_used_at
        FROM agent_enrollment_invites t
        LEFT JOIN (
            SELECT
                invite_id,
                COUNT(*)::BIGINT AS used_count,
                MAX(created_at) AS last_used_at
            FROM agent_enrollment_claims
            GROUP BY invite_id
        ) u ON u.invite_id = t.id
        WHERE t.kind = 'quick_pair'
        ORDER BY t.created_at DESC
        "#
    )
    .fetch_all(pool)
    .await?)
}

pub async fn revoke_agent_enrollment_token(pool: &PgPool, token_id: Uuid) -> Result<()> {
    sqlx::query!(
        "UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1",
        token_id
    )
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn revoke_all_agent_enrollment_tokens(pool: &PgPool) -> Result<u64> {
    let res = sqlx::query!(
        "UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE uses_remaining > 0"
    )
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrollmentTokenUseRow {
    pub used_at: DateTime<Utc>,
    pub agent_name: String,
    pub agent_id: Option<Uuid>,
}

pub async fn list_agent_enrollment_token_uses(
    pool: &PgPool,
    token_id: Uuid,
    limit: i64,
) -> Result<Vec<EnrollmentTokenUseRow>> {
    let limit = limit.clamp(1, 500);
    let rows = sqlx::query!(
        r"
        SELECT created_at AS used_at, requested_name AS agent_name, agent_id
        FROM agent_enrollment_claims
        WHERE invite_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        ",
        token_id,
        limit
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(EnrollmentTokenUseRow {
            used_at: r.used_at,
            agent_name: r.agent_name,
            agent_id: r.agent_id,
        });
    }
    Ok(out)
}

/// Disable outstanding bound invites as well as the installed credential.
/// Unbound enrollment can never take ownership of this row by name.
pub async fn revoke_agent_credentials(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE bound_agent_id = $1",
        agent_id
    ).execute(&mut *tx).await?;
    sqlx::query!(
        "UPDATE agents SET api_token_hash = NULL WHERE id = $1",
        agent_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Create a one-use, ten-minute invite explicitly bound to a device's UUID.
/// Revoke the installed credential and previous replacement invites atomically.
pub async fn create_agent_replacement_token(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<(Uuid, String, DateTime<Utc>)>> {
    for _ in 0..512 {
        let plaintext = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32));
        let digest = sha256_hex(&plaintext);
        let expires_at = Utc::now() + chrono::Duration::minutes(10);
        let mut tx = pool.begin().await?;
        sqlx::query!(
            "UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE bound_agent_id = $1",
            agent_id
        ).execute(&mut *tx).await?;
        let exists = sqlx::query!(
            "UPDATE agents SET api_token_hash = NULL WHERE id = $1",
            agent_id
        )
        .execute(&mut *tx)
        .await?;
        if exists.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(None);
        }
        let row = sqlx::query!(
            "INSERT INTO agent_enrollment_invites (secret_digest, kind, uses_remaining, expires_at, auto_approve, bound_agent_id) VALUES ($1, 're_enroll', 1, $2, true, $3) RETURNING id",
            &digest,
            expires_at,
            agent_id
        ).fetch_one(&mut *tx).await;
        match row {
            Ok(row) => {
                let id = row.id;
                tx.commit().await?;
                return Ok(Some((id, plaintext, expires_at)));
            }
            Err(e) if pg_is_unique_violation(&e) => {
                tx.rollback().await?;
            }
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("could not allocate a unique replacement code")
}
