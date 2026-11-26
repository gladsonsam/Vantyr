//! Listener lifecycle, first-run bootstrap and atomic reload for Vantyr DNS.
//!
//! Durable mode is opt-in: an explicit state path and worker id turn on a
//! single atomic config+policy bundle. Without them the worker runs exactly as
//! before, entirely in memory. A reload validates and builds a complete new
//! snapshot off the request path, persists it first, then publishes one `Arc`.

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use family_policy::Policy;
use hickory_server::server::Server;
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_runtime::{LkgError, WriteHooks};

use crate::bundle::{Bundle, BundleStore, BundleValidator};
use crate::compile::compile;
use crate::config::{read_bounded, Config};
use crate::controller::{ControllerError, SyncCapability};
use crate::filter::{
    compile_from_material, empty_filter, prepare as prepare_filter, FilterMaterial,
    MAX_FILTER_BUNDLE_BYTES,
};
use crate::handler::FilteringHandler;
use crate::observe::{DecisionObservation, ObservationLog};
use crate::runtime::{
    build_snapshot, reject_upstream_self_loop, same_transport, RuntimeSnapshot, SnapshotHandle,
};

const TCP_TIMEOUT_SECS: u64 = 5;
const TCP_MAX_BYTES: usize = 32 * 1024;

/// Opt-in durable mode. `now` is supplied by the caller so tests and the CLI
/// use the same code path; the binary passes `Utc::now()`.
#[derive(Clone, Debug)]
pub struct DurableOptions {
    pub state_path: PathBuf,
    pub worker_id: String,
    /// Read for first-run bootstrap and for reloads. When a snapshot already
    /// exists, the config file is read only to confirm the household identity;
    /// served policy always comes from the bundle.
    pub config_path: Option<PathBuf>,
    pub now: DateTime<Utc>,
    /// Injectable pre/post-rename seams for the durability tests.
    pub hooks: Option<WriteHooks>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReloadError {
    InvalidConfig(String),
    TransportChange(String),
    NotNewer {
        found: u64,
        highwater: u64,
    },
    /// A list source could not be read, or the filter candidate was rejected.
    /// No snapshot is swapped and no file is written on this path.
    FilterFailed(String),
    BuildFailed(String),
    PersistFailed(String),
}

impl fmt::Display for ReloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(detail) => write!(f, "invalid reload config: {detail}"),
            Self::TransportChange(detail) => {
                write!(f, "listener transport cannot change: {detail}")
            }
            Self::NotNewer { found, highwater } => write!(
                f,
                "revision {found} is not newer than the applied revision {highwater}"
            ),
            Self::FilterFailed(detail) => write!(f, "filter candidate failed: {detail}"),
            Self::BuildFailed(detail) => write!(f, "candidate build failed: {detail}"),
            Self::PersistFailed(detail) => write!(f, "candidate persistence failed: {detail}"),
        }
    }
}

impl std::error::Error for ReloadError {}

/// What actually became current after a successful reload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReloadOutcome {
    pub revision: u64,
    pub published_at: DateTime<Utc>,
}

/// A running Vantyr DNS listener. The public API stays small: bind address,
/// bounded observations, reload, status and orderly shutdown.
pub struct DnsServer {
    shutdown: CancellationToken,
    bind_addr: SocketAddr,
    task: Option<JoinHandle<()>>,
    observations: ObservationLog,
    current: SnapshotHandle,
    store: Option<BundleStore>,
    /// Serialises ALL mutations (local reload and controller pull). Held only
    /// off the query path: queries clone an Arc from `current` and never take
    /// this lock. This makes the compile basis, persist and publish of one
    /// update atomic with respect to every other update.
    update: Mutex<()>,
}

impl DnsServer {
    /// Validate, build, bind UDP and TCP on the same port, and start serving.
    /// No socket exists until configuration has passed full validation.
    pub async fn start(config: Config) -> Result<Self> {
        config.validate()?;
        let (material, filter) = prepare_filter(&config.filter, config.policy_revision)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .map_or_else(
                || (None, empty_filter()),
                |(material, filter)| (Some(material), filter),
            );
        let observations = ObservationLog::default();
        let snapshot = build_snapshot(
            config.clone(),
            config.policy(Utc::now()),
            observations.clone(),
            filter,
            material,
        )?;
        Self::serve(config, snapshot, observations, None).await
    }

