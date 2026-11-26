//! Test-only loopback transport helpers. TLS verification stays fully enabled:
//! certificates are generated in-test and the local CA is merged into
//! reqwest's verifier via `tls_certs_merge`. There is no `danger_*` switch.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::serve::Listener;
use axum::Router;
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

use crate::clock::{SharedClock, SharedRng};
use crate::config::SubscriptionConfig;
use crate::error::Error;
use crate::fetcher::Fetcher;
use crate::resolve::AddressLookup;
use crate::transport::ReqwestTransport;
use crate::validate::CandidateValidator;

struct TestCert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

/// A well-formed CA that did not sign the test server certificate. Used to
/// prove that certificate verification is actually enabled.
pub fn unrelated_ca_pem() -> String {
    let mut params = CertificateParams::new(vec!["unrelated.invalid".to_owned()]).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let key = KeyPair::generate().unwrap();
    params.self_signed(&key).unwrap().pem()
}

fn test_cert() -> TestCert {
    let mut ca_params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();

    let mut leaf_params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    leaf_params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    let leaf_key = KeyPair::generate().unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();

    TestCert {
        ca_pem: ca_cert.pem(),
        cert_der: leaf.der().as_ref().to_vec(),
        key_der: leaf_key.serialize_der(),
    }
}

struct TlsListener {
    inner: TcpListener,
    acceptor: TlsAcceptor,
}

impl Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = self.inner.accept().await.expect("tcp accept");
            if let Ok(tls) = self.acceptor.accept(stream).await {
                return (tls, addr);
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

/// Spawn an axum router behind a real TLS listener with a verified local CA.
/// Returns `(base_url, ca_pem)`; the base URL uses the `localhost` hostname so
/// hostname verification is exercised, not bypassed.
pub async fn spawn_tls_server(router: Router) -> (String, String) {
    let cert = test_cert();
    let ca_pem = cert.ca_pem.clone();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let server_config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.cert_der)],
            PrivateKeyDer::try_from(cert.key_der).unwrap(),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tls = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(Arc::new(server_config)),
    };
    tokio::spawn(async move {
        axum::serve(tls, router).await.expect("serve");
    });
    (format!("https://localhost:{port}"), ca_pem)
}

/// Resolver that pins the `localhost` name to the loopback test server. This
/// is the explicit test transport seam; production always uses VettedResolver.
struct LoopbackResolver {
    addr: SocketAddr,
}

impl Resolve for LoopbackResolver {
    fn resolve(&self, _name: Name) -> Resolving {
        let addrs: Addrs = Box::new(std::iter::once(self.addr));
        Box::pin(std::future::ready(Ok(addrs)))
    }
}

/// Static lookup used to assert that the normal path rejects a private or
/// mapped address before opening any socket.
pub struct StaticLookup(pub Vec<SocketAddr>);

#[async_trait::async_trait]
impl AddressLookup for StaticLookup {
    async fn lookup(&self, _host: &str) -> Result<Vec<SocketAddr>, Error> {
        Ok(self.0.clone())
    }
}

pub fn loopback_client(
    base: &str,
    ca_pem: &str,
    limits: &crate::config::Limits,
) -> reqwest::Client {
    let url = crate::url::ValidatedUrl::parse(
        &format!("{base}/list"),
        &crate::config::QueryPolicy::Reject,
        limits.max_header_bytes,
    )
    .unwrap();
    let port = url.port().unwrap_or(443);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let cert = reqwest::Certificate::from_pem(ca_pem.as_bytes()).unwrap();
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(limits.connect_timeout())
        .timeout(limits.request_timeout())
        .dns_resolver(Arc::new(LoopbackResolver { addr }) as Arc<dyn Resolve>)
        .tls_certs_merge([cert])
        .build()
        .unwrap()
}

/// Build a fetcher whose client is the explicit loopback test transport, with
/// deterministic clock/RNG. The production constructor and policy are
/// untouched.
pub fn fetcher_with_loopback<V: CandidateValidator>(
    root: impl AsRef<std::path::Path>,
    config: &SubscriptionConfig,
    validator: V,
    base: &str,
    ca_pem: &str,
    clock: SharedClock,
    rng: SharedRng,
) -> Fetcher<V> {
    let (limits, _) = config.validate().unwrap();
    let client = loopback_client(base, ca_pem, &limits);
    let transport =
        ReqwestTransport::from_client(client, limits.max_header_bytes, limits.request_timeout());
    let fetcher = Fetcher::with_transport(
        root.as_ref().to_path_buf(),
        config,
        validator,
        Arc::new(transport),
    )
    .unwrap();
    fetcher.with_timing(clock, rng)
}
