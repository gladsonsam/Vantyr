//! Bounded Stage A control plane for DNS list/service management.
//!
//! Everything here saves DESIRE and records worker-reported observations.
//! Nothing claims that a gateway applied, enforced or verified anything.
//! The immutable policy history, policy revisions, original publication time
//! and desired-policy assignments are never read or written by this module.
//! The DNS worker consumer is a separate subsequent stage.

use std::collections::BTreeSet;

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::dns_management_db as db;
use super::dns_management_dto as dto;
use super::{authz, db as network_db, gateway_auth, gateway_db, gateway_dto, gateway_service};
use dto::{
    AppliedView, CacheClearBody, CacheClearResult, DeliveryView, DesiredView, ManagementConfig,
    ManagementConfigV2, ManagementView, PatchBody, PatchResult, RefreshResult, ReportedStatusView,
    RuntimeSettingsDto, SourceStatusDto, StatusView, SupportedView, WorkerReadBody,
    WorkerReadResponse, WorkerStatusBody, CACHE_CLEAR_COOLDOWN_SECS, CACHE_CLEAR_TTL_SECS,
    CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION_V2, DELIVERY_HISTORY, MAX_CONFIG_BYTES,
    REFRESH_COOLDOWN_SECS, REFRESH_TTL_SECS,
};

fn worker_auth_error() -> ApiError {
    ApiError::Status(
        StatusCode::UNAUTHORIZED,
        "invalid gateway credential".to_string(),
    )
}

/// One stored desired config. v1 is never coerced into v2 on read; the v2
/// upgrade is an explicit PATCH operation with a real version/digest bump.
#[derive(Clone)]
enum StoredConfig {
    V1(ManagementConfig),
    V2(ManagementConfigV2),
}

impl StoredConfig {
    fn schema_version(&self) -> i32 {
        match self {
            Self::V1(_) => CONFIG_SCHEMA_VERSION,
            Self::V2(_) => CONFIG_SCHEMA_VERSION_V2,
        }
    }
    fn sources(&self) -> &[dto::SubscriptionSourceDto] {
        match self {
            Self::V1(config) => &config.sources,
            Self::V2(config) => &config.sources,
        }
    }
    fn as_v2(&self) -> ManagementConfigV2 {
        match self {
            Self::V1(config) => ManagementConfigV2 {
                sources: config.sources.clone(),
                catalog: config.catalog.clone(),
                selected_services: config.selected_services.clone(),
                runtime: RuntimeSettingsDto::default(),
            },
            Self::V2(config) => config.clone(),
        }
    }
}

fn config_from_row(row: &db::ConfigRow) -> ApiResult<StoredConfig> {
    match row.schema_version {
        CONFIG_SCHEMA_VERSION => serde_json::from_slice(&row.body)
            .map(StoredConfig::V1)
            .map_err(|e| ApiError::Internal(e.into())),
        CONFIG_SCHEMA_VERSION_V2 => serde_json::from_slice(&row.body)
            .map(StoredConfig::V2)
            .map_err(|e| ApiError::Internal(e.into())),
        _ => Err(ApiError::not_found("unsupported stored management schema")),
    }
}

fn desired_view(row: &db::ConfigRow, config: &StoredConfig) -> DesiredView {
    let (v1, v2) = match config {
        StoredConfig::V1(config) => (Some(config.clone()), None),
        StoredConfig::V2(config) => (None, Some(config.clone())),
    };
    DesiredView {
        config_version: row.config_version as u64,
        schema_version: config.schema_version(),
        body_sha256: row.body_sha256.clone(),
        config: v1,
        config_v2: v2,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
    }
}

fn delivery_views(rows: &[db::DeliveryPinRow]) -> Vec<DeliveryView> {
    rows.iter()
        .map(|row| DeliveryView {
            gateway_id: row.gateway_id,
            delivered_version: row.delivered_version.map(|v| v as u64),
            delivered_sha256: row.delivered_sha256.clone(),
            delivered_at: row.delivered_at,
            reported_version: row.reported_version.map(|v| v as u64),
            reported_sha256: row.reported_sha256.clone(),
            reported_at: row.reported_at,
            status_received_at: row.status_received_at,
        })
        .collect()
}

