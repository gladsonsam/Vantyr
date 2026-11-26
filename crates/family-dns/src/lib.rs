//! Hickory-based DNS worker for the family network layer.
//!
//! Protocol API paths used here (hickory 0.26.4), recorded so later workers do
//! not have to rediscover them:
//!   `hickory_server::server::{Server, Request, RequestHandler, ResponseHandler, ResponseInfo}`
//!   `hickory_server::zone_handler::{Catalog, ZoneHandler}`
//!   `hickory_server::store::in_memory::InMemoryZoneHandler`
//!   `hickory_server::store::forwarder::{ForwardZoneHandler, ForwardConfig}`
//!   `hickory_server::proto::rr::{Name, Record, RecordSet, RrKey, RData, RecordType, rdata::{A,AAAA,CNAME,SOA}}`
//!   `hickory_resolver::{Resolver, config::{ResolverConfig, ResolverOpts, NameServerConfig, LookupIpStrategy, ResolveHosts}}`
//!
//! The published configuration is an immutable `Arc<Catalog>` snapshot. Request
//! handling clones that `Arc` under a briefly-held `std::sync::RwLock` read
//! guard and performs all I/O after the guard is dropped, so a slow upstream
//! cannot serialize unrelated local queries. Updates build a complete new
//! catalog from owned configuration and swap it in atomically; only updates
//! take the update mutex, never the request path.
//!
//! This worker only ever binds loopback ephemeral ports in this slice. It does
//! not configure host DNS, listeners, or privileged ports.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Error as AnyError, Result};
use async_trait::async_trait;
use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolveHosts, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider as ResolverTokioProvider;
use hickory_resolver::Resolver;
use hickory_server::net::runtime::{Time, TokioRuntimeProvider};
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData, SOA};
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::server::{Request, RequestHandler, ResponseHandler, ResponseInfo};
use hickory_server::store::forwarder::{ForwardConfig, ForwardZoneHandler};
use hickory_server::store::in_memory::InMemoryZoneHandler;
use hickory_server::zone_handler::{AxfrPolicy, Catalog, ZoneType};
use hickory_server::Server;
use tracing::debug;

/// A local authoritative record. Block and split-DNS answers use the same type
/// so configuration revisions and local records share one path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalRecord {
    A {
        name: String,
        ttl: u32,
        addr: Ipv4Addr,
    },
    Aaaa {
        name: String,
        ttl: u32,
        addr: Ipv6Addr,
    },
    Cname {
        name: String,
        ttl: u32,
        target: String,
    },
}

impl LocalRecord {
    fn name(&self) -> &str {
        match self {
            Self::A { name, .. } | Self::Aaaa { name, .. } | Self::Cname { name, .. } => name,
        }
    }
}

/// Helper for a future caller to turn deny decisions into block records.
/// Policy evaluation is deliberately not wired into this worker slice: the
/// caller supplies the complete record set for each revision.
pub fn sinkhole_records(denied_names: &[String]) -> Vec<LocalRecord> {
    denied_names
        .iter()
        .map(|name| LocalRecord::A {
            name: name.clone(),
            ttl: 60,
            addr: Ipv4Addr::new(192, 0, 2, 0), // TEST-NET-2, never a real service
        })
        .collect()
}

/// Owned configuration used to rebuild a complete catalog. Keeping this
/// separate from the published snapshot means every revision carries both the
/// local zones and the forwarding zone; no update can drop the other kind.
#[derive(Clone, Default)]
struct CatalogConfig {
    local_zones: BTreeMap<Name, Vec<LocalRecord>>,
    forwarder: Option<SocketAddr>,
}

fn local_zone_handler(
    origin: &Name,
    records: &[LocalRecord],
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
        let entry = match record {
            LocalRecord::A { ttl, addr, .. } => {
                Record::from_rdata(name, *ttl, RData::A(AData::from(*addr)))
            }
            LocalRecord::Aaaa { ttl, addr, .. } => {
                Record::from_rdata(name, *ttl, RData::AAAA(AaaaData::from(*addr)))
            }
            LocalRecord::Cname { ttl, target, .. } => {
                Record::from_rdata(name, *ttl, RData::CNAME(CnameData(Name::from_str(target)?)))
            }
        };
        let key = RrKey::new(entry.name.clone().into(), entry.record_type());
        map.insert(key, entry.into());
    }
    InMemoryZoneHandler::<TokioRuntimeProvider>::new(
        origin.clone(),
        map,
        ZoneType::Primary,
        AxfrPolicy::Deny,
    )
    .map_err(AnyError::msg)
}

