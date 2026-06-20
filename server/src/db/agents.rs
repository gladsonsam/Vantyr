//! Agent identity and connection-history persistence (carved out of the monolithic `db.rs`).

use super::*;

/// Insert the agent if it doesn't exist yet; always bump `last_seen`.
/// Returns the stable UUID for this agent name.
pub async fn upsert_agent(pool: &PgPool, name: &str) -> Result<Uuid> {
    let row = sqlx::query(
        r"
        INSERT INTO agents (name)
        VALUES ($1)
        ON CONFLICT (name) DO UPDATE SET last_seen = NOW()
        RETURNING id
        ",
    )
    .bind(name)
    .fetch_one(pool)
    .await?;

    Ok(row.try_get("id")?)
}

/// Update `last_seen` when the agent disconnects.
pub async fn touch_agent(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE agents SET last_seen = NOW() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn agent_name_by_id(pool: &PgPool, id: Uuid) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar("SELECT name FROM agents WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(v)
}

/// Stable agent id + optional per-machine API token hash (Argon2). Used by WebSocket auth.
pub async fn get_agent_auth_by_name(
    pool: &PgPool,
    name: &str,
) -> Result<Option<(Uuid, Option<String>)>> {
    let row = sqlx::query("SELECT id, api_token_hash FROM agents WHERE name = $1")
        .bind(name)
        .fetch_optional(pool)
        .await?;
    match row {
        None => Ok(None),
        Some(r) => Ok(Some((r.try_get("id")?, r.try_get("api_token_hash")?))),
    }
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

pub(crate) fn pg_is_unique_violation(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Database(db) => db.code().is_some_and(|c| c == "23505"),
        _ => false,
    }
}

/// Enrollment codes are six digits; non-digits are ignored.
pub fn normalize_enrollment_code_for_lookup(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 6).then_some(digits)
}

