//! Windows agent local settings-window password (Argon2 PHC string): global + per-agent.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

/// `true` if this hash means the user must type a non-empty password to open settings.
pub fn agent_ui_password_is_set(hash: Option<&str>) -> bool {
    matches!(hash, Some(h) if !h.is_empty() && h.starts_with("$argon2"))
}

pub async fn get_local_ui_global_hash(pool: &PgPool) -> Result<Option<String>> {
    let v: Option<String> = sqlx::query_scalar!(
        "SELECT password_hash_sha256 FROM agent_local_ui_password WHERE id = 1"
    )
    .fetch_one(pool)
    .await?;
    Ok(v)
}

pub async fn get_local_ui_override_hash(pool: &PgPool, agent_id: Uuid) -> Result<Option<String>> {
    let v: Option<Option<String>> = sqlx::query_scalar!(
        "SELECT password_hash_sha256 FROM agent_local_ui_password_override WHERE agent_id = $1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?;

    Ok(v.flatten())
}
