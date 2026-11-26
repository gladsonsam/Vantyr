//! SQL for durable DNS event observations. All statements use the runtime
//! `sqlx` API: search/stat predicates are assembled dynamically, and keeping
//! them here avoids any change to the committed compile-time query cache.
//!
//! This module only runs SQL. Validation, auth, retention policy and clock
//! decisions live in the service/retention modules.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgConnection, PgPool, Postgres, QueryBuilder};
use uuid::Uuid;

use super::dns_events_dto::{ValidEvent, MAX_TOP_N};

#[derive(Clone, Debug, FromRow, serde::Serialize)]
pub struct EventRow {
    pub id: i64,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub event_id: Uuid,
    pub device_id: Option<Uuid>,
    pub observed_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
    pub name: String,
    pub query_type: String,
    pub protocol: String,
    pub allow: bool,
    pub reason_code: String,
    pub policy_revision: Option<i64>,
    pub applied_rule: Option<String>,
    pub upstream: Option<String>,
    pub cache_state: String,
    pub flags_rd: bool,
    pub flags_cd: bool,
    pub flags_ra: bool,
    pub flags_ad: bool,
    pub filter_blocked: bool,
    pub filter_source_id: Option<String>,
    pub filter_source_kind: Option<String>,
    pub denied_alias_target: Option<String>,
    pub correlation_id: Option<String>,
    /// Join label from the household's device inventory; weak, never a person.
    pub device_label: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct BatchReceipt {
    pub body_sha256: String,
    pub event_count: i32,
    pub inserted_count: i32,
}

const EVENT_COLUMNS: &str = r"
    network_dns_events.id AS id, network_dns_events.household_id AS household_id,
    network_dns_events.gateway_id AS gateway_id, network_dns_events.event_id AS event_id,
    network_dns_events.device_id AS device_id, network_dns_events.observed_at AS observed_at,
    network_dns_events.received_at AS received_at, network_dns_events.name AS name,
    network_dns_events.query_type AS query_type, network_dns_events.protocol AS protocol,
    network_dns_events.allow AS allow, network_dns_events.reason_code AS reason_code,
    network_dns_events.policy_revision AS policy_revision,
    network_dns_events.applied_rule AS applied_rule, network_dns_events.upstream AS upstream,
    network_dns_events.cache_state AS cache_state, network_dns_events.flags_rd AS flags_rd,
    network_dns_events.flags_cd AS flags_cd, network_dns_events.flags_ra AS flags_ra,
    network_dns_events.flags_ad AS flags_ad, network_dns_events.filter_blocked AS filter_blocked,
    network_dns_events.filter_source_id AS filter_source_id,
    network_dns_events.filter_source_kind AS filter_source_kind,
    network_dns_events.denied_alias_target AS denied_alias_target,
    network_dns_events.correlation_id AS correlation_id
";

/// A weak association is accepted only when the device is actually assigned
/// inside this household. It identifies a device, never a person.
pub async fn device_in_household(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Uuid,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"SELECT EXISTS (
            SELECT 1 FROM network_assignments
            WHERE household_id = $1 AND device_id = $2
        )",
    )
    .bind(household_id)
    .bind(device_id)
    .fetch_one(conn)
    .await
}

