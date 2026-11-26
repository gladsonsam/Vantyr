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
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use hickory_server::server::Server;
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vantyr_network_runtime::{LkgError, WriteHooks};

use crate::bundle::{Bundle, BundleStore, BundleValidator};
use crate::config::{read_bounded, Config};
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
    NotNewer { found: u64, highwater: u64 },
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
}

impl DnsServer {
    /// Validate, build, bind UDP and TCP on the same port, and start serving.
    /// No socket exists until configuration has passed full validation.
    pub async fn start(config: Config) -> Result<Self> {
        config.validate()?;
        let observations = ObservationLog::default();
        let snapshot = build_snapshot(
            config.clone(),
            config.policy(Utc::now()),
            observations.clone(),
        )?;
        Self::serve(config, snapshot, observations, None).await
    }

    /// Start in opt-in durable mode. On a lost-ack restart the local bundle is
    /// authoritative: an existing state file is loaded and validated before a
    /// listener exists, and the config file is never used as a newer policy.
    /// A config is read only for first-run bootstrap.
    pub async fn start_durable(options: DurableOptions) -> Result<Self> {
        let validator = BundleValidator;
        let store = match BundleStore::open_from_snapshot(
            &options.state_path,
            &options.worker_id,
            validator,
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
                let store = BundleStore::open(
                    &options.state_path,
                    uuid_from_household(&household)?,
                    &options.worker_id,
                    validator,
                )?;
                let published_at = config.policy_published_at.unwrap_or(options.now);
                let bundle = Bundle::build(&config, published_at)?;
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
        let snapshot = build_snapshot(
            bundle.config.clone(),
            bundle.policy.clone(),
            observations.clone(),
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
        use ReloadError::*;
        let config = Config::parse(candidate).map_err(|e| InvalidConfig(e.to_string()))?;
        let active = {
            self.current
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        };
        if !same_transport(&config, &active.config) {
            return Err(TransportChange(
                "bind address, port or loopback opt-in differs from the listener".into(),
            ));
        }
        if config.household_id != active.config.household_id {
            return Err(InvalidConfig(
                "candidate belongs to another household".into(),
            ));
        }
        let revision = config.policy_revision;
        let highwater = self
            .store
            .as_ref()
            .map_or(active.revision, |store| store.highwater())
            .max(active.revision);
        if revision <= highwater {
            return Err(NotNewer {
                found: revision,
                highwater,
            });
        }

        let published_at = config.policy_published_at.unwrap_or(now);
        let bundle =
            Bundle::build(&config, published_at).map_err(|e| InvalidConfig(e.to_string()))?;
        let snapshot = build_snapshot(
            bundle.config.clone(),
            bundle.policy.clone(),
            self.observations.clone(),
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
        // A concurrent reload may have won the race between build and swap.
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
