//! Per-exe app icons uploaded by agents.

use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

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

    sqlx::query!(
        r"
        INSERT INTO app_icons (agent_id, exe_name, png_bytes, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_id, exe_name) DO UPDATE
        SET png_bytes = EXCLUDED.png_bytes,
            updated_at = NOW()
        ",
        agent,
        &exe,
        png_bytes,
    )
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
    Ok(sqlx::query_scalar!(
        "SELECT png_bytes FROM app_icons WHERE agent_id=$1 AND exe_name=$2",
        agent,
        &exe,
    )
    .fetch_optional(pool)
    .await?)
}
