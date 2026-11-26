//! Verified encrypted UPSTREAM transports (DoT / DoH) and bounded plaintext
//! forwarding, built on the pinned Hickory resolver. There is no encrypted
//! listener, no fallback to plaintext or system resolvers, no opportunistic
//! encryption and no custom wire/TLS code: only NameServerConfig and a
//! maintained rustls client config, with a thin ZoneHandler that forwards
//! through a Resolver built with explicit options.
//!
//! Both plaintext and encrypted paths use the SAME `ResolverOpts` (cache size,
//! TTL bounds, hosts-file mode) and both register their resolver with one
//! `CacheControl` handle. That handle is the only cache-clear operation in this
//! crate; it is a runtime primitive, not a dashboard API.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{bail, Result};
use hickory_resolver::config::{NameServerConfig, ResolverConfig, ResolverOpts};
use hickory_resolver::{Hosts, Resolver};
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::{LowerName, Name, RecordType};
use hickory_server::server::Request;
use hickory_server::zone_handler::{
    AuthLookup, AxfrPolicy, LookupControlFlow, LookupError, LookupOptions, ZoneHandler, ZoneType,
};
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};

use crate::config::EncryptedUpstreamSpec;

/// Cloned resolver handles whose maintained response caches can be cleared as
/// one coherent operation on the currently applied snapshot.
#[derive(Clone, Debug, Default)]
pub(crate) struct CacheControl {
    resolvers: Vec<Resolver<TokioRuntimeProvider>>,
}

impl CacheControl {
    pub(crate) fn register(&mut self, resolver: &Resolver<TokioRuntimeProvider>) {
        self.resolvers.push(resolver.clone());
    }

    /// Clear every upstream cache in this snapshot. In-flight lookups that
    /// already captured one of these resolvers may repopulate an entry after
    /// this returns; this is a clear, not a flush barrier.
    pub(crate) fn clear(&self) {
        for resolver in &self.resolvers {
            resolver.clear_cache();
        }
    }
}

/// Build a resolver from explicit name servers and options. `hosts` is an
/// injectable, maintained `Hosts` table used by tests; production leaves it
/// unset so Hickory applies `ResolverOpts::use_hosts_file` normally.
fn build_resolver(
    servers: Vec<NameServerConfig>,
    options: ResolverOpts,
    tls: Option<ClientConfig>,
    hosts: Option<Arc<Hosts>>,
) -> Result<Resolver<TokioRuntimeProvider>> {
    let config = ResolverConfig::from_name_servers(servers);
    let builder = Resolver::builder_with_config(config, TokioRuntimeProvider::default());
    let builder = match tls {
        Some(tls) => builder.with_tls_config(tls),
        None => builder,
    };
    let mut resolver = builder
        .with_options(options)
        .build()
        .map_err(|error| anyhow::anyhow!("resolver failed to build: {error}"))?;
    if let Some(hosts) = hosts {
        resolver.set_hosts(hosts);
    }
    Ok(resolver)
}

/// Shared lookup body for both forwarders. It uses only the maintained
/// `Resolver::lookup`, so the response cache and TTL bounds are applied by
/// Hickory rather than by any local cache code.
async fn forward_lookup(
    resolver: &Resolver<TokioRuntimeProvider>,
    name: &LowerName,
    rtype: RecordType,
) -> LookupControlFlow<AuthLookup> {
    let mut name: Name = name.clone().into();
    name.set_fqdn(false);
    match resolver.lookup(name, rtype).await {
        Ok(lookup) => LookupControlFlow::Continue(Ok(AuthLookup::from(lookup))),
        Err(error) => LookupControlFlow::Continue(Err(LookupError::from(error))),
    }
}

/// A root-zone forwarder over literal plaintext UDP/TCP name servers. It owns
/// its resolver so the same cache controls apply as to the encrypted path.
/// Config validation forbids mixing it with encrypted upstreams; there is no
/// silent fallback from one to the other.
pub(crate) struct PlaintextZoneHandler {
    resolver: Resolver<TokioRuntimeProvider>,
    origin: LowerName,
}

impl PlaintextZoneHandler {
    /// Test seam: inject a maintained `Hosts` table without touching the host
    /// file. Production always uses `None` (system hosts mode from options).
    #[doc(hidden)]
    pub fn with_hosts(
        upstreams: &[SocketAddr],
        options: ResolverOpts,
        hosts: Option<Arc<Hosts>>,
    ) -> Result<Self> {
        if upstreams.is_empty() {
            bail!("no plaintext upstreams configured");
        }
        let mut servers = Vec::with_capacity(upstreams.len());
        for upstream in upstreams {
            let mut server = NameServerConfig::udp_and_tcp(upstream.ip());
            for connection in &mut server.connections {
                connection.port = upstream.port();
            }
            servers.push(server);
        }
        Ok(Self {
            resolver: build_resolver(servers, options, None, hosts)?,
            origin: Name::root().into(),
        })
    }

    pub(crate) fn resolver(&self) -> &Resolver<TokioRuntimeProvider> {
        &self.resolver
    }
}

#[async_trait::async_trait]
impl ZoneHandler for PlaintextZoneHandler {
    fn zone_type(&self) -> ZoneType {
        ZoneType::External
    }

    fn axfr_policy(&self) -> AxfrPolicy {
        AxfrPolicy::Deny
    }

    fn origin(&self) -> &LowerName {
        &self.origin
    }

