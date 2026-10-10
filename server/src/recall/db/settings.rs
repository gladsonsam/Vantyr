//! Capture settings: the global row and per-agent overrides.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use ts_rs::TS;
use uuid::Uuid;

/// Capture settings in the shape the agent consumes (`set_recall_settings`) and the
/// settings UI shows, so exactly one type knows the field names on the wire.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RecallSettings {
    pub enabled: bool,
    pub interval_ms: i32,
    pub hot_interval_ms: i32,
    pub jpeg_quality: i16,
    pub max_dim: i32,
    pub dedup_hamming: i16,
    pub keyframe_max_gap_ms: i32,
    pub ocr: bool,
}

/// Effective capture settings for one agent: the global row with any per-agent
/// override applied column-by-column (`COALESCE`, so NULL means "inherit").
///
/// `None` when the global row is missing (migration not applied): the agent then keeps
/// its built-in defaults rather than receiving a half-formed policy.
pub async fn effective_recall_settings(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<RecallSettings>> {
    let row = sqlx::query!(
        "SELECT
           COALESCE(a.enabled,             g.enabled)             AS enabled,
           COALESCE(a.interval_ms,         g.interval_ms)         AS interval_ms,
           COALESCE(a.hot_interval_ms,     g.hot_interval_ms)     AS hot_interval_ms,
           COALESCE(a.jpeg_quality,        g.jpeg_quality)        AS jpeg_quality,
           COALESCE(a.max_dim,             g.max_dim)             AS max_dim,
           COALESCE(a.dedup_hamming,       g.dedup_hamming)       AS dedup_hamming,
           COALESCE(a.keyframe_max_gap_ms, g.keyframe_max_gap_ms) AS keyframe_max_gap_ms,
           COALESCE(a.ocr,                 g.ocr)                 AS ocr
         FROM recall_settings_global g
         LEFT JOIN recall_settings_agent a ON a.agent_id = $1
         WHERE g.id = 1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| RecallSettings {
        enabled: r.enabled.unwrap_or(true),
        interval_ms: r.interval_ms.unwrap_or(20_000),
        hot_interval_ms: r.hot_interval_ms.unwrap_or(6_000),
        jpeg_quality: r.jpeg_quality.unwrap_or(45),
        max_dim: r.max_dim.unwrap_or(1_600),
        dedup_hamming: r.dedup_hamming.unwrap_or(4),
        keyframe_max_gap_ms: r.keyframe_max_gap_ms.unwrap_or(300_000),
        ocr: r.ocr.unwrap_or(true),
    }))
}

/// The raw global capture settings row (for the settings UI).
pub async fn get_recall_settings_global(pool: &PgPool) -> Result<RecallSettings> {
    Ok(sqlx::query_as!(
        RecallSettings,
        "SELECT enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
                dedup_hamming, keyframe_max_gap_ms, ocr
         FROM recall_settings_global WHERE id = 1",
    )
    .fetch_one(pool)
    .await?)
}

/// The per-agent override row: `None` fields inherit the global value.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RecallSettingsOverride {
    pub enabled: Option<bool>,
    pub interval_ms: Option<i32>,
    pub hot_interval_ms: Option<i32>,
    pub jpeg_quality: Option<i16>,
    pub max_dim: Option<i32>,
    pub dedup_hamming: Option<i16>,
    pub keyframe_max_gap_ms: Option<i32>,
    pub ocr: Option<bool>,
    pub updated_at: DateTime<Utc>,
}

/// The raw per-agent override row, or `None` when the agent has none.
///
/// Distinct from [`effective_recall_settings`], which COALESCEs the override over the
/// global row: the settings UI needs to know *which* fields are overridden so it can
/// show the rest as inherited rather than as deliberate local values.
pub async fn get_recall_settings_agent_override(
    pool: &PgPool,
    agent_id: Uuid,
) -> Result<Option<RecallSettingsOverride>> {
    Ok(sqlx::query_as!(
        RecallSettingsOverride,
        "SELECT enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
                dedup_hamming, keyframe_max_gap_ms, ocr, updated_at
         FROM recall_settings_agent WHERE agent_id = $1",
        agent_id,
    )
    .fetch_optional(pool)
    .await?)
}

/// Capture settings the operator may change. `None` leaves a column untouched.
#[derive(Debug, Default, Clone)]
pub struct RecallSettingsPatch {
    pub enabled: Option<bool>,
    pub interval_ms: Option<i32>,
    pub hot_interval_ms: Option<i32>,
    pub jpeg_quality: Option<i16>,
    pub max_dim: Option<i32>,
    pub dedup_hamming: Option<i16>,
    pub keyframe_max_gap_ms: Option<i32>,
    pub ocr: Option<bool>,
}

/// Update the global capture settings. Omitted fields keep their current value.
pub async fn set_recall_settings_global(pool: &PgPool, p: &RecallSettingsPatch) -> Result<()> {
    sqlx::query!(
        "UPDATE recall_settings_global SET
           enabled             = COALESCE($1, enabled),
           interval_ms         = COALESCE($2, interval_ms),
           hot_interval_ms     = COALESCE($3, hot_interval_ms),
           jpeg_quality        = COALESCE($4, jpeg_quality),
           max_dim             = COALESCE($5, max_dim),
           dedup_hamming       = COALESCE($6, dedup_hamming),
           keyframe_max_gap_ms = COALESCE($7, keyframe_max_gap_ms),
           ocr                 = COALESCE($8, ocr),
           updated_at          = NOW()
         WHERE id = 1",
        p.enabled,
        p.interval_ms,
        p.hot_interval_ms,
        p.jpeg_quality,
        p.max_dim,
        p.dedup_hamming,
        p.keyframe_max_gap_ms,
        p.ocr
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Set (or clear) the per-agent override. Fields left `None` become NULL, i.e. the
/// agent inherits the global value for them.
pub async fn set_recall_settings_agent(
    pool: &PgPool,
    agent_id: Uuid,
    p: &RecallSettingsPatch,
) -> Result<()> {
    sqlx::query!(
        "INSERT INTO recall_settings_agent
           (agent_id, enabled, interval_ms, hot_interval_ms, jpeg_quality, max_dim,
            dedup_hamming, keyframe_max_gap_ms, ocr, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           interval_ms = EXCLUDED.interval_ms,
           hot_interval_ms = EXCLUDED.hot_interval_ms,
           jpeg_quality = EXCLUDED.jpeg_quality,
           max_dim = EXCLUDED.max_dim,
           dedup_hamming = EXCLUDED.dedup_hamming,
           keyframe_max_gap_ms = EXCLUDED.keyframe_max_gap_ms,
           ocr = EXCLUDED.ocr,
           updated_at = NOW()",
        agent_id,
        p.enabled,
        p.interval_ms,
        p.hot_interval_ms,
        p.jpeg_quality,
        p.max_dim,
        p.dedup_hamming,
        p.keyframe_max_gap_ms,
        p.ocr
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove an agent's override so it fully inherits the global settings again.
pub async fn clear_recall_settings_agent(pool: &PgPool, agent_id: Uuid) -> Result<()> {
    sqlx::query!(
        "DELETE FROM recall_settings_agent WHERE agent_id = $1",
        agent_id
    )
    .execute(pool)
    .await?;
    Ok(())
}