pub(crate) fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn new_agent_token_plain() -> String {
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

fn claim_from_row(r: sqlx::postgres::PgRow) -> Result<EnrollmentClaimRow> {
    Ok(EnrollmentClaimRow {
        id: r.try_get("id")?,
        invite_id: r.try_get("invite_id")?,
        status: r.try_get("status")?,
        requested_name: r.try_get("requested_name")?,
        hostname: r.try_get("hostname")?,
        os: r.try_get("os")?,
        agent_version: r.try_get("agent_version")?,
        client_ip: r.try_get("client_ip")?,
        discovered_server: r.try_get("discovered_server")?,
        created_at: r.try_get("created_at")?,
        approved_by: r.try_get("approved_by")?,
        approved_at: r.try_get("approved_at")?,
        rejected_by: r.try_get("rejected_by")?,
        rejected_at: r.try_get("rejected_at")?,
        agent_id: r.try_get("agent_id")?,
        error: r.try_get("error")?,
    })
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
        if let Some(row) = sqlx::query(
            r"
            SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                   discovered_server, created_at, approved_by, approved_at, rejected_by,
                   rejected_at, agent_id, error
            FROM agent_enrollment_claims
            WHERE install_id_digest = $1 AND status = 'pending'
            ",
        )
        .bind(digest)
        .fetch_optional(&mut *tx)
        .await?
        {
            let claim_id: Uuid = row.try_get("id")?;
            let mut invite_id: Option<Uuid> = None;
            let mut auto_approve = false;
            if !pairing_code.is_empty() {
                let Some(code) = normalize_enrollment_code_for_lookup(pairing_code) else {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                };
                let invite_digest = sha256_hex(&code);
                let invite = sqlx::query(
                    r"
                    SELECT id, kind, uses_remaining, expires_at, auto_approve, bound_agent_id
                    FROM agent_enrollment_invites
                    WHERE secret_digest = $1 AND revoked_at IS NULL
                    FOR UPDATE
                    ",
                )
                .bind(&invite_digest)
                .fetch_optional(&mut *tx)
                .await?;

                let Some(invite) = invite else {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                };

                invite_id = Some(invite.try_get("id")?);
                let kind: String = invite.try_get("kind")?;
                let uses: i32 = invite.try_get("uses_remaining")?;
                let exp: Option<DateTime<Utc>> = invite.try_get("expires_at")?;
                let bound_agent_id: Option<Uuid> = invite.try_get("bound_agent_id")?;
                let invite_auto_approve: bool = invite.try_get("auto_approve")?;
                auto_approve = invite_auto_approve || kind == "quick_pair";
                if uses <= 0 || exp.is_some_and(|exp| Utc::now() > exp) {
                    tx.rollback().await?;
                    return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
                }

                if bound_agent_id.is_none() {
                    let existing_hash: Option<String> =
                        sqlx::query_scalar("SELECT api_token_hash FROM agents WHERE name = $1")
                            .bind(&requested_name)
                            .fetch_optional(&mut *tx)
                            .await?
                            .flatten();
                    if existing_hash.is_some() {
                        tx.rollback().await?;
                        return Ok(Err(ClaimCreateReject::AlreadyEnrolled));
                    }
                }

                sqlx::query(
                    "UPDATE agent_enrollment_invites SET uses_remaining = uses_remaining - 1 WHERE id = $1",
                )
                .bind(invite_id)
                .execute(&mut *tx)
                .await?;
            }

            let row = sqlx::query(
                r"
                UPDATE agent_enrollment_claims
                SET requested_name = $2, hostname = $3, os = $4, agent_version = $5,
                    client_ip = $6, discovered_server = $7, invite_id = COALESCE($8, invite_id)
                WHERE id = $1
                RETURNING id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                          discovered_server, created_at, approved_by, approved_at, rejected_by,
                          rejected_at, agent_id, error
                ",
            )
            .bind(claim_id)
            .bind(&requested_name)
            .bind(hostname)
            .bind(os)
            .bind(agent_version)
            .bind(client_ip)
            .bind(discovered_server)
            .bind(invite_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Ok(EnrollmentClaimCreateOutcome {
                claim: claim_from_row(row)?,
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
        let invite = sqlx::query(
            r"
            SELECT id, kind, uses_remaining, expires_at, auto_approve, bound_agent_id
            FROM agent_enrollment_invites
            WHERE secret_digest = $1 AND revoked_at IS NULL
            FOR UPDATE
            ",
        )
        .bind(&invite_digest)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(invite) = invite else {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
        };

        invite_id = Some(invite.try_get("id")?);
        let kind: String = invite.try_get("kind")?;
        let uses: i32 = invite.try_get("uses_remaining")?;
        let exp: Option<DateTime<Utc>> = invite.try_get("expires_at")?;
        bound_agent_id = invite.try_get("bound_agent_id")?;
        let invite_auto_approve: bool = invite.try_get("auto_approve")?;
        auto_approve = invite_auto_approve || kind == "quick_pair";
        if uses <= 0 || exp.is_some_and(|exp| Utc::now() > exp) {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::InvalidOrExpiredCode));
        }
    }

    if bound_agent_id.is_none() {
        let existing_hash: Option<String> =
            sqlx::query_scalar("SELECT api_token_hash FROM agents WHERE name = $1")
                .bind(&requested_name)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
        if existing_hash.is_some() {
            tx.rollback().await?;
            return Ok(Err(ClaimCreateReject::AlreadyEnrolled));
        }
    }

    if let Some(invite_id) = invite_id {
        sqlx::query(
            "UPDATE agent_enrollment_invites SET uses_remaining = uses_remaining - 1 WHERE id = $1",
        )
        .bind(invite_id)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query(
        r"
        INSERT INTO agent_enrollment_claims
            (invite_id, status, requested_name, hostname, os, agent_version,
             install_id_digest, client_ip, discovered_server)
        VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
                  discovered_server, created_at, approved_by, approved_at, rejected_by,
                  rejected_at, agent_id, error
        ",
    )
    .bind(invite_id)
    .bind(&requested_name)
    .bind(hostname)
    .bind(os)
    .bind(agent_version)
    .bind(install_digest_opt.as_deref())
    .bind(client_ip)
    .bind(discovered_server)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Ok(EnrollmentClaimCreateOutcome {
        claim: claim_from_row(row)?,
        auto_approve,
    }))
}

pub async fn get_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
) -> Result<Option<EnrollmentClaimRow>> {
    let row = sqlx::query(
        r"
        SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
               discovered_server, created_at, approved_by, approved_at, rejected_by,
               rejected_at, agent_id, error
        FROM agent_enrollment_claims
        WHERE id = $1
        ",
    )
    .bind(claim_id)
    .fetch_optional(pool)
    .await?;
    row.map(claim_from_row).transpose()
}

pub async fn list_agent_enrollment_claims(pool: &PgPool) -> Result<Vec<EnrollmentClaimRow>> {
    let rows = sqlx::query(
        r"
        SELECT id, invite_id, status, requested_name, hostname, os, agent_version, client_ip,
               discovered_server, created_at, approved_by, approved_at, rejected_by,
               rejected_at, agent_id, error
        FROM agent_enrollment_claims
        WHERE created_at > NOW() - INTERVAL '14 days' OR status = 'pending'
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 200
        ",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(claim_from_row).collect()
}

pub async fn approve_agent_enrollment_claim(
    pool: &PgPool,
    claim_id: Uuid,
    approved_by: &str,
    agent_name: Option<&str>,
    group_id: Option<Uuid>,
) -> anyhow::Result<Result<(Uuid, String, String), ClaimApproveReject>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        r"
        SELECT c.id, c.status, c.requested_name, c.agent_id, i.bound_agent_id
        FROM agent_enrollment_claims c
        LEFT JOIN agent_enrollment_invites i ON i.id = c.invite_id
        WHERE c.id = $1
        FOR UPDATE OF c
        ",
    )
    .bind(claim_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(Err(ClaimApproveReject::NotFound));
    };
    let status: String = row.try_get("status")?;
    if status != "pending" {
        tx.rollback().await?;
        return Ok(Err(ClaimApproveReject::NotPending));
    }
    let requested_name: String = row.try_get("requested_name")?;
    let final_name = agent_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&requested_name)
        .chars()
        .take(128)
        .collect::<String>();
    let bound_agent_id: Option<Uuid> = row.try_get("bound_agent_id")?;

    let token_plain = new_agent_token_plain();
    let api_hash = hash_dashboard_password(&token_plain)?;
    let agent_id = if let Some(id) = bound_agent_id {
        sqlx::query(
            "UPDATE agents SET name = $2, api_token_hash = $3, last_seen = NOW() WHERE id = $1",
        )
        .bind(id)
        .bind(&final_name)
        .bind(&api_hash)
        .execute(&mut *tx)
        .await?;
        id
    } else {
        let existing =
            sqlx::query("SELECT id, api_token_hash FROM agents WHERE name = $1 FOR UPDATE")
                .bind(&final_name)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(existing) = existing {
            let existing_hash: Option<String> = existing.try_get("api_token_hash")?;
            if existing_hash.is_some() {
                tx.rollback().await?;
                return Ok(Err(ClaimApproveReject::AlreadyEnrolled));
            }
            let id: Uuid = existing.try_get("id")?;
            sqlx::query("UPDATE agents SET api_token_hash = $2, last_seen = NOW() WHERE id = $1")
                .bind(id)
                .bind(&api_hash)
                .execute(&mut *tx)
                .await?;
            id
        } else {
            let ar = sqlx::query(
                "INSERT INTO agents (name, api_token_hash) VALUES ($1, $2) RETURNING id",
            )
            .bind(&final_name)
            .bind(&api_hash)
            .fetch_one(&mut *tx)
            .await?;
            ar.try_get("id")?
        }
    };

    if let Some(group_id) = group_id {
        sqlx::query("INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(group_id)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(
        r"
        UPDATE agent_enrollment_claims
        SET status = 'approved', approved_by = $2, approved_at = NOW(),
            agent_id = $3, issued_token_hash = $4, error = NULL
        WHERE id = $1
        ",
    )
    .bind(claim_id)
    .bind(approved_by)
    .bind(agent_id)
    .bind(&api_hash)
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
    let r = sqlx::query(
        r"
        UPDATE agent_enrollment_claims
        SET status = 'rejected', rejected_by = $2, rejected_at = NOW(), error = COALESCE($3, 'Rejected by admin')
        WHERE id = $1 AND status = 'pending'
        ",
    )
    .bind(claim_id)
    .bind(rejected_by)
    .bind(error)
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
        let res = sqlx::query(
            r"
            INSERT INTO agent_enrollment_invites
                (secret_digest, kind, uses_remaining, expires_at, auto_approve, note)
            VALUES ($1, 'quick_pair', $2, $3, true, $4)
            RETURNING id
            ",
        )
        .bind(&digest)
        .bind(uses)
        .bind(expires_at)
        .bind(note)
        .fetch_one(pool)
        .await;
        match res {
            Ok(row) => {
                let id: Uuid = row.try_get("id")?;
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
    let rows = sqlx::query(
        r"
        SELECT
            t.id,
            t.uses_remaining,
            t.created_at,
            t.expires_at,
            t.note,
            COALESCE(u.used_count, 0)::BIGINT AS used_count,
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
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(EnrollmentTokenRow {
            id: r.try_get("id")?,
            uses_remaining: r.try_get("uses_remaining")?,
            created_at: r.try_get("created_at")?,
            expires_at: r.try_get("expires_at")?,
            note: r.try_get("note")?,
            used_count: r.try_get("used_count")?,
            last_used_at: r.try_get("last_used_at")?,
        });
    }
    Ok(out)
}

pub async fn revoke_agent_enrollment_token(pool: &PgPool, token_id: Uuid) -> Result<()> {
    sqlx::query("UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1")
        .bind(token_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn revoke_all_agent_enrollment_tokens(pool: &PgPool) -> Result<u64> {
    let res = sqlx::query("UPDATE agent_enrollment_invites SET uses_remaining = 0, revoked_at = COALESCE(revoked_at, NOW()) WHERE uses_remaining > 0")
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
    let rows = sqlx::query(
        r"
        SELECT created_at AS used_at, requested_name AS agent_name, agent_id
        FROM agent_enrollment_claims
        WHERE invite_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        ",
    )
    .bind(token_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(EnrollmentTokenUseRow {
            used_at: r.try_get("used_at")?,
            agent_name: r.try_get("agent_name")?,
            agent_id: r.try_get("agent_id")?,
        });
    }
    Ok(out)
}

pub async fn revoke_agent_credentials(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query("UPDATE agents SET api_token_hash = NULL WHERE id = $1")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_agents_by_ids(pool: &PgPool, agent_ids: &[Uuid]) -> Result<u64> {
    if agent_ids.is_empty() {
        return Ok(0);
    }
    let res = sqlx::query("DELETE FROM agents WHERE id = ANY($1)")
        .bind(agent_ids)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Upsert the latest system/specs snapshot for an agent.
pub async fn upsert_agent_info(
    pool: &PgPool,
    agent_id: Uuid,
    info: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO agent_info (agent_id, info, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (agent_id)
        DO UPDATE SET info = EXCLUDED.info, updated_at = NOW()
        ",
    )
    .bind(agent_id)
    .bind(info)
    .execute(pool)
    .await?;
    Ok(())
}

/// Fetch the latest stored system/specs snapshot for an agent (if any).
pub async fn get_agent_info(pool: &PgPool, agent_id: Uuid) -> Result<Option<serde_json::Value>> {
    let row = sqlx::query("SELECT info FROM agent_info WHERE agent_id = $1")
        .bind(agent_id)
        .fetch_optional(pool)
        .await?;

    Ok(row.and_then(|r| r.try_get::<serde_json::Value, _>("info").ok()))
}

/// Fetch latest stored agent versions in batch (best-effort; missing entries omitted).
pub async fn agent_versions_batch(
    pool: &PgPool,
    agent_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>> {
    use sqlx::Row;
    if agent_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query(
        r"
        SELECT agent_id, info->>'agent_version' AS agent_version
        FROM agent_info
        WHERE agent_id = ANY($1)
        ",
    )
    .bind(agent_ids)
    .fetch_all(pool)
    .await?;

    let mut out = std::collections::HashMap::new();
    for r in rows {
        let id: Uuid = r.try_get("agent_id").unwrap_or_default();
        let v: Option<String> = r.try_get("agent_version").ok();
        if let Some(s) = v {
            let t = s.trim();
            if !t.is_empty() {
                out.insert(id, t.to_string());
            }
        }
    }
    Ok(out)
}

// ─── Agent sessions (connection history) ──────────────────────────────────────

/// Record a new WebSocket session for an agent. Returns the session row id.
pub async fn start_agent_session(pool: &PgPool, agent_id: Uuid) -> Result<i64> {
    let id: i64 =
        sqlx::query_scalar(r"INSERT INTO agent_sessions (agent_id) VALUES ($1) RETURNING id")
            .bind(agent_id)
            .fetch_one(pool)
            .await?;
    Ok(id)
}

/// Mark an agent session disconnected.
pub async fn end_agent_session(pool: &PgPool, session_id: i64) -> Result<()> {
    sqlx::query("UPDATE agent_sessions SET disconnected_at = NOW() WHERE id = $1")
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Returns (`last_connected_at`, `last_disconnected_at`) for an agent.
#[allow(dead_code)] // Retained for ad-hoc use; hot paths use [`agent_last_session_times_batch`].
pub async fn agent_last_session_times(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<(Option<DateTime<Utc>>, Option<DateTime<Utc>>)> {
    let row = sqlx::query(
        r"
        SELECT
            MAX(connected_at)    AS last_connected_at,
            MAX(disconnected_at) AS last_disconnected_at
        FROM agent_sessions
        WHERE agent_id = $1
        ",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await?;

    let last_connected_at: Option<DateTime<Utc>> = row.try_get("last_connected_at").ok();
    let last_disconnected_at: Option<DateTime<Utc>> = row.try_get("last_disconnected_at").ok();
    Ok((last_connected_at, last_disconnected_at))
}

/// Batch variant of [`agent_last_session_times`] for many agents in one round-trip.
pub async fn agent_last_session_times_batch(
    pool: &PgPool,
    agent_ids: &[Uuid],
) -> Result<HashMap<Uuid, (Option<DateTime<Utc>>, Option<DateTime<Utc>>)>> {
    if agent_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r"
        SELECT agent_id,
               MAX(connected_at)    AS last_connected_at,
               MAX(disconnected_at) AS last_disconnected_at
        FROM agent_sessions
        WHERE agent_id = ANY($1)
        GROUP BY agent_id
        ",
    )
    .bind(agent_ids)
    .fetch_all(pool)
    .await?;

    let mut out = HashMap::with_capacity(rows.len());
    for row in rows {
        let id: Uuid = row.try_get("agent_id")?;
        let last_connected_at: Option<DateTime<Utc>> = row.try_get("last_connected_at").ok();
        let last_disconnected_at: Option<DateTime<Utc>> = row.try_get("last_disconnected_at").ok();
        out.insert(id, (last_connected_at, last_disconnected_at));
    }
    Ok(out)
}
