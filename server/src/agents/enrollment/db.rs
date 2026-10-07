//! Enrollment persistence: pairing codes (invites), pending claims and their approval,
//! token-use history, and per-device credential revocation / replacement.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};

use crate::auth::secrets::hash_dashboard_password;
use crate::db::pg_is_unique_violation;

/// Bound claim lookup used to acquire the lifecycle write gate before approval.
pub async fn enrollment_claim_bound_agent_id(
    pool: &PgPool,
    claim_id: Uuid,
) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar!(
        "SELECT i.bound_agent_id FROM agent_enrollment_claims c JOIN agent_enrollment_invites i ON i.id = c.invite_id WHERE c.id = $1 AND c.status = 'pending' AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > NOW())",
        claim_id
    ).fetch_optional(pool).await?.flatten())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimCreateReject {
    InvalidOrExpiredCode,
    AlreadyEnrolled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimApproveReject {
    NotFound,
    NotPending,
    AlreadyEnrolled,
}

pub struct EnrollmentClaimCreateOutcome {
    pub claim: EnrollmentClaimRow,
    pub auto_approve: bool,
}

/// Enrollment codes are six digits; non-digits are ignored.
pub fn normalize_enrollment_code_for_lookup(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 6).then_some(digits)
}

fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn new_agent_token_plain() -> String {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrollmentClaimRow {
    pub id: Uuid,
    pub invite_id: Option<Uuid>,
    pub status: String,
    pub requested_name: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub agent_version: Option<String>,
    pub client_ip: Option<String>,
    pub discovered_server: Option<String>,
    pub created_at: DateTime<Utc>,
    pub approved_by: Option<String>,
    pub approved_at: Option<DateTime<Utc>>,
    pub rejected_by: Option<String>,
    pub rejected_at: Option<DateTime<Utc>>,
    pub agent_id: Option<Uuid>,
    pub error: Option<String>,
}

pub struct AgentEnrollmentClaimInput<'a> {
    pub pairing_code: Option<&'a str>,
    pub requested_name: &'a str,
    pub hostname: Option<&'a str>,
    pub os: Option<&'a str>,
    pub agent_version: Option<&'a str>,
    pub install_id: &'a str,
    pub discovered_server: Option<&'a str>,
    pub client_ip: Option<&'a str>,
}

