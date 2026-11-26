//! Operator-opted-in scheduled public-list integration.
//!
//! This module owns no filter state of its own. Each configured source has an
//! accepted `vantyr-network-subscriptions` fetcher with a maintained-parser
//! callback for that source's format. A single cancellable integrator loop
//! refreshes due sources, then hands the combined validated bytes to the DNS
//! worker's one typed material path. A cached download is never reported as an
//! applied filter: applied digest/generation/error are tracked separately.
//!
//! No URL is fetched unless the operator configured a subscription source and
//! enabled this runtime. No host resolver, router, firewall or trust store is
//! touched here.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_filter::{
    compile_with_limits, FilterSnapshot, Limits as FilterLimits, ListFormat, ListSource,
};
use vantyr_network_subscriptions::config::{Limits, SubscriptionConfig, SubscriptionSource};
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::ReqwestTransport;
use vantyr_network_subscriptions::validate::{
    CandidateValidator, CompilationSummary, ValidationError,
};

use crate::config::{ListFormatSpec, SubscriptionSettings, SubscriptionSourceSpec};
use crate::filter::{material_identity, prepare as prepare_filter, FilterError};
use crate::server::DnsServer;

/// Validates one candidate against the maintained parser for its configured
/// format before the fetcher is allowed to promote it to last-known-good.
#[derive(Clone, Copy, Debug)]
pub struct FormatValidator {
    format: ListFormatSpec,
}

impl FormatValidator {
    /// Bind the validator to the operator-configured source format.
    pub fn new(format: ListFormatSpec) -> Self {
        Self { format }
    }
}

impl CandidateValidator for FormatValidator {
    fn validate(&self, bytes: &[u8]) -> Result<CompilationSummary, ValidationError> {
        let format = match self.format {
            ListFormatSpec::Hosts => ListFormat::Hosts,
            ListFormatSpec::Abp => ListFormat::Abp,
        };
        let source = ListSource {
            id: "candidate".to_owned(),
            format,
            bytes,
            source_url: None,
        };
        let snapshot: Arc<FilterSnapshot> = Arc::new(
            compile_with_limits(1, &[source], None, &[], &FilterLimits::default())
                .map_err(|error| ValidationError::new(error.to_string()))?,
        );
        Ok(CompilationSummary {
            rule_count: snapshot.total_rules() as u64,
        })
    }
}

/// Why a subscription could not be set up. Safe to log: never a URL query or
/// credential.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubscriptionError {
    Invalid(String),
}

impl std::fmt::Display for SubscriptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(detail) => write!(f, "invalid subscription runtime: {detail}"),
        }
    }
}
impl std::error::Error for SubscriptionError {}

