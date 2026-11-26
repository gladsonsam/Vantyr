//! Operator-opted-in scheduled public-list integration.
//!
//! This module owns no filter state of its own. Each configured source has an
//! accepted `vantyr-network-subscriptions` fetcher with a maintained-parser
//! callback for that source's format. One cancellable integrator task refreshes
//! only the sources that are due (or explicitly requested), then hands the
//! combined validated bytes to the DNS worker's single material path. A
//! downloaded cache entry is never reported as an applied filter.
//!
//! A corrupt or URL-mismatched cache is quarantined per source instead of
//! aborting a restart: the applied bundle remains authoritative. First boot
//! with no valid required material still fails closed. No URL is fetched
//! unless the operator configured a subscription source and enabled this
//! runtime; no host resolver, router, firewall or trust store is touched.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
use vantyr_network_subscriptions::error::Error as SubscriptionErrorKind;
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::ReqwestTransport;
use vantyr_network_subscriptions::validate::{
    CandidateValidator, CompilationSummary, ValidationError,
};

use crate::config::{ListFormatSpec, SubscriptionSettings, SubscriptionSourceSpec};
use crate::filter::{prepare as prepare_filter, FilterError};
use crate::server::{DnsServer, ReloadError};

/// Default integrator reaction tick. The fetcher still enforces each source's
/// configured interval and abuse cooldown; this only bounds reaction time.
pub const DEFAULT_TICK: Duration = Duration::from_secs(60);
const MAX_RETRIES: u32 = 3;
const MAX_DIAGNOSTIC_LEN: usize = 200;

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

/// Invalid operator settings (fail before any listener). Cache faults are NOT
/// errors here: they are quarantined per source and reported in status.
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
    /// `download` is cache state, not an enforcement claim. A quarantined
    /// source is reported as such and is never applied.
    pub download: String,
    pub checked_at: Option<DateTime<Utc>>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub content_changed_at: Option<DateTime<Utc>>,
    pub next_due_at: Option<DateTime<Utc>>,
    pub stale: bool,
    pub failure_count: u64,
    pub cooldown_until: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub bytes: u64,
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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuntimeDiagnostics {
    pub integrator_ticks: u64,
    pub task_running: bool,
    pub manual_requests: u64,
}

/// Cheap handle for manual refresh requests and truthful diagnostics.
#[derive(Clone)]
pub struct SubscriptionHandle {
    ids: Arc<Mutex<BTreeSet<String>>>,
    pending: Arc<Mutex<BTreeSet<String>>>,
    wake: Arc<tokio::sync::Notify>,
    cancel: CancellationToken,
    manual_requests: Arc<AtomicU64>,
}

impl SubscriptionHandle {
    /// Request a bounded manual refresh of one configured source. Unknown ids
    /// are ignored; the queue can never grow past the configured source count.
    pub fn request_refresh(&self, id: &str) {
        let ids = self.ids.lock().unwrap();
        if ids.is_empty() || !ids.contains(id) {
            return;
        }
        let cap = ids.len();
        drop(ids);
        let mut pending = self.pending.lock().unwrap();
        if pending.len() < cap {
            pending.insert(id.to_owned());
            self.manual_requests.fetch_add(1, Ordering::SeqCst);
        }
        // A stored permit survives a wake while the integrator is busy;
        // notify_waiters would drop that request entirely.
        self.wake.notify_one();
    }

    /// Take and clear the bounded set of explicitly requested ids.
    pub fn take_pending(&self) -> Vec<String> {
        let mut pending = self.pending.lock().unwrap();
        std::mem::take(&mut *pending).into_iter().collect()
    }

