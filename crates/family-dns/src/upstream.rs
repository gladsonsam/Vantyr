//! Verified encrypted UPSTREAM transports (DoT / DoH) built on the pinned
//! Hickory resolver. There is no encrypted listener, no fallback to plaintext
//! or system resolvers, no opportunistic encryption and no custom wire/TLS
//! code: only NameServerConfig::tls/https, a maintained rustls client config,
//! and a thin ZoneHandler that forwards through a Resolver built with an
//! explicit TLS configuration.

use std::io;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;

use anyhow::{bail, Result};
use hickory_resolver::config::{NameServerConfig, ResolverConfig, ResolverOpts};
use hickory_resolver::Resolver;
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::{LowerName, Name, RecordType};
use hickory_server::server::Request;
use hickory_server::zone_handler::{
    AuthLookup, AxfrPolicy, LookupControlFlow, LookupError, LookupOptions, ZoneHandler, ZoneType,
};
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};

use crate::config::EncryptedUpstreamSpec;

/// A root-zone forwarder over verified DoT/DoH name servers only.
pub(crate) struct EncryptedZoneHandler {
    resolver: Resolver<TokioRuntimeProvider>,
    origin: LowerName,
}

impl EncryptedZoneHandler {
    pub(crate) fn new(specs: &[EncryptedUpstreamSpec], options: ResolverOpts) -> Result<Self> {
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
        let config = ResolverConfig::from_name_servers(servers);
        let tls = client_config(specs)?;
        let resolver = Resolver::builder_with_config(config, TokioRuntimeProvider::default())
            .with_options(options)
            .with_tls_config(tls)
            .build()
            .map_err(|error| anyhow::anyhow!("encrypted resolver failed to build: {error}"))?;
        Ok(Self {
            resolver,
            origin: Name::root().into(),
        })
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
        let mut name: Name = name.clone().into();
        name.set_fqdn(false);
        match self.resolver.lookup(name, rtype).await {
            Ok(lookup) => LookupControlFlow::Continue(Ok(AuthLookup::from(lookup))),
            Err(error) => LookupControlFlow::Continue(Err(LookupError::from(error))),
        }
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
