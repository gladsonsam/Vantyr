//! The categorization settings row and the list download/import job state.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct Settings {
    pub enabled: bool,
    pub auto_update: bool,
    pub source_url: String,
    pub last_update_at: Option<DateTime<Utc>>,
    pub last_update_error: Option<String>,
}

pub async fn get_settings(pool: &PgPool) -> Result<Settings> {
    let row = sqlx::query!(
        r"
        SELECT enabled, auto_update, source_url, last_update_at, last_update_error
        FROM url_categorization_settings
        WHERE id = 1
        "
    )
    .fetch_one(pool)
    .await?;
    Ok(Settings {
        enabled: row.enabled,
        auto_update: row.auto_update,
        source_url: row.source_url,
        last_update_at: row.last_update_at,
        last_update_error: row.last_update_error,
    })
}

pub async fn set_settings(
    pool: &PgPool,
    enabled: bool,
    auto_update: bool,
    source_url: &str,
) -> Result<()> {
    sqlx::query!(
        r"
        UPDATE url_categorization_settings
        SET enabled = $1,
            auto_update = $2,
            source_url = $3
        WHERE id = 1
        ",
        enabled,
        auto_update,
        source_url
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_update_ok(pool: &PgPool) -> Result<()> {
    sqlx::query!(
        r"
        UPDATE url_categorization_settings
        SET last_update_at = NOW(),
            last_update_error = NULL
        WHERE id = 1
        "
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_update_err(pool: &PgPool, err: &str) -> Result<()> {
    sqlx::query!(
        r"
        UPDATE url_categorization_settings
        SET last_update_error = $1
        WHERE id = 1
        ",
        err
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn job_set(
    pool: &PgPool,
    state: &str,
    bytes_done: i64,
    bytes_total: Option<i64>,
    message: Option<&str>,
) -> Result<()> {
    sqlx::query!(
        r"
        UPDATE url_categorization_job
        SET state = $1,
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW(),
            bytes_done = $2,
            bytes_total = $3,
            message = $4
        WHERE id = 1
        ",
        state,
        bytes_done.max(0),
        bytes_total,
        message
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn job_reset(pool: &PgPool) -> Result<()> {
    sqlx::query!(
        r"
        UPDATE url_categorization_job
        SET state = 'idle',
            started_at = NULL,
            updated_at = NOW(),
            bytes_total = NULL,
            bytes_done = 0,
            message = NULL
        WHERE id = 1
        "
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn job_state(pool: &PgPool) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar!("SELECT state FROM url_categorization_job WHERE id = 1")
            .fetch_optional(pool)
            .await?,
    )
}

/// Progress of the list download/import job, as shown by the admin UI.
#[derive(Serialize)]
pub struct JobStatus {
    pub state: String,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub bytes_total: Option<i64>,
    pub bytes_done: i64,
    pub message: Option<String>,
}

pub async fn job_status(pool: &PgPool) -> Result<Option<JobStatus>> {
    let row = sqlx::query!(
        "SELECT state, started_at, updated_at, bytes_total, bytes_done, message FROM url_categorization_job WHERE id = 1"
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| JobStatus {
        state: r.state,
        started_at: r.started_at,
        updated_at: r.updated_at,
        bytes_total: r.bytes_total,
        bytes_done: r.bytes_done,
        message: r.message,
    }))
}