    async fn lookup(
        &self,
        name: &LowerName,
        rtype: RecordType,
        _request_info: Option<&hickory_server::server::RequestInfo<'_>>,
        _lookup_options: LookupOptions,
    ) -> LookupControlFlow<AuthLookup> {
        forward_lookup(&self.resolver, name, rtype).await
    }

    async fn search(
        &self,
        request: &Request,
        lookup_options: LookupOptions,
    ) -> (
        LookupControlFlow<AuthLookup>,
        Option<hickory_server::proto::rr::TSigResponseContext>,
    ) {
        let info = match request.request_info() {
            Ok(info) => info,
            Err(error) => return (LookupControlFlow::Break(Err(error)), None),
        };
        (
            self.lookup(
                info.query.name(),
                info.query.query_type(),
                Some(&info),
                lookup_options,
            )
            .await,
            None,
        )
    }

    async fn nsec_records(
        &self,
        _name: &LowerName,
        _lookup_options: LookupOptions,
    ) -> LookupControlFlow<AuthLookup> {
        LookupControlFlow::Continue(Err(LookupError::from(io::Error::other(
            "NSEC records are unavailable for a plaintext forwarder",
        ))))
    }

    fn metrics_label(&self) -> &'static str {
        "plaintext_forwarder"
    }
}

/// A root-zone forwarder over verified DoT/DoH name servers only.
pub(crate) struct EncryptedZoneHandler {
    resolver: Resolver<TokioRuntimeProvider>,
    origin: LowerName,
}

impl EncryptedZoneHandler {
    /// Test seam mirroring the plaintext path. Encrypted upstreams do not use
    /// a hosts file in production; this exists only for maintained injection.
    #[doc(hidden)]
    pub fn with_hosts(
        specs: &[EncryptedUpstreamSpec],
        options: ResolverOpts,
        hosts: Option<Arc<Hosts>>,
    ) -> Result<Self> {
        if specs.is_empty() {
            bail!("no encrypted upstreams configured");
        }
        let mut servers = Vec::with_capacity(specs.len());
        for spec in specs {
            let ip = IpAddr::from_str(spec.bootstrap())
                .map_err(|_| anyhow::anyhow!("encrypted bootstrap is not an IP literal"))?;
            let name: Arc<str> = Arc::from(spec.server_name());
            let mut server = match spec {
                EncryptedUpstreamSpec::Dot { .. } => NameServerConfig::tls(ip, name),
                EncryptedUpstreamSpec::Doh { path, .. } => {
                    NameServerConfig::https(ip, name, Some(Arc::from(path.as_str())))
                }
            };
            server.connections[0].port = spec.port();
            servers.push(server);
        }
        let tls = client_config(specs)?;
        Ok(Self {
            resolver: build_resolver(servers, options, Some(tls), hosts)?,
            origin: Name::root().into(),
        })
    }

    pub(crate) fn resolver(&self) -> &Resolver<TokioRuntimeProvider> {
        &self.resolver
    }
}

/// WebPKI roots plus any operator-supplied CA, with normal rustls name and
/// chain verification. Empty/unparseable CA material fails closed here.
fn client_config(specs: &[EncryptedUpstreamSpec]) -> Result<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for spec in specs {
        if let Some(pem) = spec.ca_pem() {
            let certs = pem::parse_many(pem)
                .map_err(|_| anyhow::anyhow!("encrypted upstream CA is not valid PEM"))?;
            if certs.is_empty() {
                bail!("encrypted upstream CA contains no certificate");
            }
            for cert in certs {
                roots
                    .add(CertificateDer::from(cert.contents().to_vec()))
                    .map_err(|_| anyhow::anyhow!("encrypted upstream CA certificate is invalid"))?;
            }
        }
    }
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

#[async_trait::async_trait]
impl ZoneHandler for EncryptedZoneHandler {
    fn zone_type(&self) -> ZoneType {
        ZoneType::External
    }

    fn axfr_policy(&self) -> AxfrPolicy {
        AxfrPolicy::Deny
    }

    fn origin(&self) -> &LowerName {
        &self.origin
    }

    async fn lookup(
        &self,
        name: &LowerName,
        rtype: RecordType,
        _request_info: Option<&hickory_server::server::RequestInfo<'_>>,
        _lookup_options: LookupOptions,
    ) -> LookupControlFlow<AuthLookup> {
        forward_lookup(&self.resolver, name, rtype).await
    }

    async fn search(
        &self,
        request: &Request,
        lookup_options: LookupOptions,
    ) -> (
        LookupControlFlow<AuthLookup>,
        Option<hickory_server::proto::rr::TSigResponseContext>,
    ) {
        let info = match request.request_info() {
            Ok(info) => info,
            Err(error) => return (LookupControlFlow::Break(Err(error)), None),
        };
        (
            self.lookup(
                info.query.name(),
                info.query.query_type(),
                Some(&info),
                lookup_options,
            )
            .await,
            None,
        )
    }

    async fn nsec_records(
        &self,
        _name: &LowerName,
        _lookup_options: LookupOptions,
    ) -> LookupControlFlow<AuthLookup> {
        LookupControlFlow::Continue(Err(LookupError::from(io::Error::other(
            "NSEC records are unavailable for an encrypted forwarder",
        ))))
    }

    fn metrics_label(&self) -> &'static str {
        "encrypted_forwarder"
    }
}
