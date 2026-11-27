//! Runtime database access for bounded DNS management. All statements use
//! runtime `sqlx::query*` (no compile-time macros), so no new `.sqlx` cache
//! files are needed. Every mutation takes the household lock in the service
//! layer first; the credential-scoped auth lookup uses the existing h->g->c
//! order from `gateway_db`.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, PgConnection, PgPool};
use uuid::Uuid;

use super::dns_management_dto::{CacheClearView, PendingCacheClearView, PendingRefreshView};

#[derive(Debug, FromRow)]
pub struct ConfigRow {
    pub config_version: i64,
    pub body: Vec<u8>,
    pub body_sha256: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub updated_by: Option<Uuid>,
}

#[derive(Debug, FromRow)]
pub struct DeliveryPinRow {
    pub gateway_id: Uuid,
    pub delivered_version: Option<i64>,
    pub delivered_sha256: Option<String>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub reported_version: Option<i64>,
    pub reported_sha256: Option<String>,
    pub reported_at: Option<DateTime<Utc>>,
    pub status_received_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
pub struct StatusRow {
    pub gateway_id: Uuid,
    pub delivered_version: Option<i64>,
    pub reported_version: Option<i64>,
    pub config_version: Option<i64>,
    pub body_sha256: Option<String>,
    pub report_id: Option<Uuid>,
    pub reported_at: Option<DateTime<Utc>>,
    pub received_at: Option<DateTime<Utc>>,
    pub applied_version: Option<i64>,
    /// Digest of the genuinely delivered applied version, from the ledger.
    pub applied_sha256: Option<String>,
    pub applied_at: Option<DateTime<Utc>>,
    pub applied_error: Option<String>,
    pub generation: Option<i64>,
    pub filter_generation: Option<i64>,
    pub filter_identity: Option<String>,
    pub sources: Option<Value>,
}

#[derive(Debug, FromRow)]
pub struct PendingRow {
    pub source_id: String,
    pub refresh_seq: i64,
    pub config_version: i64,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
pub struct ReportedPinRow {
    pub delivered_version: Option<i64>,
    pub reported_version: Option<i64>,
}

// ─── Desired config ─────────────────────────────────────────────────────────

pub async fn desired_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Option<ConfigRow>> {
    sqlx::query_as::<_, ConfigRow>(
        r"
        SELECT config_version, body, body_sha256,
               created_at, updated_at, updated_by
        FROM network_dns_management_config
        WHERE household_id = $1
        ",
    )
    .bind(household_id)
    .fetch_optional(conn)
    .await
}

pub async fn get_desired(pool: &PgPool, household_id: Uuid) -> sqlx::Result<Option<ConfigRow>> {
    let mut conn = pool.acquire().await?;
    desired_on_conn(&mut conn, household_id).await
}

/// INSERT on version 1, otherwise an exact `old_version + 1` CAS. A stale
/// caller writes zero rows and the service maps it to 409.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_desired_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    config_version: i64,
    body: &[u8],
    body_sha256: &str,
    now: DateTime<Utc>,
    actor: Uuid,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        INSERT INTO network_dns_management_config
            (household_id, config_version, body, body_sha256,
             created_at, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, $5, $6)
        ON CONFLICT (household_id) DO UPDATE SET
            config_version = EXCLUDED.config_version,
            body = EXCLUDED.body,
            body_sha256 = EXCLUDED.body_sha256,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
        WHERE network_dns_management_config.config_version = $2 - 1
        ",
    )
    .bind(household_id)
    .bind(config_version)
    .bind(body)
    .bind(body_sha256)
    .bind(now)
    .bind(actor)
    .execute(conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

// ─── Bounded delivery ledger ────────────────────────────────────────────────

pub async fn insert_delivery_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    config_version: i64,
    body_sha256: &str,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        INSERT INTO network_dns_delivery
            (household_id, gateway_id, kind, config_version, body_sha256, delivered_at)
        VALUES ($1, $2, 'dns', $3, $4, $5)
        ON CONFLICT (household_id, gateway_id, config_version) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(config_version)
    .bind(body_sha256)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Exact version + digest evidence for a delivered config. A status is never
/// accepted only because its version is <= the newest delivery.
pub async fn delivered_digest_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    config_version: i64,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r"
        SELECT body_sha256 FROM network_dns_delivery
        WHERE household_id = $1 AND gateway_id = $2 AND config_version = $3
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(config_version)
    .fetch_optional(conn)
    .await
}

/// Keep the newest `limit` versions plus every pinned version. Pins are the
/// current delivered pointer, the last reported-applied pointer and every
/// config version with an outstanding refresh delivery.
pub async fn prune_delivery_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    limit: i64,
    pins: &[i64],
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        DELETE FROM network_dns_delivery
        WHERE ctid IN (
            SELECT ctid FROM (
                SELECT ctid, config_version,
                       ROW_NUMBER() OVER (ORDER BY config_version DESC) AS rn
                FROM network_dns_delivery
                WHERE household_id = $1 AND gateway_id = $2
            ) ranked
            WHERE rn > $3 AND NOT (config_version = ANY($4::bigint[]))
        )
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(limit)
    .bind(pins)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn delivery_pins_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<(Option<i64>, Option<i64>, Vec<i64>)> {
    let pins = sqlx::query_scalar::<_, i64>(
        r"
        SELECT config_version FROM network_dns_refresh_delivery
        WHERE household_id = $1 AND gateway_id = $2
        UNION
        SELECT config_version FROM network_dns_status
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_all(&mut *conn)
    .await?;
    let pin = sqlx::query_as::<_, ReportedPinRow>(
        r"
        SELECT delivered_version, reported_version FROM network_dns_gateway_state
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await?;
    Ok((
        pin.as_ref().and_then(|p| p.delivered_version),
        pin.as_ref().and_then(|p| p.reported_version),
        pins,
    ))
}

pub async fn upsert_gateway_state_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    delivered_version: i64,
    delivered_sha256: &str,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_dns_gateway_state
            (household_id, gateway_id, kind, delivered_version, delivered_sha256, updated_at)
        VALUES ($1, $2, 'dns', $3, $4, $5)
        ON CONFLICT (household_id, gateway_id) DO UPDATE SET
            delivered_version = EXCLUDED.delivered_version,
            delivered_sha256 = EXCLUDED.delivered_sha256,
            updated_at = EXCLUDED.updated_at
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(delivered_version)
    .bind(delivered_sha256)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn set_reported_pin_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    reported_version: i64,
    reported_sha256: &str,
    reported_at: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        UPDATE network_dns_gateway_state
        SET reported_version = $3, reported_sha256 = $4, reported_at = $5,
            updated_at = $5
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(reported_version)
    .bind(reported_sha256)
    .bind(reported_at)
    .execute(conn)
    .await?;
    Ok(())
}

/// A report with no applied version clears the pin: the worker has the
/// desired config but has not applied any management version.
pub async fn clear_reported_pin_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        UPDATE network_dns_gateway_state
        SET reported_version = NULL, reported_sha256 = NULL, reported_at = NULL,
            updated_at = $3
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn delivery_pins_view(
    pool: &PgPool,
    household_id: Uuid,
) -> sqlx::Result<Vec<DeliveryPinRow>> {
    sqlx::query_as::<_, DeliveryPinRow>(
        r"
        SELECT g.id AS gateway_id,
               s.delivered_version, s.delivered_sha256, s.updated_at AS delivered_at,
               s.reported_version, s.reported_sha256, s.reported_at,
               st.received_at AS status_received_at
        FROM network_gateways g
        LEFT JOIN network_dns_gateway_state s
          ON s.household_id = g.household_id AND s.gateway_id = g.id
        LEFT JOIN network_dns_status st
          ON st.household_id = g.household_id AND st.gateway_id = g.id
        WHERE g.household_id = $1 AND g.kind = 'dns' AND g.revoked_at IS NULL
        ORDER BY g.created_at DESC, g.id
        ",
    )
    .bind(household_id)
    .fetch_all(pool)
    .await
}

// ─── Manual refresh ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct RefreshOutcome {
    pub refresh_seq: i64,
    pub config_version: i64,
    pub expires_at: DateTime<Utc>,
    pub created: bool,
}

#[allow(clippy::too_many_arguments)]
pub async fn request_refresh_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    source_id: &str,
    actor: Uuid,
    now: DateTime<Utc>,
    config_version: i64,
    cooldown_secs: i64,
    ttl_secs: i64,
) -> crate::error::ApiResult<RefreshOutcome> {
    let existing: Option<(i64, DateTime<Utc>, i64, DateTime<Utc>)> = sqlx::query_as(
        r"
        SELECT refresh_seq, requested_at, config_version, expires_at FROM network_dns_refresh_request
        WHERE household_id = $1 AND source_id = $2
        ",
    )
    .bind(household_id)
    .bind(source_id)
    .fetch_optional(&mut *conn)
    .await?;
    let expires_at = DateTime::<Utc>::from_timestamp_micros(
        (now + chrono::Duration::seconds(ttl_secs)).timestamp_micros(),
    )
    .ok_or_else(|| {
        crate::error::ApiError::bad_request("refresh expiry is outside the storage range")
    })?;
    match existing {
        None => {
            sqlx::query(
                r"
                INSERT INTO network_dns_refresh_request
                    (household_id, source_id, refresh_seq, config_version,
                     requested_at, expires_at, requested_by)
                VALUES ($1, $2, 1, $3, $4, $5, $6)
                ",
            )
            .bind(household_id)
            .bind(source_id)
            .bind(config_version)
            .bind(now)
            .bind(expires_at)
            .bind(actor)
            .execute(conn)
            .await?;
            Ok(RefreshOutcome {
                refresh_seq: 1,
                config_version,
                expires_at,
                created: true,
            })
        }
        Some((seq, requested_at, _, _))
            if requested_at <= now - chrono::Duration::seconds(cooldown_secs) =>
        {
            let next = seq
                .checked_add(1)
                .ok_or_else(|| crate::error::ApiError::conflict("refresh sequence is exhausted"))?;
            // A new token invalidates the previous gateway deliveries and their
            // cascading acknowledgments. The household lock serializes this
            // with worker reads/reports, so the next cycle starts independently.
            sqlx::query("DELETE FROM network_dns_refresh_delivery WHERE household_id = $1 AND source_id = $2")
                .bind(household_id).bind(source_id).execute(&mut *conn).await?;
            sqlx::query(
                r"
                UPDATE network_dns_refresh_request
                SET refresh_seq = $3, config_version = $4, requested_at = $5,
                    expires_at = $6, requested_by = $7
                WHERE household_id = $1 AND source_id = $2
                ",
            )
            .bind(household_id)
            .bind(source_id)
            .bind(next)
            .bind(config_version)
            .bind(now)
            .bind(expires_at)
            .bind(actor)
            .execute(conn)
            .await?;
            Ok(RefreshOutcome {
                refresh_seq: next,
                config_version,
                expires_at,
                created: true,
            })
        }
        Some((seq, _, stored_version, stored_expiry)) => Ok(RefreshOutcome {
            refresh_seq: seq,
            config_version: stored_version,
            expires_at: stored_expiry,
            created: false,
        }),
    }
}