/// `GET .../dns/management`: desired config, delivery pointers and honest
/// capability map. An empty household returns `desired: null` with 200.
pub async fn get_view(pool: &PgPool, household_id: Uuid) -> ApiResult<ManagementView> {
    let desired = match db::get_desired(pool, household_id).await? {
        Some(row) => {
            let config = config_from_row(&row)?;
            Some(desired_view(&row, &config))
        }
        None => None,
    };
    let pins = db::delivery_pins_view(pool, household_id).await?;
    Ok(ManagementView {
        desired,
        delivery: delivery_views(&pins),
        supported: SupportedView::default(),
    })
}

/// Atomic, household-locked PATCH with exact CAS on `expected_config_version`.
/// A caller cannot set a version, timestamp, digest or household id.
pub async fn patch(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    body: PatchBody,
    now: DateTime<Utc>,
) -> ApiResult<PatchResult> {
    if body.operations.is_empty() {
        return Err(ApiError::bad_request("operations must not be empty"));
    }

    let mut tx = pool.begin().await?;
    network_db::lock_household(&mut tx, household_id).await?;
    if !authz::has_grant_on_conn(&mut tx, actor, household_id, authz::NetworkGrant::Admin).await? {
        return Err(ApiError::forbidden());
    }
    let current = db::desired_on_conn(&mut tx, household_id).await?;
    let current_version = current
        .as_ref()
        .map(|row| row.config_version as u64)
        .unwrap_or(0);
    if body.expected_config_version != current_version {
        return Err(ApiError::conflict(
            "expected_config_version is stale; reload the desired config",
        ));
    }

    let current_config = match &current {
        Some(row) => config_from_row(row)?,
        None => StoredConfig::V1(ManagementConfig::default()),
    };
    let mut schema_version = current_config.schema_version();
    // Work on the v2 superset so an explicit runtime op can upgrade in one
    // atomic CAS. A v1 batch without a runtime op serializes back to v1 bytes.
    let mut config = current_config.as_v2();

    for operation in body.operations {
        match operation {
            dto::PatchOperation::AddList { source } => {
                if let Some(existing) = config.sources.iter().find(|s| s.id == source.id) {
                    if *existing == source {
                        continue; // identical re-add is an honest no-op
                    }
                    return Err(ApiError::conflict(
                        "a different source with that id already exists",
                    ));
                }
                config.sources.push(source);
            }
            dto::PatchOperation::RemoveList { id } => {
                let before = config.sources.len();
                config.sources.retain(|s| s.id != id);
                if config.sources.len() == before {
                    return Err(ApiError::not_found("source id not found in desired config"));
                }
            }
            dto::PatchOperation::SetList { id, patch } => {
                let source = config
                    .sources
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or_else(|| ApiError::not_found("source id not found in desired config"))?;
                if let Some(url) = patch.url {
                    source.url = url;
                }
                if let Some(format) = patch.format {
                    source.format = format;
                }
                if let Some(enabled) = patch.enabled {
                    source.enabled = enabled;
                }
                if let Some(interval) = patch.interval_secs {
                    source.interval_secs = interval;
                }
                if let Some(stale) = patch.max_stale_secs {
                    source.max_stale_secs = stale;
                }
                if let Some(metadata) = patch.metadata {
                    source.metadata = metadata;
                }
            }
            dto::PatchOperation::SetCatalog { catalog } => {
                config.catalog = Some(catalog);
            }
            dto::PatchOperation::SelectServices { ids } => {
                config.selected_services = ids;
            }
            dto::PatchOperation::SetRuntimeSettings { runtime } => {
                dto::validate_runtime_settings(&runtime)?;
                config.runtime = runtime;
                schema_version = CONFIG_SCHEMA_VERSION_V2;
            }
            dto::PatchOperation::ResetRuntimeSettings {} => {
                config.runtime = RuntimeSettingsDto::default();
                schema_version = CONFIG_SCHEMA_VERSION;
            }
        }
    }

    let bytes = if schema_version == CONFIG_SCHEMA_VERSION {
        let mut base = config.base();
        dto::canonicalize(&mut base);
        dto::validate_config(&base)?;
        dto::canonical_bytes(&base)?
    } else {
        dto::canonicalize_v2(&mut config);
        dto::validate_config_v2(&config)?;
        dto::canonical_bytes_v2(&config)?
    };
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(ApiError::bad_request(
            "canonical management config exceeds 16 KiB",
        ));
    }
    let checksum = dto::digest(&bytes);

    if let Some(row) = &current {
        if row.body == bytes {
            // Honest no-op: no version bump, no audit row, no refresh churn.
            tx.commit().await?;
            return Ok(PatchResult {
                changed: false,
                view: get_view(pool, household_id).await?,
            });
        }
    }

    let new_version = current_version
        .checked_add(1)
        .ok_or_else(|| ApiError::conflict("config_version counter exhausted"))?;
    if !db::upsert_desired_on_conn(
        &mut tx,
        household_id,
        schema_version,
        new_version as i64,
        &bytes,
        &checksum,
        now,
        actor,
    )
    .await?
    {
        return Err(ApiError::conflict(
            "expected_config_version is stale; reload the desired config",
        ));
    }

    // A refresh token for a source that no longer exists or is disabled can
    // never be fetched; remove it (and its delivery/ack rows by cascade).
    let enabled: BTreeSet<String> = config
        .sources
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.id.clone())
        .collect();
    for source_id in db::refresh_source_ids_on_conn(&mut tx, household_id).await? {
        if !enabled.contains(&source_id) {
            db::delete_refresh_for_source_on_conn(&mut tx, household_id, &source_id).await?;
        }
    }
    tx.commit().await?;

    Ok(PatchResult {
        changed: true,
        view: get_view(pool, household_id).await?,
    })
}

