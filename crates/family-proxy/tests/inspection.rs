//! Real loopback TLS tests for the OPTIONAL inspection path.
//!
//! No host DNS, router, CA trust store, SSO or live controller is touched. A
//! private origin is pinned to a loopback socket, a test-only CA is used as the
//! upstream trust anchor through the explicit test seam, and clients verify the
//! issued leaf against the unique inspection CA. Production always uses normal
//! roots; that choice is not available through the binary or `start()`.

mod support;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use family_proxy::{Config, InspectionRuntime, ProxyServer};
use rama::tls::client::TlsClientConfig;
use rustls::pki_types::CertificateDer;
use support::{connect, read_head, status_line, NoDnsResolver, GOOD_AUTH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;
use vantyr_network_pki::{CaSigner, LeafRequest};

const CLIENT_ID: &str = "22222222-3333-4444-5555-666666666666";
const DEVICE_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

fn now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

fn ca() -> CaSigner {
    CaSigner::generate(now(), now() + time::Duration::days(1)).unwrap()
}

fn config_with_connections(
    origin: SocketAddr,
    leaf_validity_secs: u64,
    exceptions: serde_json::Value,
    max_connections: usize,
) -> Config {
    let value = serde_json::json!({
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 1,
        "bind": { "address": "127.0.0.1", "port": 0 },
        "limits": {
            "max_connections": max_connections,
            "max_header_bytes": 16384,
            "max_body_bytes": 65536,
            "connect_timeout_ms": 1000,
            "request_timeout_secs": 2,
            "tunnel_idle_secs": 30
        },
        "profiles": { "restricted": [
            { "effect": "allow", "match": { "type": "suffix", "value": "origin.test" } }
        ]},
        "default_device_profile": "restricted",
        "devices": [{ "id": DEVICE_ID, "default_profile": "restricted" }],
        "clients": [{
            "id": CLIENT_ID,
            "token": "vantyr-proxy-bootstrap-token-0001",
            "device_id": DEVICE_ID
        }],
        "destinations": [{
            "host": "origin.test", "port": origin.port(),
            "pin": format!("127.0.0.1:{}", origin.port())
        }],
        "inspection": {
            "enabled": true,
            "ca_dir": "/tmp/unused-inspection-ca-dir",
            "ca_name": "inspection-ca",
            "secret_file_path": "/tmp/unused-inspection-secret",
            "leaf_validity_secs": leaf_validity_secs,
            "handshake_timeout_secs": 2,
            "enabled_client_ids": [CLIENT_ID],
            "exceptions": exceptions
        }
    });
    Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn config_with(
    origin: SocketAddr,
    leaf_validity_secs: u64,
    exceptions: serde_json::Value,
) -> Config {
    config_with_connections(origin, leaf_validity_secs, exceptions, 32)
}

/// Accepts TCP but never writes a TLS ServerHello: stalls the upstream handshake.
struct StallTlsOrigin {
    addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl StallTlsOrigin {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let _held = stream;
                    std::future::pending::<()>().await;
                });
            }
        });
        Self { addr, task }
    }
}

impl Drop for StallTlsOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct TlsOrigin {
    addr: SocketAddr,
    accepts: Arc<AtomicUsize>,
    http: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl TlsOrigin {
    async fn start(ca: &CaSigner, dns_name: &str) -> Self {
        let mut request = LeafRequest::new(vec![dns_name.to_owned()], Vec::new());
        request.validity_secs = 3600;
        let leaf = ca.issue_server_leaf(request).unwrap();
        let chain = leaf
            .chain_der
            .into_iter()
            .map(CertificateDer::from)
            .collect();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(leaf.private_key_der.to_vec()),
        );
        let mut cfg = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepts = Arc::new(AtomicUsize::new(0));
        let http = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (a, h, s) = (accepts.clone(), http.clone(), seen.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                a.fetch_add(1, Ordering::SeqCst);
                let acceptor = acceptor.clone();
                let h = h.clone();
                let s = s.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while let Ok(n) = tls.read(&mut tmp).await {
                        if n == 0 || buf.len() > 16 * 1024 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    if !buf.is_empty() {
                        h.fetch_add(1, Ordering::SeqCst);
                        s.lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&buf).to_string());
                    }
                    let _ = tls
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await;
                });
            }
        });
        Self {
            addr,
            accepts,
            http,
            seen,
            task,
        }
    }

    fn http_hits(&self) -> usize {
        self.http.load(Ordering::SeqCst)
    }
    fn accepts(&self) -> usize {
        self.accepts.load(Ordering::SeqCst)
    }
    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for TlsOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn client_connector(trust_der: &[u8]) -> TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(trust_der.to_vec())).unwrap();
    let mut cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    TlsConnector::from(Arc::new(cfg))
}

