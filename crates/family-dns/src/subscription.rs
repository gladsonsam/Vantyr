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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_filter::{
    compile_with_limits, FilterSnapshot, Limits as FilterLimits, ListFormat, ListSource,
};
use vantyr_network_subscriptions::cache::sha256_hex;
use vantyr_network_subscriptions::config::{
    Limits, SubscriptionConfig, SubscriptionSource, MAX_STALE_SECS,
};
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
    /// Owned cache root, so inactive staging directories can be reclaimed
    /// without touching active/local/external paths.
    cache_root: PathBuf,
}

struct StagedInner {
    entries: Vec<(String, Arc<Fetcher<FormatValidator>>)>,
    cache: PathBuf,
    activated: std::sync::atomic::AtomicBool,
}

impl Drop for StagedInner {
    fn drop(&mut self) {
        if !self.activated.load(Ordering::SeqCst) {
            let _ = std::fs::remove_dir_all(&self.cache);
        }
    }
}

/// Prospective managed fetchers with a SEPARATE cache root. Downloading a
/// candidate never touches active fetchers, managed ids or applied bytes.
#[derive(Clone)]
pub struct StagedManaged {
    inner: Arc<StagedInner>,
}

static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);
static INSTANCE_SEQ: AtomicU64 = AtomicU64::new(0);
static WRITER_SEQ: AtomicU64 = AtomicU64::new(0);

const STAGE_MARKER: &str = ".vantyr-managed-cache";
/// Stable authoritative pointer to the ACTIVE managed cache. It lives at the
/// configured cache root (which is per-worker in production), so a fresh
/// runtime can discover the exact cache the applied bundle was built from.
const ACTIVE_LOCATOR: &str = ".vantyr-managed-active";
/// Exclusive lease for reclaim work. A live instance that holds it prevents
/// every other instance from deleting anything under the shared root.
const CACHE_LEASE: &str = ".vantyr-cache-lease";
const CACHE_META_VERSION: &str = "v1";
const MAX_LOCATOR_BYTES: usize = 512;

#[derive(Clone, Debug)]
struct FaultedSource {
    id: String,
    error: String,
    attempts: u32,
    /// Cache root the applied spec was bound to. A quarantined source is
    /// rebuilt from THIS path after repair, never from a fresh empty root.
    cache_root: PathBuf,
}

fn bounded(detail: impl AsRef<str>) -> String {
    detail
        .as_ref()
        .chars()
        .take(MAX_DIAGNOSTIC_LEN)
        .filter(|c| !c.is_control())
        .collect()
}

/// A unique identity for one `SubscriptionRuntime` construction. It combines
/// the pid, a process-wide sequence and a monotonic clock reading so two
/// instances in the same process (or after pid reuse) can never pick the same
/// staging path or claim each other's ownership.
fn new_instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "{}-{}-{:x}",
        std::process::id(),
        INSTANCE_SEQ.fetch_add(1, Ordering::SeqCst),
        nanos
    )
}

/// Canonical, order-independent identity of the applied managed specs. It
/// binds the active locator to the config that was actually applied; a URL or
/// format change while down is therefore never silently attributed to old
/// bytes.
fn specs_identity(specs: &[SubscriptionSourceSpec]) -> String {
    let mut lines: Vec<String> = specs
        .iter()
        .map(|spec| {
            format!(
                "{}|{}|{:?}|{}",
                spec.id, spec.url, spec.format, spec.enabled
            )
        })
        .collect();
    lines.sort();
    sha256_hex(lines.join("\n").as_bytes())
}

/// Bounded, no-follow read of one of our small metadata files.
fn read_meta(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() as usize > MAX_LOCATOR_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > MAX_LOCATOR_BYTES {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return None;
    }
    Some(text)
}