pub async fn create_agent_enrollment_claim(
    pool: &PgPool,
    input: AgentEnrollmentClaimInput<'_>,
) -> anyhow::Result<Result<EnrollmentClaimCreateOutcome, ClaimCreateReject>> {
    let AgentEnrollmentClaimInput {
        pairing_code,
        requested_name,
        hostname,
        os,
        agent_version,
        install_id,
        discovered_server,
        client_ip,
    } = input;
    let install_digest = if install_id.trim().is_empty() {
        String::new()
    } else {
        sha256_hex(install_id.trim())
    };
    let install_digest_opt = (!install_digest.is_empty()).then_some(install_digest);
    let requested_name = requested_name.trim().chars().take(128).collect::<String>();
    let requested_name = if requested_name.is_empty() {
        hostname
            .unwrap_or("agent")
            .trim()
            .chars()
            .take(128)
            .collect::<String>()
    } else {
        requested_name
    };

    let mut tx = pool.begin().await?;
    let pairing_code = pairing_code.map(str::trim).unwrap_or_default();

    if let Some(ref digest) = install_digest_opt {
        if let Some(row) = sqlx::query_as!(
            EnrollmentClaimRow,
            r"
            SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                   discovered_server, created_at, approved_by, approved_at, rejected_by,
                   rejected_at, agent_id, error
            FROM agent_enrollment_claims
            WHERE install_id_digest = $1 AND status = 'pending'
            ",
            digest
        )
        .fetch_optional(&mut *tx)
        .await?
        {
            let claim_id: Uuid = row.id;
            let mut invite_id: Option<Uuid> = None;
            let mut auto_approve = false;
            if !pairing_code.is_empty() {
                let Some(code) = normalize_enrollment_code_for_lookup(pairing_code) else {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                };
                let invite_digest = sha256_hex(&code);
                let invite = sqlx::query!(
                    r"
                    SELECT id, kind, uses_remaining, expires_at, auto_approve, bound_agent_id
                    FROM agent_enrollment_invites
                    WHERE secret_digest = $1 AND revoked_at IS NULL
                    FOR UPDATE
                    ",
                    &invite_digest
                )
                .fetch_optional(&mut *tx)
                .await?;

                let Some(invite) = invite else {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                };

                invite_id = Some(invite.id);
                let kind: String = invite.kind;
                let uses: i32 = invite.uses_remaining;
                let exp: Option<DateTime<Utc>> = invite.expires_at;
                let bound_agent_id: Option<Uuid> = invite.bound_agent_id;
                let invite_auto_approve: bool = invite.auto_approve;
                auto_approve = invite_auto_approve || kind == "quick_pair";
                if uses <= 0
                    || exp.is_some_and(|exp| Utc::now() > exp)
                    || (kind == "re_enroll" && bound_agent_id.is_none())
                {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                }

                if bound_agent_id.is_none() {
                    let existing_id: Option<Uuid> = sqlx::query_scalar!(
                        "SELECT id FROM agents WHERE name = $1",
                        &requested_name
                    )
                    .fetch_optional(&mut *tx)
                    .await?;
                    if existing_id.is_some() {
                        tx.rollback().await?;
                        return Ok(Err(ClaimCreateReject::AlreadyEnrolled));
                    }
                }

                sqlx::query!(
                    "UPDATE agent_enrollment_invites SET uses_remaining = uses_remaining - 1 WHERE id = $1",
                    invite_id
                )
                .execute(&mut *tx)
                .await?;
            }

            let row = sqlx::query_as!(
                EnrollmentClaimRow,
                r"
                UPDATE agent_enrollment_claims
                SET requested_name = $2, hostname = $3, os = $4, agent_version = $5,
                    client_ip = $6, discovered_server = $7, invite_id = COALESCE($8, invite_id)
                WHERE id = $1
                RETURNING id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                          discovered_server, created_at, approved_by, approved_at, rejected_by,
                          rejected_at, agent_id, error
                ",
                claim_id,
                &requested_name,
                hostname,
                os,
                agent_version,
                client_ip,
                discovered_server,
                invite_id
            )
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Ok(EnrollmentClaimCreateOutcome {
                claim: row,
                auto_approve,
            }));
        }
    }

    let mut invite_id: Option<Uuid> = None;
    let mut bound_agent_id: Option<Uuid> = None;
    let mut auto_approve = false;
    if !pairing_code.is_empty() {
        let Some(code) = normalize_enrollment_code_for_lookup(pairing_code) else {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
        };
        let invite_digest = sha256_hex(&code);
        let invite = sqlx::query!(
            r"
            SELECT id, kind, uses_remaining, expires_at, auto_approve, bound_agent_id
            FROM agent_enrollment_invites
            WHERE secret_digest = $1 AND revoked_at IS NULL
            FOR UPDATE
            ",
            &invite_digest
        )
        .fetch_optional(&mut *tx)
        .await?;

        let Some(invite) = invite else {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
        };

        invite_id = Some(invite.id);
        let kind: String = invite.kind;
        let uses: i32 = invite.uses_remaining;
        let exp: Option<DateTime<Utc>> = invite.expires_at;
        bound_agent_id = invite.bound_agent_id;
        let invite_auto_approve: bool = invite.auto_approve;
        auto_approve = invite_auto_approve || kind == "quick_pair";
        if uses <= 0
            || exp.is_some_and(|exp| Utc::now() > exp)
            || (kind == "re_enroll" && bound_agent_id.is_none())
        {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
        }
    }

    if bound_agent_id.is_none() {
        let existing_id: Option<Uuid> =
            sqlx::query_scalar!("SELECT id FROM agents WHERE name = $1", &requested_name)
                .fetch_optional(&mut *tx)
                .await?;
        if existing_id.is_some() {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::AlreadyEnrolled));
        }
    }

    if let Some(invite_id) = invite_id {
        sqlx::query!(
            "UPDATE agent_enrollment_invites SET uses_remaining = uses_remaining - 1 WHERE id = $1",
            invite_id
        )
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query_as!(
        EnrollmentClaimRow,
        r"
        INSERT INTO agent_enrollment_claims
            (invite_id, status, requested_name, hostname, os, agent_version,
             install_id_digest, client_ip, discovered_server)
        VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                  discovered_server, created_at, approved_by, approved_at, rejected_by,
                  rejected_at, agent_id, error
        ",
        invite_id,
        &requested_name,
        hostname,
        os,
        agent_version,
        install_digest_opt.as_deref(),
        client_ip,
        discovered_server
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Ok(EnrollmentClaimCreateOutcome {
        claim: row,
        auto_approve,
    }))
}

