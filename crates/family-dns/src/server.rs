//! Listener lifecycle, first-run bootstrap and atomic reload for Vantyr DNS.
//!
//! Durable mode is opt-in: an explicit state path and worker id turn on a
//! single atomic config+policy+material bundle. Without them the worker runs
//! exactly as before, entirely in memory. A reload validates and builds a
//! complete new snapshot off the request path, persists it first, then
//! publishes one `Arc`.
//!
//! Three counters are deliberately independent. `policy.revision` belongs to
//! the household/controller policy space; `bundle_generation` advances on
//! every durable commit (policy OR list refresh); `filter_generation` advances
//! only when the applied material content changes. A list refresh never
//! invents a policy revision and cannot make the next controller revision
//! stale.

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use family_policy::Policy;
use hickory_resolver::Hosts;
use hickory_server::server::Server;
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_runtime::{LkgError, WriteHooks};

use crate::bundle::{Bundle, BundleStore, BundleValidator};
use crate::compile::compile;
use crate::config::{read_bounded, Config};
use crate::controller::{ControllerError, SyncCapability};
use crate::dot::PreparedTls;
use crate::events::EventQueue;
use crate::filter::{
    compile_from_material, empty_filter, material_identity, no_remote, prepare as prepare_filter,
    FilterMaterial, MAX_FILTER_BUNDLE_BYTES,
};
use crate::handler::FilteringHandler;
use crate::observe::{DecisionObservation, ObservationLog};
use crate::runtime::{
    build_snapshot, build_snapshot_with_hosts, reject_upstream_self_loop, same_transport,
    BundleState, RuntimeSnapshot, SnapshotHandle,
};
use crate::subscription::{AppliedStatus, SourceStatus, SubscriptionRuntime};

const TCP_TIMEOUT_SECS: u64 = 5;
const TCP_MAX_BYTES: usize = 32 * 1024;
/// Small bounded backoff between bind proofs in `stop_and_wait`. It is a
/// retry delay only; release is proven by a successful rebind, never by the
/// passing of time. Capped by the caller's deadline.
const RELEASE_PROBE_BACKOFF: Duration = Duration::from_millis(2);
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
    /// The bundle generation changed while a material candidate was being
    /// prepared; the candidate must be rebuilt from the current settings.
    StaleBasis {
        found: u64,
        expected: u64,
    },
    Conflict(String),
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
            Self::Conflict(detail) => write!(f, "management conflict: {detail}"),
            Self::StaleBasis { found, expected } => write!(
                f,
                "material was prepared for bundle generation {expected} but generation {found} is current"
            ),
            Self::BuildFailed(detail) => write!(f, "candidate build failed: {detail}"),
            Self::PersistFailed(detail) => write!(f, "candidate persistence failed: {detail}"),
        }
    }
}

impl std::error::Error for ReloadError {}

/// What actually became current after a successful durable commit. The policy
/// revision and both independent counters are reported separately.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReloadOutcome {
    pub revision: u64,
    pub published_at: DateTime<Utc>,
    pub generation: u64,
    pub filter_generation: u64,
}

/// Result of an idempotent material-only update. An unchanged material never
/// advances a generation or writes a file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MaterialOutcome {
    Applied {
        generation: u64,
        filter_generation: u64,
        policy_revision: u64,
    },
    Unchanged {
        generation: u64,
        filter_generation: u64,
        policy_revision: u64,
    },
}

/// Labeled status for a running worker. Nothing here claims a download was
/// enforced or that a controller acknowledged anything.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DnsStatus {
    pub policy_revision: u64,
    pub policy_published_at: DateTime<Utc>,
    pub bundle_generation: u64,
    pub filter_generation: u64,
    pub filter_identity: String,
}

/// A running Vantyr DNS listener. The public API stays small: bind address,
/// bounded observations, reload, status and orderly shutdown.
pub struct DnsServer {
    shutdown: CancellationToken,
    bind_addr: SocketAddr,
    /// The OS-assigned address of the DoQ UDP socket, captured from
    /// `UdpSocket::local_addr()` at the moment of a successful bind. Never a
    /// caller-supplied address. Used only by `stop_and_wait` to verify that
    /// the exact owned port has been released before a same-port restart.
    doq_bound: Option<SocketAddr>,
    task: Mutex<Option<JoinHandle<()>>>,
    observations: ObservationLog,
    current: SnapshotHandle,
    store: Option<BundleStore>,
    subscriptions: Option<Arc<SubscriptionRuntime>>,
    /// Serialises ALL mutations (local reload, controller pull and material
    /// update). Held only off the query path: queries clone an Arc from
    /// `current` and never take this lock.
    update: Mutex<()>,
}

