//! Database operations.
//!
//! All queries use the non-macro `sqlx::query()` / `sqlx::query_scalar()` API
//! so the server compiles without a running database (no `SQLX_OFFLINE` flag
//! needed in CI or Docker builds).

// Re-exported (`pub(crate)`) so the `db/` submodules can pull the whole shared prelude with a
// single `use super::*;`.
pub(crate) use anyhow::Result;
pub(crate) use base64::engine::general_purpose::URL_SAFE_NO_PAD;
pub(crate) use base64::Engine as _;
pub(crate) use chrono::{DateTime, TimeZone, Utc};
pub(crate) use rand::{Rng, RngCore};
pub(crate) use serde::Serialize;
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use sqlx::{PgPool, Row};
pub(crate) use std::collections::HashMap;
pub(crate) use uuid::Uuid;

pub(crate) use crate::url_categorization;

pub(crate) use argon2::password_hash::{
    PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
pub(crate) use argon2::Argon2;
pub(crate) use rand::rngs::OsRng;

// Submodules carved out of the original monolithic `db.rs`. Each is `pub use`d so existing
// `db::<fn>` call sites keep working unchanged (facade pattern).
mod agent_groups;
mod agents;
mod alert_rules;
mod app_block;
mod internet_block;
mod queries;
mod software;
mod telemetry;
mod users_sessions;
pub use agent_groups::*;
pub use agents::*;
pub use alert_rules::*;
pub use app_block::*;
pub use internet_block::*;
pub use queries::*;
pub use software::*;
pub use telemetry::*;
pub use users_sessions::*;

/// Mirrors each persisted audit row to `tracing` so `docker logs` matches the dashboard log.
pub(crate) fn emit_audit_tracing_line(
    actor: &str,
    action: &str,
    status: &str,
    client_ip: Option<&str>,
) {
    let ip = client_ip.unwrap_or("-");
    match status {
        "error" => tracing::error!(
            target: "vantyr_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        "rejected" => tracing::warn!(
            target: "vantyr_audit",
            actor,
            action,
            status,
            ip,
            "audit"
        ),
        _ => tracing::info!(
            target: "vantyr_audit",
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
    /// Monitoring channels only: which metric (`resource`) — cpu_pct/mem_pct/disk_pct.
    pub metric: Option<&'a str>,
    /// Monitoring channels only: `gt` | `lt` (`resource`).
    pub comparator: Option<&'a str>,
    /// Monitoring channels only: percent threshold (`resource`).
    pub threshold: Option<f32>,
    /// Monitoring channels only: offline grace / sustained breach seconds.
    pub duration_secs: Option<i32>,
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

                // url_sessions (time-on-site) is parallel raw navigation telemetry
                // to url_visits; without this it grows forever and silently bypasses
                // the operator-configured URL retention. Use ts_start (indexed).
                sqlx::query(
                    "DELETE FROM url_sessions WHERE agent_id = $1 AND ts_start < NOW() - ($2::bigint * INTERVAL '1 day')",
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

/// Delete stale scheduled-script execution rows (by `created_at`).
///
/// This table is append-only — one row per (script, agent) per fire/trigger — and
/// nothing else bounds it, so without this it grows without limit. Index
/// `idx_sse_created_at` (migration 0053) serves the predicate.
pub async fn prune_script_executions_by_age(pool: &PgPool, days: i64) -> Result<u64> {
    let r = sqlx::query(
        "DELETE FROM scheduled_script_executions WHERE created_at < NOW() - ($1::bigint * INTERVAL '1 day')",
    )
    .bind(days)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Optional extra pruning (alert history + old software rows + script executions).
/// Telemetry uses [`prune_telemetry_by_retention`].
pub async fn prune_auxiliary_retention(
    pool: &PgPool,
    alert_event_days: Option<i64>,
    software_inventory_days: Option<i64>,
    script_execution_days: Option<i64>,
    metrics_days: Option<i64>,
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
    if let Some(d) = script_execution_days {
        let n = prune_script_executions_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(
                rows = n,
                "pruned old scheduled_script_executions by retention"
            );
        }
    }
    if let Some(d) = metrics_days {
        let n = prune_metrics_by_age(pool, d).await?;
        if n > 0 {
            tracing::info!(rows = n, "pruned old agent_metrics by retention");
        }
    }
    Ok(())
}

// ─── Agent local UI password (Argon2 PHC string) ───

/// Vantyr value meaning “no local UI password” when pushed to the agent.
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

// ─── Utility ──────────────────────────────────────────────────────────────────

pub(crate) fn unix_to_dt(ts: Option<i64>) -> DateTime<Utc> {
    ts.and_then(|s| Utc.timestamp_opt(s, 0).single())
        .unwrap_or_else(Utc::now)
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

    #[test]
    fn unique_violation_detection_is_conservative() {
        // A non-database error is never treated as a unique violation.
        assert!(!pg_is_unique_violation(&sqlx::Error::RowNotFound));
    }
}