/// Write a small metadata file atomically (temp + rename) so a crash can never
/// leave a half-written pointer or lease that looks authoritative.
fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let unique = format!(
        ".vantyr-meta-{}-{}-{}",
        std::process::id(),
        WRITER_SEQ.fetch_add(1, Ordering::SeqCst),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let temp = parent.join(unique);
    std::fs::write(&temp, contents.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// Only ever resolve a metadata name to a DIRECT child. Reject separators,
/// traversal, empty names and unbounded strings; never invent ownership from a
/// `staging-` prefix alone.
fn safe_direct_child(root: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty()
        || name.len() > 128
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || !name.starts_with("staging-")
    {
        return None;
    }
    Some(root.join(name))
}

/// `(instance_id, pid, identity_digest)` from a proven-owned staging marker.
fn read_stage_marker(path: &Path) -> Option<(String, u32, String)> {
    let marker = read_meta(&path.join(STAGE_MARKER))?;
    let mut lines = marker.lines();
    if lines.next() != Some(CACHE_META_VERSION) {
        return None;
    }
    let instance = lines.next()?.to_owned();
    let pid = lines.next()?.parse::<u32>().ok()?;
    let digest = lines.next()?.to_owned();
    if instance.is_empty() || digest.len() != 64 {
        return None;
    }
    Some((instance, pid, digest))
}

/// Liveness check that is portable across Unixes. `kill(pid, 0)` sends no
/// signal: EPERM (and any unknown error) means "treat as alive", ESRCH means
/// "gone". Non-Unix hosts conservatively report every pid as alive so cleanup
/// becomes a safe no-op rather than deleting a live worker.
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => false,
            // EPERM means the process exists but belongs to another user.
            // Unknown errors are deliberately treated as alive.
            _ => true,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
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
    /// Worker-owned staging cache roots that must never be reclaimed.
    active_caches: Mutex<BTreeSet<PathBuf>>,
    /// Unique identity of THIS runtime instance; used in ownership proofs and
    /// staging paths so two instances in one process cannot collide.
    instance_id: String,
    /// The cache root the currently applied managed specs were bound to. On a
    /// restart this is the discovered ACTIVE cache, not the bare root.
    managed_cache_root: Mutex<PathBuf>,
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
                    cache_root: root.clone(),
                }),
                Err(error) => faults.push(FaultedSource {
                    id: source.id.clone(),
                    error: bounded(error.to_string()),
                    attempts: 1,
                    cache_root: root.clone(),
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
            instance_id: new_instance_id(),
            managed_cache_root: Mutex::new(root.clone()),
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
            active_caches: Mutex::new(BTreeSet::new()),
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
                cache_root: self.root.clone(),
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

    /// Discover the ACTIVE managed cache from the authoritative locator. The
    /// locator is only honoured when its config identity matches the applied
    /// specs and the named directory carries a matching ownership marker.
    fn discover_active_cache(&self, digest: &str) -> Option<PathBuf> {
        let text = read_meta(&self.root.join(ACTIVE_LOCATOR))?;
        let mut lines = text.lines();
        if lines.next() != Some(CACHE_META_VERSION) {
            return None;
        }
        let name = lines.next()?;
        if lines.next()? != digest {
            return None; // config changed while down: never attribute old bytes
        }
        let cache = safe_direct_child(&self.root, name)?;
        if !std::fs::symlink_metadata(&cache).ok()?.file_type().is_dir() {
            return None;
        }
        let (_, _, marker_digest) = read_stage_marker(&cache)?;
        (marker_digest == digest).then_some(cache)
    }

    /// Take the exclusive reclaim lease. A live instance that already holds it
    /// makes cleanup a no-op for this runtime.
    fn claim_cleanup_lease(&self) -> bool {
        let path = self.root.join(CACHE_LEASE);
        if let Some(text) = read_meta(&path) {
            let mut lines = text.lines();
            if lines.next() == Some(CACHE_META_VERSION) {
                let pid = lines.next().and_then(|line| line.parse::<u32>().ok());
                let owner = lines.next().unwrap_or_default();
                if owner != self.instance_id
                    && pid.is_some_and(|pid| pid == std::process::id() || process_alive(pid))
                {
                    return false;
                }
            }
        }
        let body = format!(
            "{CACHE_META_VERSION}\n{}\n{}\n",
            std::process::id(),
            self.instance_id
        );
        atomic_write(&path, &body).is_ok()
    }

    fn release_cleanup_lease(&self) {
        let path = self.root.join(CACHE_LEASE);
        if let Some(text) = read_meta(&path) {
            if text.lines().nth(2) == Some(self.instance_id.as_str()) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Reclaim only directories this worker can prove it created, that are no
    /// longer active, and whose owning instance is gone. Never follows a
    /// symlink, never touches unmarked/foreign/local paths, and never deletes
    /// the path named by the active locator.
    fn reclaim_owned_inactive(&self) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        if !self.claim_cleanup_lease() {
            return; // another live instance owns this root
        }
        let mut active = self.active_caches.lock().unwrap().clone();
        active.extend(
            self.entries
                .lock()
                .unwrap()
                .iter()
                .map(|entry| entry.cache_root.clone()),
        );
        active.insert(self.managed_cache_root.lock().unwrap().clone());
        if let Some(text) = read_meta(&self.root.join(ACTIVE_LOCATOR)) {
            if let Some(name) = text.lines().nth(1) {
                if let Some(cache) = safe_direct_child(&self.root, name) {
                    active.insert(cache);
                }
            }
        }
        let me = std::process::id();
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.file_type().is_dir() || active.contains(&path) {
                continue;
            }
            let Some((owner_instance, owner_pid, _)) = read_stage_marker(&path) else {
                continue; // unmarked or malformed: never guessed at
            };
            // A different live instance in this process is never reclaimed.
            if owner_pid == me && owner_instance != self.instance_id {
                continue;
            }
            // A live process (any pid) is never reclaimed; only our own
            // inactive candidates and dead predecessors are.
            if owner_pid != me && process_alive(owner_pid) {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
    }

    /// Build candidate fetchers in an isolated cache. No active state changes.
    pub fn stage_managed(
        &self,
        specs: &[SubscriptionSourceSpec],
    ) -> Result<StagedManaged, FilterError> {
        self.reclaim_owned_inactive();
        let serial = STAGE_SEQ.fetch_add(1, Ordering::SeqCst);
        // The instance id makes the path proof-owned and collision-free even
        // when the serial resets in another process or instance.
        let cache = self
            .root
            .join(format!("staging-{}-{serial}", self.instance_id));
        std::fs::create_dir_all(&cache).map_err(|error| FilterError::Io(error.to_string()))?;
        let marker = format!(
            "{CACHE_META_VERSION}\n{}\n{}\n{}\n",
            self.instance_id,
            std::process::id(),
            specs_identity(specs)
        );
        std::fs::write(cache.join(STAGE_MARKER), marker)
            .map_err(|error| FilterError::Io(error.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o700));
        }
        let mut entries = Vec::new();
        for spec in specs {
            let fetcher = (self.factory)(spec, &cache, self.trusted_ca_pem.as_deref())
                .map_err(|error| FilterError::Io(error.to_string()))?;
            entries.push((spec.id.clone(), Arc::new(fetcher)));
        }
        Ok(StagedManaged {
            inner: Arc::new(StagedInner {
                entries,
                cache,
                activated: std::sync::atomic::AtomicBool::new(false),
            }),
        })
    }

    /// Download staged candidates only; active fetchers stay untouched.
    pub async fn staged_refresh(
        staged: &StagedManaged,
        ids: &[String],
        force: bool,
    ) -> Vec<String> {
        let mut errors = Vec::new();
        for id in ids {
            let Some((_, fetcher)) = staged
                .inner
                .entries
                .iter()
                .find(|(candidate, _)| candidate == id)
            else {
                errors.push(format!("{id}: staged source is absent"));
                continue;
            };
            if let Err(error) = fetcher.refresh(id, force).await {
                errors.push(format!("{id}: {error}"));
            }
        }
        errors
    }

    /// Validated bytes from the staged cache for one candidate source.
    pub fn staged_last_good(
        staged: &StagedManaged,
        id: &str,
    ) -> Result<Option<Vec<u8>>, FilterError> {
        staged
            .inner
            .entries
            .iter()
            .find(|(candidate_id, _)| candidate_id == id)
            .ok_or_else(|| FilterError::Invalid(format!("staged source {id} is absent")))?
            .1
            .last_good_bytes(id)
            .map_err(|error| FilterError::Io(error.to_string()))
    }

    /// Infallible activation after a successful durable publish. The staged
    /// fetchers already hold validated candidates; transferring them (and
    /// taking ownership of their cache) cannot fail. The active locator is
    /// updated atomically so a fresh runtime can find this exact cache. If
    /// locator persistence/removal fails, the live bundle remains usable and
    /// the bounded runtime diagnostic is included in management status reports.
    pub fn activate_staged(&self, staged: StagedManaged, specs: &[SubscriptionSourceSpec]) {
        let mut managed = self.managed_ids.lock().unwrap();
        let mut entries = self.entries.lock().unwrap();
        let mut faults = self.faults.lock().unwrap();
        entries.retain(|entry| !managed.contains(&entry.id));
        faults.retain(|fault| !managed.contains(&fault.id));
        managed.clear();
        let mut specs_map = self.specs.lock().unwrap();
        for (id, fetcher) in &staged.inner.entries {
            entries.push(FetcherEntry {
                id: id.clone(),
                fetcher: fetcher.clone(),
                cache_root: staged.inner.cache.clone(),
            });
            managed.insert(id.clone());
        }
        for spec in specs {
            // Applied specs are durable truth even when a source is disabled.
            specs_map.insert(spec.id.clone(), spec.clone());
        }
        if staged.inner.entries.is_empty() {
            // No active managed cache exists any more; do not leave an empty
            // candidate directory on every deactivation.
            if let Err(error) = std::fs::remove_file(self.root.join(ACTIVE_LOCATOR)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    self.record_error(format!("active cache locator removal failed: {error}"));
                }
            }
            self.active_caches.lock().unwrap().clear();
            *self.managed_cache_root.lock().unwrap() = self.root.clone();
            staged.inner.activated.store(false, Ordering::SeqCst);
        } else {
            let digest = specs_identity(specs);
            let name = staged
                .inner
                .cache
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let locator = format!("{CACHE_META_VERSION}\n{name}\n{digest}\n");
            if let Err(error) = atomic_write(&self.root.join(ACTIVE_LOCATOR), &locator) {
                // The bundle is already durable and the in-memory fetchers
                // remain usable, but restart may lose this cache binding.
                // Surface that degradation without freshening content age.
                self.record_error(format!("active cache locator write failed: {error}"));
            }
            // Exactly one managed cache is active after a valid switch; the
            // previous one becomes reclaimable only from this point on.
            let mut active = self.active_caches.lock().unwrap();
            active.clear();
            active.insert(staged.inner.cache.clone());
            drop(active);
            *self.managed_cache_root.lock().unwrap() = staged.inner.cache.clone();
            staged.inner.activated.store(true, Ordering::SeqCst);
        }
        let all: BTreeSet<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        *self.handle.ids.lock().unwrap() = all;
    }

    /// Rebuild managed fetchers from durable applied settings with NO network
    /// I/O. The exact ACTIVE cache is discovered from the authoritative locator
    /// BEFORE any cleanup, so bytes/hash/check times/revision survive restart.
    /// A bad/mismatched cache is quarantined; a valid bundle still binds.
    pub fn rehydrate_managed(&self, sources: &[SubscriptionSourceSpec]) {
        let digest = specs_identity(sources);
        let active = self.discover_active_cache(&digest);
        let cache_root = active.clone().unwrap_or_else(|| self.root.clone());
        if let Some(dir) = active {
            self.active_caches.lock().unwrap().insert(dir.clone());
            *self.managed_cache_root.lock().unwrap() = dir;
        } else {
            *self.managed_cache_root.lock().unwrap() = self.root.clone();
        }
        let mut managed = self.managed_ids.lock().unwrap();
        let mut entries = self.entries.lock().unwrap();
        let mut faults = self.faults.lock().unwrap();
        let mut specs_map = self.specs.lock().unwrap();
        entries.retain(|entry| !managed.contains(&entry.id));
        faults.retain(|fault| !managed.contains(&fault.id));
        managed.clear();
        for spec in sources {
            // Keep the applied spec even when the factory fails. Without this
            // a repaired cache could never be rebuilt by a later ordinary poll
            // or manual token.
            specs_map.insert(spec.id.clone(), spec.clone());
            match (self.factory)(spec, &cache_root, self.trusted_ca_pem.as_deref()) {
                Ok(fetcher) => {
                    entries.push(FetcherEntry {
                        id: spec.id.clone(),
                        fetcher: Arc::new(fetcher),
                        cache_root: cache_root.clone(),
                    });
                    managed.insert(spec.id.clone());
                }
                Err(error) => faults.push(FaultedSource {
                    id: spec.id.clone(),
                    error: bounded(error.to_string()),
                    attempts: 1,
                    cache_root: cache_root.clone(),
                }),
            }
        }
        // Quarantined ids remain addressable so a manual retry can rebuild a
        // fetcher after the operator repairs the cache. No ack without a fetch.
        let mut all: BTreeSet<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        all.extend(faults.iter().map(|fault| fault.id.clone()));
        *self.handle.ids.lock().unwrap() = all;
        drop(specs_map);
        drop(faults);
        drop(entries);
        drop(managed);
        // Discovery and binding happened first; cleanup can now only remove
        // proven-owned INACTIVE directories, never the active cache above.
        self.reclaim_owned_inactive();
    }

    /// Reconcile applied managed specs without disturbing healthy fetchers. A
    /// quarantined source is retried from its recorded cache root on every
    /// ordinary poll/manual cycle, so a repaired cache really recovers; a
    /// newly applied source gets a fetcher built from the managed cache root.
    pub fn ensure_managed(&self, sources: &[SubscriptionSourceSpec]) {
        let missing: Vec<SubscriptionSourceSpec> = {
            let entries = self.entries.lock().unwrap();
            sources
                .iter()
                .filter(|spec| !entries.iter().any(|entry| entry.id == spec.id))
                .cloned()
                .collect()
        };
        for spec in missing {
            let quarantined = self.faults.lock().unwrap().iter().any(|f| f.id == spec.id);
            if quarantined {
                let mut errors = Vec::new();
                self.retry_faulted(&spec.id, &mut errors);
            } else {
                self.build_managed_entry(&spec);
            }
        }
    }

    /// Build one newly applied managed fetcher. Healthy existing fetchers are
    /// never rebuilt, so their due times and backoff survive reconciliation.
    fn build_managed_entry(&self, spec: &SubscriptionSourceSpec) {
        let cache_root = self.managed_cache_root.lock().unwrap().clone();
        let mut managed = self.managed_ids.lock().unwrap();
        let mut entries = self.entries.lock().unwrap();
        let mut faults = self.faults.lock().unwrap();
        let mut specs_map = self.specs.lock().unwrap();
        specs_map.insert(spec.id.clone(), spec.clone());
        faults.retain(|fault| fault.id != spec.id);
        match (self.factory)(spec, &cache_root, self.trusted_ca_pem.as_deref()) {
            Ok(fetcher) => {
                entries.push(FetcherEntry {
                    id: spec.id.clone(),
                    fetcher: Arc::new(fetcher),
                    cache_root,
                });
                managed.insert(spec.id.clone());
            }
            Err(error) => faults.push(FaultedSource {
                id: spec.id.clone(),
                error: bounded(error.to_string()),
                attempts: 1,
                cache_root,
            }),
        }
        let mut all: BTreeSet<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        all.extend(faults.iter().map(|fault| fault.id.clone()));
        *self.handle.ids.lock().unwrap() = all;
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
        self.release_cleanup_lease();
    }

    /// Non-async cancellation used only by `Drop`, which cannot await.
    pub fn cancel_only(&self) {
        self.handle.cancel.cancel();
        self.handle.wake.notify_waiters();
        self.release_cleanup_lease();
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

    /// Rebuild a quarantined source from the cache root it was bound to. There
    /// is deliberately no permanent retry cap: an operator repair must be
    /// picked up by an ordinary later poll or manual token. Attempts are a
    /// truthful diagnostic counter, not a lock-out.
    fn retry_faulted(&self, id: &str, errors: &mut Vec<String>) -> bool {
        let spec = { self.specs.lock().unwrap().get(id).cloned() };
        let Some(spec) = spec else {
            errors.push(format!("{id}: applied spec is absent; cannot rebuild"));
            return false;
        };
        let cache_root = {
            let faults = self.faults.lock().unwrap();
            let Some(fault) = faults.iter().find(|fault| fault.id == id) else {
                return false;
            };
            fault.cache_root.clone()
        };
        match (self.factory)(&spec, &cache_root, self.trusted_ca_pem.as_deref()) {
            Ok(fetcher) => {
                self.faults.lock().unwrap().retain(|fault| fault.id != id);
                self.entries.lock().unwrap().push(FetcherEntry {
                    id: id.to_owned(),
                    fetcher: Arc::new(fetcher),
                    cache_root,
                });
                true
            }
            Err(error) => {
                if let Some(fault) = self
                    .faults
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|fault| fault.id == id)
                {
                    fault.error = bounded(error.to_string());
                    fault.attempts = fault.attempts.saturating_add(1);
                }
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
                errors.push(format!("{id}: no configured fetcher"));
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
            let fetcher = match fetcher {
                Some(fetcher) => Some(fetcher),
                None => {
                    if !self.retry_faulted(id, &mut errors) {
                        errors.push(format!("{id}: quarantined, no fetch attempt"));
                        continue;
                    }
                    // A recovered source performs a REAL fetch; no ack without it.
                    self.entries
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|entry| entry.id == *id)
                        .map(|entry| entry.fetcher.clone())
                }
            };
            let Some(fetcher) = fetcher else {
                errors.push(format!("{id}: recovered source has no fetcher"));
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
            // Capture the whole-bundle generation BEFORE reading any settings
            // or preparing material, and re-read both on every retry.
            let basis = server.status().bundle_generation;
            let config = server.local_config();
            let effective = match server.management_state() {
                Some(management) => {
                    match crate::management_worker::merge_config(&config, &management.config) {
                        Ok(effective) => effective,
                        Err(error) => {
                            self.applied.lock().unwrap().last_error = Some(error.to_string());
                            return;
                        }
                    }
                }
                None => config.filter.clone(),
            };
            let result =
                prepare_filter(&effective, config.policy_revision, &|id| self.last_good(id));
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
                    .map(|(id, fetcher)| FetcherEntry {
                        id,
                        fetcher,
                        cache_root: PathBuf::new(),
                    })
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
            active_caches: Mutex::new(BTreeSet::new()),
            instance_id: new_instance_id(),
            managed_cache_root: Mutex::new(PathBuf::new()),
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

/// The ONE config builder used by the production fetcher factory and by the
/// injected test factories. Bounds parity matters: Stage A accepts an explicit
/// source `max_stale_secs` up to the library's hard `MAX_STALE_SECS` (7 days),
/// while the library `Limits::default()` is 3 days. An explicit validated
/// source value is honoured up to (and never silently clipped above) that hard
/// bound; absent values keep the 3-day default. Values beyond the hard bound
/// are left for `SubscriptionConfig::validate` to reject.
pub fn single_source_config(source: &SubscriptionSourceSpec) -> SubscriptionConfig {
    let mut limits = Limits::default();
    if let Some(stale) = source.max_stale_secs {
        if stale <= MAX_STALE_SECS {
            limits.max_stale_secs = stale;
        }
    }
    SubscriptionConfig {
        sources: vec![SubscriptionSource {
            id: source.id.clone(),
            url: source.url.clone(),
            enabled: source.enabled,
            interval_secs: source.interval_secs,
            max_stale_secs: source.max_stale_secs,
            metadata: source.metadata.clone(),
        }],
        limits,
        query_policy: Default::default(),
    }
}
