//! Immutable catalog snapshot and listener lifecycle for Vantyr DNS.
//!
//! A complete catalog is built from validated configuration before the
//! listener starts. Requests briefly take a read lock to clone an `Arc` and
//! then perform all I/O on that immutable snapshot, so a slow upstream cannot
//! serialise unrelated queries. Updates rebuild a whole snapshot off-path.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolveHosts, ResolverOpts};
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData, SOA};
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::server::Server;
use hickory_server::store::forwarder::{ForwardConfig, ForwardZoneHandler};
use hickory_server::store::in_memory::InMemoryZoneHandler;
use hickory_server::zone_handler::{AxfrPolicy, Catalog, ZoneType};
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::{forwards_to_self, Config, RecordSpec};
use crate::handler::FilteringHandler;
use crate::observe::{DecisionObservation, ObservationLog};
use crate::policy::PolicyEvaluator;

const FORWARD_TIMEOUT_SECS: u64 = 2;
const FORWARD_ATTEMPTS: usize = 1;
const FORWARD_CACHE_ENTRIES: u64 = 4096;
const FORWARD_CONCURRENCY: usize = 2;
const MAX_ACTIVE_REQUESTS: usize = 256;
const TCP_TIMEOUT_SECS: u64 = 5;
const TCP_MAX_BYTES: usize = 32 * 1024;

fn local_zone_handler(
    origin: &Name,
    records: &[RecordSpec],
) -> Result<InMemoryZoneHandler<TokioRuntimeProvider>> {
    let mut map: BTreeMap<RrKey, RecordSet> = BTreeMap::new();
    let soa = Record::from_rdata(
        origin.clone(),
        3600,
        RData::SOA(SOA::new(
            origin.clone(),
            Name::from_str("hostmaster.invalid.")?,
            1,
            3600,
            600,
            86_400,
            60,
        )),
    );
    map.insert(
        RrKey::new(origin.clone().into(), RecordType::SOA),
        soa.into(),
    );

    for record in records {
        let name = Name::from_str(record.name())?;
        let (record_type, rdata, ttl) = match record {
            RecordSpec::A { ttl, addr, .. } => (
                RecordType::A,
                RData::A(AData::from(addr.parse::<Ipv4Addr>()?)),
                *ttl,
            ),
            RecordSpec::Aaaa { ttl, addr, .. } => (
                RecordType::AAAA,
                RData::AAAA(AaaaData::from(addr.parse::<Ipv6Addr>()?)),
                *ttl,
            ),
            RecordSpec::Cname { ttl, target, .. } => (
                RecordType::CNAME,
                RData::CNAME(CnameData(Name::from_str(target)?)),
                *ttl,
            ),
        };
        let key = RrKey::new(name.clone().into(), record_type);
        let set = map
            .entry(key)
            .or_insert_with(|| RecordSet::with_ttl(name.clone(), record_type, ttl));
        // Accumulate every address at one owner instead of replacing the
        // previous record set with `map.insert`.
        set.insert(Record::from_rdata(name, ttl, rdata), 0);
        if set.ttl() > ttl {
            set.set_ttl(ttl);
        }
    }

    InMemoryZoneHandler::<TokioRuntimeProvider>::new(
        origin.clone(),
        map,
        ZoneType::Primary,
        AxfrPolicy::Deny,
    )
    .map_err(anyhow::Error::msg)
}

fn forwarder_handler(upstreams: &[SocketAddr]) -> Result<ForwardZoneHandler<TokioRuntimeProvider>> {
    let mut servers = Vec::with_capacity(upstreams.len());
    for upstream in upstreams {
        let mut server = NameServerConfig::udp_and_tcp(upstream.ip());
        for connection in &mut server.connections {
            connection.port = upstream.port();
        }
        servers.push(server);
    }
    let mut options = ResolverOpts::default();
    options.timeout = Duration::from_secs(FORWARD_TIMEOUT_SECS);
    options.attempts = FORWARD_ATTEMPTS;
    options.cache_size = FORWARD_CACHE_ENTRIES;
    options.num_concurrent_reqs = FORWARD_CONCURRENCY;
    options.max_active_requests = MAX_ACTIVE_REQUESTS;
    options.use_hosts_file = ResolveHosts::Never;
    options.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
    // Keep CNAME records visible so the handler can check every alias target
    // before releasing an answer.
    options.preserve_intermediates = true;
    let config = ForwardConfig {
        name_servers: servers,
        options: Some(options),
    };
    ForwardZoneHandler::builder_tokio(config)
        .with_origin(Name::root())
        .build()
        .map_err(anyhow::Error::msg)
}

/// Build a complete catalog atomically. A failure leaves any running snapshot
/// untouched because callers only swap after this returns successfully.
pub fn build_catalog(config: &Config) -> Result<Catalog> {
    let mut catalog = Catalog::new();
    for (origin, records) in &config.local_zones {
        let origin = Name::from_str(origin)?;
        let handler = local_zone_handler(&origin, records)?;
        catalog.upsert(origin.into(), vec![Arc::new(handler)]);
    }
    let upstreams = config.upstreams();
    if !upstreams.is_empty() {
        let handler = forwarder_handler(&upstreams)?;
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
    }
    Ok(catalog)
}

/// A running Vantyr DNS listener. The public API is deliberately small:
/// bind address, bounded observations, and an orderly shutdown.
pub struct DnsServer {
    shutdown: CancellationToken,
    bind_addr: SocketAddr,
    task: Option<JoinHandle<()>>,
    observations: ObservationLog,
}

impl DnsServer {
    /// Validate, build, bind UDP and TCP on the same port, and start serving.
    /// No socket exists until configuration has passed full validation.
    pub async fn start(config: Config) -> Result<Self> {
        config.validate()?;
        let observations = ObservationLog::default();
        let evaluator = Arc::new(PolicyEvaluator::new(config.clone(), observations.clone()));
        let catalog = Arc::new(build_catalog(&config)?);
        let handler = FilteringHandler::new(catalog, evaluator, config.deny.clone());

        let mut server = Server::new(handler);
        let udp = UdpSocket::bind(config.bind.configured_addr()).await?;
        let bound = udp.local_addr()?;
        // Re-check against the actual port (port 0 is assigned by the OS).
        for upstream in config.upstreams() {
            if forwards_to_self(&upstream, &bound) {
                bail!("upstream {upstream} points back at the bound listener {bound}");
            }
        }
        let tcp = TcpListener::bind(bound).await?;
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
        })
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
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

impl Drop for DnsServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