pub async fn batch_receipt(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    batch_id: Uuid,
) -> sqlx::Result<Option<BatchReceipt>> {
    sqlx::query_as::<_, BatchReceipt>(
        r"SELECT body_sha256, event_count, inserted_count
          FROM network_dns_event_batches
          WHERE household_id = $1 AND gateway_id = $2 AND batch_id = $3",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(batch_id)
    .fetch_optional(conn)
    .await
}

/// Insert one validated event. Duplicate `(household_id, event_id)` rows are
/// ignored so a replay cannot double-count an observation.
#[allow(clippy::too_many_arguments)]
pub async fn insert_event(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    event: &ValidEvent,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        r"
        INSERT INTO network_dns_events (
            household_id, gateway_id, event_id, device_id, observed_at, name,
            query_type, protocol, allow, reason_code, policy_revision, applied_rule,
            upstream, cache_state, flags_rd, flags_cd, flags_ra, flags_ad,
            filter_blocked, filter_source_id, filter_source_kind, denied_alias_target,
            correlation_id
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20, $21, $22, $23
        )
        ON CONFLICT (household_id, event_id) DO NOTHING
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(event.event_id)
    .bind(event.device_id)
    .bind(event.observed_at)
    .bind(&event.name)
    .bind(&event.query_type)
    .bind(&event.protocol)
    .bind(event.allow)
    .bind(&event.reason_code)
    .bind(event.policy_revision)
    .bind(&event.applied_rule)
    .bind(&event.upstream)
    .bind(&event.cache_state)
    .bind(event.flags.rd)
    .bind(event.flags.cd)
    .bind(event.flags.ra)
    .bind(event.flags.ad)
    .bind(event.filter_blocked)
    .bind(&event.filter_source_id)
    .bind(&event.filter_source_kind)
    .bind(&event.denied_alias_target)
    .bind(&event.correlation_id)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_receipt(
    conn: &mut PgConnection,
    household_id: Uuid,
    gateway_id: Uuid,
    batch_id: Uuid,
    digest: &str,
    event_count: usize,
    inserted_count: usize,
) -> sqlx::Result<()> {
    sqlx::query(
        r"
        INSERT INTO network_dns_event_batches (
            household_id, gateway_id, batch_id, body_sha256, event_count, inserted_count
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ",
    )
    .bind(household_id)
    .bind(gateway_id)
    .bind(batch_id)
    .bind(digest)
    .bind(event_count as i32)
    .bind(inserted_count as i32)
    .execute(conn)
    .await?;
    Ok(())
}

/// Enforce the household count cap inside the ingest transaction, so concurrent
/// batches for the same household cannot grow the table without bound.
pub async fn prune_household_events(
    conn: &mut PgConnection,
    household_id: Uuid,
    cutoff: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        DELETE FROM network_dns_events
        WHERE household_id = $1 AND (
            observed_at < $2
            OR id NOT IN (
                SELECT id FROM network_dns_events
                WHERE household_id = $1
                ORDER BY observed_at DESC, id DESC
                LIMIT $3
            )
        )
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .bind(max_per_household)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

pub async fn prune_household_batches(
    conn: &mut PgConnection,
    household_id: Uuid,
    cutoff: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        DELETE FROM network_dns_event_batches
        WHERE household_id = $1 AND (
            received_at < $2
            OR (household_id, gateway_id, batch_id) NOT IN (
                SELECT household_id, gateway_id, batch_id
                FROM network_dns_event_batches
                WHERE household_id = $1
                ORDER BY received_at DESC, gateway_id DESC, batch_id DESC
                LIMIT $3
            )
        )
        ",
    )
    .bind(household_id)
    .bind(cutoff)
    .bind(max_per_household)
    .execute(conn)
    .await?;
    Ok(res.rows_affected())
}

/// Production sweep for idle households. Bounded age + count in one statement.
pub async fn prune_all_events(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        DELETE FROM network_dns_events e
        WHERE e.observed_at < $1
           OR e.id IN (
                SELECT ranked.id FROM (
                    SELECT id, row_number() OVER (
                        PARTITION BY household_id
                        ORDER BY observed_at DESC, id DESC
                    ) AS rn
                    FROM network_dns_events
                ) ranked
                WHERE ranked.rn > $2
           )
        ",
    )
    .bind(cutoff)
    .bind(max_per_household)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

pub async fn prune_all_batches(
    pool: &PgPool,
    cutoff: DateTime<Utc>,
    max_per_household: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        r"
        DELETE FROM network_dns_event_batches b
        WHERE b.received_at < $1
           OR (b.household_id, b.gateway_id, b.batch_id) IN (
                SELECT ranked.household_id, ranked.gateway_id, ranked.batch_id FROM (
                    SELECT household_id, gateway_id, batch_id,
                           row_number() OVER (
                               PARTITION BY household_id
                               ORDER BY received_at DESC, gateway_id DESC, batch_id DESC
                           ) AS rn
                    FROM network_dns_event_batches
                ) ranked
                WHERE ranked.rn > $2
           )
        ",
    )
    .bind(cutoff)
    .bind(max_per_household)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

// ─── Bounded reads ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct EventFilter<'a> {
    pub household_id: Uuid,
    pub domain: Option<&'a str>,
    pub device_id: Option<Uuid>,
    pub reason: Option<&'a str>,
    pub allow: Option<bool>,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
}

/// Escape LIKE wildcards so a search term is literal. Bound and deterministic.
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Append the shared tenant + time + optional filters as ` AND ...` clauses.
/// The identical predicate is used for the page, the total, top-domain,
/// top-device and time-series queries inside one REPEATABLE READ snapshot, so
/// counts cannot disagree. An alias prefix (`""` or `"e."`) keeps it reusable
/// in joined queries.
fn push_conditions(qb: &mut QueryBuilder<Postgres>, filter: &EventFilter<'_>, alias: &str) {
    let c = |name: &str| -> String { format!("{alias}{name}") };
    qb.push(" AND ");
    qb.push(c("household_id"));
    qb.push(" = ");
    qb.push_bind(filter.household_id);
    qb.push(" AND ");
    qb.push(c("observed_at"));
    qb.push(" >= ");
    qb.push_bind(filter.from);
    qb.push(" AND ");
    qb.push(c("observed_at"));
    qb.push(" <= ");
    qb.push_bind(filter.to);
    if let Some(domain) = filter.domain {
        qb.push(" AND ");
        qb.push(c("name"));
        qb.push(" LIKE '%' || ");
        qb.push_bind(escape_like(domain));
        qb.push(" || '%' ESCAPE '\\'");
    }
    if let Some(device_id) = filter.device_id {
        qb.push(" AND ");
        qb.push(c("device_id"));
        qb.push(" = ");
        qb.push_bind(device_id);
    }
    if let Some(reason) = filter.reason {
        qb.push(" AND ");
        qb.push(c("reason_code"));
        qb.push(" = ");
        qb.push_bind(reason.to_string());
    }
    if let Some(allow) = filter.allow {
        qb.push(" AND ");
        qb.push(c("allow"));
        qb.push(" = ");
        qb.push_bind(allow);
    }
}

fn push_where(qb: &mut QueryBuilder<Postgres>, filter: &EventFilter<'_>) {
    qb.push(" WHERE 1 = 1");
    push_conditions(qb, filter, "network_dns_events.");
}

pub async fn count_events(conn: &mut PgConnection, filter: &EventFilter<'_>) -> sqlx::Result<i64> {
    let mut qb = QueryBuilder::<Postgres>::new("SELECT COUNT(*)::bigint FROM network_dns_events");
    push_where(&mut qb, filter);
    let row: (i64,) = qb.build_query_as().fetch_one(conn).await?;
    Ok(row.0)
}

pub async fn search_events(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<EventRow>> {
    let mut qb = QueryBuilder::<Postgres>::new(format!(
        "SELECT {EVENT_COLUMNS}, d.label AS device_label FROM network_dns_events
         LEFT JOIN network_devices d ON d.id = network_dns_events.device_id"
    ));
    push_where(&mut qb, filter);
    qb.push(" ORDER BY network_dns_events.observed_at DESC, network_dns_events.id DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);
    qb.build_query_as::<EventRow>().fetch_all(conn).await
}

#[derive(Clone, Debug, FromRow)]
pub struct RetentionState {
    pub stored_count: i64,
    pub oldest: Option<DateTime<Utc>>,
    pub newest: Option<DateTime<Utc>>,
}

/// Actual retained coverage for the household (or one device), independent of
/// the read filters. Used to report shortened windows honestly.
pub async fn retention_state(
    conn: &mut PgConnection,
    household_id: Uuid,
    device_id: Option<Uuid>,
) -> sqlx::Result<RetentionState> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*)::bigint AS stored_count, MIN(observed_at) AS oldest, MAX(observed_at) AS newest FROM network_dns_events WHERE household_id = ",
    );
    qb.push_bind(household_id);
    if let Some(device_id) = device_id {
        qb.push(" AND device_id = ");
        qb.push_bind(device_id);
    }
    qb.build_query_as::<RetentionState>().fetch_one(conn).await
}

/// Keyset cursor: `(observed_at, id)` strictly older than the last row.
pub async fn search_events_after(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
    cursor_at: DateTime<Utc>,
    cursor_id: i64,
    limit: i64,
) -> sqlx::Result<Vec<EventRow>> {
    let mut qb = QueryBuilder::<Postgres>::new(format!(
        "SELECT {EVENT_COLUMNS}, d.label AS device_label FROM network_dns_events
         LEFT JOIN network_devices d ON d.id = network_dns_events.device_id"
    ));
    push_where(&mut qb, filter);
    qb.push(" AND (network_dns_events.observed_at < ");
    qb.push_bind(cursor_at);
    qb.push(" OR (network_dns_events.observed_at = ");
    qb.push_bind(cursor_at);
    qb.push(" AND network_dns_events.id < ");
    qb.push_bind(cursor_id);
    qb.push(")) ORDER BY network_dns_events.observed_at DESC, network_dns_events.id DESC LIMIT ");
    qb.push_bind(limit);
    qb.build_query_as::<EventRow>().fetch_all(conn).await
}

#[derive(Clone, Copy, Debug, FromRow)]
pub struct AllowCount {
    pub allow: bool,
    pub count: i64,
}

pub async fn allow_counts(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
) -> sqlx::Result<Vec<AllowCount>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT allow, COUNT(*)::bigint AS count FROM network_dns_events",
    );
    push_where(&mut qb, filter);
    qb.push(" GROUP BY allow");
    qb.build_query_as::<AllowCount>().fetch_all(conn).await
}