    pub fn is_shutdown(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub fn manual_requests(&self) -> u64 {
        self.manual_requests.load(Ordering::SeqCst)
    }
}

struct FetcherEntry {
    id: String,
    fetcher: Arc<Fetcher<FormatValidator>>,
}

#[derive(Clone, Debug)]
struct FaultedSource {
    id: String,
    error: String,
    attempts: u32,
}

fn bounded(detail: impl AsRef<str>) -> String {
    detail
        .as_ref()
        .chars()
        .take(MAX_DIAGNOSTIC_LEN)
        .filter(|c| !c.is_control())
        .collect()
}

/// All configured fetchers, quarantined sources and the one integrator task.
type FetcherFactory = Arc<
    dyn Fn(
            &SubscriptionSourceSpec,
            &Path,
            Option<&str>,
        ) -> Result<Fetcher<FormatValidator>, SubscriptionErrorKind>
        + Send
        + Sync,
>;

pub struct SubscriptionRuntime {
    entries: Mutex<Vec<FetcherEntry>>,
    faults: Mutex<Vec<FaultedSource>>,
    specs: Mutex<BTreeMap<String, SubscriptionSourceSpec>>,
    managed_ids: Mutex<BTreeSet<String>>,
    root: PathBuf,
    trusted_ca_pem: Option<String>,
    applied: Mutex<AppliedStatus>,
    handle: SubscriptionHandle,
    task: Mutex<Option<JoinHandle<()>>>,
    tick: Duration,
    ticks: AtomicU64,
    factory: FetcherFactory,
}

impl SubscriptionRuntime {
    /// Build fetchers from small settings. Cache files hold bytes, not config.
    /// A per-source cache fault (missing/corrupt/URL mismatch) is quarantined
    /// with a bounded diagnostic so a valid applied bundle can still start.
    pub fn new(
        settings: &SubscriptionSettings,
        trusted_ca_pem: Option<&str>,
    ) -> Result<Self, SubscriptionError> {
        settings
            .validate()
            .map_err(|error| SubscriptionError::Invalid(error.to_string()))?;
        let root = PathBuf::from(&settings.cache_path);
        let specs: BTreeMap<String, SubscriptionSourceSpec> = settings
            .sources
            .iter()
            .map(|source| (source.id.clone(), source.clone()))
            .collect();
        let mut entries = Vec::new();
        let mut faults = Vec::new();
        let factory: FetcherFactory = Arc::new(default_fetcher_factory);
        for source in &settings.sources {
            match factory(source, &root, trusted_ca_pem) {
                Ok(fetcher) => entries.push(FetcherEntry {
                    id: source.id.clone(),
                    fetcher: Arc::new(fetcher),
                }),
                Err(error) => faults.push(FaultedSource {
                    id: source.id.clone(),
                    error: bounded(error.to_string()),
                    attempts: 1,
                }),
            }
        }
        let ids: BTreeSet<String> = specs.keys().cloned().collect();
        let cancel = CancellationToken::new();
        Ok(Self {
            entries: Mutex::new(entries),
            faults: Mutex::new(faults),
            specs: Mutex::new(specs),
            managed_ids: Mutex::new(BTreeSet::new()),
            root,
            trusted_ca_pem: trusted_ca_pem.map(str::to_owned),
            applied: Mutex::new(AppliedStatus::default()),
            handle: SubscriptionHandle {
                ids: Arc::new(Mutex::new(ids)),
                pending: Arc::new(Mutex::new(BTreeSet::new())),
                wake: Arc::new(tokio::sync::Notify::new()),
                cancel,
                manual_requests: Arc::new(AtomicU64::new(0)),
            },
            task: Mutex::new(None),
            tick: DEFAULT_TICK,
            ticks: AtomicU64::new(0),
            factory,
        })
    }

    fn build_fetcher(
        source: &SubscriptionSourceSpec,
        root: &Path,
        trusted_ca_pem: Option<&str>,
    ) -> Result<Fetcher<FormatValidator>, SubscriptionErrorKind> {
        let config = single_source_config(source);
        let limits = config.limits.clone();
        let transport = ReqwestTransport::new(&limits, trusted_ca_pem, None)?;
        Fetcher::with_transport(
            root.to_path_buf(),
            &config,
            FormatValidator::new(source.format),
            Arc::new(transport),
        )
    }