    /// Start in opt-in durable mode. On a lost-ack restart the local bundle is
    /// authoritative: an existing state file is loaded and validated before a
    /// listener exists, and the config file is never used as a newer policy.
    /// A config is read only for first-run bootstrap.
    pub async fn start_durable(options: DurableOptions) -> Result<Self> {
        let validator = BundleValidator;
        // The one bundle now carries bounded filter material as well as small
        // settings. Raise this store's serialization ceiling explicitly; the
        // runtime default (1 MiB) and every other store stay unchanged.
        let store = match BundleStore::open_from_snapshot_with_limit(
            &options.state_path,
            &options.worker_id,
            validator,
            MAX_FILTER_BUNDLE_BYTES,
        ) {
            Ok(store) => {
                let household = store.household_id();
                if let Some(path) = &options.config_path {
                    let config = Config::parse(&read_bounded(path)?)?;
                    if config.household_id != household.to_string() {
                        bail!("state file belongs to another household; refusing to serve it");
                    }
                }
                store
            }
            Err(LkgError::Missing) => {
                let path = options
                    .config_path
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("no state file and no bootstrap config"))?;
                let config = Config::parse(&read_bounded(path)?)?;
                let household = config.household_id.clone();
                let store = BundleStore::open_with_limit(
                    &options.state_path,
                    uuid_from_household(&household)?,
                    &options.worker_id,
                    validator,
                    MAX_FILTER_BUNDLE_BYTES,
                )?;
                let published_at = config.policy_published_at.unwrap_or(options.now);
                let material = prepare_filter(&config.filter, config.policy_revision)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?
                    .map(|(material, _snapshot)| material);
                let bundle = Bundle::build_with_filter(&config, published_at, material)?;
                // Persist before the listener exists. A failure here leaves no
                // listener and no partly written state.
                store.apply(bundle, options.now)?;
                store
            }
            Err(error) => return Err(error.into()),
        };

