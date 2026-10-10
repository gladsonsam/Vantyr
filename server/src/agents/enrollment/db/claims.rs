//! Pending enrollment claims: creation from a pairing code, listing, approval and rejection.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::sha256_hex;
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

/// A pending claim that is locked for approval inside the caller's transaction.
pub struct LockedClaim {
    pub requested_name: String,
    pub bound_agent_id: Option<Uuid>,
}

/// Lock a pending claim (and its invite) for approval. Rejects a claim that is missing, no
/// longer pending, whose invite was revoked or expired, or whose binding differs from
/// `expected_bound_agent_id` (it changed while the lifecycle gate was acquired).
pub async fn lock_claim_for_approval(
    conn: &mut PgConnection,
    claim_id: Uuid,
    expected_bound_agent_id: Option<Uuid>,
) -> Result<Result<LockedClaim, ClaimApproveReject>> {
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
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(Err(ClaimApproveReject::NotFound));
    };
    let status: String = row.status;
    if status != "pending" {
        return Ok(Err(ClaimApproveReject::NotPending));
    }
    let requested_name: String = row.requested_name;
    let bound_agent_id: Option<Uuid> = row.bound_agent_id;
    if bound_agent_id != expected_bound_agent_id {
        return Ok(Err(ClaimApproveReject::NotPending));
    }
    if let Some(invite_id) = row.invite_id {
        let invite = sqlx::query!(
            "SELECT kind, bound_agent_id, revoked_at, expires_at FROM agent_enrollment_invites WHERE id = $1 FOR UPDATE",
            invite_id
        ).fetch_optional(&mut *conn).await?;
        if invite.is_none_or(|invite| {
            let kind: String = invite.kind;
            let revoked: Option<DateTime<Utc>> = invite.revoked_at;
            let bound: Option<Uuid> = invite.bound_agent_id;
            let expires_at: Option<DateTime<Utc>> = invite.expires_at;
            revoked.is_some()
                || expires_at.is_some_and(|expiry| Utc::now() > expiry)
                || (kind == "re_enroll" && bound.is_none())
        }) {
            return Ok(Err(ClaimApproveReject::NotPending));
        }
    }
    Ok(Ok(LockedClaim {
        requested_name,
        bound_agent_id,
    }))
}

/// Store the new credential hash: rotate it on the bound identity, or create the agent
/// named `final_name`. Returns the agent id and its final name.
pub async fn issue_agent_credentials(
    conn: &mut PgConnection,
    bound_agent_id: Option<Uuid>,
    final_name: &str,
    api_hash: &str,
) -> Result<Result<(Uuid, String), ClaimApproveReject>> {
    if let Some(id) = bound_agent_id {
        let updated = sqlx::query!(
            "UPDATE agents SET api_token_hash = $2, last_seen = NOW() WHERE id = $1 RETURNING name",
            id,
            api_hash
        )
        .fetch_optional(&mut *conn)
        .await?;
        let Some(updated) = updated else {
            return Ok(Err(ClaimApproveReject::NotFound));
        };
        Ok(Ok((id, updated.name)))
    } else {
        // Only a bound invite may replace an identity, regardless of whether
        // that identity currently has credentials. The unique name constraint
        // also covers simultaneous approvals.
        let ar = sqlx::query!(
            "INSERT INTO agents (name, api_token_hash) VALUES ($1, $2) RETURNING id",
            final_name,
            api_hash
        )
        .fetch_one(&mut *conn)
        .await;
        match ar {
            Ok(row) => Ok(Ok((row.id, final_name.to_string()))),
            Err(e) if pg_is_unique_violation(&e) => Ok(Err(ClaimApproveReject::AlreadyEnrolled)),
            Err(e) => Err(e.into()),
        }
    }
}

/// Add the new agent to the group (when given) and mark the claim approved.
pub async fn mark_claim_approved(
    conn: &mut PgConnection,
    claim_id: Uuid,
    approved_by: &str,
    agent_id: Uuid,
    group_id: Option<Uuid>,
    api_hash: &str,
) -> Result<()> {
    if let Some(group_id) = group_id {
        sqlx::query!(
            "INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            group_id,
            agent_id
        )
        .execute(&mut *conn)
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
        api_hash
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
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