    /// Atomically install (or remove) the operator-authorized managed
    /// sources. Local fetchers are untouched; a managed id colliding with a
    /// configured local source is rejected rather than silently replacing it.
    pub fn install_managed(&self, sources: &[SubscriptionSourceSpec]) -> Result<(), FilterError> {
        let mut specs = self.specs.lock().unwrap();
        let mut managed = self.managed_ids.lock().unwrap();
        let mut entries = self.entries.lock().unwrap();
        let mut faults = self.faults.lock().unwrap();
        entries.retain(|entry| !managed.contains(&entry.id));
        faults.retain(|fault| !managed.contains(&fault.id));
        managed.clear();
        for spec in sources {
            if entries.iter().any(|entry| entry.id == spec.id) {
                return Err(FilterError::Invalid(format!(
                    "managed source {} collides with a local source",
                    spec.id
                )));
            }
            let fetcher = (self.factory)(spec, &self.root, self.trusted_ca_pem.as_deref())
                .map_err(|error| FilterError::Io(error.to_string()))?;
            specs.insert(spec.id.clone(), spec.clone());
            entries.push(FetcherEntry {
                id: spec.id.clone(),
                fetcher: Arc::new(fetcher),
            });
            managed.insert(spec.id.clone());
        }
        let all: BTreeSet<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        *self.handle.ids.lock().unwrap() = all;
        Ok(())
    }

    /// Replace the fetcher factory (embedding/test seam). Production uses the
    /// vetted transport; a test may supply a loopback TLS transport. This does
    /// not change any validation, promotion or material rules.
    pub fn with_fetcher_factory(
        mut self,
        factory: impl Fn(
                &SubscriptionSourceSpec,
                &Path,
                Option<&str>,
            ) -> Result<Fetcher<FormatValidator>, SubscriptionErrorKind>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.factory = Arc::new(factory);
        self
    }

    /// Bounded reaction tick for an embedding that needs faster polling. This
    /// never relaxes a configured source interval, the fetcher's cooldown, TLS
    /// or the vetted transport; it only changes how often due work is checked.
    pub fn with_tick(mut self, tick: Duration) -> Self {
        self.tick = tick.max(Duration::from_millis(10));
        self
    }

    /// Initialize the applied-status view from a bundle loaded at startup.
    pub fn initialize(&self, status: &crate::server::DnsStatus) {
        *self.applied.lock().unwrap() = AppliedStatus {
            generation: status.bundle_generation,
            filter_generation: status.filter_generation,
            filter_identity: status.filter_identity.clone(),
            applied_at: None,
            last_error: None,
        };
    }

    /// Record a bounded bootstrap diagnostic that must stay visible even
    /// though the applied bundle itself is healthy.
    pub fn record_error(&self, detail: impl AsRef<str>) {
        self.applied.lock().unwrap().last_error = Some(bounded(detail));
    }

    pub fn handle(&self) -> SubscriptionHandle {
        SubscriptionHandle {
            ids: self.handle.ids.clone(),
            pending: self.handle.pending.clone(),
            wake: self.handle.wake.clone(),
            cancel: self.handle.cancel.clone(),
            manual_requests: self.handle.manual_requests.clone(),
        }
    }