impl DnsServer {
    /// Validate, build, bind UDP and TCP on the same port, and start serving.
    /// No socket exists until configuration has passed full validation.
    pub async fn start(config: Config) -> Result<Self> {
        Self::start_inner(config, None, None).await
    }

    /// Start with an opt-in event channel. Reporting is a side channel: an
    /// outage in the controller never delays or changes a DNS answer.
    pub async fn start_with_events(config: Config, events: Arc<EventQueue>) -> Result<Self> {
        Self::start_inner(config, None, Some(events)).await
    }

    /// Test-only seam: start with a maintained Hickory `Hosts` table injected
    /// instead of reading the machine's hosts file. No host file is changed.
    #[doc(hidden)]
    pub async fn start_with_hosts(config: Config, hosts: Arc<Hosts>) -> Result<Self> {
        Self::start_inner(config, Some(hosts), None).await
    }

    async fn start_inner(
        config: Config,
        hosts: Option<Arc<Hosts>>,
        events: Option<Arc<EventQueue>>,
    ) -> Result<Self> {
        config.validate()?;
        let (material, filter) = prepare_filter(&config.filter, config.policy_revision, &no_remote)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .map_or_else(
                || (None, empty_filter()),
                |(material, filter)| (Some(material), filter),
            );
        let state = initial_state(&config, material.as_ref());
        let observations = ObservationLog::default();
        let snapshot = build_snapshot_with_hosts(
            config.clone(),
            config.policy(Utc::now()),
            observations.clone(),
            filter,
            material,
            state,
            None,
            hosts,
        )?;
        // Prepare BOTH encrypted listeners' material once from the same
        // validated config the snapshot was built from, before any socket
        // exists or any state is written.
        let tls = PreparedTls::prepare(&config)?;
        Self::serve(config, snapshot, observations, None, None, events, tls).await
    }

    /// Start in opt-in durable mode. On a lost-ack restart the local bundle is
    /// authoritative: an existing state file is loaded and validated before a
    /// listener exists, and the config file is never used as a newer policy.
    pub async fn start_durable(options: DurableOptions) -> Result<Self> {
        Self::start_durable_inner(options, None, None)
            .await
            .map(|(server, _)| server)
    }

    /// Durable start with an operator-opted-in subscription runtime. No URL is
    /// fetched after binding except by the single integrator task. Returns the
    /// ONE canonical `Arc` that owns the listener for the runtime lifetime.
    /// Do not unwrap and re-wrap it: the task's Weak would never upgrade.
    pub async fn start_durable_with_subscriptions(
        options: DurableOptions,
        subscriptions: Option<Arc<SubscriptionRuntime>>,
    ) -> Result<Arc<Self>> {
        let (server, bootstrap_errors) =
            Self::start_durable_inner(options, subscriptions, None).await?;
        // Rehydrate managed fetchers from the applied bundle BEFORE the
        // coordinator polls. No network: a cache fault quarantines only.
        if let (Some(runtime), Some(management)) =
            (server.subscriptions.clone(), server.management_state())
        {
            let specs: Vec<_> = management
                .config
                .sources
                .iter()
                .map(crate::management_worker::to_source_spec)
                .collect();
            runtime.rehydrate_managed(&specs);
        }
        let shared = Arc::new(server);
        if let Some(runtime) = &shared.subscriptions {
            runtime.initialize(&shared.status());
            if !bootstrap_errors.is_empty() {
                runtime.record_error(bootstrap_errors.join("; "));
            }
            runtime.start(Arc::downgrade(&shared));
        }
        Ok(shared)
    }

    /// Durable start with an opt-in event queue threaded into the REAL
    /// listener. This is the production entry point used by `--dns-events`.
    /// It keeps the same single canonical `Arc` as the subscription path: the
    /// event worker holds only queue/client handles and never owns the socket.
    pub async fn start_durable_with_events(
        options: DurableOptions,
        subscriptions: Option<Arc<SubscriptionRuntime>>,
        events: Arc<EventQueue>,
    ) -> Result<Arc<Self>> {
        let (server, bootstrap_errors) =
            Self::start_durable_inner(options, subscriptions, Some(events)).await?;
        if let (Some(runtime), Some(management)) =
            (server.subscriptions.clone(), server.management_state())
        {
            let specs: Vec<_> = management
                .config
                .sources
                .iter()
                .map(crate::management_worker::to_source_spec)
                .collect();
            runtime.rehydrate_managed(&specs);
        }
        let shared = Arc::new(server);
        if let Some(runtime) = &shared.subscriptions {
            runtime.initialize(&shared.status());
            if !bootstrap_errors.is_empty() {
                runtime.record_error(bootstrap_errors.join("; "));
            }
            runtime.start(Arc::downgrade(&shared));
        }
        Ok(shared)
    }

