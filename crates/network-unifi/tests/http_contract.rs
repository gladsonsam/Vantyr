//! Read-only HTTP contract tests against local TLS fixtures. Certificates are
//! generated in-test with rcgen; a trusted local CA is added to reqwest's
//! verifier via `tls_certs_merge`, never by disabling verification.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use axum::serve::Listener;
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer},
    ServerConfig,
};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use vantyr_network_unifi::*;

struct TestCert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
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

async fn spawn_router(router: Router) -> (String, String) {
    let cert = test_cert();
    let ca_pem = cert.ca_pem.clone();
    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
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
    let address = listener.local_addr().unwrap();
    let tls = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(std::sync::Arc::new(server_config)),
    };
    tokio::spawn(async move {
        axum::serve(tls, router).await.expect("serve");
    });
    (
        format!("https://localhost:{}{}", address.port(), LOCAL_BASE_PATH),
        ca_pem,
    )
}

const SITE: &str = "11111111-1111-4111-8111-111111111111";
const NETWORK: &str = "22222222-2222-4222-8222-222222222222";

fn test_config(base: &str, ca: &str) -> ControllerConfig {
    ControllerConfig::from_base_url_allow_hostname(
        base,
        ApiKey::new("super-secret-key"),
        vec![SITE.to_owned()],
    )
    .unwrap()
    .with_trusted_ca_pem(ca.to_owned())
}

fn page(data: serde_json::Value, offset: i64, total: i64) -> Response {
    (
        StatusCode::OK,
        axum::Json(json!({
            "count": data.as_array().map(|a| a.len()).unwrap_or(0),
            "data": data,
            "limit": 100,
            "offset": offset,
            "totalCount": total
        })),
    )
        .into_response()
}

type Calls = Arc<Mutex<Vec<(String, String, Option<String>)>>>;

fn record(calls: &Calls, request: &Request) {
    let method = request.method().to_string();
    let uri = request.uri().to_string();
    let key = request
        .headers()
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    calls.lock().unwrap().push((method, uri, key));
}

#[tokio::test]
async fn discovery_is_read_only_bounded_and_redacts_the_key() {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let router = Router::new()
        .route("/proxy/network/integration/v1/info", get({
            let calls = recorded.clone();
            move |request: Request| async move {
                record(&calls, &request);
                axum::Json(json!({"applicationVersion": "9.1.0"})).into_response()
            }
        }))
        .route("/proxy/network/integration/v1/sites", get({
            let calls = recorded.clone();
            move |request: Request| async move {
                record(&calls, &request);
                let offset: i64 = request
                    .uri()
                    .query()
                    .and_then(|query| {
                        query
                            .split('&')
                            .find(|pair| pair.starts_with("offset="))
                            .and_then(|pair| pair[7..].parse().ok())
                    })
                    .unwrap_or(0);
                if offset == 0 {
                    page(json!([{"id": SITE, "internalReference": "default", "name": "Home"}]), 0, 1)
                } else {
                    page(json!([]), offset, 1)
                }
            }
        }))
        .route("/proxy/network/integration/v1/sites/{siteId}/networks", get({
            let calls = recorded.clone();
            move |request: Request| async move {
                record(&calls, &request);
                page(
                    json!([{"id": NETWORK, "name": "Home", "management": "GATEWAY",
                            "vlanId": 20, "enabled": true, "default": false}]),
                    0,
                    1,
                )
            }
        }))
        .route("/proxy/network/integration/v1/sites/{siteId}/clients", get({
            let calls = recorded.clone();
            move |request: Request| async move {
                record(&calls, &request);
                page(
                    json!([{"id": "client-1", "name": "TV", "type": "WIRED",
                            "ipAddress": "10.0.0.50"}]),
                    0,
                    1,
                )
            }
        }))
        .route(
            "/proxy/network/integration/v1/sites/{siteId}/networks/{networkId}",
            get({
                let calls = recorded.clone();
                move |request: Request| async move {
                    record(&calls, &request);
                    axum::Json(json!({
                        "id": NETWORK, "name": "Home", "management": "GATEWAY",
                        "vlanId": 20, "enabled": true, "default": false,
                        "zoneId": "zone-1",
                        "ipv4Configuration": {"dhcpConfiguration": {
                            "mode": "SERVER",
                            "dnsServerIpAddressesOverride": ["192.168.1.1"]
                        }},
                        "ipv6Configuration": {
                            "interfaceType": "PREFIX_DELEGATION",
                            "routerAdvertisement": {"priority": "MEDIUM"},
                            "clientAddressAssignment": {"slaacEnabled": true}
                        }
                    }))
                    .into_response()
                }
            }),
        );

    let (base, ca) = spawn_router(router).await;
    let config = test_config(&base, &ca);
    let transport = HttpTransport::new(&config).unwrap();
    let discovery = Discovery::new(&config, &transport);

    let report = discovery.discover().await.unwrap();
    assert_eq!(report.capabilities.application_version.as_deref(), Some("9.1.0"));
    assert_eq!(report.capabilities.api_doc_version, API_DOC_VERSION);
    assert_eq!(report.sites.len(), 1);
    assert_eq!(report.networks[SITE].len(), 1);
    assert_eq!(report.clients[SITE][0].ip_address.as_deref(), Some("10.0.0.50"));

    let detail = discovery.network_detail(SITE, NETWORK).await.unwrap();
    assert_eq!(detail.management, Management::Gateway);
    assert_eq!(
        detail.dns.ipv4_dns_overrides,
        Some(vec!["192.168.1.1".to_owned()])
    );

    let recorded_calls = { calls.lock().unwrap().clone() };
    assert!(recorded_calls.iter().all(|(method, _, key)| {
        method == "GET" && key.as_deref() == Some("super-secret-key")
    }));
    assert!(recorded_calls
        .iter()
        .any(|(_, uri, _)| uri.contains("offset=0&limit=100")));
    // The configured site allowlist is enforced without issuing a request.
    assert!(matches!(
        discovery.list_networks("site-not-allowed").await,
        Err(Error::SiteNotAllowed(_))
    ));

    let debug_config = format!("{:?}", config);
    let debug_transport = format!("{:?}", transport);
    assert!(!debug_config.contains("super-secret-key"));
    assert!(!debug_transport.contains("super-secret-key"));
}