        let store = match options.hooks {
            Some(hooks) => store.with_hooks(hooks),
            None => store,
        };
        let bundle = store
            .current()
            .expect("a durable store always has a loaded or bootstrapped bundle");
        let observations = ObservationLog::default();
        // Recompile from the persisted bytes, never from the source paths. A
        // source file that changed or vanished while the worker was down does
        // not silently change the filter that was actually applied.
        let filter = compile_from_material(bundle.filter.as_ref(), &bundle.config.filter)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .unwrap_or_else(empty_filter);
        let snapshot = build_snapshot(
            bundle.config.clone(),
            bundle.policy.clone(),
            observations.clone(),
            filter,
            bundle.filter.clone(),
        )?;
        Self::serve(bundle.config, snapshot, observations, Some(store)).await
    }

    async fn serve(
        config: Config,
        snapshot: Arc<RuntimeSnapshot>,
        observations: ObservationLog,
        store: Option<BundleStore>,
    ) -> Result<Self> {
        let current: SnapshotHandle = Arc::new(RwLock::new(snapshot));
        let handler = FilteringHandler::new(current.clone());
        let mut server = Server::new(handler);
        // With an ephemeral port the OS may hand back a UDP port whose TCP
        // side is already held by another worker. Retry a bounded number of
        // times instead of failing a valid config on that accidental collision.
        let mut attempts = 0;
        let (udp, tcp, bound) = loop {
            let udp = UdpSocket::bind(config.bind.configured_addr()).await?;
            let bound = udp.local_addr()?;
            // Re-check against the actual port (port 0 is assigned by the OS).
            reject_upstream_self_loop(&config, bound)?;
            match TcpListener::bind(bound).await {
                Ok(tcp) => break (udp, tcp, bound),
                Err(error) if config.bind.port == 0 && error.kind() == io::ErrorKind::AddrInUse => {
                    attempts += 1;
                    if attempts >= 32 {
                        return Err(error.into());
                    }
                    drop(udp);
                }
                Err(error) => return Err(error.into()),
            }
        };
        server.register_socket(udp);
        server.register_listener(tcp, Duration::from_secs(TCP_TIMEOUT_SECS), TCP_MAX_BYTES);

        let shutdown = server.shutdown_token().clone();
        let task = tokio::spawn(async move {
            if let Err(error) = server.block_until_done().await {
                tracing::debug!(%error, "Vantyr DNS server stopped with an error");
            }
        });
        Ok(Self {
            shutdown,
            bind_addr: bound,
            task: Some(task),
            observations,
            current,
            store,
            update: Mutex::new(()),
        })
    }

    /// Validate a full candidate, build its catalog and policy off the request
    /// path, persist it before publishing, then swap one immutable snapshot.
    /// Any failure at any stage leaves both disk and runtime on the old version.
    pub fn reload(
        &self,
        candidate: &[u8],
        now: DateTime<Utc>,
    ) -> Result<ReloadOutcome, ReloadError> {
        let _update = self
            .update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        use ReloadError::*;
        let config = Config::parse(candidate).map_err(|e| InvalidConfig(e.to_string()))?;
        self.check_candidate(&config)?;
        // Source files are read and the filter compiled here, off the query
        // path and before any persistence or swap. A missing, oversized or
        // malformed candidate file rejects the whole candidate.
        let (material, filter) = prepare_filter(&config.filter, config.policy_revision)
            .map_err(|error| FilterFailed(error.to_string()))?
            .map_or_else(
                || (None, empty_filter()),
                |(material, filter)| (Some(material), filter),
            );
        let published_at = config.policy_published_at.unwrap_or(now);
        let bundle = Bundle::build_with_filter(&config, published_at, material.clone())
            .map_err(|e| InvalidConfig(e.to_string()))?;
        self.publish_bundle(config, bundle, now, filter, material)
    }

    /// Validate the replayable local-control preconditions shared by SIGHUP
    /// reloads and controller candidates. A controller candidate uses the same
    /// transport and household checks; only its content source differs.
    fn check_candidate(&self, config: &Config) -> Result<(), ReloadError> {
        use ReloadError::*;
        let active = self.active_snapshot();
        if !same_transport(config, &active.config) {
            return Err(TransportChange(
                "bind address, port or loopback opt-in differs from the listener".into(),
            ));
        }
        if config.household_id != active.config.household_id {
            return Err(InvalidConfig(
                "candidate belongs to another household".into(),
            ));
        }
        let highwater = self.highwater(active.revision);
        if config.policy_revision <= highwater {
            return Err(NotNewer {
                found: config.policy_revision,
                highwater,
            });
        }
        Ok(())
    }

    fn active_snapshot(&self) -> Arc<RuntimeSnapshot> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn highwater(&self, active_revision: u64) -> u64 {
        self.store
            .as_ref()
            .map_or(active_revision, |store| store.highwater())
            .max(active_revision)
    }

    /// Persist first, then swap one immutable snapshot. A concurrent local
    /// reload or controller pull can only win with a strictly newer revision;
    /// the store enforces the same monotonicity on disk.
    fn publish_bundle(
        &self,
        config: Config,
        bundle: Bundle,
        now: DateTime<Utc>,
        filter: std::sync::Arc<vantyr_network_filter::FilterSnapshot>,
        material: Option<FilterMaterial>,
    ) -> Result<ReloadOutcome, ReloadError> {
        use ReloadError::*;
        let revision = bundle.revision();
        let published_at = bundle.published_at();
        let snapshot = build_snapshot(
            config,
            bundle.policy.clone(),
            self.observations.clone(),
            filter,
            material,
        )
        .map_err(|e| BuildFailed(e.to_string()))?;

        if let Some(store) = &self.store {
            store
                .apply(bundle, now)
                .map_err(|e| PersistFailed(e.to_string()))?;
        }

        let mut current = self
            .current
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if revision <= current.revision {
            return Err(NotNewer {
                found: revision,
                highwater: current.revision,
            });
        }
        *current = snapshot;
        Ok(ReloadOutcome {
            revision,
            published_at,
        })
    }

    /// Compile a verified controller policy onto the worker's local transport
    /// config and apply it through the same monotonic persist/swap path as a
    /// local reload. Same revision + same whole policy is an idempotent no-op;
    /// same revision + different content is rejected before any write.
    pub fn apply_controller_policy(
        &self,
        policy: &Policy,
        now: DateTime<Utc>,
    ) -> Result<SyncCapability, ControllerError> {
        // One update at a time, and the compile basis is the CURRENT whole
        // snapshot (not a startup capture). A local reload that won earlier is
        // therefore the basis for this pull; a local reload that comes later
        // cannot be reverted by an older pull's stale basis.
        let _update = self
            .update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let active = self.active_snapshot();
        let candidate = compile(&active.config, policy)?;
        if !same_transport(&candidate, &active.config) {
            return Err(ControllerError::Unsupported(
                "controller candidate would change the listener transport".into(),
            ));
        }
        if candidate.household_id != active.config.household_id {
            return Err(ControllerError::Integrity(
                "controller policy belongs to another household".into(),
            ));
        }
        let published_at = candidate.policy_published_at.unwrap_or(now);
        // `compile` carries every local field, including the filter settings,
        // and the active material/snapshot are reused verbatim. A pull can
        // therefore neither drop filtering nor restore a startup filter after
        // a newer local filter change.
        let filter = active.filter.clone();
        let material = active.filter_material.clone();
        let bundle = Bundle::build_with_filter(&candidate, published_at, material.clone())
            .map_err(|error| ControllerError::Unsupported(error.to_string()))?;
        let revision = candidate.policy_revision;
        let highwater = self.highwater(active.revision);
        if revision == active.revision {
            if bundle.policy == active.policy {
                // No reset, no fresh save time, no age freshening.
                return Ok(SyncCapability::Unchanged { revision });
            }
            return Err(ControllerError::SameRevisionConflict(revision));
        }
        if revision < highwater {
            return Err(ControllerError::StaleRevision {
                found: revision,
                highwater,
            });
        }
        let outcome = self
            .publish_bundle(candidate, bundle, now, filter, material)
            .map_err(|error| match error {
                ReloadError::NotNewer { found, highwater } => {
                    ControllerError::StaleRevision { found, highwater }
                }
                ReloadError::PersistFailed(detail) => ControllerError::Persistence(detail),
                other => ControllerError::Unsupported(other.to_string()),
            })?;
        Ok(SyncCapability::AppliedLocally {
            revision: outcome.revision,
        })
    }

    /// Apply already validated, typed list material through the *same*
    /// compile -> persist -> publish path as a local reload. This is the sole
    /// seam a future fetch layer uses; it introduces no second filter state,
    /// store or error-swallowing path. No URL is fetched or retained here and
    /// the policy's original publication age is preserved.
    ///
    /// The caller supplies a strictly newer policy revision (the store's
    /// monotonic high-water mark applies) and material whose source ids and
    /// selected services match the current local filter settings.
    pub fn apply_filter_material(
        &self,
        revision: u64,
        material: FilterMaterial,
        now: DateTime<Utc>,
    ) -> Result<ReloadOutcome, ReloadError> {
        let _update = self
            .update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        use ReloadError::*;
        let active = self.active_snapshot();
        let mut config = active.config.clone();
        config.policy_revision = revision;
        config.policy_published_at = Some(active.policy.published_at);
        self.check_candidate(&config)?;
        let filter = compile_from_material(Some(&material), &config.filter)
            .map_err(|error| FilterFailed(error.to_string()))?
            .unwrap_or_else(empty_filter);
        let bundle =
            Bundle::build_with_filter(&config, active.policy.published_at, Some(material.clone()))
                .map_err(|error| InvalidConfig(error.to_string()))?;
        self.publish_bundle(config, bundle, now, filter, Some(material))
    }

    /// Local worker config currently serving. Kept read-only: callers must go
    /// through the compile/reload path to change policy.
    pub fn local_config(&self) -> Config {
        self.active_snapshot().config.clone()
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }

    /// Revision of the snapshot currently answering queries.
    pub fn revision(&self) -> u64 {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .revision
    }

    /// Original publication time of the currently active policy.
    pub fn published_at(&self) -> DateTime<Utc> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .published_at
    }

    pub fn is_durable(&self) -> bool {
        self.store.is_some()
    }

    /// Bounded decision observations. Never includes raw request bytes.
    pub fn observations(&self) -> Vec<DecisionObservation> {
        self.observations.snapshot()
    }

    pub fn clear_observations(&self) {
        self.observations.clear();
    }

    pub async fn stop(mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

fn uuid_from_household(raw: &str) -> Result<family_policy::HouseholdId> {
    use std::str::FromStr;
    family_policy::HouseholdId::from_str(raw)
        .map_err(|_| anyhow::anyhow!("household_id is not a UUID"))
}

impl Drop for DnsServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