/// Bounded manual refresh: one pending token per source, 60 s cooldown,
/// 10 min expiry and a hard cap enforced by the migration trigger.
pub async fn request_refresh(
    pool: &PgPool,
    actor: Uuid,
    household_id: Uuid,
    source_id: &str,
    now: DateTime<Utc>,
) -> ApiResult<RefreshResult> {
    dto::validate_source_id(source_id)?;
    let mut tx = pool.begin().await?;
    network_db::lock_household(&mut tx, household_id).await?;
    if !authz::has_grant_on_conn(&mut tx, actor, household_id, authz::NetworkGrant::Admin).await? {
        return Err(ApiError::forbidden());
    }
    let row = db::desired_on_conn(&mut tx, household_id)
        .await?
        .ok_or_else(|| ApiError::not_found("no desired DNS configuration saved"))?;
    let config = config_from_row(&row)?;
    let source = config
        .sources()
        .iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| ApiError::not_found("source id not found in desired config"))?;
    if !source.enabled {
        return Err(ApiError::conflict(
            "source is disabled; enable it before refreshing",
        ));
    }

    let outcome = db::request_refresh_on_conn(
        &mut tx,
        household_id,
        source_id,
        actor,
        now,
        row.config_version,
        REFRESH_COOLDOWN_SECS,
        REFRESH_TTL_SECS,
    )
    .await?;
    tx.commit().await?;
    Ok(RefreshResult {
        source_id: source_id.to_owned(),
        refresh_seq: outcome.refresh_seq as u64,
        config_version: outcome.config_version as u64,
        expires_at: outcome.expires_at,
        created: outcome.created,
        cooldown_secs: REFRESH_COOLDOWN_SECS,
    })
}

/// Request a cache clear of the CURRENT resolver cache. This is a command,
/// not a settings or policy mutation: no revision, publication time or bundle
/// generation is bumped, and no entries count is fabricated. Delivery and ack
/// are exclusively reported by the scoped worker commands.
pub async fn request_clear(
    pool: &sqlx::PgPool,
    actor: Uuid,
    household_id: Uuid,
    body: CacheClearBody,
    now: DateTime<Utc>,
) -> ApiResult<CacheClearResult> {
    let mut tx = pool.begin().await?;
    network_db::lock_household(&mut tx, household_id).await?;
    if !authz::has_grant_on_conn(&mut tx, actor, household_id, authz::NetworkGrant::Admin).await? {
        return Err(ApiError::forbidden());
    }
    let row = db::desired_on_conn(&mut tx, household_id)
        .await?
        .ok_or_else(|| ApiError::not_found("no desired DNS configuration saved"))?;
    if body.expected_config_version != row.config_version as u64 {
        return Err(ApiError::conflict(
            "expected_config_version is stale; reload the desired config",
        ));
    }
    let outcome = db::request_clear_on_conn(
        &mut tx,
        household_id,
        actor,
        now,
        row.config_version,
        CACHE_CLEAR_COOLDOWN_SECS,
        CACHE_CLEAR_TTL_SECS,
    )
    .await?;
    tx.commit().await?;
    Ok(CacheClearResult {
        clear_seq: outcome.clear_seq as u64,
        config_version: outcome.config_version as u64,
        expires_at: outcome.expires_at,
        created: outcome.created,
        cooldown_secs: CACHE_CLEAR_COOLDOWN_SECS,
    })
}