    async fn start_durable_inner(
        options: DurableOptions,
        subscriptions: Option<Arc<SubscriptionRuntime>>,
        events: Option<Arc<EventQueue>>,
    ) -> Result<(Self, Vec<String>)> {
        let validator = BundleValidator;
        let mut bootstrap_errors: Vec<String> = Vec::new();
        // Prepare TLS for BOTH encrypted listeners ONCE for whichever config is
        // actually selected, and pass the result into `serve`. On a cold start
        // that is the bootstrap config; on a restart it is the persisted
        // bundle. No path is re-read later, so an invalid cert/key fails before
        // any state write and before any bind and there is no preflight/reload
        // window to exploit.
        let mut prepared_tls = PreparedTls::default();
        let mut needs_tls_prepare = true;
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
                // Validate/load both listeners' material for the config that
                // is about to become the persisted bundle, before any state
                // write or bind.
                prepared_tls = PreparedTls::prepare(&config)?;
                needs_tls_prepare = false;
                let household = config.household_id.clone();
                let store = BundleStore::open_with_limit(
                    &options.state_path,
                    uuid_from_household(&household)?,
                    &options.worker_id,
                    validator,
                    MAX_FILTER_BUNDLE_BYTES,
                )?;
                let published_at = config.policy_published_at.unwrap_or(options.now);
                // A clean installation has no applied bundle and no cache. Do
                // ONE bounded verified fetch before any listener exists; a
                // valid restart never takes this branch and never waits on a
                // download. Missing material below still fails closed.
                bootstrap_errors = match &subscriptions {
                    Some(runtime) => runtime.bootstrap_fetch().await,
                    None => Vec::new(),
                };
                let remote_subscriptions = subscriptions.clone();
                let remote = |id: &str| match &remote_subscriptions {
                    Some(runtime) => runtime.last_good(id),
                    None => no_remote(id),
                };
                let material = prepare_filter(&config.filter, config.policy_revision, &remote)
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
        if needs_tls_prepare {
            // Restart: the persisted bundle is authoritative. Prepare TLS from
            // its config, NOT from the bootstrap file, and still before any
            // bind. A changed bootstrap config cannot redirect either
            // listener's transport or certificate paths.
            prepared_tls = PreparedTls::prepare(&bundle.config)?;
        }
        let observations = ObservationLog::default();
        // Recompile from the persisted bytes, never from the source paths. A
        // source file/cache that changed or vanished while the worker was down
        // does not change the filter that was actually applied.
        let effective_filter = match &bundle.management {
            Some(management) => {
                crate::management_worker::merge_config(&bundle.config, &management.config)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?
            }
            None => bundle.config.filter.clone(),
        };
        let filter = compile_from_material(bundle.filter.as_ref(), &effective_filter)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .unwrap_or_else(empty_filter);
        let state = BundleState {
            generation: bundle.generation(),
            policy_highwater: bundle.policy_highwater(),
            filter_generation: bundle.filter_generation(),
            filter_identity: material_identity(bundle.filter.as_ref()),
        };
        let snapshot = build_snapshot(
            bundle.config.clone(),
            bundle.policy.clone(),
            observations.clone(),
            filter,
            bundle.filter.clone(),
            state,
            bundle.management.clone(),
        )?;
        let mut server = Self::serve(
            bundle.config,
            snapshot,
            observations,
            Some(store),
            None,
            events,
            prepared_tls,
        )
        .await?;
        server.subscriptions = subscriptions;
        Ok((server, bootstrap_errors))
    }

