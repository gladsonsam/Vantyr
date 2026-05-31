//! Database operations.
//!
//! All queries use the non-macro `sqlx::query()` / `sqlx::query_scalar()` API
//! so the server compiles without a running database (no `SQLX_OFFLINE` flag
//! needed in CI or Docker builds).

use anyhow::Result;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, TimeZone, Utc};
use rand::{Rng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use uuid::Uuid;

use crate::url_categorization;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::rngs::OsRng;

/// Mirrors each persisted audit row to `tracing` so `docker logs` matches the dashboard log.
fn emit_audit_tracing_line(actor: &str, action: &str, status: &str, client_ip: Option<&str>) {
    let ip = client_ip.unwrap_or("-");
    match status {
        "error" => tracing::error!(
            target: "sentinel_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        "rejected" => tracing::warn!(
            target: "sentinel_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        _ => tracing::info!(
            target: "sentinel_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
    }
}

// ─── Retention policy ─────────────────────────────────────────────────────────

/// Global retention: `None` / NULL = keep forever (no automatic deletion). `Some(0)` is never stored (API normalizes to `None`).
#[derive(Debug, Clone, Serialize)]
pub struct RetentionPolicy {
    pub keylog_days: Option<i32>,
    pub window_days: Option<i32>,
    pub url_days: Option<i32>,
}

/// Per-agent override. Each `None` means “use global default for that category”.
/// `Some(0)` means unlimited for that stream (no prune), regardless of global.
#[derive(Debug, Clone, Serialize)]
pub struct RetentionAgentOverride {
    pub keylog_days: Option<i32>,
    pub window_days: Option<i32>,
    pub url_days: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditRecord {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub actor: String,
    /// Set on HTTP audit rows; null for older rows or WebSocket-only events.
    pub client_ip: Option<String>,
    pub agent_id: Option<Uuid>,
    pub action: String,
    pub status: String,
    pub detail: serde_json::Value,
}

/// Arguments for [`insert_audit_log_dedup`] and [`insert_audit_log_dedup_traced`].
#[derive(Clone, Copy)]
pub struct AuditLogDedup<'a> {
    pub actor: &'a str,
    pub agent_id: Option<Uuid>,
    pub action: &'a str,
    pub status: &'a str,
    pub detail: &'a serde_json::Value,
    pub dedup_window_secs: i64,
    pub client_ip: Option<&'a str>,
}

/// Arguments for [`alert_rule_create_with_scopes`] and [`alert_rule_update_with_scopes`].
#[derive(Clone, Copy)]
pub struct AlertRuleUpsert<'a> {
    pub name: &'a str,
    pub channel: &'a str,
    pub pattern: &'a str,
    pub match_mode: &'a str,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub enabled: bool,
    pub take_screenshot: bool,
    pub scopes: &'a [(String, Option<Uuid>, Option<Uuid>)],
}

#[derive(Debug, Clone, Serialize)]
pub struct UrlTopRow {
    pub url: String,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowTopRow {
    pub app: String,
    pub app_display: String,
    pub title: String,
    pub focus_count: i64,
    pub last_ts: DateTime<Utc>,
}

// ─── Dashboard users & sessions ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DashboardUserRow {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub display_icon: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

pub fn hash_dashboard_password(plain: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify_dashboard_password(hash: &str, plain: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok()
}

pub async fn dashboard_user_count(pool: &PgPool) -> Result<i64> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dashboard_users")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

pub async fn dashboard_admin_count(pool: &PgPool) -> Result<i64> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dashboard_users WHERE role = 'admin'")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

pub async fn dashboard_user_is_admin(pool: &PgPool, user_id: Uuid) -> Result<bool> {
    let v: Option<String> = sqlx::query_scalar("SELECT role FROM dashboard_users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(v.as_deref() == Some("admin"))
}

/// Returns `(username, display_icon)` when the row exists.
pub async fn dashboard_username_taken_by_other(
    pool: &PgPool,
    username: &str,
    exclude_id: Uuid,
) -> Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM dashboard_users WHERE lower(username) = lower($1) AND id <> $2",
    )
    .bind(username)
    .bind(exclude_id)
    .fetch_one(pool)
    .await?;
    Ok(n > 0)
}

pub async fn dashboard_user_get_profile_bits(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Option<(String, Option<String>, String)>> {
    let row = sqlx::query(
        "SELECT username, display_icon, display_name FROM dashboard_users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| {
        (
            r.try_get::<String, _>("username")
                .unwrap_or_else(|_| String::new()),
            r.try_get::<Option<String>, _>("display_icon")
                .unwrap_or(None),
            r.try_get::<String, _>("display_name")
                .unwrap_or_else(|_| String::new()),
        )
    }))
}

pub async fn dashboard_user_get_by_username(
    pool: &PgPool,
    username: &str,
) -> Result<Option<(Uuid, String, String)>> {
    // Returns (id, password_hash, role)
    let row = sqlx::query(
        "SELECT id, password_hash, role FROM dashboard_users WHERE lower(username) = lower($1)",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        (
            r.try_get::<Uuid, _>("id").unwrap_or_default(),
            r.try_get::<String, _>("password_hash")
                .unwrap_or_else(|_| String::new()),
            r.try_get::<String, _>("role")
                .unwrap_or_else(|_| "viewer".to_string()),
        )
    }))
}