pub async fn delete_refresh_for_source_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    source_id: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "DELETE FROM network_dns_refresh_request WHERE household_id = $1 AND source_id = $2",
    )
    .bind(household_id)
    .bind(source_id)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn pending_refreshes_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<Vec<PendingRefreshView>> {
    let rows = sqlx::query_as::<_, PendingRow>(
        r"
        SELECT r.source_id, d.refresh_seq, d.config_version, r.expires_at
        FROM network_dns_refresh_request r
        JOIN network_dns_refresh_delivery d
          ON d.household_id = r.household_id AND d.source_id = r.source_id
        LEFT JOIN network_dns_refresh_ack a
          ON a.household_id = d.household_id AND a.gateway_id = d.gateway_id
         AND a.source_id = d.source_id AND a.refresh_seq = d.refresh_seq
         AND a.config_version = d.config_version
        WHERE r.household_id = $1 AND d.gateway_id = $2
          AND a.gateway_id IS NULL AND r.expires_at > $3
        ORDER BY r.source_id
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(now)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PendingRefreshView {
            source_id: row.source_id,
            refresh_seq: row.refresh_seq as u64,
            config_version: row.config_version as u64,
            expires_at: row.expires_at,
        })
        .collect())
}

pub async fn mark_refresh_delivered_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    source_id: &str,
    refresh_seq: i64,
    config_version: i64,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_dns_refresh_delivery
            (household_id, gateway_id, source_id, refresh_seq, config_version, delivered_at)
        SELECT r.household_id, $2, r.source_id, r.refresh_seq, r.config_version, $6
        FROM network_dns_refresh_request r
        WHERE r.household_id = $1 AND r.source_id = $3
          AND r.refresh_seq = $4 AND r.config_version = $5
          AND r.expires_at > $6
        ON CONFLICT (household_id, gateway_id, source_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(source_id)
    .bind(refresh_seq)
    .bind(config_version)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

/// All unexpired household refresh tokens, used by the scoped worker read to
/// mark per-gateway delivery. A token is never visible until delivered.
pub async fn all_pending_requests_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<Vec<PendingRow>> {
    sqlx::query_as::<_, PendingRow>(
        r"
        SELECT source_id, refresh_seq, config_version, expires_at
        FROM network_dns_refresh_request
        WHERE household_id = $1 AND expires_at > $2
        ORDER BY source_id
        ",
    )
    .bind(household_id)
    .bind(now)
    .fetch_all(conn)
    .await
}

/// Source ids with a live refresh request. Config mutation removes requests
/// for sources that are no longer enabled.
pub async fn refresh_source_ids_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT source_id FROM network_dns_refresh_request WHERE household_id = $1",
    )
    .bind(household_id)
    .fetch_all(conn)
    .await
}