/// Scoped, cookie-free worker pull. Records delivery evidence (version +
/// digest) and per-gateway refresh/cache-clear token delivery; never applied.
pub async fn worker_read(
    pool: &PgPool,
    bearer: Option<&str>,
    body: WorkerReadBody,
    now: DateTime<Utc>,
) -> ApiResult<WorkerReadResponse> {
    if body.audience != gateway_auth::AUDIENCE
        || body.command != gateway_auth::COMMAND_READ_DNS_MANAGEMENT
    {
        return Err(worker_auth_error());
    }
    if gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())? != "dns" {
        return Err(worker_auth_error());
    }

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
        gateway_auth::COMMAND_READ_DNS_MANAGEMENT,
        now,
    )
    .await?;

    let (config_version, schema_version, body_sha256, config, config_v2) =
        match db::desired_on_conn(&mut tx, worker.household_id).await? {
            Some(row) => {
                let parsed = config_from_row(&row)?;
                let (v1, v2) = match &parsed {
                    StoredConfig::V1(config) => (Some(config.clone()), None),
                    StoredConfig::V2(config) => (None, Some(config.clone())),
                };
                (
                    row.config_version as u64,
                    Some(row.schema_version),
                    Some(row.body_sha256.clone()),
                    v1,
                    v2,
                )
            }
            None => (0, None, None, None, None),
        };

    if config_version > 0 {
        let digest = body_sha256
            .as_ref()
            .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("missing stored digest")))?;
        db::insert_delivery_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            config_version as i64,
            digest,
            now,
        )
        .await?;
        db::upsert_gateway_state_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            config_version as i64,
            digest,
            now,
        )
        .await?;
        for pending in db::all_pending_requests_on_conn(&mut tx, worker.household_id, now).await? {
            // A read delivers only the current config. Never invent historical
            // delivery evidence for a token issued before this config changed.
            if pending.config_version != config_version as i64 {
                continue;
            }
            db::mark_refresh_delivered_on_conn(
                &mut tx,
                worker.household_id,
                worker.gateway_id,
                &pending.source_id,
                pending.refresh_seq,
                pending.config_version,
                now,
            )
            .await?;
        }
        // Cache clear is delivered only for this exact delivered config
        // version; a token requested before a config edit is never rebound.
        db::mark_clear_delivered_on_conn(&mut tx, worker.household_id, worker.gateway_id, now)
            .await?;
    }

    let (delivered, reported, extra_pins) =
        db::delivery_pins_on_conn(&mut tx, worker.household_id, worker.gateway_id).await?;
    let mut pins = extra_pins;
    pins.extend(delivered);
    pins.extend(reported);
    pins.sort_unstable();
    pins.dedup();
    db::prune_delivery_on_conn(
        &mut tx,
        worker.household_id,
        worker.gateway_id,
        DELIVERY_HISTORY as i64,
        &pins,
    )
    .await?;

    let pending_refreshes =
        db::pending_refreshes_on_conn(&mut tx, worker.household_id, worker.gateway_id, now)
            .await?
            .into_iter()
            .filter(|token| token.config_version == config_version)
            .collect();
    let pending_clear = if config_version > 0 {
        db::pending_clear_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            config_version as i64,
            now,
        )
        .await?
        .into_iter()
        .collect()
    } else {
        Vec::new()
    };
    gateway_db::mark_credential_used(&mut tx, worker.id).await?;
    tx.commit().await?;

    Ok(WorkerReadResponse {
        household_id: worker.household_id,
        gateway_id: worker.gateway_id,
        kind: "dns",
        config_version,
        schema_version,
        body_sha256,
        config,
        config_v2,
        pending_refreshes,
        pending_cache_clear: pending_clear,
        server_time: now,
    })
}

