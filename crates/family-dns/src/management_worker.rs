//! One cancellable worker-side coordinator for optional DNS management.
//!
//! Network I/O (read/report/downloads) never happens under the update mutex.
//! Every durable commit captures the CURRENT whole-bundle generation and is
//! rejected if another update won first. The canonical server Arc is owned by
//! the caller; this task keeps only a Weak reference and is joined on stop.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, Weak};

use chrono::Utc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_subscriptions::config::SourceMetadata;

use crate::config::{
    Config, FilterConfig, ListFormatSpec, ServiceCatalogSpec, ServiceDomainSpec, ServiceSpec,
    SubscriptionSettings, SubscriptionSourceSpec,
};
use crate::filter::{material_identity, no_remote, prepare as prepare_filter};
use crate::management::{
    ManagementClient, ManagementError, ManagementOptions, ManagementState, MAX_RECEIPTS,
};
use crate::management_dto::{
    canonical_bytes, digest, AppliedStatusDto, DownloadState, ManagementConfig, RefreshAckDto,
    SourceStatusDto, WorkerStatusBody,
};
use crate::server::{DnsServer, ReloadError};
use crate::subscription::SubscriptionRuntime;

const MAX_RETRIES: usize = 2;

type RemoteFn = Box<dyn Fn(&str) -> Result<Option<Vec<u8>>, crate::filter::FilterError>>;

/// Worker-side management coordinator. Default OFF: only constructed when the
/// operator supplies explicit private options.
pub struct ManagementWorker {
    client: Arc<ManagementClient>,
    options: ManagementOptions,
    subscriptions: Option<Arc<SubscriptionRuntime>>,
    cancel: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Transient errors are observations, not durable commits: a failing poll
    /// must not churn the bundle generation or rewrite applied state.
    error: Mutex<Option<String>>,
}

impl ManagementWorker {
    pub fn new(
        options: ManagementOptions,
        client: Arc<ManagementClient>,
        subscriptions: Option<Arc<SubscriptionRuntime>>,
    ) -> Self {
        Self {
            client,
            options,
            subscriptions,
            cancel: CancellationToken::new(),
            task: Mutex::new(None),
            error: Mutex::new(None),
        }
    }