    async fn serve(
        config: Config,
        snapshot: Arc<RuntimeSnapshot>,
        observations: ObservationLog,
        store: Option<BundleStore>,
        subscriptions: Option<Arc<SubscriptionRuntime>>,
        events: Option<Arc<EventQueue>>,
        tls: PreparedTls,
    ) -> Result<Self> {
        // TLS is prepared ONCE by the caller against the actual selected
        // config, before any state write and before any bind. Do not reload
        // from the paths here: a second read would reopen the TOCTOU window
        // and could let a bad certificate fail after state was persisted.
        let current: SnapshotHandle = Arc::new(RwLock::new(snapshot));
        let handler = FilteringHandler::with_events(current.clone(), events);
        let mut server = Server::new(handler);
        let mut attempts = 0;
        let (udp, tcp, bound) = loop {
            let udp = UdpSocket::bind(config.bind.configured_addr()).await?;
            let bound = udp.local_addr()?;
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
        // Every listener shares this Server (and therefore its shutdown token)
        // and the same FilteringHandler: decrypted queries get the identical
        // immutable policy and source-IP device mapping.
        let mut bound_addrs = vec![bound];
        // Optional DoT listener: ALPN "dot", TLS on its own port.
        if let (Some(spec), Some(cfg)) = (config.dot_listener.as_ref(), tls.dot) {
            let dot = TcpListener::bind(spec.bind.configured_addr()).await?;
            let dot_bound = dot.local_addr()?;
            reject_upstream_self_loop(&config, dot_bound)?;
            reject_duplicate_bind(&bound_addrs, dot_bound)?;
            bound_addrs.push(dot_bound);
            server.register_tls_listener_with_tls_config(
                dot,
                Duration::from_secs(TCP_TIMEOUT_SECS),
                cfg,
            )?;
        }
        // Optional DoH listener: ALPN "h2" only, one hostname and one path.
        // Hickory's maintained h2 handler takes the client source from the
        // accepted socket; untrusted forwarding headers are never consulted.
        if let (Some(spec), Some(cfg)) = (config.doh_listener.as_ref(), tls.doh) {
            let doh = TcpListener::bind(spec.bind.configured_addr()).await?;
            let doh_bound = doh.local_addr()?;
            reject_upstream_self_loop(&config, doh_bound)?;
            reject_duplicate_bind(&bound_addrs, doh_bound)?;
            server.register_https_listener_with_tls_config(
                doh,
                Duration::from_secs(TCP_TIMEOUT_SECS),
                cfg,
                Some(spec.hostname.clone()),
                spec.path.clone(),
            )?;
        }
        // Optional DoQ listener: UDP on its own port, TLS 1.3 with the single
        // `doq` ALPN. Hickory's maintained QUIC handler takes the client source
        // from the accepted connection address; no identity is inferred from it.
        // It is registered last, so any failure here drops the already-registered
        // sockets and tasks before the serving task is started.
        let mut doq_bound_addr = None;
        if let (Some(spec), Some(cfg)) = (config.doq_listener.as_ref(), tls.doq) {
            let doq = UdpSocket::bind(spec.bind.configured_addr()).await?;
            let doq_bound = doq.local_addr()?;
            reject_upstream_self_loop(&config, doq_bound)?;
            reject_duplicate_bind(&bound_addrs, doq_bound)?;
            bound_addrs.push(doq_bound);
            server.register_quic_listener_and_tls_config(
                doq,
                Duration::from_secs(TCP_TIMEOUT_SECS),
                cfg,
            )?;
            // Retain the address the OS actually assigned at a successful
            // bind (it may be an ephemeral port). This is the only address
            // `stop_and_wait` is allowed to verify.
            doq_bound_addr = Some(doq_bound);
        }
        let shutdown = server.shutdown_token().clone();
        let task = tokio::spawn(async move {
            if let Err(error) = server.block_until_done().await {
                tracing::debug!(%error, "Vantyr DNS server stopped with an error");
            }
        });
        Ok(Self {
            shutdown,
            bind_addr: bound,
            doq_bound: doq_bound_addr,
            task: Mutex::new(Some(task)),
            observations,
            current,
            store,
            subscriptions,
            update: Mutex::new(()),
        })
    }

    /// Validate a full candidate, build its catalog and policy off the request
    /// path, persist it before publishing, then swap one immutable snapshot.
    pub fn reload(
        &self,
        candidate: &[u8],
        now: DateTime<Utc>,
    ) -> Result<ReloadOutcome, ReloadError> {
        let _update = self.update.lock().unwrap_or_else(|p| p.into_inner());
        use ReloadError::*;
        let mut config = Config::parse(candidate).map_err(|e| InvalidConfig(e.to_string()))?;
        let active = self.active_snapshot();
        // A local reload supplies operator files, but applied management
        // settings are authoritative and must survive it unchanged.
        self.carry_applied_settings(&mut config, &active)?;
        self.check_candidate(&config, &active)?;
        let remote = |id: &str| match &self.subscriptions {
            Some(runtime) => runtime.last_good(id),
            None => no_remote(id),
        };
        // Material must include enabled managed sources; local settings remain
        // authoritative for paths/trust and any id collision is rejected.
        let effective_filter = match &active.management {
            Some(management) => crate::management_worker::merge_config(&config, &management.config)
                .map_err(|error| InvalidConfig(error.to_string()))?,
            None => config.filter.clone(),
        };
        let (material, filter) = prepare_filter(&effective_filter, config.policy_revision, &remote)
            .map_err(|error| FilterFailed(error.to_string()))?
            .map_or_else(
                || (None, empty_filter()),
                |(material, filter)| (Some(material), filter),
            );
        let (filter_generation, identity) =
            self.next_filter_generation(&active, material.as_ref())?;
        let published_at = config.policy_published_at.unwrap_or(now);
        let bundle = Bundle::unchecked(
            config.clone(),
            config.policy_at(published_at),
            material.clone(),
            active.management.clone(),
        );
        let bundle = self.next_bundle(&bundle, &active, filter_generation)?;
        let bundle = self.preserve_management(bundle, &active, filter_generation)?;
        self.publish_bundle(bundle, now, filter, material, identity)
    }

    fn next_filter_generation(
        &self,
        active: &RuntimeSnapshot,
        material: Option<&FilterMaterial>,
    ) -> Result<(u64, String), ReloadError> {
        match material {
            None => Ok((0, String::new())),
            Some(material) => {
                let identity = material_identity(Some(material));
                if identity == active.state.filter_identity {
                    Ok((active.state.filter_generation, identity))
                } else {
                    let next = active
                        .state
                        .filter_generation
                        .checked_add(1)
                        .ok_or_else(|| {
                            ReloadError::InvalidConfig(
                                "filter generation overflow; refusing to wrap".into(),
                            )
                        })?;
                    Ok((next, identity))
                }
            }
        }
    }

    /// Re-apply server-manageable runtime settings to a local reload candidate.
    /// Only the supported cache/deny fields are touched; policy revision and
    /// publication time come from the local candidate and are never freshened.
    fn carry_applied_settings(
        &self,
        config: &mut Config,
        active: &RuntimeSnapshot,
    ) -> Result<(), ReloadError> {
        // The applied settings live in the single current config itself, so a
        // local reload copies exactly those validated cache/deny fields.
        if active.management.is_some() {
            config.cache = active.config.cache.clone();
            config.deny = active.config.deny.clone();
        }
        Ok(())
    }

    /// Preserve the current applied management state through a local reload or
    /// controller pull; material/identity may change but management does not.
    fn preserve_management(
        &self,
        bundle: Bundle,
        active: &RuntimeSnapshot,
        filter_generation: u64,
    ) -> Result<Bundle, ReloadError> {
        match &active.management {
            Some(management) => bundle
                .with_management(bundle.generation(), filter_generation, management.clone())
                .map_err(|error| ReloadError::BuildFailed(error.to_string())),
            None => Ok(bundle),
        }
    }

    fn next_bundle(
        &self,
        bundle: &Bundle,
        active: &RuntimeSnapshot,
        filter_generation: u64,
    ) -> Result<Bundle, ReloadError> {
        let generation = active.state.generation.checked_add(1).ok_or_else(|| {
            ReloadError::InvalidConfig("bundle generation overflow; refusing to wrap".into())
        })?;
        bundle
            .with_generation(generation, filter_generation)
            .map_err(|error| ReloadError::BuildFailed(error.to_string()))
    }

    /// Shared preconditions for local reloads and controller candidates. The
    /// revision space here is the POLICY space, never the bundle generation.
    fn check_candidate(
        &self,
        config: &Config,
        active: &RuntimeSnapshot,
    ) -> Result<(), ReloadError> {
        use ReloadError::*;
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
        let highwater = active.state.policy_highwater.max(active.policy.revision);
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

    /// Persist first, then swap one immutable snapshot. Every caller holds the
    /// updates mutex, so generation assignment, disk commit and publication are
    /// atomic with respect to each other.
    fn publish_bundle(
        &self,
        bundle: Bundle,
        now: DateTime<Utc>,
        filter: Arc<vantyr_network_filter::FilterSnapshot>,
        material: Option<FilterMaterial>,
        identity: String,
    ) -> Result<ReloadOutcome, ReloadError> {
        use ReloadError::*;
        let revision = bundle.revision();
        let generation = bundle.generation();
        let filter_generation = bundle.filter_generation();
        let published_at = bundle.published_at();
        let state = BundleState {
            generation,
            policy_highwater: bundle.policy_highwater(),
            filter_generation,
            filter_identity: identity,
        };
        let snapshot = build_snapshot(
            bundle.config.clone(),
            bundle.policy.clone(),
            self.observations.clone(),
            filter,
            material,
            state,
            bundle.management.clone(),
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
        if generation <= current.state.generation {
            return Err(NotNewer {
                found: generation,
                highwater: current.state.generation,
            });
        }
        *current = snapshot;
        Ok(ReloadOutcome {
            revision,
            published_at,
            generation,
            filter_generation,
        })
    }

    /// Compile a verified controller policy onto the worker's local transport
    /// config and apply it through the same monotonic persist/swap path.
    pub fn apply_controller_policy(
        &self,
        policy: &Policy,
        now: DateTime<Utc>,
    ) -> Result<SyncCapability, ControllerError> {
        let _update = self.update.lock().unwrap_or_else(|p| p.into_inner());
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
        // Every local field, including filter settings, travels with the pull;
        // the current material and snapshot are reused verbatim.
        let filter = active.filter.clone();
        let material = active.filter_material.clone();
        let bundle = Bundle::unchecked(
            candidate.clone(),
            candidate.policy_at(published_at),
            material.clone(),
            active.management.clone(),
        );
        let revision = candidate.policy_revision;
        let highwater = active.state.policy_highwater.max(active.policy.revision);
        if revision == active.revision {
            if bundle.policy == active.policy {
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
        let bundle =
            bundle
                .with_generation(
                    active.state.generation.checked_add(1).ok_or_else(|| {
                        ControllerError::Unsupported("generation overflow".into())
                    })?,
                    active.state.filter_generation,
                )
                .map_err(|error| ControllerError::Unsupported(error.to_string()))?;
        let bundle = self
            .preserve_management(bundle, &active, active.state.filter_generation)
            .map_err(|error| ControllerError::Unsupported(error.to_string()))?;
        let outcome = self
            .publish_bundle(
                bundle,
                now,
                filter,
                material,
                active.state.filter_identity.clone(),
            )
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

    /// Apply already validated, typed material through the *same*
    /// compile -> persist -> publish path as a local reload. This is the sole
    /// seam used by the subscription integrator: no second filter state or
    /// store, no swallowed errors, and NO policy revision is advanced.
    /// `expected_generation` is the whole-bundle generation observed when the
    /// candidate material was prepared. Any local reload, controller update
    /// or earlier material commit changes it, so a stale candidate is rejected
    /// under this lock instead of reverting a newer local source/policy.
    pub fn apply_filter_material(
        &self,
        material: FilterMaterial,
        expected_generation: u64,
        now: DateTime<Utc>,
    ) -> Result<MaterialOutcome, ReloadError> {
        let _update = self.update.lock().unwrap_or_else(|p| p.into_inner());
        let active = self.active_snapshot();
        if active.state.generation != expected_generation {
            return Err(ReloadError::StaleBasis {
                found: active.state.generation,
                expected: expected_generation,
            });
        }
        let identity = material_identity(Some(&material));
        let policy_revision = active.policy.revision;
        if identity == active.state.filter_identity {
            return Ok(MaterialOutcome::Unchanged {
                generation: active.state.generation,
                filter_generation: active.state.filter_generation,
                policy_revision,
            });
        }
        let generation = active.state.generation.checked_add(1).ok_or_else(|| {
            ReloadError::InvalidConfig("bundle generation overflow; refusing to wrap".into())
        })?;
        let filter_generation = active
            .state
            .filter_generation
            .checked_add(1)
            .ok_or_else(|| {
                ReloadError::InvalidConfig("filter generation overflow; refusing to wrap".into())
            })?;
        // ONE authority: material is compiled against the CURRENT local +
        // applied-managed settings and the bundle always carries the CURRENT
        // management state. No material path may erase management.
        let effective_filter = match &active.management {
            Some(management) => {
                crate::management_worker::merge_config(&active.config, &management.config)
                    .map_err(|error| ReloadError::FilterFailed(error.to_string()))?
            }
            None => active.config.filter.clone(),
        };
        let filter = compile_from_material(Some(&material), &effective_filter)
            .map_err(|error| ReloadError::FilterFailed(error.to_string()))?
            .unwrap_or_else(empty_filter);
        // The policy and its original publication age are carried untouched.
        let bundle = Bundle::unchecked(
            active.config.clone(),
            active.policy.clone(),
            Some(material.clone()),
            active.management.clone(),
        );
        let bundle = bundle
            .with_generation(generation, filter_generation)
            .map_err(|error| ReloadError::BuildFailed(error.to_string()))?;
        self.publish_bundle(bundle, now, filter, Some(material), identity)?;
        Ok(MaterialOutcome::Applied {
            generation,
            filter_generation,
            policy_revision,
        })
    }

    /// Commit one management observation (applied config, or new receipts)
    /// with a fresh whole-bundle generation. Never touches the policy spaces.
    pub fn commit_management(
        &self,
        material: Option<FilterMaterial>,
        filter: Option<Arc<vantyr_network_filter::FilterSnapshot>>,
        management: crate::management::ManagementState,
        expected_generation: u64,
        now: DateTime<Utc>,
    ) -> Result<ReloadOutcome, ReloadError> {
        self.commit_management_with_config(
            None,
            material,
            filter,
            management,
            expected_generation,
            now,
        )
    }

    /// Commit desired runtime settings, material, receipts and management
    /// state in ONE atomic bundle publish. `config` is a fully validated
    /// candidate derived from the current config; when absent, the current
    /// config is carried unchanged (receipt-only commits).
    #[allow(clippy::too_many_arguments)]
    pub fn commit_management_with_config(
        &self,
        config: Option<Config>,
        material: Option<FilterMaterial>,
        filter: Option<Arc<vantyr_network_filter::FilterSnapshot>>,
        management: crate::management::ManagementState,
        expected_generation: u64,
        now: DateTime<Utc>,
    ) -> Result<ReloadOutcome, ReloadError> {
        let _update = self.update.lock().unwrap_or_else(|p| p.into_inner());
        use ReloadError::*;
        let active = self.active_snapshot();
        if active.state.generation != expected_generation {
            return Err(StaleBasis {
                found: active.state.generation,
                expected: expected_generation,
            });
        }
        // Management versions are their own monotonic space. Equal version +
        // equal digest is allowed for receipt-only commits; a lower version or
        // a same-version content change is rejected under the update lock.
        if let Some(current) = &active.management {
            if management.config_version < current.config_version {
                return Err(Conflict(format!(
                    "management version {} is older than applied {}",
                    management.config_version, current.config_version
                )));
            }
            if management.config_version == current.config_version
                && management.digest != current.digest
            {
                return Err(Conflict(
                    "same management version has a different digest".to_owned(),
                ));
            }
        }
        let generation = active.state.generation.checked_add(1).ok_or_else(|| {
            InvalidConfig("bundle generation overflow; refusing to wrap".to_owned())
        })?;
        let identity = if material.is_some() {
            management.filter_identity.clone()
        } else {
            active.state.filter_identity.clone()
        };
        let filter_generation = if material.is_some() && identity != active.state.filter_identity {
            active
                .state
                .filter_generation
                .checked_add(1)
                .ok_or_else(|| {
                    InvalidConfig("filter generation overflow; refusing to wrap".to_owned())
                })?
        } else {
            active.state.filter_generation
        };
        let bundle = Bundle {
            config: config.unwrap_or_else(|| active.config.clone()),
            policy: active.policy.clone(),
            filter: material.clone().or_else(|| active.filter_material.clone()),
            generation: None,
            policy_highwater: Some(active.state.policy_highwater),
            filter_generation: None,
            management: None,
        };
        let bundle = bundle
            .with_management(generation, filter_generation, management)
            .map_err(|error| BuildFailed(error.to_string()))?;
        let filter = filter.unwrap_or_else(|| active.filter.clone());
        self.publish_bundle(bundle, now, filter, material, identity)
    }

    /// Local worker config currently serving. Kept read-only: callers must go
    /// through the compile/reload path to change policy.
    pub fn local_config(&self) -> Config {
        self.active_snapshot().config.clone()
    }

    /// Labeled current versions. A list refresh changes only the two
    /// generation counters, never `policy_revision` or `policy_published_at`.
    pub fn status(&self) -> DnsStatus {
        let active = self.active_snapshot();
        DnsStatus {
            policy_revision: active.revision,
            policy_published_at: active.published_at,
            bundle_generation: active.state.generation,
            filter_generation: active.state.filter_generation,
            filter_identity: active.state.filter_identity.clone(),
        }
    }

    /// Clear the maintained response caches of the CURRENTLY applied snapshot.
    /// This is a runtime primitive only: no dashboard/HTTP route claims to
    /// deliver it, and no policy revision or generation is advanced.
    ///
    /// Coherent semantics: the mutation lock (the same one that serialises
    /// reloads) and the snapshot read lock are held while selecting the current
    /// snapshot. A concurrent reload cannot publish between selection and clear.
    /// Queries already in flight cloned the same `Arc`; their resolvers are the
    /// ones cleared here, but a lookup that finishes after this returns may
    /// repopulate an entry. This is a clear, not a flush barrier, and no
    /// "no repopulation" guarantee is claimed. A fresh snapshot swap builds
    /// new resolvers and therefore starts with empty caches without touching
    /// any older snapshot.
    pub fn clear_cache(&self) {
        let _update = self
            .update
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = self
            .current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        snapshot.cache.clear();
    }

    /// Download state versus what DNS actually applied, plus the last
    /// combined error. No badge or enforcement claim is made.
    pub fn subscription_status(&self) -> Option<(Vec<SourceStatus>, AppliedStatus)> {
        self.subscriptions.as_ref().map(|runtime| runtime.status())
    }

    /// Request a bounded manual refresh of one configured source.
    pub fn request_subscription_refresh(&self, id: &str) -> Result<(), ReloadError> {
        match &self.subscriptions {
            Some(runtime) => {
                runtime.handle().request_refresh(id);
                Ok(())
            }
            None => Err(ReloadError::InvalidConfig(
                "no subscription runtime is enabled".to_owned(),
            )),
        }
    }

    /// Subscriptions runtime, if the worker opted in to scheduled lists.
    pub fn subscription_runtime(&self) -> Option<Arc<SubscriptionRuntime>> {
        self.subscriptions.clone()
    }

    /// Currently applied management state, if any. Independent of policy.
    pub fn management_state(&self) -> Option<crate::management::ManagementState> {
        self.active_snapshot().management.clone()
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }

    /// Policy revision of the snapshot currently answering queries.
    pub fn revision(&self) -> u64 {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .revision
    }

    pub fn published_at(&self) -> DateTime<Utc> {
        self.current
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .published_at
    }

    pub fn is_durable(&self) -> bool {
        self.store.is_some()
    }

    pub fn observations(&self) -> Vec<DecisionObservation> {
        self.observations.snapshot()
    }

    pub fn clear_observations(&self) {
        self.observations.clear();
    }

    async fn stop_inner(&self) {
        // Actually await the integrator task before consuming the server: it
        // may hold an upgraded Arc while a download is in flight.
        if let Some(runtime) = &self.subscriptions {
            runtime.shutdown().await;
        }
        self.shutdown.cancel();
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// Stop an owned server (tests and library callers).
    ///
    /// This cancels the shutdown token and awaits the listener task. It does
    /// NOT wait for the DoQ UDP socket to be released: Hickory's maintained
    /// registration moves that socket into a private QUIC endpoint whose
    /// driver drops it asynchronously after the joined task ends, and the
    /// pinned API exposes no close or wait handle for it. A caller that must
    /// rebind the same DoQ port should use [`Self::stop_and_wait`] instead.
    pub async fn stop(self) {
        self.stop_inner().await;
    }

    /// Stop a server shared with a subscription runtime. Safe while other
    /// handles exist; no `Arc::try_unwrap` is needed or permitted here.
    ///
    /// Same task-join guarantee and the same DoQ socket-release limitation as
    /// [`Self::stop`]; use [`Self::stop_and_wait`] when a same-port DoQ restart
    /// depends on the port being free.
    pub async fn stop_shared(&self) {
        self.stop_inner().await;
    }

    /// Stop, then verify the owned DoQ UDP port is observably released.
    ///
    /// This performs the same shutdown and task join as [`Self::stop`], then
    /// repeatedly rebinds the exact OS-assigned DoQ address captured at
    /// startup until the bind succeeds or `timeout` elapses. The successful
    /// probe socket is dropped immediately: the guarantee is that release was
    /// *observed* at completion, not that the port is reserved for a later
    /// caller (another process may claim it between the probe and its bind).
    ///
    /// Only `AddrInUse` is retried, with a small backoff bounded by the
    /// deadline; any other bind error is returned. When no DoQ listener was
    /// enabled this is just the existing shutdown. Repeated calls are
    /// idempotent, and `&self` works for both owned and `Arc<DnsServer>`
    /// callers. Operationally the timeout is an upper bound on waiting for
    /// the quinn driver to finish after the listener task joins; if the port
    /// is still held when the deadline passes, an error is returned rather
    /// than proceeding with an unproven release.
    pub async fn stop_and_wait(&self, timeout: Duration) -> Result<()> {
        self.stop_inner().await;
        let Some(addr) = self.doq_bound else {
            return Ok(());
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match UdpSocket::bind(addr).await {
                Ok(probe) => {
                    // Release is proven by the bind; never hold a reservation.
                    drop(probe);
                    return Ok(());
                }
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        anyhow::bail!(
                            "DoQ UDP port {addr} was not released within {:?}",
                            timeout
                        );
                    }
                    let remaining = deadline - now;
                    tokio::time::sleep(remaining.min(RELEASE_PROBE_BACKOFF)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

/// Guard the ACTUAL bound address of each listener, including OS-assigned
/// ephemeral ports that config validation cannot know. A failure here drops
/// the already-registered listeners (no task has been spawned yet), so no
/// partially started server survives.
fn reject_duplicate_bind(seen: &[SocketAddr], candidate: SocketAddr) -> Result<()> {
    if seen.contains(&candidate) {
        bail!("listener address {candidate} collides with another listener");
    }
    Ok(())
}

fn initial_state(config: &Config, material: Option<&FilterMaterial>) -> BundleState {
    BundleState {
        generation: config.policy_revision,
        policy_highwater: config.policy_revision,
        filter_generation: if material.is_some() { 1 } else { 0 },
        filter_identity: material_identity(material),
    }
}

fn uuid_from_household(raw: &str) -> Result<family_policy::HouseholdId> {
    use std::str::FromStr;
    family_policy::HouseholdId::from_str(raw)
        .map_err(|_| anyhow::anyhow!("household_id is not a UUID"))
}

impl Drop for DnsServer {
    fn drop(&mut self) {
        if let Some(runtime) = &self.subscriptions {
            runtime.cancel_only();
        }
        self.shutdown.cancel();
    }
}