/// Scoped worker status report. A reported version is accepted only when its
/// exact version + digest exist in this gateway's delivery ledger; lagging
/// applied versions are validated the same way. No applied/enforced/verified
/// claim is manufactured by the server.
pub async fn worker_status(
    pool: &PgPool,
    bearer: Option<&str>,
    body: WorkerStatusBody,
    now: DateTime<Utc>,
) -> ApiResult<StatusOutcome> {
    if body.audience != gateway_auth::AUDIENCE
        || body.command != gateway_auth::COMMAND_REPORT_DNS_STATUS
    {
        return Err(worker_auth_error());
    }
    if gateway_dto::normalize_kind(&body.kind).map_err(|_| worker_auth_error())? != "dns" {
        return Err(worker_auth_error());
    }
    dto::validate_worker_status(&body, now)?;

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
        gateway_auth::COMMAND_REPORT_DNS_STATUS,
        now,
    )
    .await?;

    let reported_digest = db::delivered_digest_on_conn(
        &mut tx,
        worker.household_id,
        worker.gateway_id,
        body.config_version as i64,
    )
    .await?
    .filter(|stored| stored == &body.body_sha256)
    .ok_or_else(|| {
        ApiError::conflict(
            "reported config version/digest was not delivered to this gateway; reread management config",
        )
    })?;
    let applied_digest = match &body.applied {
        Some(applied) => Some(
            db::delivered_digest_on_conn(
                &mut tx,
                worker.household_id,
                worker.gateway_id,
                applied.config_version as i64,
            )
            .await?
            .ok_or_else(|| {
                ApiError::conflict(
                    "reported applied version was not delivered to this gateway; reread management config",
                )
            })?,
        ),
        None => None, // honest: delivered but never applied
    };

    for ack in &body.refresh_ack {
        if let Some(existing) = db::ack_state_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            &ack.source_id,
        )
        .await?
        {
            if existing.refresh_seq == ack.refresh_seq as i64
                && existing.config_version == ack.config_version as i64
            {
                continue; // exact replay: idempotent
            }
            return Err(ApiError::conflict(
                "refresh ack does not match the accepted token for this source",
            ));
        }
        if !db::delivery_token_exists_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            &ack.source_id,
            ack.refresh_seq as i64,
            ack.config_version as i64,
        )
        .await?
        {
            return Err(ApiError::conflict(
                "refresh token was not delivered to this gateway",
            ));
        }
        db::insert_ack_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            &ack.source_id,
            ack.refresh_seq as i64,
            ack.config_version as i64,
            now,
        )
        .await?;
    }

    for ack in &body.clear_ack {
        if let Some(existing) =
            db::clear_ack_state_on_conn(&mut tx, worker.household_id, worker.gateway_id).await?
        {
            if existing.clear_seq == ack.clear_seq as i64
                && existing.config_version == ack.config_version as i64
            {
                continue; // exact replay: idempotent
            }
            return Err(ApiError::conflict(
                "cache clear ack does not match the accepted token for this gateway",
            ));
        }
        if !db::clear_token_exists_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            ack.clear_seq as i64,
            ack.config_version as i64,
        )
        .await?
        {
            return Err(ApiError::conflict(
                "cache clear token was not delivered to this gateway",
            ));
        }
        db::insert_clear_ack_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            ack.clear_seq as i64,
            ack.config_version as i64,
            ack.cleared_at,
            now,
        )
        .await?;
    }

    if db::existing_report_id_on_conn(&mut tx, worker.household_id, worker.gateway_id).await?
        != Some(body.report_id)
    {
        let sources: Value =
            serde_json::to_value(body.sources.iter().map(source_json).collect::<Vec<Value>>())
                .map_err(|e| ApiError::Internal(e.into()))?;
        db::upsert_status_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            worker.id,
            body.report_id,
            body.config_version as i64,
            // Store the server-verified ledger digest, not a caller string.
            &reported_digest,
            body.reported_at,
            now,
            body.applied.as_ref().map(|a| a.config_version as i64),
            body.applied.as_ref().and_then(|a| a.applied_at),
            body.applied.as_ref().and_then(|a| a.last_error.as_deref()),
            body.applied.as_ref().map(|a| a.generation as i64),
            body.applied.as_ref().map(|a| a.filter_generation as i64),
            body.applied.as_ref().map(|a| a.filter_identity.as_str()),
            &sources,
        )
        .await?;
    }

    if let (Some(applied), Some(applied_digest)) = (&body.applied, &applied_digest) {
        db::set_reported_pin_on_conn(
            &mut tx,
            worker.household_id,
            worker.gateway_id,
            applied.config_version as i64,
            applied_digest,
            body.reported_at,
        )
        .await?;
    } else {
        db::clear_reported_pin_on_conn(&mut tx, worker.household_id, worker.gateway_id, now)
            .await?;
    }
    let (delivered, reported, extra_pins) =
        db::delivery_pins_on_conn(&mut tx, worker.household_id, worker.gateway_id).await?;
    let mut pins = extra_pins;
    pins.extend(delivered);
    pins.extend(reported);
    pins.sort_unstable();
    pins.dedup();
    db::prune_delivery_on_conn(
        &mut tx,
        worker.household_id,
        worker.gateway_id,
        DELIVERY_HISTORY as i64,
        &pins,
    )
    .await?;
    gateway_db::mark_credential_used(&mut tx, worker.id).await?;
    tx.commit().await?;
    Ok(StatusOutcome {
        household_id: worker.household_id,
        gateway_id: worker.gateway_id,
        report_id: body.report_id,
    })
}

