//! Logic for durable DNS event ingestion and bounded reads. Auth, validation,
//! clock and retention decisions live here; SQL lives in `dns_events_db`.
//!
//! Ingestion accepts worker observations only. A device id is scoped evidence
//! about a device, never a person. Nothing here reports enforcement, coverage
//! or verification.

use std::collections::HashSet;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::dns_events_db::{self, EventFilter, EventRow};
use super::dns_events_dto::{
    validate_batch, EventBatchBody, EventQueryParams, StatsQueryParams, StatsWindow, MAX_OFFSET,
    MAX_PAGE_LIMIT, MAX_TOP_N,
};
use super::dns_events_retention::DnsEventRetention;
use super::{gateway_auth, gateway_db, gateway_dto, gateway_service};

fn worker_auth_error() -> ApiError {
    ApiError::status(
        axum::http::StatusCode::UNAUTHORIZED,
        "invalid gateway credential",
    )
}

// ─── Worker ingest ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, serde::Serialize)]
pub struct IngestOutcome {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub batch_id: Uuid,
    pub event_count: usize,
    pub inserted: usize,
    pub duplicates: usize,
    pub replayed: bool,
}

/// Ingest one bounded batch under the household lock. Replays with the same
/// `(gateway, batch_id, digest)` are idempotent; the same id with different
/// bytes is rejected so an attacker cannot shadow a prior receipt.
pub async fn ingest(
    pool: &PgPool,
    bearer: Option<&str>,
    body: EventBatchBody,
    now: DateTime<Utc>,
) -> ApiResult<IngestOutcome> {
    if body.audience != gateway_auth::AUDIENCE
        || body.command != gateway_auth::COMMAND_REPORT_DNS_EVENTS
    {
        return Err(worker_auth_error());
    }
    if gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())? != "dns" {
        return Err(worker_auth_error());
    }
    let (events, digest) = validate_batch(&body, now)?;

    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, body.household_id, body.gateway_id).await? {
        return Err(worker_auth_error());
    }
    let worker = gateway_service::authorize_worker_on_conn(
        &mut tx,
        bearer,
        body.household_id,
        body.gateway_id,
        "dns",
        gateway_auth::COMMAND_REPORT_DNS_EVENTS,
        now,
    )
    .await?;

    // Device association is weak evidence and must be scoped to this household.
    let mut checked: HashSet<Uuid> = HashSet::new();
    for event in &events {
        if let Some(device_id) = event.device_id {
            if checked.insert(device_id)
                && !dns_events_db::device_in_household(&mut tx, worker.household_id, device_id)
                    .await?
            {
                return Err(ApiError::bad_request(
                    "device_id is not assigned in this household",
                ));
            }
        }
    }

    if let Some(receipt) = dns_events_db::batch_receipt(
        &mut tx,
        worker.household_id,
        worker.gateway_id,
        body.batch_id,
    )
    .await?
    {
        if receipt.body_sha256 != digest {
            return Err(ApiError::status(
                axum::http::StatusCode::CONFLICT,
                "batch_id was already used with different bytes",
            ));
        }
        let inserted = receipt.inserted_count.max(0) as usize;
        gateway_db::mark_credential_used(&mut tx, worker.id).await?;
        tx.commit().await?;
        return Ok(IngestOutcome {
            household_id: worker.household_id,
            gateway_id: worker.gateway_id,
            batch_id: body.batch_id,
            event_count: receipt.event_count.max(0) as usize,
            inserted,
            duplicates: receipt.event_count.max(0) as usize - inserted,
            replayed: true,
        });
    }

    let mut inserted = 0usize;
    for event in &events {
        if dns_events_db::insert_event(&mut tx, worker.household_id, worker.gateway_id, event)
            .await?
        {
            inserted += 1;
        }
    }
    dns_events_db::insert_receipt(
        &mut tx,
        worker.household_id,
        worker.gateway_id,
        body.batch_id,
        &digest,
        events.len(),
        inserted,
    )
    .await?;

    // Hard caps on every write, including concurrent batches in this household.
    let cfg = DnsEventRetention::from_env().clamped();
    dns_events_db::prune_household_events(
        &mut tx,
        worker.household_id,
        cfg.cutoff(now),
        cfg.max_per_household,
    )
    .await?;
    dns_events_db::prune_household_batches(
        &mut tx,
        worker.household_id,
        cfg.cutoff(now),
        cfg.max_batches_per_household,
    )
    .await?;
    gateway_db::mark_credential_used(&mut tx, worker.id).await?;
    tx.commit().await?;

    Ok(IngestOutcome {
        household_id: worker.household_id,
        gateway_id: worker.gateway_id,
        batch_id: body.batch_id,
        event_count: events.len(),
        inserted,
        duplicates: events.len() - inserted,
        replayed: false,
    })
}