/// Exact delivered-token evidence for one gateway. An ack is rejected when
/// this row does not exist: tokens cannot be guessed or replayed from another
/// gateway or from a removed/re-added source id.
pub async fn delivery_token_exists_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    source_id: &str,
    refresh_seq: i64,
    config_version: i64,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_dns_refresh_delivery
            WHERE household_id = $1 AND gateway_id = $2 AND source_id = $3
              AND refresh_seq = $4 AND config_version = $5
        )
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(source_id)
    .bind(refresh_seq)
    .bind(config_version)
    .fetch_one(conn)
    .await
}

#[derive(Debug, Clone, Copy)]
pub struct AckState {
    pub refresh_seq: i64,
    pub config_version: i64,
}

pub async fn ack_state_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    source_id: &str,
) -> sqlx::Result<Option<AckState>> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        r"
        SELECT refresh_seq, config_version FROM network_dns_refresh_ack
        WHERE household_id = $1 AND gateway_id = $2 AND source_id = $3
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(source_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(refresh_seq, config_version)| AckState {
        refresh_seq,
        config_version,
    }))
}

pub async fn insert_ack_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    source_id: &str,
    refresh_seq: i64,
    config_version: i64,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        INSERT INTO network_dns_refresh_ack
            (household_id, gateway_id, source_id, refresh_seq, config_version, acked_at)
        SELECT d.household_id, d.gateway_id, d.source_id, d.refresh_seq, d.config_version, $6
        FROM network_dns_refresh_delivery d
        WHERE d.household_id = $1 AND d.gateway_id = $2 AND d.source_id = $3
          AND d.refresh_seq = $4 AND d.config_version = $5
        ON CONFLICT (household_id, gateway_id, source_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(source_id)
    .bind(refresh_seq)
    .bind(config_version)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

// ─── Latest status ──────────────────────────────────────────────────────────

pub async fn existing_report_id_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<Uuid>> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT report_id FROM network_dns_status WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_status_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    credential_id: Uuid,
    report_id: Uuid,
    config_version: i64,
    body_sha256: &str,
    reported_at: DateTime<Utc>,
    received_at: DateTime<Utc>,
    applied_version: Option<i64>,
    applied_at: Option<DateTime<Utc>>,
    applied_error: Option<&str>,
    generation: Option<i64>,
    filter_generation: Option<i64>,
    filter_identity: Option<&str>,
    sources: &Value,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_dns_status
            (household_id, gateway_id, credential_id, report_id, config_version,
             body_sha256, reported_at, received_at, applied_version, applied_at,
             applied_error, generation, filter_generation, filter_identity, sources)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (household_id, gateway_id) DO UPDATE SET
            credential_id = EXCLUDED.credential_id,
            report_id = EXCLUDED.report_id,
            config_version = EXCLUDED.config_version,
            body_sha256 = EXCLUDED.body_sha256,
            reported_at = EXCLUDED.reported_at,
            received_at = EXCLUDED.received_at,
            applied_version = EXCLUDED.applied_version,
            applied_at = EXCLUDED.applied_at,
            applied_error = EXCLUDED.applied_error,
            generation = EXCLUDED.generation,
            filter_generation = EXCLUDED.filter_generation,
            filter_identity = EXCLUDED.filter_identity,
            sources = EXCLUDED.sources
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(credential_id)
    .bind(report_id)
    .bind(config_version)
    .bind(body_sha256)
    .bind(reported_at)
    .bind(received_at)
    .bind(applied_version)
    .bind(applied_at)
    .bind(applied_error)
    .bind(generation)
    .bind(filter_generation)
    .bind(filter_identity)
    .bind(sources)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn status_rows(pool: &PgPool, household_id: Uuid) -> sqlx::Result<Vec<StatusRow>> {
    sqlx::query_as::<_, StatusRow>(
        r"
        SELECT g.id AS gateway_id,
               s.delivered_version, s.reported_version,
               st.config_version, st.body_sha256, st.report_id,
               st.reported_at, st.received_at, st.applied_version,
               (SELECT d.body_sha256 FROM network_dns_delivery d
                 WHERE d.household_id = st.household_id AND d.gateway_id = st.gateway_id
                   AND d.config_version = st.applied_version) AS applied_sha256,
               st.applied_at, st.applied_error, st.generation,
               st.filter_generation, st.filter_identity, st.sources
        FROM network_gateways g
        LEFT JOIN network_dns_gateway_state s
          ON s.household_id = g.household_id AND s.gateway_id = g.id
        LEFT JOIN network_dns_status st
          ON st.household_id = g.household_id AND st.gateway_id = g.id
        WHERE g.household_id = $1 AND g.kind = 'dns' AND g.revoked_at IS NULL
        ORDER BY g.created_at DESC, g.id
        ",
    )
    .bind(household_id)
    .fetch_all(pool)
    .await
}

// ─── Cache-clear command (request / delivery / attempt / ack) ────────────────

#[derive(Debug)]
pub struct ClearOutcome {
    pub clear_seq: i64,
    pub config_version: i64,
    pub expires_at: DateTime<Utc>,
    pub created: bool,
}

/// One pending clear token per household. A new cycle after cooldown deletes
/// all prior per-gateway deliveries (and their cascading acks) so repeated
/// cycles are independent and an old token cannot be acked later.
#[allow(clippy::too_many_arguments)]
pub async fn request_clear_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    actor: Uuid,
    now: DateTime<Utc>,
    config_version: i64,
    cooldown_secs: i64,
    ttl_secs: i64,
) -> crate::error::ApiResult<ClearOutcome> {
    let existing: Option<(i64, DateTime<Utc>, i64, DateTime<Utc>)> = sqlx::query_as(
        r"
        SELECT clear_seq, requested_at, config_version, expires_at
        FROM network_dns_cache_clear_request WHERE household_id = $1
        ",
    )
    .bind(household_id)
    .fetch_optional(&mut *conn)
    .await?;
    let expires_at = DateTime::<Utc>::from_timestamp_micros(
        (now + chrono::Duration::seconds(ttl_secs)).timestamp_micros(),
    )
    .ok_or_else(|| {
        crate::error::ApiError::bad_request("clear expiry is outside the storage range")
    })?;
    match existing {
        None => {
            sqlx::query(
                r"
                INSERT INTO network_dns_cache_clear_request
                    (household_id, clear_seq, config_version, requested_at, expires_at, requested_by)
                VALUES ($1, 1, $2, $3, $4, $5)
                ",
            )
            .bind(household_id)
            .bind(config_version)
            .bind(now)
            .bind(expires_at)
            .bind(actor)
            .execute(&mut *conn)
            .await?;
            Ok(ClearOutcome {
                clear_seq: 1,
                config_version,
                expires_at,
                created: true,
            })
        }
        Some((seq, requested_at, _, _))
            if requested_at <= now - chrono::Duration::seconds(cooldown_secs) =>
        {
            let next = seq
                .checked_add(1)
                .ok_or_else(|| crate::error::ApiError::conflict("clear sequence is exhausted"))?;
            sqlx::query("DELETE FROM network_dns_cache_clear_delivery WHERE household_id = $1")
                .bind(household_id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(
                r"
                UPDATE network_dns_cache_clear_request
                SET clear_seq = $2, config_version = $3, requested_at = $4,
                    expires_at = $5, requested_by = $6
                WHERE household_id = $1
                ",
            )
            .bind(household_id)
            .bind(next)
            .bind(config_version)
            .bind(now)
            .bind(expires_at)
            .bind(actor)
            .execute(conn)
            .await?;
            Ok(ClearOutcome {
                clear_seq: next,
                config_version,
                expires_at,
                created: true,
            })
        }
        Some((seq, _, stored_version, stored_expiry)) => Ok(ClearOutcome {
            clear_seq: seq,
            config_version: stored_version,
            expires_at: stored_expiry,
            created: false,
        }),
    }
}

/// Mark delivery only for the exact current token, never for a stale one.
pub async fn mark_clear_delivered_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    now: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_dns_cache_clear_delivery
            (household_id, gateway_id, kind, clear_seq, config_version, requested_at, delivered_at)
        SELECT r.household_id, $2, 'dns', r.clear_seq, r.config_version, r.requested_at, $3
        FROM network_dns_cache_clear_request r
        WHERE r.household_id = $1 AND r.expires_at > $3
        ON CONFLICT (household_id, gateway_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

/// The one pending clear token visible to this gateway, only for a config
/// version that was actually delivered to it, and only until ack/expiry.
pub async fn pending_clear_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    current_config_version: i64,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<PendingCacheClearView>> {
    let row: Option<(i64, i64, DateTime<Utc>)> = sqlx::query_as(
        r"
        SELECT d.clear_seq, d.config_version, r.expires_at
        FROM network_dns_cache_clear_delivery d
        JOIN network_dns_cache_clear_request r
          ON r.household_id = d.household_id AND r.clear_seq = d.clear_seq
         AND r.config_version = d.config_version
        LEFT JOIN network_dns_cache_clear_ack a
          ON a.household_id = d.household_id AND a.gateway_id = d.gateway_id
        WHERE d.household_id = $1 AND d.gateway_id = $2
          AND d.config_version = $3 AND r.expires_at > $4
          AND a.gateway_id IS NULL
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(current_config_version)
    .bind(now)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(
        |(clear_seq, config_version, expires_at)| PendingCacheClearView {
            clear_seq: clear_seq as u64,
            config_version: config_version as u64,
            expires_at,
        },
    ))
}

#[derive(Debug, Clone, Copy)]
pub struct ClearAckState {
    pub clear_seq: i64,
    pub config_version: i64,
}

pub async fn clear_ack_state_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
) -> sqlx::Result<Option<ClearAckState>> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        r"
        SELECT clear_seq, config_version FROM network_dns_cache_clear_ack
        WHERE household_id = $1 AND gateway_id = $2
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(clear_seq, config_version)| ClearAckState {
        clear_seq,
        config_version,
    }))
}