#[derive(Clone, Debug, FromRow, serde::Serialize)]
pub struct NameCount {
    pub name: String,
    pub count: i64,
}

#[derive(Clone, Debug, FromRow, serde::Serialize)]
pub struct DeviceCount {
    pub device_id: Uuid,
    pub count: i64,
}

#[derive(Clone, Debug, FromRow, serde::Serialize)]
pub struct BucketCount {
    pub bucket: DateTime<Utc>,
    pub count: i64,
}

pub async fn top_domains(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
) -> sqlx::Result<Vec<NameCount>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT name, COUNT(*)::bigint AS count FROM network_dns_events",
    );
    push_where(&mut qb, filter);
    qb.push(" GROUP BY name ORDER BY count DESC, name ASC LIMIT ");
    qb.push_bind(MAX_TOP_N as i64 + 1);
    qb.build_query_as::<NameCount>().fetch_all(conn).await
}

pub async fn top_devices(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
) -> sqlx::Result<(Vec<DeviceCount>, i64)> {
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*) FILTER (WHERE device_id IS NULL)::bigint AS unknown FROM network_dns_events",
    );
    push_where(&mut qb, filter);
    let unknown: (i64,) = qb.build_query_as().fetch_one(&mut *conn).await?;

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT device_id, COUNT(*)::bigint AS count FROM network_dns_events",
    );
    push_where(&mut qb, filter);
    qb.push(
        " AND device_id IS NOT NULL GROUP BY device_id ORDER BY count DESC, device_id ASC LIMIT ",
    );
    qb.push_bind(MAX_TOP_N as i64 + 1);
    let rows = qb.build_query_as::<DeviceCount>().fetch_all(conn).await?;
    Ok((rows, unknown.0))
}