// ─── Bounded read queries ────────────────────────────────────────────────────

fn parse_instant(
    raw: Option<&str>,
    default: DateTime<Utc>,
    field: &'static str,
) -> ApiResult<DateTime<Utc>> {
    match raw {
        None => Ok(default),
        Some(value) => {
            let parsed = chrono::DateTime::parse_from_rfc3339(value.trim())
                .map_err(|_| ApiError::bad_request(field))?;
            Ok(parsed.with_timezone(&Utc))
        }
    }
}

fn parse_u32(
    raw: Option<&str>,
    default: u32,
    min: u32,
    max: u32,
    field: &'static str,
) -> ApiResult<u32> {
    match raw {
        None => Ok(default),
        Some(value) => {
            let parsed: u32 = value
                .trim()
                .parse()
                .map_err(|_| ApiError::bad_request(field))?;
            if !(min..=max).contains(&parsed) {
                return Err(ApiError::bad_request(field));
            }
            Ok(parsed)
        }
    }
}

/// Resolve the bounded window and paging from raw query parameters. The tenant
/// and optional filters are assembled by the caller so normalised strings can
/// be borrowed for the whole snapshot.
fn resolve_window_and_paging(
    params: &EventQueryParams,
    now: DateTime<Utc>,
) -> ApiResult<(DateTime<Utc>, DateTime<Utc>, i64, i64)> {
    let default_from = now - chrono::Duration::hours(24);
    let from = parse_instant(params.from.as_deref(), default_from, "invalid from")?;
    let to = parse_instant(params.to.as_deref(), now, "invalid to")?;
    if from > to {
        return Err(ApiError::bad_request("from must not be after to"));
    }
    if from < now - chrono::Duration::days(super::dns_events_retention::HARD_MAX_AGE_DAYS)
        || to > now + gateway_auth::MAX_FUTURE_SKEW
    {
        return Err(ApiError::bad_request(
            "query window is outside the retention bound",
        ));
    }
    let limit = parse_u32(
        params.limit.as_deref(),
        50,
        1,
        MAX_PAGE_LIMIT,
        "limit must be 1..=200",
    )? as i64;
    let offset = parse_u32(
        params.offset.as_deref(),
        0,
        0,
        MAX_OFFSET,
        "offset must be 0..=100000",
    )? as i64;
    Ok((from, to, limit, offset))
}

/// The row shape the dashboard consumes. Every field is a DNS observation;
/// `person_label` is always null and `evidence` is always the weak
/// `network_observation` value — a DNS worker never verifies a person.
#[derive(Clone, Debug, serde::Serialize)]
pub struct EventView {
    pub event_id: Uuid,
    /// Worker-reported observation time (alias of `observed_at`).
    pub time: DateTime<Utc>,
    pub observed_at: DateTime<Utc>,
    pub received_at: DateTime<Utc>,
    pub source: &'static str,
    pub device_id: Option<Uuid>,
    pub device_label: Option<String>,
    pub person_label: Option<String>,
    pub evidence: &'static str,
    pub domain: String,
    /// `allow` or `deny`, derived from the observation's decision.
    pub effect: &'static str,
    pub allow: bool,
    pub reason: String,
    pub reason_code: String,
    pub policy_revision: Option<i64>,
    pub correlation_id: Option<String>,
    pub protocol: String,
    pub query_type: String,
    pub cache_state: String,
    pub upstream: Option<String>,
    pub applied_rule: Option<String>,
    pub filter_blocked: bool,
    pub filter_source_id: Option<String>,
    pub filter_source_kind: Option<String>,
    pub denied_alias_target: Option<String>,
    pub flags_rd: bool,
    pub flags_cd: bool,
    pub flags_ra: bool,
    pub flags_ad: bool,
}