fn forwarder_handler(upstream: SocketAddr) -> Result<ForwardZoneHandler<TokioRuntimeProvider>> {
    let mut upstream_server = NameServerConfig::udp_and_tcp(upstream.ip());
    for connection in &mut upstream_server.connections {
        connection.port = upstream.port();
    }
    let config = ForwardConfig {
        name_servers: vec![upstream_server],
        options: None,
    };
    ForwardZoneHandler::builder_tokio(config)
        .with_origin(Name::root())
        .build()
        .map_err(AnyError::msg)
}

/// Build a fresh, complete catalog from owned configuration. Called only on
/// the update path; a failure here leaves the published snapshot untouched.
fn build_catalog(config: &CatalogConfig) -> Result<Catalog> {
    let mut catalog = Catalog::new();
    for (origin, records) in &config.local_zones {
        let handler = local_zone_handler(origin, records)?;
        catalog.upsert(origin.clone().into(), vec![Arc::new(handler)]);
    }
    if let Some(upstream) = config.forwarder {
        let handler = forwarder_handler(upstream)?;
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
    }
    Ok(catalog)
}

/// Request handler that holds only a snapshot, never a lock across I/O.
#[derive(Clone)]
struct SharedCatalog(Arc<RwLock<Arc<Catalog>>>);

#[async_trait]
impl RequestHandler for SharedCatalog {
    async fn handle_request<R: ResponseHandler, T: Time>(
        &self,
        request: &Request,
        response_handle: R,
    ) -> ResponseInfo {
        // Clone the Arc and release the read guard before any await. The
        // catalog behind this Arc is immutable for the lifetime of the query.
        let catalog = {
            let guard = self
                .0
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(&*guard)
        };
        catalog
            .handle_request::<R, T>(request, response_handle)
            .await
    }
}