pub async fn dashboard_user_list(pool: &PgPool) -> Result<Vec<DashboardUserRow>> {
    let rows = sqlx::query(
        "SELECT id, username, display_name, role, display_icon, created_at FROM dashboard_users ORDER BY lower(username) ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| DashboardUserRow {
            id: r.try_get("id").unwrap_or_default(),
            username: r.try_get("username").unwrap_or_else(|_| String::new()),
            display_name: r.try_get("display_name").unwrap_or_else(|_| String::new()),
            role: r.try_get("role").unwrap_or_else(|_| "viewer".to_string()),
            display_icon: r
                .try_get::<Option<String>, _>("display_icon")
                .unwrap_or(None),
            created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

pub async fn dashboard_user_create(
    pool: &PgPool,
    username: &str,
    password_plain: &str,
    role: &str,
    display_name: &str,
) -> Result<Uuid> {
    let hash = hash_dashboard_password(password_plain)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO dashboard_users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(username)
    .bind(hash)
    .bind(role)
    .bind(display_name)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn dashboard_user_set_password(
    pool: &PgPool,
    user_id: Uuid,
    password_plain: &str,
) -> Result<()> {
    let hash = hash_dashboard_password(password_plain)?;
    sqlx::query("UPDATE dashboard_users SET password_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(hash)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_user_set_role(pool: &PgPool, user_id: Uuid, role: &str) -> Result<()> {
    sqlx::query("UPDATE dashboard_users SET role = $2 WHERE id = $1")
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_user_delete(pool: &PgPool, user_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM dashboard_users WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_session_create(
    pool: &PgPool,
    token_sha256_hex: &str,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
    client_ip: Option<&str>,
    csrf_token: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO dashboard_sessions (token_sha256_hex, user_id, expires_at, client_ip, csrf_token) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(token_sha256_hex)
    .bind(user_id)
    .bind(expires_at)
    .bind(client_ip)
    .bind(csrf_token)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn dashboard_session_delete(pool: &PgPool, token_sha256_hex: &str) -> Result<()> {
    sqlx::query("DELETE FROM dashboard_sessions WHERE token_sha256_hex = $1")
        .bind(token_sha256_hex)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_session_touch(pool: &PgPool, token_sha256_hex: &str) -> Result<()> {
    sqlx::query("UPDATE dashboard_sessions SET last_seen_at = NOW() WHERE token_sha256_hex = $1")
        .bind(token_sha256_hex)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn dashboard_session_get_user(
    pool: &PgPool,
    token_sha256_hex: &str,
) -> Result<Option<(Uuid, String, String, String, Option<String>, String)>> {
    // Returns (user_id, username, role, display_name, display_icon, csrf_token) when session exists and is not expired.
    let row = sqlx::query(
        r"
        SELECT u.id AS user_id, u.username, u.role, u.display_name, u.display_icon, s.csrf_token
        FROM dashboard_sessions s
        JOIN dashboard_users u ON u.id = s.user_id
        WHERE s.token_sha256_hex = $1
          AND s.expires_at > NOW()
        ",
    )
    .bind(token_sha256_hex)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        (
            r.try_get::<Uuid, _>("user_id").unwrap_or_default(),
            r.try_get::<String, _>("username")
                .unwrap_or_else(|_| String::new()),
            r.try_get::<String, _>("role")
                .unwrap_or_else(|_| "viewer".to_string()),
            r.try_get::<String, _>("display_name")
                .unwrap_or_else(|_| String::new()),
            r.try_get::<Option<String>, _>("display_icon")
                .unwrap_or(None),
            r.try_get::<String, _>("csrf_token")
                .unwrap_or_else(|_| String::new()),
        )
    }))
}

pub async fn dashboard_user_set_username(
    pool: &PgPool,
    user_id: Uuid,
    username: &str,
) -> Result<()> {
    let n = sqlx::query("UPDATE dashboard_users SET username = $2 WHERE id = $1")
        .bind(user_id)
        .bind(username)
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
    let n = sqlx::query("UPDATE dashboard_users SET display_icon = $2 WHERE id = $1")
        .bind(user_id)
        .bind(display_icon)
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
    let n = sqlx::query("UPDATE dashboard_users SET display_name = $2 WHERE id = $1")
        .bind(user_id)
        .bind(display_name)
        .execute(pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(anyhow::anyhow!("user not found"));
    }
    Ok(())
}

pub async fn bootstrap_default_admin(
    pool: &PgPool,
    username: &str,
    password_plain: &str,
) -> Result<()> {
    if dashboard_user_count(pool).await? > 0 {
        return Ok(());
    }
    // First boot: create the initial admin user.
    let _ = dashboard_user_create(pool, username, password_plain, "admin", "").await?;
    Ok(())
}

pub async fn dashboard_identity_get_user_id(
    pool: &PgPool,
    issuer: &str,
    subject: &str,
) -> Result<Option<Uuid>> {
    let v: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM dashboard_identities WHERE issuer = $1 AND subject = $2",
    )
    .bind(issuer)
    .bind(subject)
    .fetch_optional(pool)
    .await?
    .flatten();
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
    sqlx::query(
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
    )
    .bind(issuer)
    .bind(subject)
    .bind(user_id)
    .bind(preferred_username)
    .bind(email)
    .bind(name)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
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
    let rows = sqlx::query(
        r"
        SELECT id, issuer, subject, preferred_username, email, name, last_login_at, created_at
        FROM dashboard_identities
        WHERE user_id = $1
        ORDER BY last_login_at DESC
        ",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| DashboardIdentityRow {
            id: r.try_get("id").unwrap_or_default(),
            issuer: r.try_get("issuer").unwrap_or_else(|_| String::new()),
            subject: r.try_get("subject").unwrap_or_else(|_| String::new()),
            preferred_username: r.try_get("preferred_username").ok().flatten(),
            email: r.try_get("email").ok().flatten(),
            name: r.try_get("name").ok().flatten(),
            last_login_at: r.try_get("last_login_at").unwrap_or_else(|_| Utc::now()),
            created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

pub async fn dashboard_identity_unlink(pool: &PgPool, identity_id: i64) -> Result<()> {
    sqlx::query("DELETE FROM dashboard_identities WHERE id = $1")
        .bind(identity_id)
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
    sqlx::query(
        r"
        INSERT INTO dashboard_identities (issuer, subject, user_id, last_login_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (issuer, subject) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            last_login_at = NOW()
        ",
    )
    .bind(issuer)
    .bind(subject)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── Agents ───────────────────────────────────────────────────────────────────

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

fn pg_is_unique_violation(e: &sqlx::Error) -> bool {
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

#[allow(clippy::too_many_arguments)]
pub async fn create_agent_enrollment_claim(
    pool: &PgPool,
    pairing_code: Option<&str>,
    requested_name: &str,
    hostname: Option<&str>,
    os: Option<&str>,
    agent_version: Option<&str>,
    install_id: &str,
    discovered_server: Option<&str>,
    client_ip: Option<&str>,
) -> anyhow::Result<Result<EnrollmentClaimCreateOutcome, ClaimCreateReject>> {
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

// ─── Window events ────────────────────────────────────────────────────────────

pub async fn insert_window(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let title = v["title"].as_str().unwrap_or("");
    let app = v["app"].as_str().unwrap_or("");
    let app_display = v["app_display"].as_str().unwrap_or(app);
    let hwnd = v["hwnd"].as_i64().unwrap_or(0);
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query(
        "INSERT INTO window_events (agent_id, title, app, app_display, hwnd, ts, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(agent)
    .bind(title)
    .bind(app)
    .bind(app_display)
    .bind(hwnd)
    .bind(ts)
    .bind(user_name)
    .execute(pool)
    .await?;

    sqlx::query(
        r"
        INSERT INTO window_top_stats (agent_id, app, app_display, title, focus_count, last_ts)
        VALUES ($1, $2, $3, $4, 1, $5)
        ON CONFLICT (agent_id, app, title) DO UPDATE
        SET app_display = EXCLUDED.app_display,
            focus_count = window_top_stats.focus_count + 1,
            last_ts = GREATEST(window_top_stats.last_ts, EXCLUDED.last_ts)
        ",
    )
    .bind(agent)
    .bind(app)
    .bind(app_display)
    .bind(title)
    .bind(ts)
    .execute(pool)
    .await?;

    Ok(())
}

// ─── Key sessions ─────────────────────────────────────────────────────────────

/// Append text to an open session (same agent/app/window, updated ≤ 30 s ago).
/// Creates a new session row if no open one exists.
pub async fn upsert_keys(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let app = v["app"].as_str().unwrap_or("");
    let app_display = v["app_display"].as_str().unwrap_or(app);
    let window = v["window"].as_str().unwrap_or("");
    let text = v["text"].as_str().unwrap_or("");
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    let updated = sqlx::query(
        r"
        UPDATE key_sessions
        SET    text         = text || $1,
               app_display  = $2,
               user_name    = COALESCE($6, user_name),
               updated_at   = NOW()
        WHERE  agent_id     = $3
          AND  app          = $4
          AND  window_title = $5
          AND  updated_at   > NOW() - INTERVAL '30 seconds'
        ",
    )
    .bind(text)
    .bind(app_display)
    .bind(agent)
    .bind(app)
    .bind(window)
    .bind(user_name)
    .execute(pool)
    .await?;

    if updated.rows_affected() == 0 {
        sqlx::query(
            "INSERT INTO key_sessions (agent_id, app, app_display, window_title, text, started_at, updated_at, user_name) \
             VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)",
        )
        .bind(agent)
        .bind(app)
        .bind(app_display)
        .bind(window)
        .bind(text)
        .bind(ts)
        .bind(user_name)
        .execute(pool)
        .await?;
    }

    Ok(())
}

// ─── URL visits ───────────────────────────────────────────────────────────────

/// Insert a URL visit, skipping exact consecutive duplicates for this agent.
pub async fn insert_url(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
    let title = v["title"].as_str();
    let browser = v["browser"].as_str();
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    // Skip if same URL as the most-recent visit for this agent.
    let last: Option<String> = sqlx::query_scalar(
        "SELECT url FROM url_visits WHERE agent_id = $1 ORDER BY ts DESC LIMIT 1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await?;

    if last.as_deref() == Some(url) {
        return Ok(());
    }

    let visit_id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO url_visits (agent_id, url, title, browser, ts, user_name)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(title)
    .bind(browser)
    .bind(ts)
    .bind(user_name)
    .fetch_one(pool)
    .await?;

    sqlx::query(
        r"
        INSERT INTO url_top_stats (agent_id, url, visit_count, last_ts)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (agent_id, url) DO UPDATE
        SET visit_count = url_top_stats.visit_count + 1,
            last_ts = GREATEST(url_top_stats.last_ts, EXCLUDED.last_ts)
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(ts)
    .execute(pool)
    .await?;

    // Enqueue for categorization only when the feature is enabled.
    // This avoids unbounded queue growth when categorization is turned off.
    sqlx::query(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT $1, $2, $3, $4, ''
        WHERE (SELECT enabled FROM url_categorization_settings WHERE id = 1) = true
        ON CONFLICT (url_visit_id) DO NOTHING
        ",
    )
    .bind(visit_id)
    .bind(agent)
    .bind(ts)
    .bind(url)
    .execute(pool)
    .await
    .ok();

    Ok(())
}

// ─── URL sessions (time-on-site) ─────────────────────────────────────────────

pub async fn insert_url_session(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let url = v["url"].as_str().unwrap_or("");
    if !url_categorization::looks_like_complete_navigation_url(url) {
        return Ok(());
    }
    let title = v["title"].as_str();
    let browser = v["browser"].as_str();
    let start_ts = unix_to_dt(v["started_at_ts"].as_i64());
    let end_ts = unix_to_dt(v["ended_at_ts"].as_i64());
    let duration_ms: i64 = v["duration_ms"]
        .as_i64()
        .or_else(|| {
            v["duration_ms"]
                .as_u64()
                .and_then(|u| i64::try_from(u).ok())
        })
        .unwrap_or(0)
        .max(0);
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    let hostname = url_categorization::extract_hostname_from_url(url);
    let cat = url_categorization::categorize_url_now(pool, &hostname, url).await?;
    let category_id: Option<i64> = cat.as_ref().map(|(id, _)| *id);

    sqlx::query(
        r"
        INSERT INTO url_sessions (agent_id, url, hostname, title, browser, ts_start, ts_end, duration_ms, category_id, user_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ",
    )
    .bind(agent)
    .bind(url)
    .bind(&hostname)
    .bind(title)
    .bind(browser)
    .bind(start_ts)
    .bind(end_ts)
    .bind(duration_ms)
    .bind(category_id)
    .bind(user_name)
    .execute(pool)
    .await?;

    // Aggregate per-site.
    if !hostname.is_empty() {
        sqlx::query(
            r"
            INSERT INTO url_site_stats (agent_id, hostname, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, hostname) DO UPDATE
            SET time_ms = url_site_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_site_stats.visit_count + 1,
                last_ts = GREATEST(url_site_stats.last_ts, EXCLUDED.last_ts)
            ",
        )
        .bind(agent)
        .bind(&hostname)
        .bind(duration_ms)
        .bind(end_ts)
        .execute(pool)
        .await?;
    }

    // Aggregate per-category.
    if let Some(cid) = category_id {
        sqlx::query(
            r"
            INSERT INTO url_category_time_stats (agent_id, category_id, time_ms, visit_count, last_ts)
            VALUES ($1, $2, $3, 1, $4)
            ON CONFLICT (agent_id, category_id) DO UPDATE
            SET time_ms = url_category_time_stats.time_ms + EXCLUDED.time_ms,
                visit_count = url_category_time_stats.visit_count + 1,
                last_ts = GREATEST(url_category_time_stats.last_ts, EXCLUDED.last_ts)
            ",
        )
        .bind(agent)
        .bind(cid)
        .bind(duration_ms)
        .bind(end_ts)
        .execute(pool)
        .await?;
    }

    Ok(())
}

// ─── Activity log ─────────────────────────────────────────────────────────────

pub async fn insert_activity(pool: &PgPool, agent: Uuid, v: &serde_json::Value) -> Result<()> {
    let kind = v["type"].as_str().unwrap_or("");
    let idle_secs = v["idle_secs"].as_i64();
    let ts = unix_to_dt(v["ts"].as_i64());
    let user_name = v["user"].as_str().map(str::trim).filter(|s| !s.is_empty());

    sqlx::query(
        "INSERT INTO activity_log (agent_id, event_type, idle_secs, ts, user_name) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(agent)
    .bind(kind)
    .bind(idle_secs)
    .bind(ts)
    .bind(user_name)
    .execute(pool)
    .await?;

    Ok(())
}

// ─── App icons (per exe) ─────────────────────────────────────────────────────

pub async fn upsert_app_icon(
    pool: &PgPool,
    agent: Uuid,
    exe_name: &str,
    png_bytes: &[u8],
) -> Result<()> {
    // Keep exe_name small-ish; the WS layer also validates, but DB functions should be safe too.
    let exe = exe_name.trim().to_lowercase();
    if exe.is_empty() {
        return Ok(());
    }

    sqlx::query(
        r"
        INSERT INTO app_icons (agent_id, exe_name, png_bytes, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_id, exe_name) DO UPDATE
        SET png_bytes = EXCLUDED.png_bytes,
            updated_at = NOW()
        ",
    )
    .bind(agent)
    .bind(&exe)
    .bind(png_bytes)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_app_icon_png(
    pool: &PgPool,
    agent: Uuid,
    exe_name: &str,
) -> Result<Option<Vec<u8>>> {
    let exe = exe_name.trim().to_lowercase();
    if exe.is_empty() {
        return Ok(None);
    }
    let v: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT png_bytes FROM app_icons WHERE agent_id=$1 AND exe_name=$2")
            .bind(agent)
            .bind(&exe)
            .fetch_optional(pool)
            .await?
            .flatten();
    Ok(v)
}

// ─── List / query helpers (used by API) ───────────────────────────────────────

pub async fn list_agents(pool: &PgPool) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT id, name, first_seen, last_seen, icon FROM agents ORDER BY last_seen DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let id: Uuid = r.try_get("id").unwrap_or_default();
            let name: String = r.try_get("name").unwrap_or_default();
            let first: DateTime<Utc> = r.try_get("first_seen").unwrap_or_else(|_| Utc::now());
            let last: DateTime<Utc> = r.try_get("last_seen").unwrap_or_else(|_| Utc::now());
            let icon: Option<String> = r.try_get("icon").ok();
            serde_json::json!({ "id": id, "name": name, "first_seen": first, "last_seen": last, "icon": icon })
        })
        .collect())
}

/// Set (or clear) an agent icon label.
pub async fn set_agent_icon(pool: &PgPool, agent_id: Uuid, icon: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE agents SET icon = $2 WHERE id = $1")
        .bind(agent_id)
        .bind(icon)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_agent_icon(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar("SELECT icon FROM agents WHERE id = $1")
        .bind(agent_id)
        .fetch_optional(pool)
        .await?
        .flatten();
    Ok(v)
}

pub async fn insert_audit_log(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO audit_log (actor, agent_id, action, status, detail, client_ip) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(actor)
    .bind(agent_id)
    .bind(action)
    .bind(status)
    .bind(detail)
    .bind(client_ip)
    .execute(pool)
    .await?;

    emit_audit_tracing_line(actor, action, status, client_ip);

    Ok(())
}

/// Insert an audit row unless an identical recent row already exists.
///
/// "Identical" means same actor/agent/action/status/detail JSON and within
/// `dedup_window_secs` from now.
pub async fn insert_audit_log_dedup(pool: &PgPool, row: AuditLogDedup<'_>) -> Result<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        r"
        SELECT id
        FROM audit_log
        WHERE actor = $1
          AND (($2::uuid IS NULL AND agent_id IS NULL) OR agent_id = $2)
          AND action = $3
          AND status = $4
          AND detail = $5::jsonb
          AND (client_ip IS NOT DISTINCT FROM $7::text)
          AND ts > NOW() - ($6::bigint * INTERVAL '1 second')
        ORDER BY ts DESC
        LIMIT 1
        ",
    )
    .bind(row.actor)
    .bind(row.agent_id)
    .bind(row.action)
    .bind(row.status)
    .bind(row.detail)
    .bind(row.dedup_window_secs)
    .bind(row.client_ip)
    .fetch_optional(pool)
    .await?;

    if exists.is_none() {
        insert_audit_log(
            pool,
            row.actor,
            row.agent_id,
            row.action,
            row.status,
            row.detail,
            row.client_ip,
        )
        .await?;
    }

    Ok(())
}

/// Like [`insert_audit_log`], but emits a warning when the insert fails (HTTP handlers may still return 200).
pub async fn insert_audit_log_traced(
    pool: &PgPool,
    actor: &str,
    agent_id: Option<Uuid>,
    action: &str,
    status: &str,
    detail: &serde_json::Value,
    client_ip: Option<&str>,
) {
    if let Err(e) = insert_audit_log(pool, actor, agent_id, action, status, detail, client_ip).await
    {
        tracing::warn!(error = %e, action, "audit log insert failed");
    }
}

/// Like [`insert_audit_log_dedup`], but warns on failure.
pub async fn insert_audit_log_dedup_traced(pool: &PgPool, row: AuditLogDedup<'_>) {
    if let Err(e) = insert_audit_log_dedup(pool, row).await {
        tracing::warn!(error = %e, action = row.action, "audit log dedup insert failed");
    }
}

pub async fn query_audit_log(
    pool: &PgPool,
    agent_id: Option<Uuid>,
    action: Option<&str>,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<AuditRecord>> {
    let rows = sqlx::query(
        r"
        SELECT id, ts, actor, client_ip, agent_id, action, status, detail
        FROM audit_log
        WHERE ($1::uuid IS NULL OR agent_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY ts DESC
        LIMIT $4 OFFSET $5
        ",
    )
    .bind(agent_id)
    .bind(action)
    .bind(status)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| AuditRecord {
            id: r.try_get("id").unwrap_or_default(),
            ts: r.try_get("ts").unwrap_or_else(|_| Utc::now()),
            actor: r
                .try_get("actor")
                .unwrap_or_else(|_| "dashboard".to_string()),
            client_ip: r.try_get("client_ip").ok(),
            agent_id: r.try_get("agent_id").ok(),
            action: r.try_get("action").unwrap_or_default(),
            status: r.try_get("status").unwrap_or_else(|_| "ok".to_string()),
            detail: r
                .try_get("detail")
                .unwrap_or_else(|_| serde_json::json!({})),
        })
        .collect())
}

pub async fn query_top_urls(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<UrlTopRow>> {
    let rows = sqlx::query(
        r"
        SELECT url, visit_count, last_ts
        FROM url_top_stats
        WHERE agent_id = $1
        ORDER BY visit_count DESC, last_ts DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| UrlTopRow {
            url: r.try_get("url").unwrap_or_default(),
            visit_count: r.try_get("visit_count").unwrap_or_default(),
            last_ts: r.try_get("last_ts").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

pub async fn query_top_windows(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<WindowTopRow>> {
    let rows = sqlx::query(
        r"
        SELECT app, app_display, title, focus_count, last_ts
        FROM window_top_stats
        WHERE agent_id = $1
        ORDER BY focus_count DESC, last_ts DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| WindowTopRow {
            app: r.try_get("app").unwrap_or_default(),
            app_display: r.try_get("app_display").unwrap_or_default(),
            title: r.try_get("title").unwrap_or_default(),
            focus_count: r.try_get("focus_count").unwrap_or_default(),
            last_ts: r.try_get("last_ts").unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

/// Disk usage for the connected database (`pg_database_size`) plus a per-relation breakdown
/// for the `public` schema. Partition children are omitted — their storage is counted on the
/// parent (`pg_total_relation_size` on a partitioned table includes all partitions).
pub async fn query_database_storage(pool: &PgPool) -> Result<serde_json::Value> {
    let db_size_bytes: i64 =
        sqlx::query_scalar("SELECT pg_database_size(current_database())::bigint")
            .fetch_one(pool)
            .await?;

    let table_rows = sqlx::query(
        r"
        SELECT
            c.relname::text AS name,
            pg_total_relation_size(c.oid)::bigint AS bytes
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'm')
          AND NOT c.relispartition
        ORDER BY bytes DESC
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut public_tables_bytes: i64 = 0;
    let tables = table_rows
        .iter()
        .map(|r| {
            let name = r.try_get::<String, _>("name").unwrap_or_default();
            let bytes = r.try_get::<i64, _>("bytes").unwrap_or_default();
            public_tables_bytes += bytes;
            serde_json::json!({ "name": name, "bytes": bytes })
        })
        .collect::<Vec<_>>();

    let other_bytes = (db_size_bytes - public_tables_bytes).max(0);

    Ok(serde_json::json!({
        "database_bytes": db_size_bytes,
        "public_tables_bytes": public_tables_bytes,
        "other_bytes": other_bytes,
        "tables": tables
    }))
}

pub async fn query_windows(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT title, app, app_display, hwnd, ts, user_name \
         FROM window_events WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let title: String = r.try_get("title").unwrap_or_default();
            let app: String = r.try_get("app").unwrap_or_default();
            let app_display: String = r.try_get("app_display").unwrap_or_default();
            let hwnd: i64 = r.try_get("hwnd").unwrap_or_default();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({ "title": title, "app": app, "app_display": app_display, "hwnd": hwnd, "ts": ts, "user": user_name })
        })
        .collect())
}

pub async fn query_keys(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT app, app_display, window_title, text, started_at, updated_at, user_name \
         FROM key_sessions WHERE agent_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let app: String = r.try_get("app").unwrap_or_default();
            let app_display: String = r.try_get("app_display").unwrap_or_default();
            let window: String = r.try_get("window_title").unwrap_or_default();
            let text: String = r.try_get("text").unwrap_or_default();
            let started_at: DateTime<Utc> = r.try_get("started_at").unwrap_or_else(|_| Utc::now());
            let updated_at: DateTime<Utc> = r.try_get("updated_at").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({
                "app": app, "app_display": app_display,
                "window_title": window, "text": text,
                "started_at": started_at, "updated_at": updated_at,
                "user": user_name
            })
        })
        .collect())
}

pub async fn query_urls(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        r"
        SELECT v.id, v.url, v.title, v.browser, v.ts, v.user_name,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        LEFT JOIN url_categories c ON c.id = vc.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE v.agent_id = $1
        ORDER BY v.ts DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let id: i64 = r.try_get("id").unwrap_or_default();
            let url: String = r.try_get("url").unwrap_or_default();
            let title: Option<String> = r.try_get("title").ok().flatten();
            let browser: Option<String> = r.try_get("browser").ok().flatten();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            let category: Option<String> = r.try_get("category").ok().flatten();
            let category_key: Option<String> = r.try_get("category_key").ok().flatten();
            serde_json::json!({ "id": id, "url": url, "title": title, "browser": browser, "ts": ts, "user": user_name, "category_key": category_key, "category": category })
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct UrlCategoryStatRow {
    pub category: String,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_url_category_stats(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
) -> Result<Vec<UrlCategoryStatRow>> {
    let rows = sqlx::query(
        r"
        SELECT COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category,
               SUM(s.visit_count)::bigint AS visit_count,
               MAX(s.last_ts) AS last_ts
        FROM url_category_stats s
        JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
        GROUP BY category
        ORDER BY visit_count DESC, last_ts DESC
        LIMIT $2
        ",
    )
    .bind(agent)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| UrlCategoryStatRow {
            category: r.try_get::<String, _>("category").unwrap_or_default(),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

// ─── Analytics queries (URL sessions) ────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlCategoryTimeRow {
    pub category_key: String,
    pub category_label: String,
    pub time_ms: i64,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_agent_url_categories_time(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AgentUrlCategoryTimeRow>> {
    let rows = sqlx::query(
        r"
        SELECT COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label,
               SUM(s.duration_ms)::bigint AS time_ms,
               COUNT(*)::bigint AS visit_count,
               MAX(s.ts_end) AS last_ts
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
        GROUP BY category_key, category_label
        ORDER BY time_ms DESC NULLS LAST
        LIMIT $4
        ",
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlCategoryTimeRow {
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None)
                .unwrap_or_else(|| "uncategorized".into()),
            category_label: r
                .try_get::<String, _>("category_label")
                .unwrap_or_else(|_| "uncategorized".into()),
            time_ms: r.try_get::<i64, _>("time_ms").unwrap_or(0),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlSiteTimeRow {
    pub hostname: String,
    pub category_key: Option<String>,
    pub category_label: Option<String>,
    pub time_ms: i64,
    pub visit_count: i64,
    pub last_ts: DateTime<Utc>,
}

pub async fn query_agent_url_sites_time(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    custom_category_key: Option<&str>,
    category_key: Option<&str>,
    limit: i64,
) -> Result<Vec<AgentUrlSiteTimeRow>> {
    let rows = sqlx::query(
        r"
        SELECT s.hostname,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label,
               SUM(s.duration_ms)::bigint AS time_ms,
               COUNT(*)::bigint AS visit_count,
               MAX(s.ts_end) AS last_ts
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
          AND ($4::text IS NULL OR COALESCE(cc.key, c.key, 'uncategorized') = $4::text)
          AND ($5::text IS NULL OR c.key = $5::text)
        GROUP BY s.hostname, category_key, category_label
        ORDER BY time_ms DESC NULLS LAST
        LIMIT $6
        ",
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(custom_category_key)
    .bind(category_key)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSiteTimeRow {
            hostname: r.try_get::<String, _>("hostname").unwrap_or_default(),
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None),
            category_label: r
                .try_get::<Option<String>, _>("category_label")
                .unwrap_or(None),
            time_ms: r.try_get::<i64, _>("time_ms").unwrap_or(0),
            visit_count: r.try_get::<i64, _>("visit_count").unwrap_or(0),
            last_ts: r
                .try_get::<DateTime<Utc>, _>("last_ts")
                .unwrap_or_else(|_| Utc::now()),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentUrlSessionRow {
    pub id: i64,
    pub url: String,
    pub hostname: String,
    pub ts_start: DateTime<Utc>,
    pub ts_end: DateTime<Utc>,
    pub duration_ms: i64,
    pub user: Option<String>,
    pub category_key: Option<String>,
    pub category_label: Option<String>,
    pub browser: Option<String>,
    pub title: Option<String>,
}

pub async fn query_agent_url_sessions(
    pool: &PgPool,
    agent: Uuid,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<AgentUrlSessionRow>> {
    let rows = sqlx::query(
        r"
        SELECT s.id, s.url, s.hostname, s.ts_start, s.ts_end, s.duration_ms, s.browser, s.title, s.user_name,
               COALESCE(cc.key, c.key, 'uncategorized') AS category_key,
               COALESCE(cc.label_en, COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))), 'Uncategorized') AS category_label
        FROM url_sessions s
        LEFT JOIN url_categories c ON c.id = s.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        LEFT JOIN url_custom_category_members m ON m.ut1_key = c.key
        LEFT JOIN url_custom_categories cc ON cc.id = m.custom_category_id AND cc.hidden = false
        WHERE s.agent_id = $1
          AND s.ts_start >= $2
          AND s.ts_end <= $3
        ORDER BY s.ts_start DESC
        LIMIT $4
        ",
    )
    .bind(agent)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentUrlSessionRow {
            id: r.try_get::<i64, _>("id").unwrap_or_default(),
            url: r.try_get::<String, _>("url").unwrap_or_default(),
            hostname: r.try_get::<String, _>("hostname").unwrap_or_default(),
            ts_start: r
                .try_get::<DateTime<Utc>, _>("ts_start")
                .unwrap_or_else(|_| Utc::now()),
            ts_end: r
                .try_get::<DateTime<Utc>, _>("ts_end")
                .unwrap_or_else(|_| Utc::now()),
            duration_ms: r.try_get::<i64, _>("duration_ms").unwrap_or(0),
            user: r.try_get::<Option<String>, _>("user_name").unwrap_or(None),
            category_key: r
                .try_get::<Option<String>, _>("category_key")
                .unwrap_or(None),
            category_label: r
                .try_get::<Option<String>, _>("category_label")
                .unwrap_or(None),
            browser: r.try_get::<Option<String>, _>("browser").unwrap_or(None),
            title: r.try_get::<Option<String>, _>("title").unwrap_or(None),
        })
        .collect())
}

/// Enqueue existing URL visits that have not been categorized yet (best-effort backfill).
/// Returns number of rows enqueued.
pub async fn enqueue_url_categorization_backfill(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
) -> Result<i64> {
    // Only enqueue when categorization is enabled to avoid unbounded queue growth.
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }

    let rows = sqlx::query(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT v.id, v.agent_id, v.ts, v.url, ''
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        WHERE v.agent_id = $1
          AND vc.url_visit_id IS NULL
        ORDER BY v.ts ASC
        LIMIT $2
        ON CONFLICT (url_visit_id) DO NOTHING
        RETURNING url_visit_id
        ",
    )
    .bind(agent)
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;

    Ok(rows.len() as i64)
}

pub async fn enqueue_url_categorization_backfill_all(pool: &PgPool, limit: i64) -> Result<i64> {
    let enabled: bool =
        sqlx::query_scalar("SELECT enabled FROM url_categorization_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }
    let rows = sqlx::query(
        r"
        INSERT INTO url_categorization_queue (url_visit_id, agent_id, ts, url, hostname)
        SELECT v.id, v.agent_id, v.ts, v.url, ''
        FROM url_visits v
        LEFT JOIN url_visit_category vc ON vc.url_visit_id = v.id
        WHERE vc.url_visit_id IS NULL
        ORDER BY v.ts ASC
        LIMIT $1
        ON CONFLICT (url_visit_id) DO NOTHING
        RETURNING url_visit_id
        ",
    )
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    Ok(rows.len() as i64)
}

pub async fn recalc_url_sessions_categories(pool: &PgPool, limit: i64) -> Result<i64> {
    // Load latest sessions and recompute category; update rows + aggregates best-effort.
    let rows = sqlx::query(
        r"
        SELECT id, agent_id, url, hostname, ts_end, duration_ms
        FROM url_sessions
        ORDER BY ts_end DESC
        LIMIT $1
        ",
    )
    .bind(limit.max(0))
    .fetch_all(pool)
    .await?;
    let mut updated: i64 = 0;
    for r in rows {
        let id: i64 = r.try_get("id")?;
        let url: String = r.try_get("url").unwrap_or_default();
        let hostname: String = r.try_get("hostname").unwrap_or_default();
        let cat = url_categorization::categorize_url_now(pool, &hostname, &url).await?;
        let category_id: Option<i64> = cat.as_ref().map(|(cid, _)| *cid);
        let res = sqlx::query("UPDATE url_sessions SET category_id = $1 WHERE id = $2")
            .bind(category_id)
            .bind(id)
            .execute(pool)
            .await?;
        if res.rows_affected() > 0 {
            updated += 1;
        }
    }
    Ok(updated)
}

pub async fn query_activity(
    pool: &PgPool,
    agent: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT event_type, idle_secs, ts, user_name \
         FROM activity_log WHERE agent_id=$1 ORDER BY ts DESC LIMIT $2 OFFSET $3",
    )
    .bind(agent)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|r| {
            let event_type: String = r.try_get("event_type").unwrap_or_default();
            let idle_secs: Option<i64> = r.try_get("idle_secs").ok().flatten();
            let ts: DateTime<Utc> = r.try_get("ts").unwrap_or_else(|_| Utc::now());
            let user_name: Option<String> = r.try_get("user_name").ok().flatten();
            serde_json::json!({ "event_type": event_type, "idle_secs": idle_secs, "ts": ts, "user": user_name })
        })
        .collect())
}

/// Clear all telemetry history for an agent while keeping the `agents` row.
///
/// This is used by the dashboard "clear history" UX so operators can
/// selectively wipe what they previously recorded for a single client.
pub async fn clear_agent_history(pool: &PgPool, agent: Uuid) -> Result<u64> {
    // Note: we intentionally do NOT delete from `agents` (the sidebar needs it).
    // Deleting telemetry rows keeps foreign keys simple (each table already
    // references `agents(id)` with ON DELETE CASCADE).
    let win = sqlx::query("DELETE FROM window_events WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?
        .rows_affected();

    let keys = sqlx::query("DELETE FROM key_sessions WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?
        .rows_affected();

    let urls = sqlx::query("DELETE FROM url_visits WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?
        .rows_affected();

    let activity = sqlx::query("DELETE FROM activity_log WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?
        .rows_affected();

    // Also clear websocket connection history so "last seen" becomes empty.
    // If you prefer to keep last-seen timestamps, remove this query.
    let sessions = sqlx::query("DELETE FROM agent_sessions WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?
        .rows_affected();

    Ok(win
        .saturating_add(keys)
        .saturating_add(urls)
        .saturating_add(activity)
        .saturating_add(sessions))
}

// ─── Retention settings & pruning ─────────────────────────────────────────────

pub async fn get_retention_global(pool: &PgPool) -> Result<RetentionPolicy> {
    let row =
        sqlx::query("SELECT keylog_days, window_days, url_days FROM retention_global WHERE id = 1")
            .fetch_one(pool)
            .await?;

    Ok(RetentionPolicy {
        keylog_days: row.try_get::<Option<i32>, _>("keylog_days").unwrap_or(None),
        window_days: row.try_get::<Option<i32>, _>("window_days").unwrap_or(None),
        url_days: row.try_get::<Option<i32>, _>("url_days").unwrap_or(None),
    })
}

pub async fn set_retention_global(pool: &PgPool, p: &RetentionPolicy) -> Result<()> {
    sqlx::query(
        "UPDATE retention_global SET keylog_days = $1, window_days = $2, url_days = $3 WHERE id = 1",
    )
    .bind(p.keylog_days)
    .bind(p.window_days)
    .bind(p.url_days)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_retention_agent(
    pool: &PgPool,
    agent: Uuid,
) -> Result<Option<RetentionAgentOverride>> {
    let row = sqlx::query(
        "SELECT keylog_days, window_days, url_days FROM retention_agent WHERE agent_id = $1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RetentionAgentOverride {
        keylog_days: r.try_get::<Option<i32>, _>("keylog_days").unwrap_or(None),
        window_days: r.try_get::<Option<i32>, _>("window_days").unwrap_or(None),
        url_days: r.try_get::<Option<i32>, _>("url_days").unwrap_or(None),
    }))
}

pub async fn set_retention_agent(
    pool: &PgPool,
    agent: Uuid,
    p: &RetentionAgentOverride,
) -> Result<()> {
    let all_inherit = p.keylog_days.is_none() && p.window_days.is_none() && p.url_days.is_none();
    if all_inherit {
        sqlx::query("DELETE FROM retention_agent WHERE agent_id = $1")
            .bind(agent)
            .execute(pool)
            .await?;
        return Ok(());
    }

    sqlx::query(
        r"
        INSERT INTO retention_agent (agent_id, keylog_days, window_days, url_days)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agent_id) DO UPDATE SET
            keylog_days = EXCLUDED.keylog_days,
            window_days = EXCLUDED.window_days,
            url_days = EXCLUDED.url_days
        ",
    )
    .bind(agent)
    .bind(p.keylog_days)
    .bind(p.window_days)
    .bind(p.url_days)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_retention_agent(pool: &PgPool, agent: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM retention_agent WHERE agent_id = $1")
        .bind(agent)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete telemetry older than the effective retention for each agent.
/// Activity (AFK) rows use the same cutoff as window history.
pub async fn prune_telemetry_by_retention(pool: &PgPool) -> Result<()> {
    let global = get_retention_global(pool).await?;

    let agent_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM agents")
        .fetch_all(pool)
        .await?;

    for aid in agent_ids {
        let ov = get_retention_agent(pool, aid)
            .await?
            .unwrap_or(RetentionAgentOverride {
                keylog_days: None,
                window_days: None,
                url_days: None,
            });

        let key_d = ov.keylog_days.or(global.keylog_days);
        let win_d = ov.window_days.or(global.window_days);
        let url_d = ov.url_days.or(global.url_days);

        if let Some(days) = key_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM key_sessions WHERE agent_id = $1 AND updated_at < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = win_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM window_events WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;

                sqlx::query(
                    "DELETE FROM activity_log WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }

        if let Some(days) = url_d {
            if days > 0 {
                sqlx::query(
                    "DELETE FROM url_visits WHERE agent_id = $1 AND ts < NOW() - ($2::bigint * INTERVAL '1 day')",
                )
                .bind(aid)
                .bind(i64::from(days))
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(())
}

/// Delete alert-rule events older than `days` (screenshots cascade via FK).
pub async fn prune_alert_events_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query(
        "DELETE FROM alert_rule_events WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Delete stale software inventory rows (by `captured_at`).
pub async fn prune_agent_software_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query(
        "DELETE FROM agent_software WHERE captured_at < NOW() - ($1::bigint * INTERVAL '1 day')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Optional extra pruning (alert history + old software rows). Telemetry uses [`prune_telemetry_by_retention`].
pub async fn prune_auxiliary_retention(
    pool: &PgPool,
    alert_event_days: Option<i64>,
    software_inventory_days: Option<i64>,
) -> Result<()> {
    if let Some(d) = alert_event_days {
        let n = prune_alert_events_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old alert_rule_events by retention");
        }
    }
    if let Some(d) = software_inventory_days {
        let n = prune_agent_software_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_software rows by retention");
        }
    }
    Ok(())
}

// ─── Agent local UI password (Argon2 PHC string) ───

/// Sentinel value meaning “no local UI password” when pushed to the agent.
pub const fn empty_agent_ui_password_hash() -> String {
    String::new()
}

/// Argon2 hash for a new agent local UI password (pushed to agents as a PHC string).
pub fn hash_agent_local_ui_password(plain: &str) -> Result<String> {
    hash_dashboard_password(plain)
}

/// `true` if this hash means the user must type a non-empty password to open settings.
pub fn agent_ui_password_is_set(hash: Option<&str>) -> bool {
    matches!(hash, Some(h) if !h.is_empty() && h.starts_with("$argon2"))
}

pub async fn get_local_ui_global_hash(pool: &PgPool) -> Result<Option<String>> {
    let v: Option<String> =
        sqlx::query_scalar("SELECT password_hash_sha256 FROM agent_local_ui_password WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(v)
}

pub async fn set_local_ui_global_hash(pool: &PgPool, hash: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE agent_local_ui_password SET password_hash_sha256 = $1 WHERE id = 1")
        .bind(hash)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_local_ui_override_hash(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<Option<String>> = sqlx::query_scalar(
        "SELECT password_hash_sha256 FROM agent_local_ui_password_override WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;

    Ok(v.flatten())
}

pub async fn set_local_ui_override_hash(
    pool: &PgPool,
    agent_id: Uuid,
    hash: Option<&str>,
) -> Result<()> {
    match hash {
        None => {
            sqlx::query("DELETE FROM agent_local_ui_password_override WHERE agent_id = $1")
                .bind(agent_id)
                .execute(pool)
                .await?;
        }
        Some(h) => {
            sqlx::query(
                r"
                INSERT INTO agent_local_ui_password_override (agent_id, password_hash_sha256)
                VALUES ($1, $2)
                ON CONFLICT (agent_id) DO UPDATE SET
                    password_hash_sha256 = EXCLUDED.password_hash_sha256
                ",
            )
            .bind(agent_id)
            .bind(h)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

pub async fn clear_local_ui_override(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM agent_local_ui_password_override WHERE agent_id = $1")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Effective hash pushed to the agent (override wins when set).
pub async fn effective_agent_ui_password_hash(pool: &PgPool, agent_id: Uuid) -> Result<String> {
    let global: Option<String> =
        sqlx::query_scalar("SELECT password_hash_sha256 FROM agent_local_ui_password WHERE id = 1")
            .fetch_one(pool)
            .await?;

    let global_hex = match global {
        Some(h) if !h.is_empty() => h,
        _ => empty_agent_ui_password_hash(),
    };

    let ov = get_local_ui_override_hash(pool, agent_id).await?;
    if let Some(h) = ov {
        if !h.is_empty() {
            return Ok(h);
        }
    }
    Ok(global_hex)
}

// ─── Agent auto-update (Tauri updater) ─────────────────────────────────────────

pub async fn get_agent_auto_update_global(pool: &PgPool) -> Result<bool> {
    let v: bool = sqlx::query_scalar("SELECT enabled FROM agent_auto_update WHERE id = 1")
        .fetch_one(pool)
        .await?;
    Ok(v)
}

pub async fn set_agent_auto_update_global(pool: &PgPool, enabled: bool) -> Result<()> {
    sqlx::query("UPDATE agent_auto_update SET enabled = $1 WHERE id = 1")
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_agent_auto_update_override(pool: &PgPool, agent_id: Uuid) -> Result<Option<bool>> {
    let v: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM agent_auto_update_override WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    Ok(v)
}

pub async fn set_agent_auto_update_override(
    pool: &PgPool,
    agent_id: Uuid,
    enabled: bool,
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO agent_auto_update_override (agent_id, enabled)
        VALUES ($1, $2)
        ON CONFLICT (agent_id) DO UPDATE SET
            enabled = EXCLUDED.enabled
        ",
    )
    .bind(agent_id)
    .bind(enabled)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_agent_auto_update_override(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM agent_auto_update_override WHERE agent_id = $1")
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn effective_agent_auto_update_enabled(pool: &PgPool, agent_id: Uuid) -> Result<bool> {
    let global = get_agent_auto_update_global(pool).await?;
    let ov = get_agent_auto_update_override(pool, agent_id).await?;
    Ok(ov.unwrap_or(global))
}

// ─── Agent internet block (parental controls) ─────────────────────────────────

/// Whether any enabled `internet_block_rule` applies to this agent (all/group/agent scope).
pub async fn get_agent_internet_blocked(pool: &PgPool, agent_id: Uuid) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        r"
        SELECT COUNT(*)
        FROM internet_block_rules r
        WHERE r.enabled
          -- Only always-on rules (no schedules) affect the boolean `set_network_policy` push.
          -- Scheduled rules are evaluated on-agent using local time.
          AND NOT EXISTS (SELECT 1 FROM internet_block_rule_schedules sch WHERE sch.rule_id = r.id)
          AND EXISTS (
            SELECT 1 FROM internet_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
              )
          )
        ",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

/// Effective scope kind for display: 'all' > 'group' > 'agent' > null.
pub async fn get_agent_internet_block_source(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<String>> {
    let row: Option<String> = sqlx::query_scalar(
        r"
        SELECT scope_kind FROM internet_block_rule_scopes s
        JOIN internet_block_rules r ON r.id = s.rule_id
        WHERE r.enabled
          AND NOT EXISTS (SELECT 1 FROM internet_block_rule_schedules sch WHERE sch.rule_id = r.id)
          AND (
            s.scope_kind = 'all'
            OR (s.scope_kind = 'agent' AND s.agent_id = $1)
            OR (s.scope_kind = 'group'
                AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
          )
        ORDER BY CASE s.scope_kind WHEN 'all' THEN 1 WHEN 'group' THEN 2 ELSE 3 END
        LIMIT 1
        ",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?
    .flatten();
    Ok(row)
}

// ─── Internet block rules ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RuleScheduleJson {
    pub day_of_week: i32,
    pub start_minute: i32,
    pub end_minute: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockScopeJson {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockRuleRow {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub scopes: Vec<InternetBlockScopeJson>,
    pub schedules: Vec<RuleScheduleJson>,
}

pub async fn internet_block_rules_list_all(pool: &PgPool) -> Result<Vec<InternetBlockRuleRow>> {
    let rules =
        sqlx::query("SELECT id, name, enabled, created_at FROM internet_block_rules ORDER BY id")
            .fetch_all(pool)
            .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in &rules {
        let id: i64 = r.try_get("id")?;
        let scope_rows = sqlx::query(
            "SELECT scope_kind, group_id, agent_id FROM internet_block_rule_scopes WHERE rule_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        let scopes = scope_rows
            .iter()
            .map(|s| {
                Ok(InternetBlockScopeJson {
                    kind: s.try_get("scope_kind")?,
                    group_id: s.try_get::<Option<Uuid>, _>("group_id")?,
                    agent_id: s.try_get::<Option<Uuid>, _>("agent_id")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM internet_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        out.push(InternetBlockRuleRow {
            id,
            name: r.try_get("name")?,
            enabled: r.try_get("enabled")?,
            created_at: r.try_get("created_at")?,
            scopes,
            schedules,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct InternetBlockRuleEffectiveRow {
    pub id: i64,
    pub name: String,
    pub schedules: Vec<RuleScheduleJson>,
}

/// Effective internet block rules for a specific agent (enabled only).
/// Note: schedules may be empty (meaning "always active").
pub async fn internet_block_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<InternetBlockRuleEffectiveRow>> {
    let rules = sqlx::query(
        r"
        SELECT r.id, r.name
        FROM internet_block_rules r
        WHERE r.enabled
          AND EXISTS (
            SELECT 1 FROM internet_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (SELECT group_id FROM agent_group_members WHERE agent_id = $1))
              )
          )
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in &rules {
        let id: i64 = r.try_get("id")?;
        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM internet_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        out.push(InternetBlockRuleEffectiveRow {
            id,
            name: r.try_get("name")?,
            schedules,
        });
    }

    Ok(out)
}

pub async fn internet_block_rule_create(
    pool: &PgPool,
    name: &str,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
    schedules: &[RuleScheduleJson],
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO internet_block_rules (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(&mut *tx)
            .await?;
    for (kind, group_id, agent_id) in scopes {
        sqlx::query(
            "INSERT INTO internet_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1,$2,$3,$4)",
        )
        .bind(id).bind(kind.as_str()).bind(group_id).bind(agent_id)
        .execute(&mut *tx)
        .await?;
    }
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO internet_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

pub async fn internet_block_rule_set_enabled(
    pool: &PgPool,
    rule_id: i64,
    enabled: bool,
) -> Result<bool> {
    let r = sqlx::query("UPDATE internet_block_rules SET enabled = $2 WHERE id = $1")
        .bind(rule_id)
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn internet_block_rule_set_schedules(
    pool: &PgPool,
    rule_id: i64,
    schedules: &[RuleScheduleJson],
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query("SELECT 1 FROM internet_block_rules WHERE id = $1")
        .bind(rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if r.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM internet_block_rule_schedules WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *tx)
        .await?;
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO internet_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(rule_id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn internet_block_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query("DELETE FROM internet_block_rules WHERE id = $1")
        .bind(rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Direct agent-scoped rule IDs for push-after-delete targeting.
pub async fn internet_block_rule_direct_agent_ids(
    pool: &PgPool,
    rule_id: i64,
) -> Result<Vec<Uuid>> {
    let rows = sqlx::query(
        "SELECT agent_id FROM internet_block_rule_scopes WHERE rule_id=$1 AND scope_kind='agent' AND agent_id IS NOT NULL",
    )
    .bind(rule_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| Ok(r.try_get::<Uuid, _>("agent_id")?))
        .collect()
}

pub async fn internet_block_rule_has_all_scope(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let c: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM internet_block_rule_scopes WHERE rule_id=$1 AND scope_kind='all'",
    )
    .bind(rule_id)
    .fetch_one(pool)
    .await?;
    Ok(c > 0)
}

/// Create or update the single agent-scoped rule for quick per-agent toggle.
/// Returns the new blocked state.
pub async fn internet_block_set_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    blocked: bool,
) -> Result<bool> {
    if blocked {
        // Create an agent-scoped rule if the agent isn't already blocked at agent scope.
        let already: i64 = sqlx::query_scalar(
            r"SELECT COUNT(*) FROM internet_block_rules r
               JOIN internet_block_rule_scopes s ON s.rule_id = r.id
               WHERE r.enabled AND s.scope_kind='agent' AND s.agent_id=$1",
        )
        .bind(agent_id)
        .fetch_one(pool)
        .await?;
        if already == 0 {
            internet_block_rule_create(
                pool,
                "Manual block",
                &[("agent".into(), None, Some(agent_id))],
                &[],
            )
            .await?;
        }
    } else {
        // Remove all agent-scoped rules for this specific agent.
        sqlx::query(
            r"DELETE FROM internet_block_rules WHERE id IN (
               SELECT rule_id FROM internet_block_rule_scopes WHERE scope_kind='agent' AND agent_id=$1
            )",
        )
        .bind(agent_id).execute(pool).await?;
    }
    get_agent_internet_blocked(pool, agent_id).await
}

pub async fn set_agent_internet_blocked(
    pool: &PgPool,
    agent_id: Uuid,
    blocked: bool,
) -> Result<()> {
    internet_block_set_for_agent(pool, agent_id, blocked).await?;
    Ok(())
}

// ─── Installed software inventory ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct AgentSoftwareRow {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub install_location: Option<String>,
    pub install_date: Option<String>,
    pub captured_at: DateTime<Utc>,
}

/// Replace all software rows for an agent with a fresh snapshot (`items` from agent JSON).
pub async fn replace_agent_software(
    pool: &PgPool,
    agent_id: Uuid,
    items: &[serde_json::Value],
) -> Result<usize> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM agent_software WHERE agent_id = $1")
        .bind(agent_id)
        .execute(&mut *tx)
        .await?;

    let mut n = 0usize;
    for item in items.iter().take(12_000) {
        let name = item["name"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let version = item["version"]
            .as_str()
            .map(std::string::ToString::to_string);
        let publisher = item["publisher"]
            .as_str()
            .map(std::string::ToString::to_string);
        let install_location = item["install_location"]
            .as_str()
            .map(std::string::ToString::to_string);
        let install_date = item["install_date"]
            .as_str()
            .map(std::string::ToString::to_string);
        sqlx::query(
            r"
            INSERT INTO agent_software (agent_id, name, version, publisher, install_location, install_date)
            VALUES ($1, $2, $3, $4, $5, $6)
            ",
        )
        .bind(agent_id)
        .bind(name)
        .bind(version.as_deref())
        .bind(publisher.as_deref())
        .bind(install_location.as_deref())
        .bind(install_date.as_deref())
        .execute(&mut *tx)
        .await?;
        n += 1;
    }
    tx.commit().await?;
    Ok(n)
}

pub async fn list_agent_software(pool: &PgPool, agent_id: Uuid) -> Result<Vec<AgentSoftwareRow>> {
    let rows = sqlx::query(
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentSoftwareRow {
            name: r.try_get("name")?,
            version: r.try_get("version")?,
            publisher: r.try_get("publisher")?,
            install_location: r.try_get("install_location")?,
            install_date: r.try_get("install_date")?,
            captured_at: r.try_get("captured_at")?,
        });
    }
    Ok(out)
}

/// Paginated software list (`ORDER BY lower(name)`). Returns `(rows, total_count)`.
pub async fn list_agent_software_paged(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AgentSoftwareRow>, i64)> {
    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::bigint FROM agent_software WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_one(pool)
            .await?;

    let rows = sqlx::query(
        r"
        SELECT name, version, publisher, install_location, install_date, captured_at
        FROM agent_software
        WHERE agent_id = $1
        ORDER BY lower(name) ASC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentSoftwareRow {
            name: r.try_get("name")?,
            version: r.try_get("version")?,
            publisher: r.try_get("publisher")?,
            install_location: r.try_get("install_location")?,
            install_date: r.try_get("install_date")?,
            captured_at: r.try_get("captured_at")?,
        });
    }
    Ok((out, total))
}

pub async fn latest_software_capture_time(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<DateTime<Utc>>> {
    let v: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT MAX(captured_at) FROM agent_software WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_one(pool)
            .await?;
    Ok(v)
}

// ─── Agent groups ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AgentGroupRow {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub member_count: i64,
}

pub async fn agent_groups_list(pool: &PgPool) -> Result<Vec<AgentGroupRow>> {
    let rows = sqlx::query(
        r"
        SELECT g.id, g.name, g.description, g.created_at,
               COALESCE(COUNT(m.agent_id), 0)::BIGINT AS member_count
        FROM agent_groups g
        LEFT JOIN agent_group_members m ON m.group_id = g.id
        GROUP BY g.id, g.name, g.description, g.created_at
        ORDER BY lower(g.name)
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentGroupRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            description: r.try_get("description")?,
            created_at: r.try_get("created_at")?,
            member_count: r.try_get("member_count")?,
        });
    }
    Ok(out)
}

pub async fn agent_group_create(pool: &PgPool, name: &str, description: &str) -> Result<Uuid> {
    let id: Uuid = sqlx::query_scalar(
        r"
        INSERT INTO agent_groups (name, description)
        VALUES ($1, $2)
        RETURNING id
        ",
    )
    .bind(name.trim())
    .bind(description)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn agent_group_delete(pool: &PgPool, id: Uuid) -> Result<bool> {
    let r = sqlx::query("DELETE FROM agent_groups WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_rename(
    pool: &PgPool,
    id: Uuid,
    name: &str,
    description: &str,
) -> Result<bool> {
    let r = sqlx::query("UPDATE agent_groups SET name = $2, description = $3 WHERE id = $1")
        .bind(id)
        .bind(name.trim())
        .bind(description)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_add_members(
    pool: &PgPool,
    group_id: Uuid,
    agent_ids: &[Uuid],
) -> Result<u64> {
    let mut n = 0u64;
    for aid in agent_ids {
        let r = sqlx::query(
            "INSERT INTO agent_group_members (group_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(group_id)
        .bind(aid)
        .execute(pool)
        .await?;
        n += r.rows_affected();
    }
    Ok(n)
}

pub async fn agent_group_remove_member(
    pool: &PgPool,
    group_id: Uuid,
    agent_id: Uuid,
) -> Result<bool> {
    let r = sqlx::query("DELETE FROM agent_group_members WHERE group_id = $1 AND agent_id = $2")
        .bind(group_id)
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn agent_group_members(pool: &PgPool, group_id: Uuid) -> Result<Vec<Uuid>> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT agent_id FROM agent_group_members WHERE group_id = $1 ORDER BY agent_id",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Groups that include this agent (for dashboard agent detail).
#[derive(Debug, Clone, Serialize)]
pub struct AgentGroupForAgentRow {
    pub id: Uuid,
    pub name: String,
    pub description: String,
}

pub async fn agent_groups_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AgentGroupForAgentRow>> {
    let rows = sqlx::query(
        r"
        SELECT g.id, g.name, g.description
        FROM agent_groups g
        INNER JOIN agent_group_members m ON m.group_id = g.id
        WHERE m.agent_id = $1
        ORDER BY lower(g.name)
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AgentGroupForAgentRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            description: r.try_get("description")?,
        });
    }
    Ok(out)
}

// ─── Alert rules ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleRow {
    pub id: i64,
    pub name: String,
    pub pattern: String,
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub take_screenshot: bool,
}

/// Rules that apply to this agent (global + group memberships + direct agent scope).
pub async fn alert_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    channel: &str,
) -> Result<Vec<AlertRuleRow>> {
    let rows = sqlx::query(
        r"
        SELECT DISTINCT r.id, r.name, r.pattern, r.match_mode,
               r.case_insensitive, r.cooldown_secs, r.take_screenshot
        FROM alert_rules r
        INNER JOIN alert_rule_scopes s ON s.rule_id = r.id
        WHERE r.enabled
          AND r.channel = $2
          AND (
            s.scope_kind = 'all'
            OR (s.scope_kind = 'agent' AND s.agent_id = $1)
            OR (
                s.scope_kind = 'group'
                AND s.group_id IN (
                    SELECT group_id FROM agent_group_members WHERE agent_id = $1
                )
            )
          )
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .bind(channel)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AlertRuleRow {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            pattern: r.try_get("pattern")?,
            match_mode: r.try_get("match_mode")?,
            case_insensitive: r.try_get("case_insensitive")?,
            cooldown_secs: r.try_get("cooldown_secs")?,
            take_screenshot: r.try_get::<bool, _>("take_screenshot").unwrap_or(false),
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleScopeJson {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleListItem {
    pub id: i64,
    pub name: String,
    pub channel: String,
    pub pattern: String,
    pub match_mode: String,
    pub case_insensitive: bool,
    pub cooldown_secs: i32,
    pub enabled: bool,
    pub take_screenshot: bool,
    pub scopes: Vec<AlertRuleScopeJson>,
}

pub async fn alert_rules_list_all(pool: &PgPool) -> Result<Vec<AlertRuleListItem>> {
    let rules = sqlx::query(
        r"
        SELECT id, name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot
        FROM alert_rules
        ORDER BY id
        ",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in rules {
        let id: i64 = r.try_get("id")?;
        let scopes_rows = sqlx::query(
            "SELECT scope_kind, group_id, agent_id FROM alert_rule_scopes WHERE rule_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        let mut scopes = Vec::with_capacity(scopes_rows.len());
        for s in scopes_rows {
            let kind: String = s.try_get("scope_kind")?;
            scopes.push(AlertRuleScopeJson {
                kind,
                group_id: s.try_get::<Option<Uuid>, _>("group_id")?,
                agent_id: s.try_get::<Option<Uuid>, _>("agent_id")?,
            });
        }

        out.push(AlertRuleListItem {
            id,
            name: r.try_get("name")?,
            channel: r.try_get("channel")?,
            pattern: r.try_get("pattern")?,
            match_mode: r.try_get("match_mode")?,
            case_insensitive: r.try_get("case_insensitive")?,
            cooldown_secs: r.try_get("cooldown_secs")?,
            enabled: r.try_get("enabled")?,
            take_screenshot: r.try_get::<bool, _>("take_screenshot").unwrap_or(false),
            scopes,
        });
    }
    Ok(out)
}

async fn alert_rule_scopes_write_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    rule_id: i64,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
) -> Result<()> {
    let conn = &mut **tx;
    sqlx::query("DELETE FROM alert_rule_scopes WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *conn)
        .await?;

    for (kind, group_id, agent_id) in scopes {
        sqlx::query(
            r"
            INSERT INTO alert_rule_scopes (rule_id, scope_kind, group_id, agent_id)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(rule_id)
        .bind(kind.as_str())
        .bind(group_id)
        .bind(agent_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub async fn alert_rule_create_with_scopes(
    pool: &PgPool,
    params: &AlertRuleUpsert<'_>,
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO alert_rules (name, channel, pattern, match_mode, case_insensitive, cooldown_secs, enabled, take_screenshot)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
        ",
    )
    .bind(params.name)
    .bind(params.channel)
    .bind(params.pattern)
    .bind(params.match_mode)
    .bind(params.case_insensitive)
    .bind(params.cooldown_secs)
    .bind(params.enabled)
    .bind(params.take_screenshot)
    .fetch_one(&mut *tx)
    .await?;
    alert_rule_scopes_write_tx(&mut tx, id, params.scopes).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn alert_rule_update_with_scopes(
    pool: &PgPool,
    rule_id: i64,
    params: &AlertRuleUpsert<'_>,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query(
        r"
        UPDATE alert_rules
        SET name = $2, channel = $3, pattern = $4, match_mode = $5,
            case_insensitive = $6, cooldown_secs = $7, enabled = $8, take_screenshot = $9, updated_at = NOW()
        WHERE id = $1
        ",
    )
    .bind(rule_id)
    .bind(params.name)
    .bind(params.channel)
    .bind(params.pattern)
    .bind(params.match_mode)
    .bind(params.case_insensitive)
    .bind(params.cooldown_secs)
    .bind(params.enabled)
    .bind(params.take_screenshot)
    .execute(&mut *tx)
    .await?;
    if r.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(false);
    }
    alert_rule_scopes_write_tx(&mut tx, rule_id, params.scopes).await?;
    tx.commit().await?;
    Ok(true)
}

pub async fn alert_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query("DELETE FROM alert_rules WHERE id = $1")
        .bind(rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleEventRow {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<i64>,
    pub rule_name: String,
    pub channel: String,
    pub snippet: String,
    pub has_screenshot: bool,
    /// Whether the rule currently has "take screenshot" enabled (best-effort join).
    pub screenshot_requested: bool,
    pub created_at: DateTime<Utc>,
}

/// One alert firing for admin "history by rule" (includes which agent triggered it).
#[derive(Debug, Clone, Serialize)]
pub struct AlertRuleEventTriggeredRow {
    pub id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_name: String,
    pub channel: String,
    pub snippet: String,
    pub has_screenshot: bool,
    pub screenshot_requested: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn alert_rule_event_insert(
    pool: &PgPool,
    agent_id: Uuid,
    rule_id: i64,
    rule_name: &str,
    channel: &str,
    snippet: &str,
) -> Result<i64> {
    let id: i64 = sqlx::query_scalar(
        r"
        INSERT INTO alert_rule_events (agent_id, rule_id, rule_name, channel, snippet)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        ",
    )
    .bind(agent_id)
    .bind(rule_id)
    .bind(rule_name)
    .bind(channel)
    .bind(snippet)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn alert_rule_event_screenshot_upsert(
    pool: &PgPool,
    event_id: i64,
    jpeg: &[u8],
) -> Result<()> {
    sqlx::query(
        r"
        INSERT INTO alert_rule_event_screenshots (event_id, jpeg)
        VALUES ($1, $2)
        ON CONFLICT (event_id) DO UPDATE SET
            jpeg = EXCLUDED.jpeg,
            created_at = NOW()
        ",
    )
    .bind(event_id)
    .bind(jpeg)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn alert_rule_event_screenshot_get(
    pool: &PgPool,
    event_id: i64,
) -> Result<Option<Vec<u8>>> {
    let v: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT jpeg FROM alert_rule_event_screenshots WHERE event_id = $1")
            .bind(event_id)
            .fetch_optional(pool)
            .await?
            .flatten();
    Ok(v)
}

/// All alert events across all agents — newest first (admin).
pub async fn alert_rule_events_list_all(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS agent_name,
               e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        ORDER BY e.created_at DESC
        LIMIT $1 OFFSET $2
        ",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| {
            Ok(AlertRuleEventTriggeredRow {
                id: r.try_get("id")?,
                agent_id: r.try_get("agent_id")?,
                agent_name: r.try_get("agent_name")?,
                rule_name: r.try_get("rule_name")?,
                channel: r.try_get("channel")?,
                snippet: r.try_get("snippet")?,
                has_screenshot: r.try_get::<bool, _>("has_screenshot").unwrap_or(false),
                screenshot_requested: r
                    .try_get::<bool, _>("screenshot_requested")
                    .unwrap_or(false),
                created_at: r.try_get("created_at")?,
            })
        })
        .collect()
}

pub async fn alert_rule_events_list_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.rule_id, e.rule_name, e.channel, e.snippet, e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.agent_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AlertRuleEventRow {
            id: r.try_get("id")?,
            rule_id: r.try_get("rule_id")?,
            rule_name: r.try_get("rule_name")?,
            channel: r.try_get("channel")?,
            snippet: r.try_get("snippet")?,
            has_screenshot: r.try_get::<bool, _>("has_screenshot").unwrap_or(false),
            screenshot_requested: r
                .try_get::<bool, _>("screenshot_requested")
                .unwrap_or(false),
            created_at: r.try_get("created_at")?,
        });
    }
    Ok(out)
}

pub async fn alert_rule_events_list_for_rule(
    pool: &PgPool,
    rule_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<AlertRuleEventTriggeredRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, COALESCE(a.name, '') AS agent_name, e.rule_name, e.channel, e.snippet,
               e.created_at,
               EXISTS (SELECT 1 FROM alert_rule_event_screenshots s WHERE s.event_id = e.id) AS has_screenshot,
               COALESCE(r.take_screenshot, false) AS screenshot_requested
        FROM alert_rule_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        LEFT JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.rule_id = $1
        ORDER BY e.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(rule_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(AlertRuleEventTriggeredRow {
            id: row.try_get("id")?,
            agent_id: row.try_get("agent_id")?,
            agent_name: row.try_get("agent_name")?,
            rule_name: row.try_get("rule_name")?,
            channel: row.try_get("channel")?,
            snippet: row.try_get("snippet")?,
            has_screenshot: row.try_get::<bool, _>("has_screenshot").unwrap_or(false),
            screenshot_requested: row
                .try_get::<bool, _>("screenshot_requested")
                .unwrap_or(false),
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(out)
}

// ─── App block rules ──────────────────────────────────────────────────────────

/// Minimal rule payload pushed to agents over WebSocket.
#[derive(Debug, Clone, Serialize)]
pub struct AppBlockRuleRow {
    pub id: i64,
    /// Optional friendly label; used by the dashboard UI.
    #[serde(default)]
    pub name: String,
    pub exe_pattern: String,
    pub match_mode: String,
    /// Always true for "effective" rules (disabled rules are excluded).
    pub enabled: bool,
    /// Most-permissive scope kind that makes this rule apply to the agent
    /// (`all` > `group` > `agent`). Included so the dashboard can show a scope badge.
    pub scope_kind: String,
    pub schedules: Vec<RuleScheduleJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppBlockScopeJson {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
}

/// Full rule item returned by the list API (includes scopes and metadata).
#[derive(Debug, Clone, Serialize)]
pub struct AppBlockRuleListItem {
    pub id: i64,
    pub name: String,
    pub exe_pattern: String,
    pub match_mode: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub scopes: Vec<AppBlockScopeJson>,
    pub schedules: Vec<RuleScheduleJson>,
}

/// Rules effective for a specific agent (all-scope + group + agent-scope, enabled only).
pub async fn app_block_rules_effective_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AppBlockRuleRow>> {
    // Subquery picks the most-permissive scope kind (all=1, group=2, agent=3)
    // for display purposes; the WHERE clause checks actual applicability.
    let rows = sqlx::query(
        r"
        SELECT r.id, r.name, r.exe_pattern, r.match_mode,
               (SELECT scope_kind
                FROM app_block_rule_scopes sub
                WHERE sub.rule_id = r.id
                ORDER BY CASE sub.scope_kind
                             WHEN 'all'   THEN 1
                             WHEN 'group' THEN 2
                             ELSE 3
                         END
                LIMIT 1) AS scope_kind
        FROM app_block_rules r
        WHERE r.enabled
          AND EXISTS (
            SELECT 1 FROM app_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (
                        SELECT group_id FROM agent_group_members WHERE agent_id = $1
                    ))
              )
          )
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let rule_id: i64 = r.try_get("id")?;
        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(rule_id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        out.push(AppBlockRuleRow {
            id: rule_id,
            name: r.try_get::<Option<String>, _>("name")?.unwrap_or_default(),
            exe_pattern: r.try_get("exe_pattern")?,
            match_mode: r.try_get("match_mode")?,
            enabled: true,
            scope_kind: r
                .try_get::<Option<String>, _>("scope_kind")?
                .unwrap_or_else(|| "agent".into()),
            schedules,
        });
    }
    Ok(out)
}

/// Rules applicable to a specific agent (all-scope + group + agent-scope), including disabled.
/// Used by the dashboard Agent → Control tab so toggled-off rules remain visible.
pub async fn app_block_rules_applicable_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Vec<AppBlockRuleRow>> {
    let rows = sqlx::query(
        r"
        SELECT r.id, r.name, r.exe_pattern, r.match_mode, r.enabled,
               (SELECT scope_kind
                FROM app_block_rule_scopes sub
                WHERE sub.rule_id = r.id
                ORDER BY CASE sub.scope_kind
                             WHEN 'all'   THEN 1
                             WHEN 'group' THEN 2
                             ELSE 3
                         END
                LIMIT 1) AS scope_kind
        FROM app_block_rules r
        WHERE EXISTS (
            SELECT 1 FROM app_block_rule_scopes s
            WHERE s.rule_id = r.id
              AND (
                s.scope_kind = 'all'
                OR (s.scope_kind = 'agent' AND s.agent_id = $1)
                OR (s.scope_kind = 'group'
                    AND s.group_id IN (
                        SELECT group_id FROM agent_group_members WHERE agent_id = $1
                    ))
              )
        )
        ORDER BY r.id
        ",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let rule_id: i64 = r.try_get("id")?;
        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(rule_id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        out.push(AppBlockRuleRow {
            id: rule_id,
            name: r.try_get::<Option<String>, _>("name")?.unwrap_or_default(),
            exe_pattern: r.try_get("exe_pattern")?,
            match_mode: r.try_get("match_mode")?,
            enabled: r.try_get::<Option<bool>, _>("enabled")?.unwrap_or(true),
            scope_kind: r
                .try_get::<Option<String>, _>("scope_kind")?
                .unwrap_or_else(|| "agent".into()),
            schedules,
        });
    }
    Ok(out)
}

/// All rules with their scopes — for the admin list view.
pub async fn app_block_rules_list_all(pool: &PgPool) -> Result<Vec<AppBlockRuleListItem>> {
    let rules = sqlx::query(
        "SELECT id, name, exe_pattern, match_mode, enabled, created_at FROM app_block_rules ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rules.len());
    for r in &rules {
        let id: i64 = r.try_get("id")?;
        let scope_rows = sqlx::query(
            "SELECT scope_kind, group_id, agent_id FROM app_block_rule_scopes WHERE rule_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;

        let scopes = scope_rows
            .iter()
            .map(|s| {
                Ok(AppBlockScopeJson {
                    kind: s.try_get("scope_kind")?,
                    group_id: s.try_get::<Option<Uuid>, _>("group_id")?,
                    agent_id: s.try_get::<Option<Uuid>, _>("agent_id")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let schedule_rows = sqlx::query(
            r"
            SELECT day_of_week, start_minute, end_minute
            FROM app_block_rule_schedules
            WHERE rule_id = $1
            ORDER BY day_of_week, start_minute, end_minute
            ",
        )
        .bind(id)
        .fetch_all(pool)
        .await?;
        let schedules = schedule_rows
            .iter()
            .map(|row| {
                Ok(RuleScheduleJson {
                    day_of_week: row.try_get("day_of_week")?,
                    start_minute: row.try_get("start_minute")?,
                    end_minute: row.try_get("end_minute")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let created_at_raw: Option<chrono::DateTime<Utc>> = r.try_get("created_at").ok();
        out.push(AppBlockRuleListItem {
            id,
            name: r.try_get("name")?,
            exe_pattern: r.try_get("exe_pattern")?,
            match_mode: r.try_get("match_mode")?,
            enabled: r.try_get("enabled")?,
            created_at: created_at_raw.unwrap_or_else(Utc::now),
            scopes,
            schedules,
        });
    }
    Ok(out)
}

/// Insert a new rule with its scopes. Returns the new rule id.
pub async fn app_block_rule_create(
    pool: &PgPool,
    name: &str,
    exe_pattern: &str,
    match_mode: &str,
    scopes: &[(String, Option<Uuid>, Option<Uuid>)],
    schedules: &[RuleScheduleJson],
) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO app_block_rules (name, exe_pattern, match_mode) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(name)
    .bind(exe_pattern)
    .bind(match_mode)
    .fetch_one(&mut *tx)
    .await?;

    for (kind, group_id, agent_id) in scopes {
        sqlx::query(
            "INSERT INTO app_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(kind.as_str())
        .bind(group_id)
        .bind(agent_id)
        .execute(&mut *tx)
        .await?;
    }
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

#[allow(dead_code)]
pub async fn app_block_rule_set_schedules(
    pool: &PgPool,
    rule_id: i64,
    schedules: &[RuleScheduleJson],
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let r = sqlx::query("SELECT 1 FROM app_block_rules WHERE id = $1")
        .bind(rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if r.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM app_block_rule_schedules WHERE rule_id = $1")
        .bind(rule_id)
        .execute(&mut *tx)
        .await?;
    for s in schedules {
        sqlx::query(
            r"
            INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
            VALUES ($1, $2, $3, $4)
            ",
        )
        .bind(rule_id)
        .bind(s.day_of_week)
        .bind(s.start_minute)
        .bind(s.end_minute)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// A scope row used by app-block rule operations: `(kind, group_id, agent_id)`.
pub type ScopeRow = (String, Option<Uuid>, Option<Uuid>);

/// Optional fields that can be updated on an app-block rule.
pub struct AppBlockRuleUpdateOpts<'a> {
    pub name: Option<&'a str>,
    pub exe_pattern: Option<&'a str>,
    pub match_mode: Option<&'a str>,
    pub enabled: Option<bool>,
    pub scopes: Option<&'a [ScopeRow]>,
    pub schedules: Option<&'a [RuleScheduleJson]>,
}

pub async fn app_block_rule_update(
    pool: &PgPool,
    rule_id: i64,
    opts: AppBlockRuleUpdateOpts<'_>,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let exists = sqlx::query("SELECT 1 FROM app_block_rules WHERE id = $1")
        .bind(rule_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }

    if opts.name.is_some()
        || opts.exe_pattern.is_some()
        || opts.match_mode.is_some()
        || opts.enabled.is_some()
    {
        sqlx::query(
            r"
            UPDATE app_block_rules
            SET name = COALESCE($2, name),
                exe_pattern = COALESCE($3, exe_pattern),
                match_mode = COALESCE($4, match_mode),
                enabled = COALESCE($5, enabled)
            WHERE id = $1
            ",
        )
        .bind(rule_id)
        .bind(opts.name)
        .bind(opts.exe_pattern)
        .bind(opts.match_mode)
        .bind(opts.enabled)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(scopes_rows) = opts.scopes {
        sqlx::query("DELETE FROM app_block_rule_scopes WHERE rule_id = $1")
            .bind(rule_id)
            .execute(&mut *tx)
            .await?;
        for (kind, group_id, agent_id) in scopes_rows {
            sqlx::query(
                "INSERT INTO app_block_rule_scopes (rule_id, scope_kind, group_id, agent_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(rule_id)
            .bind(kind.as_str())
            .bind(group_id)
            .bind(agent_id)
            .execute(&mut *tx)
            .await?;
        }
    }

    if let Some(sched_rows) = opts.schedules {
        sqlx::query("DELETE FROM app_block_rule_schedules WHERE rule_id = $1")
            .bind(rule_id)
            .execute(&mut *tx)
            .await?;
        for s in sched_rows {
            sqlx::query(
                r"
                INSERT INTO app_block_rule_schedules (rule_id, day_of_week, start_minute, end_minute)
                VALUES ($1, $2, $3, $4)
                ",
            )
            .bind(rule_id)
            .bind(s.day_of_week)
            .bind(s.start_minute)
            .bind(s.end_minute)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(true)
}

/// Toggle a rule's enabled state. Returns false if the rule wasn't found.
#[allow(dead_code)]
pub async fn app_block_rule_set_enabled(
    pool: &PgPool,
    rule_id: i64,
    enabled: bool,
) -> Result<bool> {
    let r = sqlx::query("UPDATE app_block_rules SET enabled = $2 WHERE id = $1")
        .bind(rule_id)
        .bind(enabled)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Delete a rule (cascades to scopes). Returns false if not found.
pub async fn app_block_rule_delete(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let r = sqlx::query("DELETE FROM app_block_rules WHERE id = $1")
        .bind(rule_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Agent UUIDs that have a direct-scope rule for this `rule_id` (for targeted push).
pub async fn app_block_rule_direct_agent_ids(pool: &PgPool, rule_id: i64) -> Result<Vec<Uuid>> {
    let rows = sqlx::query(
        "SELECT agent_id FROM app_block_rule_scopes WHERE rule_id = $1 AND scope_kind = 'agent' AND agent_id IS NOT NULL",
    )
    .bind(rule_id)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| Ok(r.try_get::<Uuid, _>("agent_id")?))
        .collect()
}

/// Whether a rule has any all-scope entry.
pub async fn app_block_rule_has_all_scope(pool: &PgPool, rule_id: i64) -> Result<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM app_block_rule_scopes WHERE rule_id = $1 AND scope_kind = 'all'",
    )
    .bind(rule_id)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

// ─── App block events ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AppBlockEventRow {
    pub id: i64,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub rule_id: Option<i64>,
    pub rule_name: Option<String>,
    pub exe_name: String,
    pub killed_at: DateTime<Utc>,
}

/// Log a process kill event (sent by the agent via WebSocket).
pub async fn log_app_block_event(
    pool: &PgPool,
    agent_id: Uuid,
    rule_id: Option<i64>,
    rule_name: Option<&str>,
    exe_name: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_block_events (agent_id, rule_id, rule_name, exe_name) VALUES ($1, $2, $3, $4)",
    )
    .bind(agent_id)
    .bind(rule_id)
    .bind(rule_name)
    .bind(exe_name)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn app_block_events_for_agent(
    pool: &PgPool,
    agent_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        WHERE e.agent_id = $1
        ORDER BY e.killed_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(agent_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| {
            Ok(AppBlockEventRow {
                id: r.try_get("id")?,
                agent_id: r.try_get("agent_id")?,
                agent_name: r.try_get("agent_name")?,
                rule_id: r.try_get("rule_id")?,
                rule_name: r.try_get("rule_name")?,
                exe_name: r.try_get("exe_name")?,
                killed_at: r.try_get("killed_at")?,
            })
        })
        .collect()
}

pub async fn app_block_events_for_rule(
    pool: &PgPool,
    rule_id: i64,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        WHERE e.rule_id = $1
        ORDER BY e.killed_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(rule_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| {
            Ok(AppBlockEventRow {
                id: r.try_get("id")?,
                agent_id: r.try_get("agent_id")?,
                agent_name: r.try_get("agent_name")?,
                rule_id: r.try_get("rule_id")?,
                rule_name: r.try_get("rule_name")?,
                exe_name: r.try_get("exe_name")?,
                killed_at: r.try_get("killed_at")?,
            })
        })
        .collect()
}

/// All events across all agents, newest first.
pub async fn app_block_events_all(
    pool: &PgPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<AppBlockEventRow>> {
    let rows = sqlx::query(
        r"
        SELECT e.id, e.agent_id, a.name AS agent_name,
               e.rule_id, COALESCE(e.rule_name, r.name) AS rule_name,
               e.exe_name, e.killed_at
        FROM app_block_events e
        JOIN agents a ON a.id = e.agent_id
        LEFT JOIN app_block_rules r ON r.id = e.rule_id
        ORDER BY e.killed_at DESC
        LIMIT $1 OFFSET $2
        ",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|r| {
            Ok(AppBlockEventRow {
                id: r.try_get("id")?,
                agent_id: r.try_get("agent_id")?,
                agent_name: r.try_get("agent_name")?,
                rule_id: r.try_get("rule_id")?,
                rule_name: r.try_get("rule_name")?,
                exe_name: r.try_get("exe_name")?,
                killed_at: r.try_get("killed_at")?,
            })
        })
        .collect()
}

// ─── Utility ──────────────────────────────────────────────────────────────────

fn unix_to_dt(ts: Option<i64>) -> DateTime<Utc> {
    ts.and_then(|s| Utc.timestamp_opt(s, 0).single())
        .unwrap_or_else(Utc::now)
}