/// Metadata only: safe to pass to the household-scoped audit writer.
pub struct StatusOutcome {
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub report_id: Uuid,
}

fn source_json(source: &SourceStatusDto) -> Value {
    json!({
        "id": source.id,
        "download": source.download,
        "checked_at": source.checked_at,
        "fetched_at": source.fetched_at,
        "content_changed_at": source.content_changed_at,
        "next_due_at": source.next_due_at,
        "stale": source.stale,
        "failure_count": source.failure_count,
        "cooldown_until": source.cooldown_until,
        "last_error": source.last_error,
        "bytes": source.bytes,
        "rule_count": source.rule_count,
        "downloaded_sha256": source.downloaded_sha256,
    })
}

/// Read-only status view for a household. Contains source ids and states only:
/// no URLs, no config metadata and no verification flag.
pub async fn status_view(pool: &PgPool, household_id: Uuid) -> ApiResult<StatusView> {
    let desired_version = db::get_desired(pool, household_id)
        .await?
        .map(|row| row.config_version as u64);
    let rows = db::status_rows(pool, household_id).await?;
    let mut conn = pool.acquire().await?;
    let clear_states = db::clear_states_on_conn(&mut conn, household_id).await?;
    let mut gateways = Vec::with_capacity(rows.len());
    for row in rows {
        let status = match (
            row.config_version,
            row.body_sha256,
            row.report_id,
            row.reported_at,
            row.received_at,
            row.applied_version,
            row.applied_sha256,
            row.generation,
            row.filter_generation,
            row.filter_identity,
            row.sources,
        ) {
            (
                Some(config_version),
                Some(body_sha256),
                Some(report_id),
                Some(reported_at),
                Some(received_at),
                applied_version,
                applied_sha256,
                generation,
                filter_generation,
                filter_identity,
                Some(sources),
            ) => {
                let source_list: Vec<SourceStatusDto> =
                    serde_json::from_value(sources).unwrap_or_default();
                let applied = match (
                    applied_version,
                    applied_sha256,
                    generation,
                    filter_generation,
                    filter_identity,
                ) {
                    (
                        Some(applied_version),
                        Some(applied_sha256),
                        Some(generation),
                        Some(filter_generation),
                        Some(filter_identity),
                    ) => Some(AppliedView {
                        config_version: applied_version as u64,
                        // Digest is derived from the delivery ledger, never
                        // accepted from the worker report body.
                        body_sha256: applied_sha256,
                        generation: generation as u64,
                        filter_generation: filter_generation as u64,
                        filter_identity,
                        applied_at: row.applied_at,
                        last_error: row.applied_error,
                    }),
                    _ => None, // delivered but never applied
                };
                Some(ReportedStatusView {
                    config_version: config_version as u64,
                    body_sha256,
                    report_id,
                    reported_at,
                    received_at,
                    applied,
                    sources: source_list,
                })
            }
            _ => None,
        };
        gateways.push(super::dns_management_dto::GatewayStatusView {
            gateway_id: row.gateway_id,
            delivered_version: row.delivered_version.map(|v| v as u64),
            reported_version: row.reported_version.map(|v| v as u64),
            status,
            cache_clear: clear_states
                .iter()
                .find(|(gateway_id, _)| *gateway_id == row.gateway_id)
                .map(|(_, view)| view.clone()),
        });
    }
    Ok(StatusView {
        desired_version,
        gateways,
    })
}