impl From<EventRow> for EventView {
    fn from(row: EventRow) -> Self {
        Self {
            event_id: row.event_id,
            time: row.observed_at,
            observed_at: row.observed_at,
            received_at: row.received_at,
            source: "dns",
            device_id: row.device_id,
            device_label: row.device_label,
            person_label: None,
            evidence: "network_observation",
            domain: row.name,
            effect: if row.allow { "allow" } else { "deny" },
            allow: row.allow,
            reason: row.reason_code.clone(),
            reason_code: row.reason_code,
            policy_revision: row.policy_revision,
            correlation_id: row.correlation_id,
            protocol: row.protocol,
            query_type: row.query_type,
            cache_state: row.cache_state,
            upstream: row.upstream,
            applied_rule: row.applied_rule,
            filter_blocked: row.filter_blocked,
            filter_source_id: row.filter_source_id,
            filter_source_kind: row.filter_source_kind,
            denied_alias_target: row.denied_alias_target,
            flags_rd: row.flags_rd,
            flags_cd: row.flags_cd,
            flags_ra: row.flags_ra,
            flags_ad: row.flags_ad,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct RetentionView {
    pub keep_days: i64,
    pub oldest_stored: Option<DateTime<Utc>>,
    pub stored_count: i64,
    pub cap_count: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SearchOutcome {
    pub rows: Vec<EventView>,
    pub total: i64,
    pub has_more: bool,
    /// Cursor in cursor mode, offset as a string in offset mode, null at the end.
    pub next: Option<String>,
    pub next_offset: Option<i64>,
    pub next_cursor: Option<String>,
    pub pagination_limited: bool,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub observed_only: bool,
    pub sources: Vec<&'static str>,
    pub unsupported_sources: Vec<&'static str>,
    pub retention: RetentionView,
    /// True when the page was capped or retention/count evictions may have
    /// removed observations that once matched this query.
    pub truncated: bool,
}

const SUPPORTED_SOURCES: &[&str] = &["dns"];
const UNSUPPORTED_SOURCES: &[&str] = &["proxy", "agent"];

/// Opaque keyset cursor over `(observed_at, id)`. No secret or URL is carried.
fn encode_cursor(at: DateTime<Utc>, id: i64) -> String {
    let raw = format!("{}|{}", at.timestamp_micros(), id);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

fn decode_cursor(raw: &str) -> ApiResult<(DateTime<Utc>, i64)> {
    if raw.len() > 128 {
        return Err(ApiError::bad_request("invalid cursor"));
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim())
        .map_err(|_| ApiError::bad_request("invalid cursor"))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| ApiError::bad_request("invalid cursor"))?;
    let (micros, id) = text
        .split_once('|')
        .ok_or_else(|| ApiError::bad_request("invalid cursor"))?;
    let micros: i64 = micros
        .parse()
        .map_err(|_| ApiError::bad_request("invalid cursor"))?;
    let id: i64 = id
        .parse()
        .map_err(|_| ApiError::bad_request("invalid cursor"))?;
    if id <= 0 {
        return Err(ApiError::bad_request("invalid cursor"));
    }
    let at = chrono::DateTime::from_timestamp_micros(micros)
        .ok_or_else(|| ApiError::bad_request("invalid cursor"))?;
    Ok((at, id))
}

/// Paginated search inside one REPEATABLE READ snapshot, so `total` and `rows`
/// cannot contradict each other under concurrent ingestion.
pub async fn search(
    pool: &PgPool,
    hid: Uuid,
    params: &EventQueryParams,
    now: DateTime<Utc>,
) -> ApiResult<SearchOutcome> {
    // Explicit source honesty: this foundation ingests DNS observations only.
    if let Some(source) = params.source.as_deref() {
        if !source.trim().eq_ignore_ascii_case("dns") {
            return Err(ApiError::bad_request(
                "only source=dns is supported; proxy and agent observation ingestion is not implemented",
            ));
        }
    }
    let domain = match (params.domain.as_deref(), params.q.as_deref()) {
        (Some(a), Some(b)) if a.trim() != b.trim() => {
            return Err(ApiError::bad_request("domain and q disagree"));
        }
        (Some(a), _) => Some(super::dns_events_dto::normalize_domain(a)?),
        (None, Some(b)) => Some(super::dns_events_dto::normalize_domain(b)?),
        (None, None) => None,
    };
    let reason = match params.reason.as_deref() {
        Some(value) => Some(super::dns_events_dto::normalize_text(
            value,
            super::dns_events_dto::MAX_REASON_LEN,
            "invalid reason",
        )?),
        None => None,
    };
    let device_id = match params.device_id.as_deref() {
        Some(value) => Some(
            Uuid::parse_str(value.trim())
                .map_err(|_| ApiError::bad_request("invalid device_id"))?,
        ),
        None => None,
    };
    let allow_from_flag = match params.allow.as_deref() {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(ApiError::bad_request("allow must be true or false")),
    };
    let allow_from_decision = match params.decision.as_deref() {
        None => None,
        Some(v) => match v.trim().to_ascii_lowercase().as_str() {
            "allow" | "allowed" => Some(true),
            "deny" | "denied" | "blocked" => Some(false),
            _ => return Err(ApiError::bad_request("decision must be allow or deny")),
        },
    };
    let allow = match (allow_from_flag, allow_from_decision) {
        (Some(a), Some(b)) if a != b => {
            return Err(ApiError::bad_request("allow and decision disagree"));
        }
        (Some(a), _) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let (from, to, limit, offset) = resolve_window_and_paging(params, now)?;
    if params.cursor.is_some() && params.offset.is_some() {
        return Err(ApiError::bad_request(
            "cursor and offset are mutually exclusive",
        ));
    }
    let cursor = match params.cursor.as_deref() {
        Some(raw) => Some(decode_cursor(raw)?),
        None => None,
    };
    let filter = EventFilter {
        household_id: hid,
        domain: domain.as_deref(),
        device_id,
        reason: reason.as_deref(),
        allow,
        from,
        to,
    };

    let cfg = DnsEventRetention::from_env().clamped();
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let total = dns_events_db::count_events(&mut tx, &filter).await?;
    let (raw_rows, has_more) = match cursor {
        Some((at, id)) => {
            let mut fetched =
                dns_events_db::search_events_after(&mut tx, &filter, at, id, limit + 1).await?;
            let more = fetched.len() as i64 > limit;
            fetched.truncate(limit as usize);
            (fetched, more)
        }
        None => {
            let fetched = dns_events_db::search_events(&mut tx, &filter, limit, offset).await?;
            let remaining = total.saturating_sub(offset + fetched.len() as i64);
            (fetched, remaining > 0)
        }
    };
    let state = dns_events_db::retention_state(&mut tx, hid, None).await?;
    tx.commit().await?;

    let next_offset = if cursor.is_none() && has_more {
        let next = offset + raw_rows.len() as i64;
        if next <= MAX_OFFSET as i64 {
            Some(next)
        } else {
            None
        }
    } else {
        None
    };
    let pagination_limited = cursor.is_none() && has_more && next_offset.is_none();
    // Always expose a keyset cursor when more rows exist, so callers can switch
    // from offset paging to a stable cursor without losing their place.
    let next_cursor = if has_more {
        raw_rows
            .last()
            .map(|row| encode_cursor(row.observed_at, row.id))
    } else {
        None
    };
    let next = next_cursor
        .clone()
        .or_else(|| next_offset.map(|n| n.to_string()));
    let rows: Vec<EventView> = raw_rows.into_iter().map(EventView::from).collect();
    let truncated = pagination_limited || state.stored_count >= cfg.max_per_household;

    Ok(SearchOutcome {
        rows,
        total,
        has_more,
        next,
        next_offset,
        next_cursor,
        pagination_limited,
        from: filter.from,
        to: filter.to,
        observed_only: true,
        sources: SUPPORTED_SOURCES.to_vec(),
        unsupported_sources: UNSUPPORTED_SOURCES.to_vec(),
        retention: RetentionView {
            keep_days: cfg.max_age_days,
            oldest_stored: state.oldest,
            stored_count: state.stored_count,
            cap_count: cfg.max_per_household,
        },
        truncated,
    })
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct StatsOutcome {
    pub window: &'static str,
    pub window_secs: i64,
    /// Requested bounds.
    pub window_start: DateTime<Utc>,
    pub window_end: DateTime<Utc>,
    /// Bounds actually covered by retained observations (nullable coverage is
    /// reflected by `shortened` and the stored timestamps below).
    pub actual_window_start: DateTime<Utc>,
    pub actual_window_end: DateTime<Utc>,
    pub retention_days: i64,
    pub oldest_stored: Option<DateTime<Utc>>,
    pub newest_stored: Option<DateTime<Utc>>,
    pub stored_count: i64,
    pub cap_count: i64,
    /// True when the requested window is not fully covered by retained data —
    /// because it is empty, retention removed older rows, or count-cap
    /// evictions dropped observations. Age alone is not the whole story.
    pub shortened: bool,
    pub device_id: Option<Uuid>,
    pub total_queries: i64,
    pub allowed: i64,
    pub blocked: i64,
    pub top_domains: Vec<dns_events_db::NameCount>,
    pub top_domains_truncated: bool,
    pub top_blocked: Vec<dns_events_db::NameCount>,
    pub top_blocked_truncated: bool,
    pub top_devices: Vec<dns_events_db::DeviceCount>,
    pub top_devices_truncated: bool,
    pub unknown_device_queries: i64,
    pub time_series: Vec<dns_events_db::BucketCount>,
    pub observed_only: bool,
    pub sources: Vec<&'static str>,
    pub unsupported_sources: Vec<&'static str>,
}

/// Household or per-device statistics over one supported window. Every figure
/// comes from received, deduplicated observations inside the same window and
/// snapshot; empty buckets are reported as zero, never invented.
pub async fn stats(
    pool: &PgPool,
    hid: Uuid,
    params: &StatsQueryParams,
    device_id_in_household: bool,
    now: DateTime<Utc>,
) -> ApiResult<StatsOutcome> {
    let window = match params.window.as_deref() {
        None => StatsWindow::Day,
        Some(raw) => StatsWindow::parse(raw)
            .ok_or_else(|| ApiError::bad_request("window must be 1h, 24h, 7d or 30d"))?,
    };
    let device_id = match params.device_id.as_deref() {
        None => None,
        Some(value) => {
            if !device_id_in_household {
                return Err(ApiError::bad_request(
                    "device_id is not assigned in this household",
                ));
            }
            Some(
                Uuid::parse_str(value.trim())
                    .map_err(|_| ApiError::bad_request("invalid device_id"))?,
            )
        }
    };
    let from = now - chrono::Duration::seconds(window.seconds());
    let filter = EventFilter {
        household_id: hid,
        domain: None,
        device_id,
        reason: None,
        allow: None,
        from,
        to: now,
    };

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let total = dns_events_db::count_events(&mut tx, &filter).await?;
    let allow_rows = dns_events_db::allow_counts(&mut tx, &filter).await?;
    let mut allowed = 0i64;
    let mut blocked = 0i64;
    for row in allow_rows {
        if row.allow {
            allowed = row.count;
        } else {
            blocked = row.count;
        }
    }
    let mut domains = dns_events_db::top_domains(&mut tx, &filter).await?;
    let top_domains_truncated = domains.len() > MAX_TOP_N;
    domains.truncate(MAX_TOP_N);
    let mut blocked_filter = filter.clone();
    blocked_filter.allow = Some(false);
    let mut blocked_domains = dns_events_db::top_domains(&mut tx, &blocked_filter).await?;
    let top_blocked_truncated = blocked_domains.len() > MAX_TOP_N;
    blocked_domains.truncate(MAX_TOP_N);
    let (mut devices, unknown) = dns_events_db::top_devices(&mut tx, &filter).await?;
    let top_devices_truncated = devices.len() > MAX_TOP_N;
    devices.truncate(MAX_TOP_N);
    let series = dns_events_db::time_series(
        &mut tx,
        &filter,
        window.bucket_seconds(),
        window.bucket_count(),
    )
    .await?;
    let cfg = DnsEventRetention::from_env().clamped();
    let scoped = dns_events_db::retention_state(&mut tx, hid, device_id).await?;
    let household = dns_events_db::retention_state(&mut tx, hid, None).await?;
    tx.commit().await?;

    // Honest coverage: the requested window can be shortened by age pruning,
    // by count-cap eviction, or simply by having no observations at one end.
    let cap_reached = household.stored_count >= cfg.max_per_household;
    let shortened = household.stored_count == 0
        || cap_reached
        || scoped.oldest.map(|t| t > from).unwrap_or(true)
        || scoped
            .newest
            .map(|t| t < now - chrono::Duration::seconds(60))
            .unwrap_or(true);
    let actual_start = scoped.oldest.map(|t| t.max(from)).unwrap_or(from);
    let actual_end = scoped.newest.map(|t| t.min(now)).unwrap_or(now);

    Ok(StatsOutcome {
        window: window.as_str(),
        window_secs: window.seconds(),
        window_start: from,
        window_end: now,
        actual_window_start: actual_start,
        actual_window_end: actual_end,
        retention_days: cfg.max_age_days,
        oldest_stored: scoped.oldest,
        newest_stored: scoped.newest,
        stored_count: household.stored_count,
        cap_count: cfg.max_per_household,
        shortened,
        device_id,
        total_queries: total,
        allowed,
        blocked,
        top_domains: domains,
        top_domains_truncated,
        top_blocked: blocked_domains,
        top_blocked_truncated,
        top_devices: devices,
        top_devices_truncated,
        unknown_device_queries: unknown,
        time_series: series,
        observed_only: true,
        sources: SUPPORTED_SOURCES.to_vec(),
        unsupported_sources: UNSUPPORTED_SOURCES.to_vec(),
    })
}

#[cfg(test)]
mod cursor_tests {
    use super::*;

    #[test]
    fn cursor_preserves_postgres_microseconds_and_bounds_decoding() {
        let at = DateTime::from_timestamp_micros(1_700_000_000_123_456).unwrap();
        assert_eq!(decode_cursor(&encode_cursor(at, 42)).unwrap(), (at, 42));
        assert!(decode_cursor(&"A".repeat(129)).is_err());
    }
}
