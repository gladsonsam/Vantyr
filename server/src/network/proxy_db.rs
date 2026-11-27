//! Database primitives for proxy sign-in credentials, sessions and evidence.
//!
//! Every mutator takes a `PgConnection` that already holds the household row
//! lock (see `db::lock_household`). Replay state lives on the evidence row and
//! is consumed under that same lock, so concurrent introspections cannot both
//! accept one receipt. No secret, digest or person value is logged here.

use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::proxy_dto::{CredentialRow, EvidenceProof, SessionRow, WorkerCredentialRow};

/// A live OIDC-backed verified session: the only acceptable proof of the
/// current person for a device. Created solely by BYOD grant consumption.
#[derive(Debug, Clone)]
pub struct OidcSession {
    pub generation: i64,
    pub expires_at: DateTime<Utc>,
}

/// The household-kind flag from the device row. The worker derives the same
/// value from its own device config, so storing it on the credential keeps the
/// two checks consistent.
pub struct DeviceScope {
    pub shared: bool,
}

pub async fn device_scope_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<Option<DeviceScope>> {
    sqlx::query_as::<_, (bool,)>(
        "SELECT shared FROM network_devices WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_optional(&mut *conn)
    .await
    .map(|row| row.map(|(shared,)| DeviceScope { shared }))
}

/// The most recent non-ended, unexpired OIDC session for this person + device.
pub async fn live_oidc_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<OidcSession>> {
    sqlx::query_as::<_, (i64, DateTime<Utc>)>(
        r"
        SELECT generation, expires_at
        FROM network_verified_sessions
        WHERE household_id = $1 AND person_id = $2 AND device_id = $3
          AND verification_method = 'oidc_session'
          AND ended_at IS NULL AND expires_at > $4
        ORDER BY verified_at DESC
        LIMIT 1
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(device_id)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await
    .map(|row| {
        row.map(|(generation, expires_at)| OidcSession {
            generation,
            expires_at,
        })
    })
}

/// Safe availability metadata: whether any OIDC-backed sign-in exists in this
/// household right now. It does not assert DNS/proxy enforcement or coverage.
pub async fn any_live_oidc_session(pool: &PgPool, household_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_verified_sessions
            WHERE household_id = $1 AND verification_method = 'oidc_session'
              AND ended_at IS NULL AND expires_at > NOW()
        )
        ",
    )
    .bind(household_id)
    .fetch_one(pool)
    .await
}

/// Read-only display projection of an explicitly resolved same-household
/// person. Never a lookup by display name and never an identity claim.
pub async fn person_label_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT display_name FROM network_persons WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(person_id)
    .fetch_optional(&mut *conn)
    .await
}