/// Time series over fixed-width buckets with honest zeros for empty buckets.
/// Every bucket uses the same tenant/time/filter predicate as the total.
pub async fn time_series(
    conn: &mut PgConnection,
    filter: &EventFilter<'_>,
    bucket_seconds: i64,
    bucket_count: i64,
) -> sqlx::Result<Vec<BucketCount>> {
    let mut qb = QueryBuilder::<Postgres>::new(
        r"
        SELECT b.bucket AS bucket, COUNT(e.id)::bigint AS count
        FROM generate_series(0, ",
    );
    qb.push_bind(bucket_count - 1);
    qb.push(
        r") AS g(i)
        CROSS JOIN LATERAL (
            SELECT ",
    );
    qb.push_bind(filter.from);
    qb.push(" + make_interval(secs => (g.i * ");
    qb.push_bind(bucket_seconds);
    qb.push(
        r")::double precision) AS bucket
        ) AS b
        LEFT JOIN network_dns_events e
          ON e.observed_at >= b.bucket
         AND (e.observed_at < b.bucket + make_interval(secs => ",
    );
    qb.push_bind(bucket_seconds);
    qb.push("::double precision) OR (g.i = ");
    qb.push_bind(bucket_count - 1);
    qb.push(" AND e.observed_at = ");
    qb.push_bind(filter.to);
    qb.push("))");
    // Same predicate as the other queries, with the joined alias. Empty
    // buckets still produce a row with count zero.
    push_conditions(&mut qb, filter, "e.");
    qb.push(" GROUP BY b.bucket ORDER BY b.bucket");
    qb.build_query_as::<BucketCount>().fetch_all(conn).await
}