    pub fn handle(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn start(self: &Arc<Self>, server: Weak<DnsServer>) {
        if self.task.lock().unwrap().is_some() {
            return;
        }
        let cancel = self.cancel.clone();
        let worker = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(worker.options.poll());
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = timer.tick() => {
                        if let Some(server) = server.upgrade() {
                            worker.sync_once(&server).await;
                        }
                    }
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    pub async fn shutdown(&self) {
        self.cancel.cancel();
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    /// One bounded read -> compile -> persist -> publish -> report cycle.
    pub async fn sync_once(&self, server: &DnsServer) {
        let response = match self.client.read().await {
            Ok(response) => response,
            Err(error) => {
                self.record_error(server, &error.to_string()).await;
                return;
            }
        };
        if response.config_version == 0 {
            // No desired config: there is no delivery for a status report and
            // no applied management version to invent.
            return;
        }
        let desired_digest = match response.body_sha256.as_deref() {
            Some(digest) => digest.to_owned(),
            None => {
                self.record_error(server, "desired config has no digest")
                    .await;
                return;
            }
        };
        let desired = match response.config.as_ref() {
            Some(config) => config,
            None => {
                self.record_error(server, "desired config is absent").await;
                return;
            }
        };

        let applied = server.management_state();
        // Equal-version polls still reconcile missing fetchers after restart;
        // healthy fetchers keep their due/backoff state.
        if let (Some(runtime), Some(applied)) = (&self.subscriptions, &applied) {
            let specs: Vec<_> = applied.config.sources.iter().map(to_source_spec).collect();
            runtime.ensure_managed(&specs);
        }
        match admit_version(applied.as_ref(), response.config_version, &desired_digest) {
            Ok(Admission::Idempotent) => {
                // Still report observations, but never rewrite applied state.
            }
            Err(error) => {
                self.record_error(server, &error.to_string()).await;
                // An inadmissible envelope must not mutate fetchers/cache or
                // send a status report with an unacknowledged version.
                return;
            }
            Ok(Admission::Apply) => match self
                .apply_desired(server, response.config_version, &desired_digest, desired)
                .await
            {
                Ok(()) => {}
                Err(error) => {
                    self.record_error(server, &error.to_string()).await;
                }
            },
        }

        self.handle_manual_tokens(server, desired, &response.pending_refreshes)
            .await;
        let _ = self
            .report_status(server, response.config_version, &desired_digest, desired)
            .await;
    }

    async fn apply_desired(
        &self,
        server: &DnsServer,
        version: u64,
        digest_value: &str,
        desired: &ManagementConfig,
    ) -> Result<(), ManagementError> {
        for attempt in 0..MAX_RETRIES {
            // Capture the generation BEFORE reading settings or awaiting any
            // network I/O. Every retry re-reads local + applied management and
            // re-prepares material; no stale byte snapshot can win.
            let basis = server.status().bundle_generation;
            let local = server.local_config();
            admit_version(server.management_state().as_ref(), version, digest_value)?;
            let combined = merge_config(&local, desired)?;
            combined
                .validate("managed")
                .map_err(|error| ManagementError::Integrity(error.to_string()))?;

            let managed = desired
                .sources
                .iter()
                .map(to_source_spec)
                .collect::<Vec<_>>();
            let staged = match &self.subscriptions {
                Some(runtime) => Some(
                    runtime
                        .stage_managed(&managed)
                        .map_err(|error| ManagementError::Integrity(error.to_string()))?,
                ),
                None => None,
            };
            let enabled: Vec<String> = managed
                .iter()
                .filter(|spec| spec.enabled)
                .map(|spec| spec.id.clone())
                .collect();
            if let Some(staged) = &staged {
                // Routine poll/retry honours due time and cooldowns; only an
                // explicitly delivered manual token uses force=true.
                let errors = SubscriptionRuntime::staged_refresh(staged, &enabled, false).await;
                if !errors.is_empty() {
                    return Err(ManagementError::Integrity(redact(&errors.join("; "))));
                }
            }
            let remote: RemoteFn = match &staged {
                Some(staged) => {
                    let staged = staged.clone();
                    Box::new(move |id| SubscriptionRuntime::staged_last_good(&staged, id))
                }
                None => Box::new(no_remote),
            };
            let (material, filter) = match prepare_filter(&combined, local.policy_revision, &remote)
                .map_err(|error| ManagementError::Integrity(error.to_string()))?
            {
                Some(pair) => pair,
                None => (
                    crate::filter::FilterMaterial::default(),
                    crate::filter::empty_filter(),
                ),
            };
            let state = ManagementState {
                config_version: version,
                digest: digest_value.to_owned(),
                config: desired.clone(),
                filter_identity: material_identity(Some(&material)),
                receipts: Vec::new(),
                receipt_expiry: Default::default(),
                applied_at: Some(Utc::now()),
                last_error: None,
            };
            match server.commit_management(Some(material), Some(filter), state, basis, Utc::now()) {
                Ok(_) => {
                    // Activation is infallible and happens ONLY after the
                    // candidate is durable, under the same generation epoch.
                    if let (Some(runtime), Some(staged)) = (&self.subscriptions, staged) {
                        runtime.activate_staged(staged, &managed);
                    }
                    return Ok(());
                }
                Err(ReloadError::StaleBasis { .. }) if attempt + 1 < MAX_RETRIES => continue,
                Err(error) => return Err(ManagementError::Conflict(redact(&error.to_string()))),
            }
        }
        Err(ManagementError::Conflict(
            "management basis changed repeatedly".into(),
        ))
    }

    async fn handle_manual_tokens(
        &self,
        server: &DnsServer,
        desired: &ManagementConfig,
        tokens: &[crate::management_dto::PendingRefreshView],
    ) {
        let Some(runtime) = &self.subscriptions else {
            return;
        };
        let Some(state) = server.management_state() else {
            return;
        };
        let configured: BTreeSet<&str> = desired
            .sources
            .iter()
            .filter(|source| source.enabled)
            .map(|source| source.id.as_str())
            .collect();
        let mut receipts = state.receipts.clone();
        let mut next_expiry = state.receipt_expiry.clone();
        let mut changed = false;
        let mut errors = Vec::new();
        for token in tokens {
            if token.config_version != state.config_version
                || !configured.contains(token.source_id.as_str())
                || token.expires_at <= Utc::now()
            {
                continue;
            }
            if receipts.iter().any(|receipt| {
                receipt.source_id == token.source_id
                    && receipt.refresh_seq == token.refresh_seq
                    && receipt.config_version == token.config_version
            }) {
                continue;
            }
            let failures = runtime
                .refresh_only(std::slice::from_ref(&token.source_id), true)
                .await;
            if !failures.is_empty() {
                errors.push(redact(&failures.join("; ")));
                continue;
            }
            // A newer sequence supersedes older receipts for the same source
            // and config version; stale acknowledgements are never resent.
            receipts.retain(|receipt| {
                !(receipt.source_id == token.source_id
                    && receipt.config_version == token.config_version
                    && receipt.refresh_seq < token.refresh_seq)
            });
            receipts.push(RefreshAckDto {
                source_id: token.source_id.clone(),
                refresh_seq: token.refresh_seq,
                config_version: token.config_version,
            });
            if receipts.len() > MAX_RECEIPTS {
                let dropped = receipts.remove(0);
                next_expiry.remove(&crate::management::receipt_key(
                    &dropped.source_id,
                    dropped.refresh_seq,
                    dropped.config_version,
                ));
            }
            next_expiry.insert(
                crate::management::receipt_key(
                    &token.source_id,
                    token.refresh_seq,
                    token.config_version,
                ),
                token.expires_at,
            );
            changed = true;
        }
        if !changed {
            return;
        }
        let mut next = state;
        next.receipts = receipts;
        next.receipt_expiry = next_expiry;
        next.last_error = if errors.is_empty() {
            None
        } else {
            Some(redact(&errors.join("; ")))
        };
        let basis = server.status().bundle_generation;
        match server.commit_management(None, None, next, basis, Utc::now()) {
            Ok(_) => {}
            Err(error) => {
                self.record_error(server, &error.to_string()).await;
            }
        }
    }

    async fn record_error(&self, _server: &DnsServer, detail: &str) {
        *self.error.lock().unwrap() = Some(redact(detail));
    }

    async fn report_status(
        &self,
        server: &DnsServer,
        desired_version: u64,
        desired_digest: &str,
        desired: &ManagementConfig,
    ) -> Result<(), ManagementError> {
        let state = server.management_state();
        let status = server.status();
        let (all_sources, _) = match &self.subscriptions {
            Some(runtime) => runtime.status(),
            None => (Vec::new(), Default::default()),
        };
        let scoped_ids: BTreeSet<&str> = desired
            .sources
            .iter()
            .take(crate::management::MAX_RECEIPTS)
            .map(|source| source.id.as_str())
            .collect();
        let applied_this_version = state
            .as_ref()
            .is_some_and(|applied| applied.config_version == desired_version);
        let sources = all_sources
            .into_iter()
            .filter(|source| scoped_ids.contains(source.id.as_str()))
            .take(crate::management::MAX_RECEIPTS)
            .map(|source| {
                if !applied_this_version {
                    // The active cache belongs to an older applied URL. Never
                    // attribute it to the newer desired config.
                    return SourceStatusDto {
                        id: source.id,
                        download: DownloadState::Unavailable,
                        checked_at: None,
                        fetched_at: None,
                        content_changed_at: None,
                        next_due_at: None,
                        stale: true,
                        failure_count: source.failure_count,
                        cooldown_until: None,
                        last_error: Some("desired config is not applied".to_owned()),
                        bytes: 0,
                        rule_count: None,
                        downloaded_sha256: None,
                    };
                }
                SourceStatusDto {
                    id: source.id,
                    download: source
                        .download
                        .parse::<DownloadState>()
                        .unwrap_or(DownloadState::Unavailable),
                    checked_at: source.checked_at,
                    fetched_at: source.fetched_at,
                    content_changed_at: source.content_changed_at,
                    next_due_at: source.next_due_at,
                    stale: source.stale,
                    failure_count: source.failure_count,
                    cooldown_until: source.cooldown_until,
                    last_error: source.last_error.map(|value| redact(&value)),
                    bytes: source.bytes,
                    rule_count: source.rule_count,
                    downloaded_sha256: source.content_version,
                }
            })
            .collect();
        let applied = state.as_ref().map(|state| AppliedStatusDto {
            config_version: state.config_version,
            generation: status.bundle_generation,
            filter_generation: status.filter_generation,
            filter_identity: status.filter_identity.clone(),
            applied_at: state.applied_at,
            last_error: state
                .last_error
                .as_ref()
                .map(|value| redact(value))
                .or_else(|| self.error.lock().unwrap().clone()),
        });
        let body = WorkerStatusBody {
            audience: crate::controller::CONTROLLER_AUDIENCE.to_owned(),
            command: crate::management::COMMAND_STATUS.to_owned(),
            household_id: self.options.household_id,
            gateway_id: self.options.gateway_id,
            kind: "dns".to_owned(),
            report_id: uuid::Uuid::new_v4(),
            config_version: desired_version,
            body_sha256: desired_digest.to_owned(),
            reported_at: Utc::now(),
            applied,
            sources,
            refresh_ack: state
                .as_ref()
                .map(|state| {
                    let now = Utc::now();
                    state
                        .receipts
                        .iter()
                        .filter(|ack| ack.config_version == state.config_version)
                        .filter(|ack| {
                            state
                                .receipt_expiry
                                .get(&crate::management::receipt_key(
                                    &ack.source_id,
                                    ack.refresh_seq,
                                    ack.config_version,
                                ))
                                .is_some_and(|expiry| *expiry > now)
                        })
                        .take(crate::management::MAX_RECEIPTS)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default(),
        };
        self.client.report(&body).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Admission {
    Apply,
    Idempotent,
}

/// Strict management-version admission, checked at read time and again under
/// the update lock by `commit_management`.
fn admit_version(
    applied: Option<&crate::management::ManagementState>,
    version: u64,
    digest_value: &str,
) -> Result<Admission, ManagementError> {
    let Some(applied) = applied else {
        return Ok(Admission::Apply);
    };
    if version < applied.config_version {
        return Err(ManagementError::Conflict(format!(
            "management version {version} is older than applied {}",
            applied.config_version
        )));
    }
    if version == applied.config_version {
        if applied.digest != digest_value {
            return Err(ManagementError::Conflict(
                "same management version has a different digest".to_owned(),
            ));
        }
        return Ok(Admission::Idempotent);
    }
    Ok(Admission::Apply)
}

/// Redact untrusted detail before it can be reported or persisted.
pub(crate) fn redact(detail: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for word in detail.split_whitespace() {
        if word.contains("://") || word.starts_with("Bearer") || word.contains("token=") {
            skip = true;
            continue;
        }
        if skip {
            skip = false;
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.len() > 200 {
            out.truncate(200);
            break;
        }
    }
    if out.is_empty() {
        "management operation failed".to_owned()
    } else {
        out
    }
}

pub(crate) fn to_source_spec(
    source: &crate::management_dto::SubscriptionSourceDto,
) -> SubscriptionSourceSpec {
    SubscriptionSourceSpec {
        id: source.id.clone(),
        url: source.url.clone(),
        format: match source.format {
            crate::management_dto::ListFormatDto::Hosts => ListFormatSpec::Hosts,
            crate::management_dto::ListFormatDto::Abp => ListFormatSpec::Abp,
        },
        enabled: source.enabled,
        interval_secs: source.interval_secs,
        max_stale_secs: source.max_stale_secs,
        metadata: SourceMetadata {
            title: source.metadata.title.clone(),
            publisher: source.metadata.publisher.clone(),
            license: source.metadata.license.clone(),
        },
    }
}

/// Merge remote sources/catalog into the CURRENT local settings. Local paths,
/// trust, upstreams, device mapping and local file lists are never changed;
/// id collisions with local data are rejected rather than replaced.
pub(crate) fn merge_config(
    local: &Config,
    desired: &ManagementConfig,
) -> Result<FilterConfig, ManagementError> {
    let mut combined = local.filter.clone();
    let local_ids: BTreeSet<&str> = combined
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .chain(
            combined
                .subscriptions
                .iter()
                .flat_map(|settings| settings.sources.iter())
                .map(|source| source.id.as_str()),
        )
        .collect();
    for source in &desired.sources {
        if local_ids.contains(source.id.as_str()) {
            return Err(ManagementError::Conflict(format!(
                "remote source {} collides with a local source",
                source.id
            )));
        }
    }
    if !desired.sources.is_empty() {
        let settings = combined
            .subscriptions
            .get_or_insert_with(|| SubscriptionSettings {
                cache_path: local
                    .filter
                    .subscriptions
                    .as_ref()
                    .map(|settings| settings.cache_path.clone())
                    .unwrap_or_else(|| ".".to_owned()),
                trusted_ca_pem: None,
                sources: Vec::new(),
            });
        for source in &desired.sources {
            settings.sources.push(to_source_spec(source));
        }
    }
    if let Some(catalog) = &desired.catalog {
        let merged = combined.catalog.get_or_insert_with(|| ServiceCatalogSpec {
            version: catalog.version.clone(),
            services: Vec::new(),
        });
        let local_service_ids: BTreeSet<String> = merged
            .services
            .iter()
            .map(|service| service.id.clone())
            .collect();
        for service in &catalog.services {
            if local_service_ids.contains(&service.id) {
                return Err(ManagementError::Conflict(format!(
                    "remote service {} collides with a local service",
                    service.id
                )));
            }
            merged.services.push(ServiceSpec {
                id: service.id.clone(),
                label: service.label.clone(),
                version: service.version.clone(),
                domains: service
                    .domains
                    .iter()
                    .map(|domain| match domain {
                        crate::management_dto::ServiceDomainDto::Exact { value } => {
                            ServiceDomainSpec::Exact {
                                value: value.clone(),
                            }
                        }
                        crate::management_dto::ServiceDomainDto::Suffix { value } => {
                            ServiceDomainSpec::Suffix {
                                value: value.clone(),
                            }
                        }
                    })
                    .collect(),
                source: service.source.clone(),
                evidence: service.evidence.clone(),
            });
        }
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for id in desired.selected_services.iter().cloned() {
        if seen.insert(id.clone()) {
            combined.selected_services.push(id);
        }
    }
    Ok(combined)
}

/// Digest used by the golden wire fixture (same function as the read path).
pub fn config_digest(config: &ManagementConfig) -> String {
    digest(&canonical_bytes(config).expect("config serializes"))
}