pub async fn clear_token_exists_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    clear_seq: i64,
    config_version: i64,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_dns_cache_clear_delivery
            WHERE household_id = $1 AND gateway_id = $2
              AND clear_seq = $3 AND config_version = $4
        )
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(clear_seq)
    .bind(config_version)
    .fetch_one(conn)
    .await
}

pub async fn insert_clear_ack_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    clear_seq: i64,
    config_version: i64,
    attempted_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let result = sqlx::query(
        r"
        INSERT INTO network_dns_cache_clear_ack
            (household_id, gateway_id, clear_seq, config_version, attempted_at, acked_at)
        SELECT d.household_id, d.gateway_id, d.clear_seq, d.config_version, $5, $6
        FROM network_dns_cache_clear_delivery d
        WHERE d.household_id = $1 AND d.gateway_id = $2
          AND d.clear_seq = $3 AND d.config_version = $4
        ON CONFLICT (household_id, gateway_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(clear_seq)
    .bind(config_version)
    .bind(attempted_at)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Truthful lifecycle view. Every timestamp is the original one: no refresh
/// on restart and no fabricated entry count.
pub async fn clear_states_on_conn(
    conn: &mut PgConnection,
    household_id: Uuid,
) -> sqlx::Result<Vec<(Uuid, CacheClearView)>> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            i64,
            i64,
            DateTime<Utc>,
            DateTime<Utc>,
            Option<DateTime<Utc>>,
            Option<DateTime<Utc>>,
            Option<DateTime<Utc>>,
        ),
    >(
        r"
        SELECT d.gateway_id, d.clear_seq, d.config_version,
               d.requested_at, r.expires_at, d.delivered_at,
               a.attempted_at, a.acked_at
        FROM network_dns_cache_clear_delivery d
        JOIN network_dns_cache_clear_request r
          ON r.household_id = d.household_id AND r.clear_seq = d.clear_seq
         AND r.config_version = d.config_version
        LEFT JOIN network_dns_cache_clear_ack a
          ON a.household_id = d.household_id AND a.gateway_id = d.gateway_id
        WHERE d.household_id = $1
        ORDER BY d.gateway_id
        ",
    )
    .bind(household_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                gateway_id,
                clear_seq,
                config_version,
                requested_at,
                expires_at,
                delivered_at,
                attempted_at,
                acked_at,
            )| {
                (
                    gateway_id,
                    CacheClearView {
                        clear_seq: clear_seq as u64,
                        config_version: config_version as u64,
                        requested_at,
                        expires_at,
                        delivered_at,
                        attempted_at,
                        acked_at,
                    },
                )
            },
        )
        .collect())
}