pub async fn get_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
) -> Result<Option<EnrollmentClaimRow>> {
    let row = sqlx::query_as!(
        EnrollmentClaimRow,
        r"
        SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
               discovered_server, created_at, approved_by, approved_at, rejected_by,
               rejected_at, agent_id, error
        FROM agent_enrollment_claims
        WHERE id = $1
        ",
        claim_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn list_agent_enrollment_claims(pool: &PgPool) -> Result<Vec<EnrollmentClaimRow>> {
    let rows = sqlx::query_as!(
        EnrollmentClaimRow,
        r"
        SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
               discovered_server, created_at, approved_by, approved_at, rejected_by,
               rejected_at, agent_id, error
        FROM agent_enrollment_claims
        WHERE created_at > NOW() - INTERVAL '14 days' OR status = 'pending'
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 200
        "
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
pub async fn approve_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
    approved_by: &str,
    agent_name: Option<&str>,
    group_id: Option<Uuid>,
) -> anyhow::Result<Result<(Uuid, String, String), ClaimApproveReject>> {
    let bound = enrollment_claim_bound_agent_id(pool, claim_id).await?;
    approve_agent_enrollment_claim_with_binding(
        pool,
        claim_id,
        approved_by,
        agent_name,
        group_id,
        bound,
    )
    .await
}

/// Reject a claim whose binding changed while its lifecycle gate was acquired.
pub async fn approve_agent_enrollment_claim_with_binding(
    pool: &PgPool,
    claim_id: Uuid,
    approved_by: &str,
    agent_name: Option<&str>,
    group_id: Option<Uuid>,
    expected_bound_agent_id: Option<Uuid>,
) -> anyhow::Result<Result<(Uuid, String, String), ClaimApproveReject>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query!(
        r"
        SELECT c.id, c.status, c.requested_name, c.agent_id, c.invite_id, i.bound_agent_id
        FROM agent_enrollment_claims c
        LEFT JOIN agent_enrollment_invites i ON i.id = c.invite_id
        WHERE c.id = $1
        FOR UPDATE OF c
        ",
        claim_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(Err(ClaimApproveReject::NotFound));
    };
    let status: String = row.status;
    if status != "pending" {
        tx.rollback().await?;
        return Ok(Err(ClaimApproveReject::NotPending));
    }
    let requested_name: String = row.requested_name;
    let mut final_name = agent_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&requested_name)
        .chars()
        .take(128)
        .collect::<String>();
    let bound_agent_id: Option<Uuid> = row.bound_agent_id;
    if bound_agent_id != expected_bound_agent_id {
        tx.rollback().await?;
        return Ok(Err(ClaimApproveReject::NotPending));
    }
    if let Some(invite_id) = row.invite_id {
        let invite = sqlx::query!(
            "SELECT kind, bound_agent_id, revoked_at, expires_at FROM agent_enrollment_invites WHERE id = $1 FOR UPDATE",
            invite_id
        ).fetch_optional(&mut *tx).await?;
        if invite.is_none_or(|invite| {
            let kind: String = invite.kind;
            let revoked: Option<DateTime<Utc>> = invite.revoked_at;
            let bound: Option<Uuid> = invite.bound_agent_id;
            let expires_at: Option<DateTime<Utc>> = invite.expires_at;
            revoked.is_some()
                || expires_at.is_some_and(|expiry| Utc::now() > expiry)
                || (kind == "re_enroll" && bound.is_none())
        }) {
            tx.rollback().await?;
            return Ok(Err(ClaimApproveReject::NotPending));
        }
    }

    let token_plain = new_agent_token_plain();
    let api_hash = hash_dashboard_password(&token_plain)?;
    let agent_id = if let Some(id) = bound_agent_id {
        let updated = sqlx::query!(
            "UPDATE agents SET api_token_hash = $2, last_seen = NOW() WHERE id = $1 RETURNING name",
            id,
            &api_hash
        )
        .fetch_optional(&mut *tx)
        .await?;
        let Some(updated) = updated else {
            tx.rollback().await?;
            return Ok(Err(ClaimApproveReject::NotFound));
        };
        final_name = updated.name;
        id
    } else {
        // Only a bound invite may replace an identity, regardless of whether
        // that identity currently has credentials. The unique name constraint
        // also covers simultaneous approvals.
        let ar = sqlx::query!(
            "INSERT INTO agents (name, api_token_hash) VALUES ($1, $2) RETURNING id",
            &final_name,
            &api_hash
        )
        .fetch_one(&mut *tx)
        .await;
        match ar {
            Ok(row) => row.id,
            Err(e) if pg_is_unique_violation(&e) => {
                tx.rollback().await?;
                return Ok(Err(ClaimApproveReject::AlreadyEnrolled));
            }
            Err(e) => return Err(e.into()),
        }
    };

    if let Some(group_id) = group_id {
        sqlx::query!(
            "INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            group_id,
            agent_id
        )
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query!(
        r"
        UPDATE agent_enrollment_claims
        SET status = 'approved', approved_by = $2, approved_at = NOW(),
            agent_id = $3, issued_token_hash = $4, error = NULL
        WHERE id = $1
        ",
        claim_id,
        approved_by,
        agent_id,
        &api_hash
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Ok((agent_id, token_plain, final_name)))
}

pub async fn reject_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
    rejected_by: &str,
    error: Option<&str>,
) -> Result<bool> {
    let r = sqlx::query!(
        r"
        UPDATE agent_enrollment_claims
        SET status = 'rejected', rejected_by = $2, rejected_at = NOW(), error = COALESCE($3, 'Rejected by admin')
        WHERE id = $1 AND status = 'pending'
        ",
        claim_id,
        rejected_by,
        error
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected() > 0)
}

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

/// Redeem an enrollment secret: stores an Argon2 hash of a fresh per-agent API token on `agents`.
/// `Ok(Ok(token))` = success; `Ok(Err(_))` = client error; `Err` = database / internal failure.
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

// ─── Agent sessions (connection history) ──────────────────────────────────────

#[cfg(test)]
mod lifecycle_db_tests {
    use super::*;
    use crate::agents::db::{delete_agents_by_ids, get_agent_auth_by_name};

    /// Touch an enrolled identity by name. A delayed WebSocket upgrade must never recreate a
    /// deleted device or connect a device whose credentials have been revoked.
    async fn upsert_agent(pool: &PgPool, name: &str) -> Result<Uuid> {
        let id = sqlx::query_scalar(
            "UPDATE agents SET last_seen = NOW() WHERE name = $1 AND api_token_hash IS NOT NULL RETURNING id",
        )
        .bind(name)
        .fetch_one(pool)
        .await?;
        Ok(id)
    }

    #[sqlx::test]
    async fn replacement_preserves_identity_and_unbound_claims_never_merge(
        pool: PgPool,
    ) -> Result<()> {
        let id: Uuid = sqlx::query_scalar("INSERT INTO agents (name, api_token_hash) VALUES ('original-host', 'old-credential') RETURNING id")
            .fetch_one(&pool).await?;
        // A history row with a real FK verifies that replacement keeps identity.
        sqlx::query("INSERT INTO agent_sessions (agent_id) VALUES ($1)")
            .bind(id)
            .execute(&pool)
            .await?;
        revoke_agent_credentials(&pool, id).await?;
        assert!(upsert_agent(&pool, "original-host").await.is_err());
        let unbound = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: None,
                requested_name: "original-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "new-unbound-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?;
        assert!(matches!(unbound, Err(ClaimCreateReject::AlreadyEnrolled)));
        let (_, first_code, _) = create_agent_replacement_token(&pool, id).await?.unwrap();
        let (_, code, _) = create_agent_replacement_token(&pool, id).await?.unwrap();
        let stale = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: Some(&first_code),
                requested_name: "different-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "stale-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?;
        assert!(matches!(
            stale,
            Err(ClaimCreateReject::InvalidOrExpiredCode)
        ));
        let outcome = create_agent_enrollment_claim(
            &pool,
            AgentEnrollmentClaimInput {
                pairing_code: Some(&code),
                requested_name: "different-host",
                hostname: None,
                os: None,
                agent_version: None,
                install_id: "replacement-install",
                discovered_server: None,
                client_ip: None,
            },
        )
        .await?
        .map_err(|_| anyhow::anyhow!("bound claim rejected"))?;
        assert!(outcome.auto_approve);
        let (replacement_id, token, name) =
            approve_agent_enrollment_claim(&pool, outcome.claim.id, "test", None, None)
                .await?
                .map_err(|_| anyhow::anyhow!("bound approval rejected"))?;
        assert_eq!(replacement_id, id);
        assert_eq!(name, "original-host");
        let (_, hash) = get_agent_auth_by_name(&pool, &name).await?.unwrap();
        assert!(crate::auth::secrets::verify_dashboard_password(
            &hash.unwrap(),
            &token
        ));
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions WHERE agent_id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await?;
        assert_eq!(count, 1);
        delete_agents_by_ids(&pool, &[id]).await?;
        assert!(upsert_agent(&pool, &name).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents")
            .fetch_one(&pool)
            .await?;
        assert_eq!(count, 0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_code_normalization() {
        // Exactly six digits, ignoring separators / surrounding noise.
        assert_eq!(
            normalize_enrollment_code_for_lookup("123-456"),
            Some("123456".to_string())
        );
        assert_eq!(
            normalize_enrollment_code_for_lookup("  1 2 3 4 5 6 "),
            Some("123456".to_string())
        );
        // Wrong digit count → rejected.
        assert_eq!(normalize_enrollment_code_for_lookup("12345"), None);
        assert_eq!(normalize_enrollment_code_for_lookup("1234567"), None);
        assert_eq!(normalize_enrollment_code_for_lookup("abcdef"), None);
        assert_eq!(normalize_enrollment_code_for_lookup(""), None);
    }
}