async fn start_inspected(
    config: Config,
    inspection_ca: CaSigner,
    upstream_ca: &CaSigner,
) -> ProxyServer {
    let runtime = InspectionRuntime::from_signer_test_seam(inspection_ca, &config)
        .expect("test seam runtime");
    let trust = TlsClientConfig::new()
        .with_alpn_http_1()
        .try_with_server_trust_anchors([CertificateDer::from(
            upstream_ca.public_cert_der().to_vec(),
        )])
        .unwrap();
    ProxyServer::start_with_test_tls(config, NoDnsResolver, runtime, trust)
        .await
        .expect("proxy start")
}

/// Perform a real CONNECT and then a real TLS handshake inside the tunnel.
/// `root_der` is the single trust anchor the client is willing to accept.
async fn inspected_request(
    proxy: SocketAddr,
    port: u16,
    root_der: &[u8],
    sni: &str,
    inner: &str,
) -> Result<String, String> {
    let mut stream = connect(proxy).await;
    let request = format!(
        "CONNECT origin.test:{port} HTTP/1.1\r\nHost: origin.test:{port}\r\nProxy-Authorization: {GOOD_AUTH}\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let connect_head = read_head(&mut stream).await;
    if status_line(&connect_head) != 200 {
        return Err(connect_head);
    }
    let tls = client_connector(root_der)
        .connect(
            rustls::pki_types::ServerName::try_from(sni.to_owned()).unwrap(),
            stream,
        )
        .await
        .map_err(|error| format!("client TLS failed: {error}"))?;
    let mut tls = tls;
    tls.write_all(inner.as_bytes())
        .await
        .map_err(|error| format!("inner write failed: {error}"))?;
    Ok(tokio::time::timeout(Duration::from_secs(4), async {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        loop {
            let n = tls.read(&mut tmp).await.expect("inner read");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    })
    .await
    .expect("inner response timeout"))
}

fn inner_request(host: &str, extra: &str) -> String {
    format!("GET / HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n\r\n")
}

async fn raw_connect(proxy: SocketAddr, port: u16) -> TcpStream {
    let mut stream = connect(proxy).await;
    let request = format!(
        "CONNECT origin.test:{port} HTTP/1.1\r\nHost: origin.test:{port}\r\nProxy-Authorization: {GOOD_AUTH}\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}

#[tokio::test]
async fn inspected_connect_uses_unique_ca_and_reaches_verified_origin() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();
    let inspection_root = inspection_ca.public_cert_der().to_vec();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    let response = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        &inspection_root,
        "origin.test",
        &inner_request("origin.test", ""),
    )
    .await
    .expect("client trusting only the inspection CA verifies the leaf");
    assert_eq!(status_line(&response), 200, "{response}");
    assert!(response.ends_with("ok"), "{response}");
    assert_eq!(
        origin.http_hits(),
        1,
        "one real decrypted origin HTTP request"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn default_roots_reject_the_inspection_leaf() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    // The origin CA alone must not verify a leaf issued by the inspection CA.
    let result = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        origin_ca.public_cert_der(),
        "origin.test",
        &inner_request("origin.test", ""),
    )
    .await;
    assert!(result.is_err(), "an unrelated root must reject the leaf");
    assert_eq!(
        origin.http_hits(),
        0,
        "no decrypted HTTP may reach the origin"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn bad_upstream_certificate_fails_before_200_without_origin_http() {
    let trusted_ca = ca();
    let rogue_ca = ca();
    let origin = TlsOrigin::start(&rogue_ca, "origin.test").await;
    let inspection_ca = ca();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &trusted_ca).await;

    let mut stream = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
    let head = read_head(&mut stream).await;
    assert!(
        matches!(status_line(&head), 502 | 504),
        "upstream verification must fail before the 200: {head}"
    );
    assert!(
        origin.accepts() >= 1,
        "TCP was dialled through the pinned socket"
    );
    assert_eq!(
        origin.http_hits(),
        0,
        "no HTTP request may be written upstream"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn bad_upstream_hostname_fails_before_200_without_origin_http() {
    let origin_ca = ca();
    // The origin presents a certificate for other.test, not origin.test.
    let origin = TlsOrigin::start(&origin_ca, "other.test").await;
    let inspection_ca = ca();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    let mut stream = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
    let head = read_head(&mut stream).await;
    assert!(
        matches!(status_line(&head), 502 | 504),
        "hostname mismatch must fail before the 200: {head}"
    );
    assert_eq!(
        origin.http_hits(),
        0,
        "no HTTP request may be written upstream"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn leaf_issuance_failure_never_falls_back_to_an_opaque_tunnel() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    // A 7-day leaf cannot be issued by a 1-day CA: no fallback is allowed.
    let inspection_ca = ca();
    let config = config_with(origin.addr, 7 * 24 * 3600, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    let mut stream = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
    let head = read_head(&mut stream).await;
    assert_eq!(
        status_line(&head),
        502,
        "leaf failure must be pre-200: {head}"
    );
    assert_eq!(
        origin.accepts(),
        0,
        "no upstream socket may be dialled on failure"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn sni_and_inner_host_mismatch_cannot_escape_the_connect_authority() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();
    let inspection_root = inspection_ca.public_cert_der().to_vec();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    // A different SNI is rejected by the SNI guard during the handshake.
    let bad_sni = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        &inspection_root,
        "evil.test",
        &inner_request("origin.test", ""),
    )
    .await;
    assert!(bad_sni.is_err(), "SNI mismatch must fail the handshake");
    assert_eq!(origin.http_hits(), 0);

    // A different inner Host is rejected by the decrypted middleware.
    let bad_host = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        &inspection_root,
        "origin.test",
        &inner_request("evil.test", ""),
    )
    .await
    .expect("the request itself is served a rejection response");
    assert_eq!(status_line(&bad_host), 403, "{bad_host}");
    assert_eq!(
        origin.http_hits(),
        0,
        "the hostile Host cannot route upstream"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn decrypted_credentials_are_stripped_before_the_origin() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();
    let inspection_root = inspection_ca.public_cert_der().to_vec();
    let config = config_with(origin.addr, 60, serde_json::json!([]));
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    let response = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        &inspection_root,
        "origin.test",
        &inner_request(
            "origin.test",
            &format!("Proxy-Authorization: {GOOD_AUTH}\r\nX-Forwarded-For: 1.2.3.4"),
        ),
    )
    .await
    .expect("request succeeds");
    assert_eq!(status_line(&response), 200);
    let seen = origin.requests();
    assert_eq!(seen.len(), 1);
    let lower = seen[0].to_ascii_lowercase();
    assert!(
        !lower.contains("proxy-authorization"),
        "client credential leaked: {}",
        seen[0]
    );
    assert!(
        !lower.contains("x-forwarded-for"),
        "forwarding metadata leaked: {}",
        seen[0]
    );
    proxy.stop().await;
}

#[tokio::test]
async fn scoped_raw_exception_preserves_client_tls_then_expiry_returns_to_inspection() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();

    // Active exception: the client's own TLS reaches the origin unchanged.
    let active = serde_json::json!([{
        "host": "origin.test", "port": origin.addr.port(),
        "client_id": CLIENT_ID, "expires_at": "2099-01-01T00:00:00Z"
    }]);
    let config = config_with(origin.addr, 60, active);
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;
    let response = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        origin_ca.public_cert_der(),
        "origin.test",
        &inner_request("origin.test", ""),
    )
    .await
    .expect("the exception keeps the client TLS end to end");
    assert_eq!(status_line(&response), 200);
    proxy.stop().await;

    // The same exception, now expired, must go back to inspection and must not
    // let a client that only trusts the origin CA through.
    let expired = serde_json::json!([{
        "host": "origin.test", "port": origin.addr.port(),
        "client_id": CLIENT_ID, "expires_at": "2000-01-01T00:00:00Z"
    }]);
    let inspection_ca = ca();
    let config = config_with(origin.addr, 60, expired);
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;
    let result = inspected_request(
        proxy.bind_addr(),
        origin.addr.port(),
        origin_ca.public_cert_der(),
        "origin.test",
        &inner_request("origin.test", ""),
    )
    .await;
    assert!(
        result.is_err(),
        "an expired exception must return to inspection"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn stalled_upstream_tls_handshake_times_out_and_releases_the_permit() {
    let origin = StallTlsOrigin::start().await;
    let origin_ca = ca();
    let inspection_ca = ca();
    // A single permit: if the timed-out handshake leaked it, the second
    // CONNECT would be dropped instead of answered.
    let config = config_with_connections(origin.addr, 60, serde_json::json!([]), 1);
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    for _ in 0..2 {
        let mut stream = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
        let head = read_head(&mut stream).await;
        assert_eq!(status_line(&head), 504, "upstream TLS stall: {head}");
    }
    proxy.stop().await;
}

#[tokio::test]
async fn stalled_downstream_tls_handshake_times_out_and_releases_the_permit() {
    let origin_ca = ca();
    let origin = TlsOrigin::start(&origin_ca, "origin.test").await;
    let inspection_ca = ca();
    let config = config_with_connections(origin.addr, 60, serde_json::json!([]), 1);
    let proxy = start_inspected(config, inspection_ca, &origin_ca).await;

    // First client completes CONNECT but never sends a ClientHello.
    let mut stalled = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
    let head = read_head(&mut stalled).await;
    assert_eq!(status_line(&head), 200, "{head}");
    tokio::time::sleep(Duration::from_millis(2600)).await;

    // The permit must have been released; a fresh CONNECT is answered again.
    let mut fresh = raw_connect(proxy.bind_addr(), origin.addr.port()).await;
    let head = read_head(&mut fresh).await;
    assert_eq!(
        status_line(&head),
        200,
        "downstream TLS stall leaked a permit: {head}"
    );
    drop(stalled);
    proxy.stop().await;
}