#[tokio::test]
async fn unsupported_unavailable_auth_denied_and_missing_are_distinct() {
    for (status, expected) in [
        (StatusCode::UNAUTHORIZED, "AuthDenied"),
        (StatusCode::FORBIDDEN, "AuthDenied"),
        (StatusCode::NOT_FOUND, "Missing"),
        (StatusCode::METHOD_NOT_ALLOWED, "Unsupported"),
        (StatusCode::NOT_IMPLEMENTED, "Unsupported"),
        (StatusCode::INTERNAL_SERVER_ERROR, "Unavailable"),
    ] {
        let router = Router::new().route(
            "/proxy/network/integration/v1/info",
            get(move || async move { status.into_response() }),
        );
        let (base, ca) = spawn_router(router).await;
        let config = test_config(&base, &ca);
        let transport = HttpTransport::new(&config).unwrap();
        let error = format!("{:?}", Discovery::new(&config, &transport).info().await.unwrap_err());
        assert!(error.contains(expected), "status {status} gave {error}");
        assert!(!error.contains("super-secret-key"));
    }
}

#[tokio::test]
async fn malformed_oversized_and_non_advancing_responses_are_rejected() {
    let malformed = Router::new().route(
        "/proxy/network/integration/v1/sites",
        get(|| async { (StatusCode::OK, "not-json").into_response() }),
    );
    let (base, ca) = spawn_router(malformed).await;
    let config = test_config(&base, &ca);
    let transport = HttpTransport::new(&config).unwrap();
    assert!(matches!(
        Discovery::new(&config, &transport).list_sites().await,
        Err(Error::Malformed("sites"))
    ));

    let oversized = Router::new().route(
        "/proxy/network/integration/v1/sites",
        get(|| async {
            (
                StatusCode::OK,
                format!("{{\"data\":\"{}\"}}", "x".repeat(4000)),
            )
                .into_response()
        }),
    );
    let (base, ca) = spawn_router(oversized).await;
    let config = test_config(&base, &ca)
        .with_limits(Duration::from_secs(5), 1024, 100, 100)
        .unwrap();
    let transport = HttpTransport::new(&config).unwrap();
    assert!(matches!(
        Discovery::new(&config, &transport).list_sites().await,
        Err(Error::LimitExceeded("sites"))
    ));

    // The server ignores `offset` and always reports more pages.
    let non_advancing = Router::new().route(
        "/proxy/network/integration/v1/sites",
        get(|| async {
            page(
                json!([{"id": SITE, "internalReference": "default", "name": "Home"}]),
                0,
                5,
            )
        }),
    );
    let (base, ca) = spawn_router(non_advancing).await;
    let config = test_config(&base, &ca);
    let transport = HttpTransport::new(&config).unwrap();
    assert!(matches!(
        Discovery::new(&config, &transport).list_sites().await,
        Err(Error::NonAdvancingPagination("sites"))
    ));
}

#[tokio::test]
async fn tls_verification_fails_without_explicit_trusted_ca() {
    let router = Router::new().route(
        "/proxy/network/integration/v1/info",
        get(|| async { axum::Json(json!({"applicationVersion": "9.1.0"})) }),
    );
    let (base, ca) = spawn_router(router).await;

    let untrusted = ControllerConfig::from_base_url_allow_hostname(
        &base,
        ApiKey::new("super-secret-key"),
        vec![SITE.to_owned()],
    )
    .unwrap();
    let transport = HttpTransport::new(&untrusted).unwrap();
    assert!(matches!(
        Discovery::new(&untrusted, &transport).info().await,
        Err(Error::Transport("info"))
    ));

    let trusted = test_config(&base, &ca);
    let transport = HttpTransport::new(&trusted).unwrap();
    assert!(Discovery::new(&trusted, &transport).info().await.is_ok());
}
