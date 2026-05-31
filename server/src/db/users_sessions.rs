//! Dashboard user accounts and session persistence (carved out of the monolithic `db.rs`).

use super::*;

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

/// Revoke every active dashboard session for a user. Returns the number of sessions removed.
/// Call this after a password change, role change, or user deletion so stale cookies stop working.
pub async fn dashboard_sessions_delete_for_user(pool: &PgPool, user_id: Uuid) -> Result<u64> {
    let res = sqlx::query("DELETE FROM dashboard_sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
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