/// One source's truthful download state plus what DNS actually applied.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceStatus {
    pub id: String,
    /// `download` is the subscription cache status, not an enforcement claim.
    pub download: String,
    pub checked_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub bytes: usize,
    pub rule_count: Option<u64>,
    pub content_version: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct AppliedStatus {
    pub generation: u64,
    pub filter_generation: u64,
    pub filter_identity: String,
    pub applied_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

/// Cheap handle for manual refresh requests and status.
#[derive(Clone)]
pub struct SubscriptionHandle {
    ids: Arc<BTreeSet<String>>,
    pending: Arc<Mutex<BTreeSet<String>>>,
    wake: Arc<tokio::sync::Notify>,
    cancel: CancellationToken,
}

impl SubscriptionHandle {
    /// Request a bounded manual refresh of a configured source. Unknown ids
    /// are ignored; the queue cannot grow past the configured source count.
    pub fn request_refresh(&self, id: &str) {
        if !self.ids.contains(id) {
            return;
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.len() < self.ids.len() {
            pending.insert(id.to_owned());
        }
        self.wake.notify_waiters();
    }

    pub fn is_shutdown(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

struct FetcherEntry {
    id: String,
    fetcher: Arc<Fetcher<FormatValidator>>,
}

/// All configured fetchers plus the one integrator loop.
pub struct SubscriptionRuntime {
    entries: Vec<FetcherEntry>,
    applied: Mutex<AppliedStatus>,
    handle: SubscriptionHandle,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl SubscriptionRuntime {
    /// Build fetchers from small settings. Cache files hold bytes, not config.
    /// A corrupt cache is rejected here, before any listener exists.
    pub fn new(
        settings: &SubscriptionSettings,
        trusted_ca_pem: Option<&str>,
    ) -> Result<Self, SubscriptionError> {
        settings
            .validate()
            .map_err(|error| SubscriptionError::Invalid(error.to_string()))?;
        let root = Path::new(&settings.cache_path);
        let mut entries = Vec::with_capacity(settings.sources.len());
        for source in &settings.sources {
            let config = single_source_config(source);
            let limits = config.limits.clone();
            let transport = ReqwestTransport::new(&limits, trusted_ca_pem, None)
                .map_err(|error| SubscriptionError::Invalid(error.to_string()))?;
            let fetcher = Fetcher::with_transport(
                root.to_path_buf(),
                &config,
                FormatValidator {
                    format: source.format,
                },
                Arc::new(transport),
            )
            .map_err(|error| SubscriptionError::Invalid(error.to_string()))?;
            entries.push(FetcherEntry {
                id: source.id.clone(),
                fetcher: Arc::new(fetcher),
            });
        }
        let ids: BTreeSet<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        let cancel = CancellationToken::new();
        Ok(Self {
            entries,
            applied: Mutex::new(AppliedStatus::default()),
            handle: SubscriptionHandle {
                ids: Arc::new(ids),
                pending: Arc::new(Mutex::new(BTreeSet::new())),
                wake: Arc::new(tokio::sync::Notify::new()),
                cancel,
            },
            task: Mutex::new(None),
        })
    }

    /// Initialize the applied-status view from a bundle loaded at startup.
    /// Download status stays independent and is filled by the fetchers.
    pub fn initialize(&self, status: &crate::server::DnsStatus) {
        *self.applied.lock().unwrap() = AppliedStatus {
            generation: status.bundle_generation,
            filter_generation: status.filter_generation,
            filter_identity: status.filter_identity.clone(),
            applied_at: None,
            last_error: None,
        };
    }

    pub fn handle(&self) -> SubscriptionHandle {
        SubscriptionHandle {
            ids: self.handle.ids.clone(),
            pending: self.handle.pending.clone(),
            wake: self.handle.wake.clone(),
            cancel: self.handle.cancel.clone(),
        }
    }

    /// Validated cache bytes for one enabled source. No network I/O here.
    pub fn last_good(&self, id: &str) -> Result<Option<Vec<u8>>, FilterError> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| FilterError::Invalid(format!("unknown subscription source {id}")))?
            .fetcher
            .last_good_bytes(id)
            .map_err(|error| FilterError::Io(error.to_string()))
    }

    /// Start the single cancellable integrator loop. `tick` is bounded by the
    /// subscription minimum interval by the caller; production never relaxes
    /// a configured interval.
    pub fn start(self: &Arc<Self>, server: Weak<DnsServer>, tick: Duration) {
        let cancel = self.handle.cancel.clone();
        let wake = self.handle.wake.clone();
        let pending = self.handle.pending.clone();
        let runtime = Arc::clone(self);
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(tick);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = timer.tick() => {
                        if let Some(server) = server.upgrade() {
                            runtime.refresh_once(&server, false).await;
                        }
                    }
                    _ = wake.notified() => {
                        let requested: Vec<String> = {
                            let mut pending = pending.lock().unwrap();
                            std::mem::take(&mut *pending).into_iter().collect()
                        };
                        if !requested.is_empty() {
                            if let Some(server) = server.upgrade() {
                                runtime.refresh_once(&server, true).await;
                            }
                        }
                    }
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    /// Shut down and join the bounded integrator task. No poller is leaked.
    pub fn shutdown(&self) {
        self.handle.cancel.cancel();
        self.handle.wake.notify_waiters();
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }

    /// Refresh every enabled source once, single-flight, then attempt the
    /// combined compile/persist/publish. Per-source failures are recorded but
    /// never swallowed into a success status. Public for manual refresh and
    /// deterministic verification; the integrator loop uses the same path.
    pub async fn refresh_once(&self, server: &DnsServer, force: bool) {
        let errors = self.refresh_downloads(force).await;
        {
            let mut applied = self.applied.lock().unwrap();
            applied.last_error = if errors.is_empty() {
                None
            } else {
                Some(errors.join("; "))
            };
        }
        self.apply_combined(server, Utc::now());
    }

    /// Download only, recording per-source errors without touching DNS. Useful
    /// for seeding a cache before boot and for truthful status polling.
    pub async fn refresh_downloads(&self, force: bool) -> Vec<String> {
        let mut errors = Vec::new();
        for entry in &self.entries {
            match entry.fetcher.refresh(&entry.id, force).await {
                Ok(_) => {}
                Err(error) => errors.push(format!("{}: {error}", entry.id)),
            }
        }
        errors
    }

    /// Assemble the CURRENT settings (local files + all cached lists + service
    /// catalog), compile, and apply atomically. A failed combined compile or
    /// persist leaves the whole DNS last-known-good untouched.
    fn apply_combined(&self, server: &DnsServer, now: DateTime<Utc>) {
        let config = server.local_config();
        let result = prepare_filter(&config.filter, config.policy_revision, &|id| {
            self.last_good(id)
        });
        match result {
            Ok(Some((material, _snapshot))) => {
                let identity = material_identity(Some(&material));
                match server.apply_filter_material(material, now) {
                    Ok(outcome) => {
                        use crate::server::MaterialOutcome;
                        let (generation, filter_generation) = match outcome {
                            MaterialOutcome::Applied {
                                generation,
                                filter_generation,
                                ..
                            }
                            | MaterialOutcome::Unchanged {
                                generation,
                                filter_generation,
                                ..
                            } => (generation, filter_generation),
                        };
                        let mut applied = self.applied.lock().unwrap();
                        applied.generation = generation;
                        applied.filter_generation = filter_generation;
                        applied.filter_identity = identity;
                        applied.applied_at = Some(now);
                        // Download errors set by `integrate` stay visible even
                        // when the applied material did not change.
                    }
                    Err(error) => self.applied.lock().unwrap().last_error = Some(error.to_string()),
                }
            }
            Ok(None) => {}
            Err(error) => self.applied.lock().unwrap().last_error = Some(error.to_string()),
        }
    }

    /// Truthful per-source download state and what DNS actually applied.
    pub fn status(&self) -> (Vec<SourceStatus>, AppliedStatus) {
        let sources = self
            .entries
            .iter()
            .map(|entry| {
                let report = entry.fetcher.status(&entry.id).ok();
                SourceStatus {
                    id: entry.id.clone(),
                    download: report
                        .as_ref()
                        .map(|report| report.status.as_str().to_owned())
                        .unwrap_or_else(|| "unavailable".to_owned()),
                    checked_at: report.as_ref().and_then(|report| report.checked_at),
                    last_error: report.as_ref().and_then(|report| report.last_error.clone()),
                    bytes: report.as_ref().map_or(0, |report| report.bytes),
                    rule_count: report.as_ref().and_then(|report| report.rule_count),
                    content_version: report
                        .as_ref()
                        .and_then(|report| report.content_version.clone()),
                }
            })
            .collect();
        (sources, self.applied.lock().unwrap().clone())
    }

    /// Embedding seam: build a runtime from already configured fetchers (for
    /// example a loopback TLS transport in an isolated integration test).
    /// Production callers use [`Self::new`], which applies the accepted vetted
    /// transport policy.
    pub fn with_fetchers(entries: Vec<(String, Arc<Fetcher<FormatValidator>>)>) -> Self {
        let ids: BTreeSet<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let cancel = CancellationToken::new();
        Self {
            entries: entries
                .into_iter()
                .map(|(id, fetcher)| FetcherEntry { id, fetcher })
                .collect(),
            applied: Mutex::new(AppliedStatus::default()),
            handle: SubscriptionHandle {
                ids: Arc::new(ids),
                pending: Arc::new(Mutex::new(BTreeSet::new())),
                wake: Arc::new(tokio::sync::Notify::new()),
                cancel,
            },
            task: Mutex::new(None),
        }
    }
}

fn single_source_config(source: &SubscriptionSourceSpec) -> SubscriptionConfig {
    SubscriptionConfig {
        sources: vec![SubscriptionSource {
            id: source.id.clone(),
            url: source.url.clone(),
            enabled: source.enabled,
            interval_secs: source.interval_secs,
            max_stale_secs: source.max_stale_secs,
            metadata: source.metadata.clone(),
        }],
        limits: Limits::default(),
        query_policy: Default::default(),
    }
}