    /// Validated cache bytes for one configured source. No network I/O here.
    pub fn last_good(&self, id: &str) -> Result<Option<Vec<u8>>, FilterError> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| {
                FilterError::Invalid(format!("subscription source {id} is quarantined"))
            })?
            .fetcher
            .last_good_bytes(id)
            .map_err(|error| FilterError::Io(error.to_string()))
    }

    /// Start the one integrator task. A second call is a no-op. `server` is a
    /// Weak reference only to avoid a strong cycle; the OWNER keeps the
    /// canonical `Arc<DnsServer>` alive for the whole runtime lifetime.
    pub fn start(self: &Arc<Self>, server: Weak<DnsServer>) {
        if self.task.lock().unwrap().is_some() {
            return;
        }
        let cancel = self.handle.cancel.clone();
        let wake = self.handle.wake.clone();
        let runtime = Arc::clone(self);
        let tick = self.tick;
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval(tick);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = timer.tick() => {
                        runtime.ticks.fetch_add(1, Ordering::SeqCst);
                        if let Some(server) = server.upgrade() {
                            let ids = runtime.configured_ids();
                            runtime.refresh_selected(&server, &ids, false).await;
                        }
                    }
                    _ = wake.notified() => {
                        let requested = runtime.handle.take_pending();
                        if !requested.is_empty() {
                            if let Some(server) = server.upgrade() {
                                runtime.refresh_selected(&server, &requested, true).await;
                            }
                        }
                    }
                }
            }
        });
        *self.task.lock().unwrap() = Some(task);
    }

    /// Cancel the in-flight download, then ACTUALLY await the integrator task.
    /// Aborting the task bounds cancellation; awaiting reaps it so no poller
    /// or listener survives shutdown.
    pub async fn shutdown(&self) {
        self.handle.cancel.cancel();
        self.handle.wake.notify_waiters();
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }

    /// Non-async cancellation used only by `Drop`, which cannot await.
    pub fn cancel_only(&self) {
        self.handle.cancel.cancel();
        self.handle.wake.notify_waiters();
    }

    fn configured_ids(&self) -> Vec<String> {
        self.handle.ids.lock().unwrap().iter().cloned().collect()
    }

    /// Refresh ONLY the requested configured ids (cooldowns and due times are
    /// still enforced by the fetcher), then combine the latest good bytes of
    /// every source and apply. An unknown id is ignored.
    pub async fn refresh_selected(&self, server: &DnsServer, ids: &[String], force: bool) {
        let mut errors = Vec::new();
        for id in ids {
            if !self.handle.ids.lock().unwrap().contains(id) {
                continue;
            }
            let fetcher = {
                let entries = self.entries.lock().unwrap();
                entries
                    .iter()
                    .find(|entry| entry.id == *id)
                    .map(|entry| entry.fetcher.clone())
            };
            let fetcher = match fetcher {
                Some(fetcher) => Some(fetcher),
                None => {
                    if !self.retry_faulted(id, &mut errors) {
                        continue;
                    }
                    self.entries
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|entry| entry.id == *id)
                        .map(|entry| entry.fetcher.clone())
                }
            };
            let Some(fetcher) = fetcher else {
                continue;
            };
            match fetcher.refresh(id, force).await {
                Ok(_) => {}
                Err(error) => errors.push(format!("{id}: {error}")),
            }
        }
        self.apply_combined(server, Utc::now(), errors);
    }

    fn retry_faulted(&self, id: &str, errors: &mut Vec<String>) -> bool {
        let mut faults = self.faults.lock().unwrap();
        let Some(fault) = faults.iter_mut().find(|fault| fault.id == id) else {
            return false;
        };
        if fault.attempts >= MAX_RETRIES {
            errors.push(format!("{id}: cache quarantined after bounded retries"));
            return false;
        }
        fault.attempts += 1;
        let spec = self.specs.lock().unwrap().get(id).cloned();
        let Some(spec) = spec else {
            return false;
        };
        match (self.factory)(&spec, &self.root, self.trusted_ca_pem.as_deref()) {
            Ok(fetcher) => {
                faults.retain(|fault| fault.id != id);
                self.entries.lock().unwrap().push(FetcherEntry {
                    id: id.to_owned(),
                    fetcher: Arc::new(fetcher),
                });
                true
            }
            Err(error) => {
                fault.error = bounded(error.to_string());
                false
            }
        }
    }

    /// One bounded forced fetch per configured source, used ONLY for a fresh
    /// first boot with no applied bundle. No listener exists while this runs,
    /// and any source still missing material fails the whole bootstrap closed.
    pub async fn bootstrap_fetch(&self) -> Vec<String> {
        let mut errors = Vec::new();
        for id in self.configured_ids() {
            let fetcher = {
                let entries = self.entries.lock().unwrap();
                entries
                    .iter()
                    .find(|entry| entry.id == id)
                    .map(|entry| entry.fetcher.clone())
            };
            let Some(fetcher) = fetcher else {
                self.retry_faulted(&id, &mut errors);
                continue;
            };
            if let Err(error) = fetcher.refresh(&id, true).await {
                errors.push(format!("{id}: {error}"));
            }
        }
        errors
    }

    /// Refresh every configured source. Public for cache seeding and for a
    /// full poll; the integrator uses `refresh_selected` for manual requests.
    pub async fn refresh_once(&self, server: &DnsServer, force: bool) {
        let ids = self.configured_ids();
        self.refresh_selected(server, &ids, force).await;
    }

    /// Refresh ONLY the named configured sources and return errors, without
    /// applying any material. Used by management for scoped manual tokens.
    pub async fn refresh_only(&self, ids: &[String], force: bool) -> Vec<String> {
        let mut errors = Vec::new();
        for id in ids {
            if !self.handle.ids.lock().unwrap().contains(id) {
                continue;
            }
            let fetcher = {
                self.entries
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|entry| entry.id == *id)
                    .map(|entry| entry.fetcher.clone())
            };
            let Some(fetcher) = fetcher else {
                self.retry_faulted(id, &mut errors);
                continue;
            };
            if let Err(error) = fetcher.refresh(id, force).await {
                errors.push(format!("{id}: {error}"));
            }
        }
        errors
    }

    /// Download-only seeding helper; no DNS state is touched.
    pub async fn refresh_downloads(&self, force: bool) -> Vec<String> {
        let mut errors = Vec::new();
        let entries: Vec<(String, Arc<Fetcher<FormatValidator>>)> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|entry| (entry.id.clone(), entry.fetcher.clone()))
            .collect();
        for (id, fetcher) in entries {
            if let Err(error) = fetcher.refresh(&id, force).await {
                errors.push(format!("{id}: {error}"));
            }
        }
        errors
    }

    /// Combine CURRENT settings with all last-good bytes and apply through the
    /// one material path. A bounded retry handles a concurrent local/controller
    /// commit that changed the bundle generation while material was prepared.
    fn apply_combined(&self, server: &DnsServer, now: DateTime<Utc>, errors: Vec<String>) {
        for _ in 0..MAX_RETRIES {
            let basis = server.status().bundle_generation;
            let config = server.local_config();
            let result = prepare_filter(&config.filter, config.policy_revision, &|id| {
                self.last_good(id)
            });
            match result {
                Ok(Some((material, _snapshot))) => {
                    match server.apply_filter_material(material, basis, now) {
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
                            applied.filter_identity = material_identity_from_server(server);
                            applied.applied_at = Some(now);
                            // `last_error` is sticky until restart: a skipped
                            // or successful later poll must not erase a real
                            // download failure from the status view.
                            if !errors.is_empty() {
                                applied.last_error = Some(bounded(errors.join("; ")));
                            }
                            return;
                        }
                        Err(ReloadError::StaleBasis { .. }) => continue,
                        Err(error) => {
                            self.applied.lock().unwrap().last_error =
                                Some(bounded(error.to_string()));
                            return;
                        }
                    }
                }
                Ok(None) => return,
                Err(error) => {
                    self.applied.lock().unwrap().last_error = Some(bounded(error.to_string()));
                    return;
                }
            }
        }
        self.applied.lock().unwrap().last_error = Some(
            "combined material basis changed too often; retrying on the next bounded tick"
                .to_owned(),
        );
    }

    /// Truthful per-source download state and what DNS actually applied.
    pub fn status(&self) -> (Vec<SourceStatus>, AppliedStatus) {
        let mut sources: Vec<SourceStatus> = self
            .entries
            .lock()
            .unwrap()
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
                    fetched_at: report.as_ref().and_then(|report| report.fetched_at),
                    content_changed_at: report
                        .as_ref()
                        .and_then(|report| report.content_updated_at),
                    next_due_at: report.as_ref().and_then(|report| report.next_due_at),
                    stale: report.as_ref().is_some_and(|report| report.stale),
                    failure_count: report.as_ref().map_or(0, |report| report.failure_count),
                    cooldown_until: report.as_ref().and_then(|report| report.cooldown_until),
                    last_error: report.as_ref().and_then(|report| report.last_error.clone()),
                    bytes: report.as_ref().map_or(0, |report| report.bytes as u64),
                    rule_count: report.as_ref().and_then(|report| report.rule_count),
                    content_version: report
                        .as_ref()
                        .and_then(|report| report.content_version.clone()),
                }
            })
            .collect();
        sources.extend(
            self.faults
                .lock()
                .unwrap()
                .iter()
                .map(|fault| SourceStatus {
                    id: fault.id.clone(),
                    download: "quarantined".to_owned(),
                    checked_at: None,
                    fetched_at: None,
                    content_changed_at: None,
                    next_due_at: None,
                    stale: true,
                    failure_count: fault.attempts as u64,
                    cooldown_until: None,
                    last_error: Some(fault.error.clone()),
                    bytes: 0,
                    rule_count: None,
                    content_version: None,
                }),
        );
        sources.sort_by(|left, right| left.id.cmp(&right.id));
        (sources, self.applied.lock().unwrap().clone())
    }

    pub fn diagnostics(&self) -> RuntimeDiagnostics {
        RuntimeDiagnostics {
            integrator_ticks: self.ticks.load(Ordering::SeqCst),
            task_running: self.task.lock().unwrap().is_some(),
            manual_requests: self.handle.manual_requests(),
        }
    }

    /// Embedding seam: build a runtime from already configured fetchers (for
    /// example a loopback TLS transport in an isolated integration test).
    pub fn with_fetchers(entries: Vec<(String, Arc<Fetcher<FormatValidator>>)>) -> Self {
        let ids: BTreeSet<String> = entries.iter().map(|(id, _)| id.clone()).collect();
        let cancel = CancellationToken::new();
        Self {
            entries: Mutex::new(
                entries
                    .into_iter()
                    .map(|(id, fetcher)| FetcherEntry { id, fetcher })
                    .collect(),
            ),
            faults: Mutex::new(Vec::new()),
            specs: Mutex::new(BTreeMap::new()),
            managed_ids: Mutex::new(BTreeSet::new()),
            root: PathBuf::new(),
            trusted_ca_pem: None,
            applied: Mutex::new(AppliedStatus::default()),
            handle: SubscriptionHandle {
                ids: Arc::new(Mutex::new(ids)),
                pending: Arc::new(Mutex::new(BTreeSet::new())),
                wake: Arc::new(tokio::sync::Notify::new()),
                cancel,
                manual_requests: Arc::new(AtomicU64::new(0)),
            },
            task: Mutex::new(None),
            tick: DEFAULT_TICK,
            ticks: AtomicU64::new(0),
            factory: Arc::new(default_fetcher_factory),
        }
    }
}

fn material_identity_from_server(server: &DnsServer) -> String {
    server.status().filter_identity
}

fn default_fetcher_factory(
    source: &SubscriptionSourceSpec,
    root: &Path,
    ca: Option<&str>,
) -> Result<Fetcher<FormatValidator>, SubscriptionErrorKind> {
    SubscriptionRuntime::build_fetcher(source, root, ca)
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