pub struct DnsWorker {
    catalog: Arc<RwLock<Arc<Catalog>>>,
    config: Arc<Mutex<CatalogConfig>>,
    shutdown: tokio_util::sync::CancellationToken,
    udp_addr: SocketAddr,
    tcp_addr: SocketAddr,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl DnsWorker {
    /// Start a loopback-only worker. `origin` is the initial local zone; it is
    /// populated with the SOA record and no other records.
    pub async fn start(origin: &str) -> Result<Self> {
        let catalog = Arc::new(RwLock::new(Arc::new(Catalog::new())));
        let mut server = Server::new(SharedCatalog(catalog.clone()));
        let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
        let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let udp_addr = udp.local_addr()?;
        let tcp_addr = tcp.local_addr()?;
        server.register_socket(udp);
        server.register_listener(tcp, Duration::from_secs(5), 32 * 1024);
        let shutdown = server.shutdown_token().clone();
        let task = tokio::spawn(async move {
            let mut server = server;
            if let Err(e) = server.block_until_done().await {
                debug!(error = %e, "dns server stopped");
            }
        });
        let mut worker = Self {
            catalog,
            config: Arc::new(Mutex::new(CatalogConfig::default())),
            shutdown,
            udp_addr,
            tcp_addr,
            task: Some(task),
        };
        // Build the initial local zone. If it fails, stop the spawned server
        // before returning so a failed start leaks no task.
        if let Err(err) = worker.apply_local_zone(origin, &[]).await {
            worker.shutdown.cancel();
            if let Some(task) = worker.task.take() {
                let _ = task.await;
            }
            return Err(err);
        }
        Ok(worker)
    }

    /// Replace one local zone atomically from a complete record set. The
    /// forwarding zone and all other local zones are carried forward from the
    /// owned configuration, so callers never lose a zone by updating another.
    pub async fn apply_local_zone(&self, origin: &str, records: &[LocalRecord]) -> Result<()> {
        let origin = Name::from_str(origin)?;
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let mut candidate = config.clone();
        candidate.local_zones.insert(origin, records.to_vec());
        let catalog = build_catalog(&candidate)?;
        *config = candidate;
        // Hold the update mutex through the publication so two concurrent
        // updates cannot publish out of order. Readers only take a brief
        // read-lock on `catalog`; they never touch `config`.
        let mut current = self.catalog.write().unwrap_or_else(|e| e.into_inner());
        *current = Arc::new(catalog);
        Ok(())
    }

    /// Attach or replace the root forwarding zone. Local zones are retained.
    pub async fn apply_forwarder(&self, upstream: SocketAddr) -> Result<()> {
        let mut config = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let mut candidate = config.clone();
        candidate.forwarder = Some(upstream);
        let catalog = build_catalog(&candidate)?;
        *config = candidate;
        let mut current = self.catalog.write().unwrap_or_else(|e| e.into_inner());
        *current = Arc::new(catalog);
        Ok(())
    }

    pub fn udp_addr(&self) -> SocketAddr {
        self.udp_addr
    }
    pub fn tcp_addr(&self) -> SocketAddr {
        self.tcp_addr
    }

    pub async fn stop(mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for DnsWorker {
    fn drop(&mut self) {
        // Cancelling the shared token stops the server task even if the caller
        // forgets to await `stop()` or returns early after an error.
        self.shutdown.cancel();
    }
}

/// A resolver pointed at a loopback worker, with the host's `/etc/hosts` and
/// system resolvers disabled so tests cannot accidentally escape this slice.
pub fn worker_resolver(worker: &DnsWorker) -> Result<Resolver<ResolverTokioProvider>> {
    resolver_for(worker.udp_addr(), false)
}

/// Build a resolver against an explicit loopback port (used for TCP-only tests).
pub fn resolver_for(addr: SocketAddr, tcp_only: bool) -> Result<Resolver<ResolverTokioProvider>> {
    let ip = addr.ip();
    let mut server = if tcp_only {
        NameServerConfig::tcp(ip)
    } else {
        NameServerConfig::udp_and_tcp(ip)
    };
    for connection in &mut server.connections {
        connection.port = addr.port();
    }
    let config = ResolverConfig::from_name_servers(vec![server]);
    let mut builder = Resolver::builder_with_config(config, ResolverTokioProvider::default());
    {
        let options = builder.options_mut();
        options.use_hosts_file = ResolveHosts::Never;
        options.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
        options.cache_size = 0;
        options.timeout = Duration::from_secs(2);
        options.attempts = 1;
    }
    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::time::Instant;

    #[tokio::test]
    async fn local_zone_serves_a_aaaa_cname_negative_and_ttl_over_udp_and_tcp() {
        let worker = DnsWorker::start("test.").await.unwrap();
        worker
            .apply_local_zone(
                "test.",
                &[
                    LocalRecord::A {
                        name: "www.test.".into(),
                        ttl: 120,
                        addr: Ipv4Addr::new(192, 0, 2, 10),
                    },
                    LocalRecord::Aaaa {
                        name: "www.test.".into(),
                        ttl: 120,
                        addr: Ipv6Addr::LOCALHOST,
                    },
                    LocalRecord::Cname {
                        name: "alias.test.".into(),
                        ttl: 90,
                        target: "www.test.".into(),
                    },
                    LocalRecord::A {
                        name: "blocked.test.".into(),
                        ttl: 60,
                        addr: Ipv4Addr::new(192, 0, 2, 0),
                    },
                ],
            )
            .await
            .unwrap();

        for tcp_only in [false, true] {
            let resolver = resolver_for(
                SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::LOCALHOST),
                    if tcp_only {
                        worker.tcp_addr().port()
                    } else {
                        worker.udp_addr().port()
                    },
                ),
                tcp_only,
            )
            .unwrap();
            let ips = resolver.lookup_ip("www.test.").await.unwrap();
            let addresses: Vec<_> = ips.iter().collect();
            assert!(addresses.contains(&IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))));
            assert!(addresses.contains(&IpAddr::V6(Ipv6Addr::LOCALHOST)));

            let cname = resolver
                .lookup("alias.test.", RecordType::CNAME)
                .await
                .unwrap();
            let RData::CNAME(target) = &cname.answers()[0].data else {
                panic!("expected CNAME answer");
            };
            assert_eq!(target.0.to_string(), "www.test.");

            let blocked = resolver
                .lookup("blocked.test.", RecordType::A)
                .await
                .unwrap();
            assert_eq!(blocked.answers()[0].ttl, 60);

            assert!(
                resolver.lookup_ip("missing.test.").await.is_err(),
                "NXDOMAIN expected"
            );
        }
        worker.stop().await;
    }

    #[tokio::test]
    async fn caller_supplied_block_zone_revisions_are_served() {
        let worker = DnsWorker::start("test.").await.unwrap();
        worker.apply_local_zone("test.", &[]).await.unwrap();
        let resolver = worker_resolver(&worker).unwrap();
        assert!(resolver.lookup_ip("ads.test.").await.is_err());

        let records = sinkhole_records(&["ads.test.".to_owned()]);
        worker.apply_local_zone("test.", &records).await.unwrap();
        let ips = resolver.lookup_ip("ads.test.").await.unwrap();
        assert!(ips
            .iter()
            .any(|ip| ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 0))));

        // A later revision removes the block (the caller's decision returned).
        worker.apply_local_zone("test.", &[]).await.unwrap();
        assert!(resolver.lookup_ip("ads.test.").await.is_err());
        worker.stop().await;
    }

    #[tokio::test]
    async fn forwarding_worker_uses_loopback_upstream() {
        let upstream = DnsWorker::start("upstream.test.").await.unwrap();
        upstream
            .apply_local_zone(
                "upstream.test.",
                &[LocalRecord::A {
                    name: "app.upstream.test.".into(),
                    ttl: 30,
                    addr: Ipv4Addr::new(192, 0, 2, 20),
                }],
            )
            .await
            .unwrap();

        let forwarder = DnsWorker::start("forward.test.").await.unwrap();
        forwarder
            .apply_forwarder(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                upstream.udp_addr().port(),
            ))
            .await
            .unwrap();
        let resolver = worker_resolver(&forwarder).unwrap();
        let ips = resolver.lookup_ip("app.upstream.test.").await.unwrap();
        assert!(ips
            .iter()
            .any(|ip| ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 20))));
        forwarder.stop().await;
        upstream.stop().await;
    }

    /// A bound loopback UDP socket that never answers stands in for an
    /// unresponsive upstream. The forwarder's query to it stays in flight while
    /// a local query is issued; with a lock held across I/O the local query
    /// would wait for the stalled forward lookup.
    #[tokio::test]
    async fn stalled_upstream_does_not_block_local_zone_queries() {
        let black_hole = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let stalled_upstream = black_hole.local_addr().unwrap();

        let worker = DnsWorker::start("local.test.").await.unwrap();
        worker
            .apply_local_zone(
                "local.test.",
                &[LocalRecord::A {
                    name: "www.local.test.".into(),
                    ttl: 60,
                    addr: Ipv4Addr::new(192, 0, 2, 10),
                }],
            )
            .await
            .unwrap();
        worker.apply_forwarder(stalled_upstream).await.unwrap();

        let forward_resolver = worker_resolver(&worker).unwrap();
        let stalled = tokio::spawn(async move {
            let _ = forward_resolver.lookup_ip("stalled.example.").await;
        });

        // Give the forwarded query time to reach the black-hole upstream.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !stalled.is_finished(),
            "the forwarded query should still be waiting on the upstream"
        );

        let local_resolver = worker_resolver(&worker).unwrap();
        let started = Instant::now();
        let ips = tokio::time::timeout(
            Duration::from_secs(1),
            local_resolver.lookup_ip("www.local.test."),
        )
        .await
        .expect("local query was blocked by the stalled upstream")
        .unwrap();
        assert!(ips
            .iter()
            .any(|ip| ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "local query must finish while the upstream is stalled"
        );

        stalled.abort();
        let _ = stalled.await;
        drop(black_hole);
        worker.stop().await;
    }

    /// Concurrent local-zone and forwarder revisions must never expose a
    /// partially built catalog: readers see both zones in every revision, and
    /// neither writer can drop the other's zone.
    #[tokio::test]
    async fn concurrent_updates_keep_local_and_forwarding_zones() {
        let upstream = DnsWorker::start("upstream.test.").await.unwrap();
        upstream
            .apply_local_zone(
                "upstream.test.",
                &[LocalRecord::A {
                    name: "app.upstream.test.".into(),
                    ttl: 30,
                    addr: Ipv4Addr::new(192, 0, 2, 30),
                }],
            )
            .await
            .unwrap();
        let upstream_addr =
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), upstream.udp_addr().port());

        let worker = Arc::new(DnsWorker::start("local.test.").await.unwrap());
        worker
            .apply_local_zone(
                "local.test.",
                &[LocalRecord::A {
                    name: "www.local.test.".into(),
                    ttl: 60,
                    addr: Ipv4Addr::new(192, 0, 2, 1),
                }],
            )
            .await
            .unwrap();
        worker.apply_forwarder(upstream_addr).await.unwrap();

        let local_writer = {
            let worker = Arc::clone(&worker);
            tokio::spawn(async move {
                for i in 0..40 {
                    let addr = if i % 2 == 0 {
                        Ipv4Addr::new(192, 0, 2, 1)
                    } else {
                        Ipv4Addr::new(192, 0, 2, 2)
                    };
                    worker
                        .apply_local_zone(
                            "local.test.",
                            &[LocalRecord::A {
                                name: "www.local.test.".into(),
                                ttl: 60,
                                addr,
                            }],
                        )
                        .await
                        .unwrap();
                }
            })
        };
        let forward_writer = {
            let worker = Arc::clone(&worker);
            tokio::spawn(async move {
                for _ in 0..40 {
                    worker.apply_forwarder(upstream_addr).await.unwrap();
                }
            })
        };

        let mut readers = Vec::new();
        for _ in 0..4 {
            let resolver = worker_resolver(&worker).unwrap();
            readers.push(tokio::spawn(async move {
                for _ in 0..40 {
                    let local = tokio::time::timeout(
                        Duration::from_secs(2),
                        resolver.lookup_ip("www.local.test."),
                    )
                    .await
                    .expect("local zone query timed out")
                    .expect("local zone vanished during updates");
                    assert!(
                        local.iter().any(|ip| {
                            ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))
                                || ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2))
                        }),
                        "local zone served an unexpected answer"
                    );

                    let forwarded = tokio::time::timeout(
                        Duration::from_secs(2),
                        resolver.lookup_ip("app.upstream.test."),
                    )
                    .await
                    .expect("forwarded query timed out")
                    .expect("forwarding zone vanished during updates");
                    assert!(
                        forwarded
                            .iter()
                            .any(|ip| ip == IpAddr::V4(Ipv4Addr::new(192, 0, 2, 30))),
                        "forwarding zone served an unexpected answer"
                    );
                }
            }));
        }

        local_writer.await.unwrap();
        forward_writer.await.unwrap();
        for reader in readers {
            reader.await.unwrap();
        }

        // Both zones are still present after the concurrent revisions, over
        // UDP and over TCP.
        for tcp_only in [false, true] {
            let resolver = resolver_for(
                SocketAddr::new(
                    IpAddr::V4(Ipv4Addr::LOCALHOST),
                    if tcp_only {
                        worker.tcp_addr().port()
                    } else {
                        worker.udp_addr().port()
                    },
                ),
                tcp_only,
            )
            .unwrap();
            assert!(resolver.lookup_ip("www.local.test.").await.is_ok());
            assert!(resolver.lookup_ip("app.upstream.test.").await.is_ok());
        }

        // `worker` is shared; the final owner stops it.
        if let Some(worker) = Arc::into_inner(worker) {
            worker.stop().await;
        }
        upstream.stop().await;
    }
}