/// Latest live OIDC session for a person anywhere in the household. Used when
/// the issue body omits `device_id`: the device is derived from authoritative
/// proof, never chosen by the caller.
pub async fn latest_oidc_session_for_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<(Uuid, i64)>> {
    sqlx::query_as::<_, (Uuid, i64)>(
        r"
        SELECT device_id, generation
        FROM network_verified_sessions
        WHERE household_id = $1 AND person_id = $2
          AND verification_method = 'oidc_session'
          AND ended_at IS NULL AND expires_at > $3
        ORDER BY verified_at DESC
        LIMIT 1
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await
}

#[allow(clippy::too_many_arguments)] // one locked insert, all bound fields
pub async fn insert_credential_on_conn(
    conn: &mut PgConnection,
    id: Uuid,
    household_id: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    label: &str,
    scopes: &[String],
    secret_hash: &str,
    generation: i64,
    household_kind: &str,
    issued_by: Uuid,
    expires_at: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_proxy_credentials
            (id, household_id, person_id, device_id, label, scopes, secret_hash,
             binding_generation, household_kind, issued_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ",
    )
    .bind(id)
    .bind(household_id)
    .bind(person_id)
    .bind(device_id)
    .bind(label)
    .bind(scopes)
    .bind(secret_hash)
    .bind(generation)
    .bind(household_kind)
    .bind(issued_by)
    .bind(expires_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Everything needed to bind an evidence receipt to an authoritative credential.
#[derive(Debug, Clone)]
pub struct EvidenceCredential {
    pub person_id: Uuid,
    pub device_id: Uuid,
    pub binding_generation: i64,
    pub household_kind: String,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
}

pub async fn credential_for_evidence_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    credential_id: Uuid,
) -> sqlx::Result<Option<EvidenceCredential>> {
    sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            i64,
            String,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            Vec<String>,
        ),
    >(
        r"
        SELECT person_id, device_id, binding_generation, household_kind,
               expires_at, revoked_at, scopes
        FROM network_proxy_credentials
        WHERE household_id = $1 AND id = $2
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(credential_id)
    .fetch_optional(&mut *conn)
    .await
    .map(|row| {
        row.map(
            |(
                person_id,
                device_id,
                binding_generation,
                household_kind,
                expires_at,
                revoked_at,
                scopes,
            )| {
                EvidenceCredential {
                    person_id,
                    device_id,
                    binding_generation,
                    household_kind,
                    expires_at,
                    revoked_at,
                    scopes,
                }
            },
        )
    })
}

pub async fn credential_in_scope(
    pool: &PgPool,
    household_id: Uuid,
    credential_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_proxy_credentials WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(credential_id)
    .fetch_one(pool)
    .await
}

pub async fn list_credentials(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<CredentialRow>> {
    sqlx::query_as::<_, CredentialRow>(
        r"
        SELECT c.id, c.label, c.person_id, p.display_name AS person_label,
               c.device_id, c.created_at, c.expires_at, c.last_used_at,
               (c.revoked_at IS NOT NULL) AS revoked, c.revoked_at, c.scopes
        FROM network_proxy_credentials c
        JOIN network_persons p ON p.id = c.person_id AND p.household_id = c.household_id
        WHERE c.household_id = $1
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn revoke_credential_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    credential_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_credentials
        SET revoked_at = $3
        WHERE household_id = $1 AND id = $2 AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(credential_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn revoke_all_for_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_credentials
        SET revoked_at = $3
        WHERE household_id = $1 AND person_id = $2 AND revoked_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

pub async fn end_sessions_for_credential_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    credential_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_sessions
        SET ended_at = $3, end_reason = 'credential_revoked'
        WHERE household_id = $1 AND credential_id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(credential_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

pub async fn end_sessions_for_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_sessions
        SET ended_at = $3, end_reason = 'credential_revoked'
        WHERE household_id = $1 AND person_id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Invalidate every unexpired receipt owned by a credential. Revoked receipts
/// keep their row (and replay state) until their own retention window.
pub async fn revoke_evidence_for_credential_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    credential_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_session_evidence
        SET revoked_at = $3
        WHERE household_id = $1 AND credential_id = $2
          AND revoked_at IS NULL AND expires_at > $3
        ",
    )
    .bind(household_id)
    .bind(credential_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

pub async fn revoke_evidence_for_person_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    person_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_session_evidence
        SET revoked_at = $3
        WHERE household_id = $1 AND person_id = $2
          AND revoked_at IS NULL AND expires_at > $3
        ",
    )
    .bind(household_id)
    .bind(person_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

#[allow(clippy::too_many_arguments)] // one locked insert, all bound fields
pub async fn insert_session_on_conn(
    conn: &mut PgConnection,
    id: Uuid,
    household_id: Uuid,
    credential_id: Uuid,
    device_id: Uuid,
    person_id: Uuid,
    generation: i64,
    household_kind: &str,
    expires_at: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_proxy_sessions
            (id, household_id, credential_id, device_id, person_id,
             binding_generation, household_kind, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ",
    )
    .bind(id)
    .bind(household_id)
    .bind(credential_id)
    .bind(device_id)
    .bind(person_id)
    .bind(generation)
    .bind(household_kind)
    .bind(expires_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn list_sessions(
    pool: &PgPool,
    household_id: Uuid,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<SessionRow>> {
    sqlx::query_as::<_, SessionRow>(
        r"
        SELECT s.id, s.credential_id, s.device_id, s.person_id,
               p.display_name AS person_label, s.started_at, s.last_active_at,
               s.expires_at, (s.ended_at IS NOT NULL) AS revoked
        FROM network_proxy_sessions s
        JOIN network_persons p ON p.id = s.person_id AND p.household_id = s.household_id
        WHERE s.household_id = $1
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(household_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
}

pub async fn session_in_scope_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    session_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_proxy_sessions WHERE household_id = $1 AND id = $2)",
    )
    .bind(household_id)
    .bind(session_id)
    .fetch_one(&mut *conn)
    .await
}

pub async fn end_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    session_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_sessions
        SET ended_at = $3, end_reason = 'session_ended'
        WHERE household_id = $1 AND id = $2 AND ended_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(session_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[allow(clippy::too_many_arguments)] // one locked insert, all bound fields
pub async fn insert_evidence_on_conn(
    conn: &mut PgConnection,
    session_id: Uuid,
    household_id: Uuid,
    credential_id: Uuid,
    device_id: Uuid,
    person_id: Option<Uuid>,
    generation: i64,
    household_kind: &str,
    command: &str,
    digest: &str,
    nonce: &str,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_proxy_session_evidence
            (session_id, household_id, credential_id, device_id, person_id,
             binding_generation, household_kind, command, digest, nonce,
             issued_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ",
    )
    .bind(session_id)
    .bind(household_id)
    .bind(credential_id)
    .bind(device_id)
    .bind(person_id)
    .bind(generation)
    .bind(household_kind)
    .bind(command)
    .bind(digest)
    .bind(nonce)
    .bind(issued_at)
    .bind(expires_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Hash-only credential set for a scoped worker. Revoked rows are included so
/// the worker can drop them from its local cache; plaintext never appears.
pub async fn worker_credentials_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Vec<WorkerCredentialRow>> {
    sqlx::query_as::<_, WorkerCredentialRow>(
        r"
        SELECT id, household_id, device_id, secret_hash, binding_generation,
               household_kind, scopes, created_at AS issued_at, expires_at, revoked_at
        FROM network_proxy_credentials
        WHERE household_id = $1
        ",
    )
    .bind(household_id)
    .fetch_all(&mut *conn)
    .await
}

pub async fn revoke_evidence_for_session_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    session_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query(
        r"
        UPDATE network_proxy_session_evidence
        SET revoked_at = $3
        WHERE household_id = $1 AND session_id = $2
          AND revoked_at IS NULL AND expires_at > $3
        ",
    )
    .bind(household_id)
    .bind(session_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Active household assignments for the scoped worker. `unknown` roles are
/// deliberately excluded: they do not establish a person-to-device binding.
pub async fn worker_assignments_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Vec<super::proxy_dto::WorkerAssignmentRow>> {
    sqlx::query_as::<_, super::proxy_dto::WorkerAssignmentRow>(
        r"
        SELECT id, person_id, device_id,
               CASE role
                   WHEN 'owner' THEN 'owner'
                   WHEN 'administrator' THEN 'administrator'
                   WHEN 'member' THEN 'member'
                   WHEN 'guest' THEN 'member'
                   WHEN 'managed' THEN 'member'
                   ELSE 'unknown'
               END AS role,
               active
        FROM network_assignments
        WHERE household_id = $1 AND active
          AND role <> 'unknown'
        ",
    )
    .bind(household_id)
    .fetch_all(&mut *conn)
    .await
}

/// Atomically validate + consume one receipt. `FOR UPDATE` serializes concurrent
/// presentations of the same receipt: exactly one can pass `consumed_at IS NULL`.
/// Scope checks that do not need row state are applied by the caller after this
/// succeeds; a later denial still consumes the receipt (no give-back path).
pub async fn consume_evidence_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    digest: &str,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<EvidenceProof>> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            Uuid,
            Uuid,
            Option<Uuid>,
            i64,
            String,
            String,
            DateTime<Utc>,
            DateTime<Utc>,
        ),
    >(
        r"
        SELECT session_id, household_id, credential_id, device_id, person_id,
               binding_generation, household_kind, command, issued_at, expires_at
        FROM network_proxy_session_evidence
        WHERE household_id = $1 AND digest = $2
          AND revoked_at IS NULL AND consumed_at IS NULL
          AND issued_at <= $3 AND expires_at > $3
        FOR UPDATE
        ",
    )
    .bind(household_id)
    .bind(digest)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let updated = sqlx::query(
        r"
        UPDATE network_proxy_session_evidence
        SET consumed_at = $3
        WHERE household_id = $1 AND session_id = $2 AND consumed_at IS NULL
        ",
    )
    .bind(household_id)
    .bind(row.0)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    if updated.rows_affected() != 1 {
        return Ok(None);
    }
    Ok(Some(EvidenceProof {
        valid: true,
        session_id: row.0,
        household_id: row.1,
        credential_id: row.2,
        device_id: row.3,
        person_id: row.4,
        binding_generation: row.5,
        household_kind: row.6,
        command: row.7,
        issued_at: row.8,
        expires_at: row.9,
    }))
}

/// Touch last-used metadata for a verified credential. Never logs a value.
pub async fn touch_credential_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    credential_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE network_proxy_credentials SET last_used_at = $3 WHERE household_id = $1 AND id = $2",
    )
    .bind(household_id)
    .bind(credential_id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Count live (unrevoked, unexpired) credentials for a household, used for the
/// bounded issuance cap. Checked under the household lock.
pub async fn count_live_credentials_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r"
        SELECT COUNT(*) FROM network_proxy_credentials
        WHERE household_id = $1 AND revoked_at IS NULL AND expires_at > $2
        ",
    )
    .bind(household_id)
    .bind(now)
    .fetch_one(&mut *conn)
    .await
}

/// Reclaim retired credentials and evidence once their audit retention has
/// elapsed. Still-live replay state is never evicted to make room.
pub async fn prune_retired_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    cutoff: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        DELETE FROM network_proxy_session_evidence
        WHERE household_id = $1
          AND ((revoked_at IS NOT NULL AND revoked_at < $2)
               OR (revoked_at IS NULL AND expires_at < $2))
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        r"
        DELETE FROM network_proxy_sessions
        WHERE household_id = $1 AND ended_at IS NOT NULL AND ended_at < $2
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        r"
        DELETE FROM network_proxy_credentials
        WHERE household_id = $1 AND revoked_at IS NOT NULL AND revoked_at < $2
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
