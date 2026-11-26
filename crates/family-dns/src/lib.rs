//! Hickory-based DNS worker for the family network layer (compatibility spike).
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
//! This worker only ever binds loopback ephemeral ports in the spike. It does
//! not configure host DNS, listeners, or privileged ports.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Error as AnyError, Result};
use async_trait::async_trait;
use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolveHosts, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::Resolver;
use hickory_server::net::runtime::Time;
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData, SOA};
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::server::{Request, RequestHandler, ResponseHandler, ResponseInfo};
use hickory_server::store::forwarder::{ForwardConfig, ForwardZoneHandler};
use hickory_server::store::in_memory::InMemoryZoneHandler;
use hickory_server::zone_handler::{Catalog, ZoneType};
use hickory_server::Server;
use tracing::debug;

/// A local authoritative record. The block sinkhole and split-DNS answers are
/// expressed with the same type so policy updates and local records share a path.
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

/// Helper for a future caller to turn deny decisions into sinkhole records.
/// The spike does NOT call `evaluate()` here: the test supplies zone records
/// directly, so no policy-to-DNS wiring is claimed in step 1.
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

/// Shared catalog so a running worker can accept a new policy revision without
/// restarting its UDP/TCP listeners.
#[derive(Clone)]
struct SharedCatalog(Arc<tokio::sync::Mutex<Catalog>>);

#[async_trait]
impl RequestHandler for SharedCatalog {
    async fn handle_request<R: ResponseHandler, T: Time>(
        &self,
        request: &Request,
        response_handle: R,
    ) -> ResponseInfo {
        let catalog = self.0.lock().await;
        catalog
            .handle_request::<R, T>(request, response_handle)
            .await
    }
}

pub struct DnsWorker {
    catalog: Arc<tokio::sync::Mutex<Catalog>>,
    shutdown: tokio_util::sync::CancellationToken,
    udp_addr: SocketAddr,
    tcp_addr: SocketAddr,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl DnsWorker {
    /// Start a loopback-only worker. `origin` is the local authoritative zone.
    pub async fn start(origin: &str) -> Result<Self> {
        let catalog = Arc::new(tokio::sync::Mutex::new(Catalog::new()));
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
        let worker = Self {
            catalog,
            shutdown,
            udp_addr,
            tcp_addr,
            task: Some(task),
        };
        // Build the initial local zone (SOA required by InMemoryZoneHandler).
        worker.apply_local_zone(origin, &[]).await?;
        Ok(worker)
    }

    /// Replace a local zone atomically from a complete record set. Used for
    /// both split-DNS records and policy-driven block answers.
    pub async fn apply_local_zone(&self, origin: &str, records: &[LocalRecord]) -> Result<()> {
        let origin_name = Name::from_str(origin)?;
        let mut map: BTreeMap<RrKey, RecordSet> = BTreeMap::new();
        let soa = Record::from_rdata(
            origin_name.clone(),
            3600,
            RData::SOA(SOA::new(
                origin_name.clone(),
                Name::from_str("hostmaster.invalid.")?,
                1,
                3600,
                600,
                86_400,
                60,
            )),
        );
        map.insert(
            RrKey::new(origin_name.clone().into(), RecordType::SOA),
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
        let handler =
            InMemoryZoneHandler::<hickory_server::net::runtime::TokioRuntimeProvider>::new(
                origin_name.clone(),
                map,
                ZoneType::Primary,
                hickory_server::zone_handler::AxfrPolicy::Deny,
            )
            .map_err(AnyError::msg)?;
        let mut catalog = self.catalog.lock().await;
        catalog.upsert(origin_name.into(), vec![Arc::new(handler)]);
        Ok(())
    }

    /// Attach a root forwarding zone to another loopback resolver (the
    /// upstream-outage / forwarding seam). Uses hickory-resolver internally.
    pub async fn apply_forwarder(&self, upstream: SocketAddr) -> Result<()> {
        let mut upstream_server = NameServerConfig::udp_and_tcp(upstream.ip());
        for connection in &mut upstream_server.connections {
            connection.port = upstream.port();
        }
        let config = ForwardConfig {
            name_servers: vec![upstream_server],
            options: None,
        };
        let handler = ForwardZoneHandler::builder_tokio(config)
            .with_origin(Name::root())
            .build()
            .map_err(AnyError::msg)?;
        let mut catalog = self.catalog.lock().await;
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
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

/// A resolver pointed at a loopback worker, with the host's `/etc/hosts` and
/// system resolvers disabled so tests cannot accidentally escape the spike.
pub fn worker_resolver(worker: &DnsWorker) -> Result<Resolver<TokioRuntimeProvider>> {
    resolver_for(worker.udp_addr(), false)
}

/// Build a resolver against an explicit loopback port (used for TCP-only tests).
pub fn resolver_for(addr: SocketAddr, tcp_only: bool) -> Result<Resolver<TokioRuntimeProvider>> {
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
    let mut builder = Resolver::builder_with_config(config, TokioRuntimeProvider::default());
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
    use hickory_server::proto::rr::RecordType;
    use std::net::IpAddr;

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
    async fn caller_supplied_sinkhole_zone_revisions_are_served() {
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

        // A later revision removes the sinkhole (the policy returned to default).
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
}
