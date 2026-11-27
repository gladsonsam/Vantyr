//! Real-server / real-worker Stage A + Stage B DNS-management integration test.
//!
//! This is NOT a mock control plane. The axum router mounted here is the real
//! `network::routes()` + `network::worker_routes()` behind the real session +
//! CSRF middleware, over the real dashboard session store and gateway credential
//! issuance, on a fresh SQLx-migrated database. The worker side uses the real
//! `ManagementOptions` / `ManagementClient` / `ManagementWorker`, the production
//! subscription `Fetcher`/compiler and a real durable UDP/TCP DNS listener.
//!
//! Reproduce against the dedicated throwaway PostgreSQL only (never a household
//! database). Read the container's POSTGRES_PASSWORD from local Docker env;
//! do not print it:
//!
//! ```text
//! SQLX_OFFLINE=true \
//! DATABASE_URL=postgres://<user>:<pw>@127.0.0.1:58743/<db> \
//!   cargo test -p vantyr-server --locked --offline \
//!   network::dns_management_e2e_tests::real_server_and_worker_dns_management_flow \
//!   -- --exact --nocapture
//! ```
//!
//! Precisely scoped test seam: production's public-host resolver rejects
//! loopback, so ONLY the subscription fetcher's DNS resolver is injected with a
//! loopback resolver. Verified TLS with the per-run private CA is still
//! required; the worker's management client uses its unchanged verified,
//! no-proxy, no-redirect transport. No insecure verifier, no SSRF bypass, no
//! live provider, no mocked wire DTO and no copied auth/serializer logic.

use std::fs;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::dns_management_dto::digest;
use axum::extract::State;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::{Listener, ListenerExt};
use axum::Router;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use family_dns::{
    config_digest, single_source_config, Config, DnsServer, DurableOptions, FormatValidator,
    ManagementClient, ManagementConfig, ManagementOptions, ManagementWorker, SubscriptionRuntime,
    SubscriptionSettings,
};
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{Name as DnsName, RData, Record, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use reqwest::dns::{Addrs, Name as HttpName, Resolve, Resolving};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;
use vantyr_network_subscriptions::error::Error as SubscriptionError;
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::{HttpTransport, ReqwestTransport};

const WORKER_ID: &str = "dns-mgmt-e2e-worker";
/// One hour in the past: safely inside the worker's future-skew bound and well
/// inside its policy freshness window, on any day the test is run.
fn published_at() -> DateTime<Utc> {
    Utc::now() - ChronoDuration::hours(1)
}
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn mapped_source() -> IpAddr {
    // The adult profile in dns_config() maps this source IP.
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

/// A minimal authoritative UDP responder that counts every real query it
/// answers. No host resolver, privileged port or live provider is involved.
struct CountingUpstream {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl CountingUpstream {
    async fn start() -> Self {
        let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .unwrap();
        let addr = socket.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            let mut buffer = vec![0u8; 4096];
            loop {
                let (len, peer) = match socket.recv_from(&mut buffer).await {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let request = match Message::from_vec(&buffer[..len]) {
                    Ok(message) => message,
                    Err(_) => continue,
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut answer =
                    Message::new(request.metadata.id, MessageType::Response, OpCode::Query);
                answer.metadata.recursion_desired = request.metadata.recursion_desired;
                answer.metadata.checking_disabled = request.metadata.checking_disabled;
                if let Some(query) = request.queries.first() {
                    answer.add_query(query.clone());
                    answer.add_answer(Record::from_rdata(
                        query.name().clone(),
                        60,
                        RData::A(AData(Ipv4Addr::new(203, 0, 113, 7))),
                    ));
                }
                answer.metadata.response_code = ResponseCode::NoError;
                if let Ok(bytes) = answer.to_vec() {
                    let _ = socket.send_to(&bytes, peer).await;
                }
            }
        });
        Self { addr, hits, task }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for CountingUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ─── Verified loopback TLS ──────────────────────────────────────────────────

#[derive(Clone)]
struct Cert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

fn cert() -> Cert {
    let mut ca = CertificateParams::new(vec!["vantyr e2e test ca".to_owned()]).unwrap();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let leaf_params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let issuer = Issuer::from_params(&ca, &ca_key);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    Cert {
        ca_pem: ca_cert.pem(),
        cert_der: leaf.der().as_ref().to_vec(),
        key_der: leaf_key.serialize_der(),
    }
}

/// Tiny axum `Listener` adapter: TLS terminates in-process; no handwritten
/// HTTP/TLS wire is introduced.
struct TlsListener {
    inner: TcpListener,
    acceptor: TlsAcceptor,
}

impl Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = self.inner.accept().await.expect("tls accept");
            if let Ok(tls) = self.acceptor.accept(stream).await {
                return (tls, addr);
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

fn server_config(cert: &Cert) -> Arc<ServerConfig> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.cert_der.clone())],
            PrivateKeyDer::try_from(cert.key_der.clone()).unwrap(),
        )
        .unwrap();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Arc::new(config)
}

struct Guard(JoinHandle<()>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn tls_router(config: Arc<ServerConfig>, router: Router) -> (String, Guard) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tls = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(config),
    }
    // axum supplies `Connected` for `TapIo<L, _>` with `L::Addr == SocketAddr`,
    // so the real handlers get the same peer connect info as a plain listener.
    .tap_io(|_| {});
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            tls,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    (format!("https://localhost:{port}"), Guard(handle))
}

/// The actual server router, identical in composition to the existing Stage A
/// harness, only served over verified TLS.
async fn spawn_server(pool: PgPool) -> (String, String, Guard) {
    let state = crate::test_support::app_state(pool);
    let api = Router::new()
        .merge(super::routes())
        .merge(crate::platform::routes());
    let app = Router::new()
        .nest("/api", api)
        .route_layer(from_fn_with_state(state.clone(), crate::auth::require_auth))
        .merge(super::worker_routes())
        .with_state(state);
    let c = cert();
    let ca_pem = c.ca_pem.clone();
    let (base, guard) = tls_router(server_config(&c), app).await;
    (base, ca_pem, guard)
}

// ─── Real admin HTTP client (cookie + CSRF) ─────────────────────────────────

struct Http {
    base: String,
    client: reqwest::Client,
    token: String,
    csrf: String,
}

impl Http {
    fn new(base: String, ca_pem: &str, token: String, csrf: String) -> Self {
        let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes()).unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .tls_certs_merge([ca])
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        Self {
            base,
            client,
            token,
            csrf,
        }
    }

    fn builder(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("x-csrf-token", self.csrf.clone())
            .header("content-type", "application/json")
    }

    async fn send(builder: reqwest::RequestBuilder) -> (u16, Value) {
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        if status >= 500 {
            // Never echo response bodies: a credential-issue failure would
            // contain the one-time plaintext token.
            eprintln!("[e2e] HTTP {status} from server route");
        }
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        (status, body)
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::GET, path)).await
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::POST, path).json(&body)).await
    }

    async fn patch(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::PATCH, path).json(&body)).await
    }

    /// One cookie-free worker-route call, used only to observe the server's
    /// own pending-token view (the worker itself uses its real typed client).
    async fn worker_read(&self, bearer: &str, hid: Uuid, gid: Uuid) -> (u16, Value) {
        Self::send(
            self.client
                .post(format!("{}/worker/network/dns-management/read", self.base))
                .header("authorization", bearer)
                .header("content-type", "application/json")
                .json(&json!({
                    "audience": "vantyr-gateway-worker",
                    "command": "read_dns_management",
                    "household_id": hid,
                    "gateway_id": gid,
                    "kind": "dns"
                })),
        )
        .await
    }
}

async fn insert_user(pool: &PgPool, username: &str, role: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1, 'test-hash', $2) RETURNING id",
    )
    .bind(username)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn session_for(pool: &PgPool, user_id: Uuid, label: &str) -> (String, String) {
    let token = format!("dns-e2e-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("dns-e2e-csrf-{label}");
    let hash = crate::auth::secrets::sha256_hex_bytes(token.as_bytes());
    crate::auth::users::db::sessions::dashboard_session_create(
        pool,
        &hash,
        user_id,
        Utc::now() + ChronoDuration::hours(1),
        None,
        &csrf,
    )
    .await
    .unwrap();
    (token, csrf)
}

async fn bootstrap_as(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn create_gateway(http: &Http, hid: Uuid) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": "dns", "label": "E2E worker" }),
        )
        .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue_cred(http: &Http, hid: Uuid, gid: Uuid) -> String {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({
                "expires_in_hours": 24,
                // Explicit commands only: no implicit upgrade at read/report.
                "commands": ["read_dns_management", "report_dns_status"]
            }),
        )
        .await;
    assert_eq!(status, 200, "credential failed: {body}");
    body["token"].as_str().unwrap().to_string()
}

// ─── Loopback list server (verified TLS, injected resolver only) ────────────

#[derive(Default)]
struct ListState {
    body: Mutex<Vec<u8>>,
    /// Simulates an unreachable list during the post-restart negative phase.
    fail: Mutex<bool>,
}

async fn list_handler(State(state): State<Arc<ListState>>) -> Response {
    if *state.fail.lock().unwrap() {
        return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    axum::http::Response::builder()
        .status(200)
        .body(axum::body::Body::from(state.body.lock().unwrap().clone()))
        .unwrap()
        .into_response()
}

struct LoopbackResolver(SocketAddr);
impl Resolve for LoopbackResolver {
    fn resolve(&self, _name: HttpName) -> Resolving {
        let addrs: Addrs = Box::new(std::iter::once(self.0));
        Box::pin(std::future::ready(Ok(addrs)))
    }
}

async fn start_list_server() -> (String, String, Arc<ListState>, Guard) {
    let c = cert();
    let ca_pem = c.ca_pem.clone();
    let state = Arc::new(ListState {
        body: Mutex::new(b"managed.block.test\n".to_vec()),
        fail: Mutex::new(false),
    });
    let router = Router::new()
        .route("/list", get(list_handler))
        .with_state(state.clone());
    let (base, guard) = tls_router(server_config(&c), router).await;
    (base, ca_pem, state, guard)
}

// ─── DNS queries over real UDP/TCP sockets ──────────────────────────────────

fn question(name: &str, qtype: RecordType) -> Message {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(DnsName::from_str(name).unwrap(), qtype));
    message
}

async fn udp_query(server: SocketAddr, name: &str) -> Message {
    let client = UdpSocket::bind(SocketAddr::new(mapped_source(), 0))
        .await
        .unwrap();
    let bytes = question(name, RecordType::A).to_vec().unwrap();
    client.send_to(&bytes, server).await.unwrap();
    let mut buffer = vec![0u8; 4096];
    let (len, _) = tokio::time::timeout(Duration::from_secs(6), client.recv_from(&mut buffer))
        .await
        .expect("UDP query timed out")
        .unwrap();
    Message::from_vec(&buffer[..len]).unwrap()
}

async fn tcp_query(server: SocketAddr, name: &str) -> Message {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(mapped_source(), 0)).unwrap();
    let mut stream = socket.connect(server).await.unwrap();
    let bytes = question(name, RecordType::A).to_vec().unwrap();
    stream
        .write_all(&(bytes.len() as u16).to_be_bytes())
        .await
        .unwrap();
    stream.write_all(&bytes).await.unwrap();
    let mut prefix = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut prefix))
        .await
        .expect("TCP header timed out")
        .unwrap();
    let mut buffer = vec![0u8; u16::from_be_bytes(prefix) as usize];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut buffer))
        .await
        .expect("TCP body timed out")
        .unwrap();
    Message::from_vec(&buffer).unwrap()
}

async fn blocked(server: &DnsServer, name: &str, tcp: bool) -> bool {
    let message = if tcp {
        tcp_query(server.bind_addr(), name).await
    } else {
        udp_query(server.bind_addr(), name).await
    };
    assert!(message.recursion_desired, "RD flag dropped");
    assert!(message.checking_disabled, "CD flag dropped");
    message.response_code == ResponseCode::NXDomain
}

/// A real forwarded answer from the counting origin (TEST-NET-3 address).
async fn answered(server: &DnsServer, name: &str, tcp: bool) -> bool {
    let message = if tcp {
        tcp_query(server.bind_addr(), name).await
    } else {
        udp_query(server.bind_addr(), name).await
    };
    message.response_code == ResponseCode::NoError
        && message.answers.iter().any(|record| {
            matches!(
                &record.data,
                RData::A(AData(ip)) if *ip == Ipv4Addr::new(203, 0, 113, 7)
            )
        })
}

// ─── Worker fixture / fixture config ────────────────────────────────────────

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
    options: PathBuf,
    credential: PathBuf,
    cache: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-e2e-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(dir.join("cache")).unwrap();
    Fixture {
        config: dir.join("dns.json"),
        state: dir.join("state.json"),
        options: dir.join("options.json"),
        credential: dir.join("credential"),
        cache: dir.join("cache"),
        dir,
    }
}

#[cfg(unix)]
fn private(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

/// Small, synthetic DNS fixture. No live provider and no production household
/// data: all addresses are TEST-NET-2 and the policy is local to this run.
fn dns_config(
    port: u16,
    revision: u64,
    published: DateTime<Utc>,
    upstream: Option<SocketAddr>,
) -> Vec<u8> {
    let upstreams = match upstream {
        Some(addr) => vec![addr.to_string()],
        None => Vec::new(),
    };
    serde_json::to_vec(&json!({
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_published_at": published,
        "policy_revision": revision,
        "bind": { "address": "127.0.0.1", "port": port },
        "upstreams": upstreams,
        "deny": { "mode": "nxdomain" },
        "local_zones": { "block.test.": [
            { "type": "a", "name": "managed.block.test.", "ttl": 60, "addr": "192.0.2.20" },
            { "type": "a", "name": "other.block.test.", "ttl": 60, "addr": "192.0.2.21" },
            { "type": "a", "name": "svc.block.test.", "ttl": 60, "addr": "192.0.2.22" },
            { "type": "a", "name": "changed.block.test.", "ttl": 60, "addr": "192.0.2.24" }
        ]},
        "profiles": {
            "adult": [{ "effect": "allow", "match": { "type": "suffix", "value": "test" }, "reason": "adult" }],
            "restricted": [{ "effect": "deny", "match": { "type": "suffix", "value": "test" }, "reason": "restricted" }]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "adult",
            "source_ips": ["127.0.0.2"]
        }]
    }))
    .unwrap()
}

fn desired_ops(list_url: &str) -> Vec<Value> {
    vec![
        json!({"op":"add_list", "source": {
            "id": "remote-list",
            "url": list_url,
            "format": "hosts",
            "enabled": true,
            "interval_secs": 300,
            "max_stale_secs": 3600,
            "metadata": {
                "title": "E2E operator list",
                "publisher": "Operator",
                "license": "asserted"
            }
        }}),
        json!({"op":"set_catalog", "catalog": {
            "version": "e2e-1",
            "services": [{
                "id": "remote-service",
                "label": "Remote service",
                "version": "1",
                "domains": [{"type":"exact","value":"svc.block.test"}],
                "source": null,
                "evidence": null,
                "license": null
            }]
        }}),
        json!({"op":"select_services", "ids": ["remote-service"]}),
    ]
}

fn patch_with(expect: u64, ops: Vec<Value>) -> Value {
    json!({ "expected_config_version": expect, "operations": ops })
}

/// Production fetcher/compiler with the single loopback-DNS seam. Rebuilt on
/// restart from the same fixture so the test exercises rehydration, not a
/// second first-run bootstrap.
fn build_runtime(st: &Fixture, list_ca: &str) -> Arc<SubscriptionRuntime> {
    let settings = SubscriptionSettings {
        cache_path: st.cache.to_string_lossy().into_owned(),
        trusted_ca_pem: None,
        sources: Vec::new(),
    };
    Arc::new(
        SubscriptionRuntime::new(&settings, None)
            .unwrap()
            // Fast integrator reaction is local only: it does not relax any
            // configured interval, cooldown or TLS validation.
            .with_tick(Duration::from_millis(250))
            .with_fetcher_factory({
                let list_ca = list_ca.to_owned();
                move |spec, root, _ca| {
                    // The production helper builds the bounded one-source
                    // config (including the 7-day explicit stale bound).
                    let cfg = single_source_config(spec);
                    let limits = cfg.limits.clone();
                    let url = reqwest::Url::parse(&spec.url)
                        .map_err(|e| SubscriptionError::InvalidConfig(e.to_string()))?;
                    let addr =
                        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), url.port().unwrap_or(443));
                    let cert = reqwest::Certificate::from_pem(list_ca.as_bytes())
                        .map_err(|e| SubscriptionError::InvalidConfig(e.to_string()))?;
                    // The ONLY injection: DNS resolution of the synthetic
                    // hostname to loopback. TLS still verifies against the
                    // unique per-run CA; no insecure verifier is used.
                    let client = reqwest::Client::builder()
                        .no_proxy()
                        .redirect(reqwest::redirect::Policy::none())
                        .dns_resolver(Arc::new(LoopbackResolver(addr)) as Arc<dyn Resolve>)
                        .tls_certs_merge([cert])
                        .build()
                        .map_err(|e| SubscriptionError::InvalidConfig(e.to_string()))?;
                    let transport = Arc::new(ReqwestTransport::from_client(
                        client,
                        limits.max_header_bytes,
                        limits.request_timeout(),
                    )) as Arc<dyn HttpTransport>;
                    // Use the runtime-supplied cache root exactly as the
                    // production factory does: no private cache override.
                    Fetcher::with_transport(
                        root.to_path_buf(),
                        &cfg,
                        FormatValidator::new(spec.format),
                        transport,
                    )
                }
            }),
    )
}

/// Runtime used by a restarted worker; `list_ca` is re-read from the fixture's
/// private CA file so no secret is printed or duplicated in source.
fn build_runtime_from_cache(st: &Fixture) -> Arc<SubscriptionRuntime> {
    let ca = fs::read_to_string(st.dir.join("ca-list.pem")).unwrap();
    build_runtime(st, &ca)
}

// Test-harness assembly only; the eight inputs are the distinct private files
// and identities the real worker needs, kept explicit rather than hidden.
#[allow(clippy::too_many_arguments)]
async fn start_worker(
    st: &Fixture,
    hid: Uuid,
    gid: Uuid,
    published: DateTime<Utc>,
    list_ca: &str,
    mgmt_base: &str,
    mgmt_ca: &str,
    bearer: &str,
    upstream: SocketAddr,
) -> (Arc<DnsServer>, Arc<ManagementWorker>) {
    fs::write(&st.config, dns_config(0, 2, published, Some(upstream))).unwrap();
    fs::write(&st.credential, format!("{bearer}\n")).unwrap();
    #[cfg(unix)]
    {
        private(&st.credential);
    }
    let ca_path = st.dir.join("ca.pem");
    fs::write(&ca_path, mgmt_ca.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        private(&ca_path);
    }
    let options_json = json!({
        "origin": mgmt_base,
        "ca_pem_path": ca_path,
        "credential_file": st.credential,
        "household_id": hid,
        "gateway_id": gid,
        "poll_interval_secs": 10,
        "request_timeout_secs": 5,
        "max_response_bytes": 32768
    });
    fs::write(&st.options, serde_json::to_vec(&options_json).unwrap()).unwrap();
    #[cfg(unix)]
    {
        private(&st.options);
    }

    let list_ca_path = st.dir.join("ca-list.pem");
    fs::write(&list_ca_path, list_ca.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        private(&list_ca_path);
    }
    let runtime = build_runtime(st, list_ca);

    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let durable = DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER_ID.to_owned(),
        config_path: Some(st.config.clone()),
        now: published,
        hooks: None,
    };
    let server = DnsServer::start_durable_with_subscriptions(durable, Some(runtime.clone()))
        .await
        .unwrap();
    let worker = Arc::new(ManagementWorker::new(options, client, Some(runtime)));
    (server, worker)
}

/// PostgreSQL stores microsecond precision; compare instants at that resolution.
fn assert_same_instant(json: &Value, expected: DateTime<Utc>, what: &str) {
    let actual: DateTime<Utc> = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(
        actual.timestamp_micros(),
        expected.timestamp_micros(),
        "{what}"
    );
}

/// Bounded readiness polling: ~30 s per phase, never a tight hammer loop.
async fn wait_until<F, Fut>(secs: u64, what: &str, mut pred: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if pred().await {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

// ─── One complete real flow ─────────────────────────────────────────────────

#[sqlx::test]
async fn real_server_and_worker_dns_management_flow(pool: PgPool) {
    let st = fixture("flow");
    // A genuine counting UDP DNS origin lets later cache tests verify effect
    // by real upstream hits, not merely by reported settings fields.
    let origin = CountingUpstream::start().await;
    let (base, ca_pem, _server_guard) = spawn_server(pool.clone()).await;
    let (list_base, list_ca, list_state, _list_guard) = start_list_server().await;

    // Real admin session + CSRF, bootstrap and scoped credential issuance.
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let mgmt_base = base.clone();
    let http = Http::new(base, &ca_pem, token, csrf);
    let hid = bootstrap_as(&http, "E2E household").await;
    let gid = create_gateway(&http, hid).await;
    let bearer = issue_cred(&http, hid, gid).await;

    // Admin PATCH creates the desired config; no policy route is touched.
    let mgmt_path = format!("/api/network/households/{hid}/dns/management");
    let list_url = format!("{list_base}/list");
    let (status, body) = http
        .patch(&mgmt_path, patch_with(0, desired_ops(&list_url)))
        .await;
    assert_eq!(status, 200, "PATCH failed: {body}");
    assert_eq!(body["changed"], true);
    assert_eq!(body["desired"]["config_version"], 1);
    let digest_v1 = body["desired"]["body_sha256"].as_str().unwrap().to_string();
    assert_eq!(digest_v1.len(), 64);
    // Server digest and the worker's typed mirror agree on the wire bytes.
    let desired_config: ManagementConfig =
        serde_json::from_value(body["desired"]["config"].clone()).unwrap();
    assert_eq!(digest_v1, config_digest(&desired_config));

    // Real worker: explicit credential file, options, CA (all owner-0600),
    // production fetcher/compiler, and the background coordinator loop.
    let published = published_at();
    let (server, worker) = start_worker(
        &st,
        hid,
        gid,
        published,
        &list_ca,
        &mgmt_base,
        &ca_pem,
        &bearer,
        origin.addr,
    )
    .await;
    worker.start(Arc::downgrade(&server));

    // Phase 1: read -> fetch -> compile -> persist -> publish -> report.
    wait_until(30, "first applied DNS answer", || async {
        blocked(&server, "managed.block.test.", false).await
    })
    .await;
    let state_v1 = server
        .management_state()
        .expect("no applied management state");
    assert_eq!(state_v1.config_version, 1);
    assert_eq!(state_v1.digest, digest_v1);
    assert!(state_v1.applied_at.is_some());
    assert!(
        blocked(&server, "managed.block.test.", true).await,
        "TCP answer"
    );
    assert!(!blocked(&server, "other.block.test.", false).await);
    // Operator catalog selected by the server config blocks the service domain.
    assert!(blocked(&server, "svc.block.test.", false).await);
    let install_status = server.status();
    assert_eq!(install_status.policy_revision, 2);
    assert_eq!(install_status.policy_published_at, published);

    // The server admitted the worker-generated status over its real HTTP+PG.
    let status_path = format!("/api/network/households/{hid}/dns/status");
    let (status, body) = http.get(&status_path).await;
    assert_eq!(status, 200, "status failed: {body}");
    let gateway = body["gateways"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["gateway_id"] == json!(gid.to_string()))
        .expect("no gateway status")
        .clone();
    assert_eq!(gateway["delivered_version"], 1);
    assert_eq!(gateway["reported_version"], 1);
    let applied = &gateway["status"]["applied"];
    assert_eq!(applied["config_version"], 1);
    assert_eq!(applied["body_sha256"], json!(digest_v1));
    assert!(applied["generation"].as_u64().unwrap() >= 1);
    assert!(applied["filter_generation"].as_u64().unwrap() >= 1);
    assert!(applied["filter_identity"].as_str().unwrap().len() <= 64);
    assert_same_instant(
        &applied["applied_at"],
        state_v1.applied_at.unwrap(),
        "reported applied_at differs from the worker bundle",
    );
    let sources = gateway["status"]["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["id"], "remote-list");
    assert_eq!(sources[0]["download"], "fresh");
    assert!(sources[0]["bytes"].as_u64().unwrap() > 0);
    let first_downloaded = sources[0]["downloaded_sha256"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(first_downloaded.len(), 64);
    // Downloaded list digest is independent of the applied config digest.
    assert_ne!(first_downloaded, digest_v1);

    // Phase 2: explicit manual refresh token (server-owned expires_at).
    *list_state.body.lock().unwrap() = b"changed.block.test\n".to_vec();
    let refresh_path = format!("/api/network/households/{hid}/dns/lists/remote-list/refresh");
    let (status, refresh) = http.post(&refresh_path, json!({})).await;
    assert_eq!(status, 200, "refresh failed: {refresh}");
    let refresh_seq = refresh["refresh_seq"].as_u64().unwrap();
    assert_eq!(refresh["config_version"], 1);
    let expires_at = json!(refresh["expires_at"].as_str().unwrap());
    wait_until(30, "refresh token visible to the worker", || {
        let http = &http;
        let bearer = bearer.clone();
        let expires_at = expires_at.clone();
        async move {
            let (code, read) = http.worker_read(&bearer, hid, gid).await;
            code == 200
                && read["pending_refreshes"].as_array().is_some_and(|pending| {
                    pending.iter().any(|p| {
                        p["source_id"] == json!("remote-list")
                            && p["refresh_seq"] == json!(refresh_seq)
                            && p["config_version"] == json!(1)
                            && p["expires_at"] == expires_at
                    })
                })
        }
    })
    .await;

    // The next coordinator cycle honours the force token; the integrator
    // recompiles the changed bytes into the next filter generation.
    wait_until(30, "changed DNS answer after refresh", || async {
        blocked(&server, "changed.block.test.", false).await
            && !blocked(&server, "managed.block.test.", false).await
    })
    .await;
    assert!(
        blocked(&server, "changed.block.test.", true).await,
        "TCP refresh"
    );

    let state_after_refresh = server.management_state().expect("applied state lost");
    assert_eq!(
        state_after_refresh.config_version, 1,
        "refresh must not bump config version"
    );
    assert_eq!(state_after_refresh.digest, digest_v1);
    assert_eq!(
        state_after_refresh.applied_at, state_v1.applied_at,
        "applied_at was freshened"
    );
    assert_eq!(state_after_refresh.receipts.len(), 1);
    assert_eq!(state_after_refresh.receipts[0].source_id, "remote-list");
    assert_eq!(state_after_refresh.receipts[0].refresh_seq, refresh_seq);
    assert_eq!(state_after_refresh.receipts[0].config_version, 1);
    let final_status = server.status();
    assert_eq!(final_status.policy_revision, install_status.policy_revision);
    assert_eq!(
        final_status.policy_published_at,
        install_status.policy_published_at
    );
    assert_eq!(
        final_status.bundle_generation,
        install_status.bundle_generation + 2,
        "one apply + one receipt commit"
    );

    // Server-side receipt row and honest downloaded-vs-applied reporting.
    // The worker reports in the same cycle that published the new answer, but
    // the HTTP report is a later step than the DNS swap, so wait for it.
    wait_until(30, "server records the first refresh ack", || {
        let pool = &pool;
        async move {
            sqlx::query_as::<_, (i64, i64, DateTime<Utc>)>(
                "SELECT refresh_seq, config_version, acked_at FROM network_dns_refresh_ack \
                 WHERE household_id = $1 AND gateway_id = $2 AND source_id = 'remote-list'",
            )
            .bind(hid)
            .bind(gid)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .is_some()
        }
    })
    .await;
    let ack: (i64, i64, DateTime<Utc>) = sqlx::query_as(
        "SELECT refresh_seq, config_version, acked_at FROM network_dns_refresh_ack \
         WHERE household_id = $1 AND gateway_id = $2 AND source_id = 'remote-list'",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ack.0 as u64, refresh_seq);
    assert_eq!(ack.1, 1);
    wait_until(30, "server reports the new downloaded digest", || async {
        let (code, body) = http.get(&status_path).await;
        if code != 200 {
            return false;
        }
        let gateways = body["gateways"].as_array().unwrap();
        gateways.iter().any(|g| {
            g["gateway_id"] == json!(gid.to_string())
                && g["status"]["sources"][0]["downloaded_sha256"].as_str()
                    != Some(first_downloaded.as_str())
        })
    })
    .await;
    let (status, body) = http.get(&status_path).await;
    assert_eq!(status, 200);
    let gw = body["gateways"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["gateway_id"] == json!(gid.to_string()))
        .unwrap();
    assert_eq!(gw["status"]["applied"]["config_version"], 1);
    assert_eq!(gw["status"]["applied"]["body_sha256"], json!(digest_v1));
    assert_same_instant(
        &gw["status"]["applied"]["applied_at"],
        state_v1.applied_at.unwrap(),
        "refresh freshened the server-reported applied_at",
    );
    let (code, read) = http.worker_read(&bearer, hid, gid).await;
    assert_eq!(code, 200);
    assert!(
        read["pending_refreshes"].as_array().unwrap().is_empty(),
        "acknowledged token must no longer be pending"
    );

    let second_downloaded = gw["status"]["sources"][0]["downloaded_sha256"]
        .as_str()
        .unwrap()
        .to_string();
    // Cache-view evidence captured BEFORE restart. The post-restart runtime
    // must rehydrate the managed fetcher with the same cache root and report
    // the same downloaded hash/fetched_at -- not merely serve bundle bytes.
    let before_restart = server
        .subscription_status()
        .expect("original runtime missing")
        .0
        .into_iter()
        .find(|source| source.id == "remote-list")
        .expect("no managed source before restart");

    // Clean shutdown, then an OFFLINE restart from the single bundle only.
    // The external config is rewritten; with no runtime attached the answer
    // can only come from the persisted bundle, never from a live provider.
    worker.shutdown().await;
    server.stop_shared().await;
    fs::write(&st.config, dns_config(0, 99, published, Some(origin.addr))).unwrap();
    let offline = DnsServer::start_durable(DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER_ID.to_owned(),
        config_path: Some(st.config.clone()),
        now: Utc::now(),
        hooks: None,
    })
    .await
    .unwrap();
    assert_eq!(offline.status(), final_status);
    assert_eq!(offline.management_state().unwrap(), state_after_refresh);
    assert!(offline.subscription_status().is_none());
    assert!(blocked(&offline, "changed.block.test.", false).await);
    assert!(!blocked(&offline, "managed.block.test.", false).await);
    offline.stop().await;

    // Post-restart phase: a NEW runtime/coordinator rehydrates the managed
    // sources from that same bundle. A refresh must be ACKed only after a
    // real download, and the downloaded bytes must change the DNS answer.
    let runtime2 = build_runtime_from_cache(&st);
    let options2 = ManagementOptions::load(&st.options).unwrap();
    let client2 = Arc::new(ManagementClient::new(&options2).unwrap());
    let worker2 = Arc::new(ManagementWorker::new(
        options2,
        client2,
        Some(runtime2.clone()),
    ));
    let online = DnsServer::start_durable_with_subscriptions(
        DurableOptions {
            state_path: st.state.clone(),
            worker_id: WORKER_ID.to_owned(),
            config_path: Some(st.config.clone()),
            now: Utc::now(),
            hooks: None,
        },
        Some(runtime2),
    )
    .await
    .unwrap();
    worker2.start(Arc::downgrade(&online));
    let restarted_state = online.management_state().unwrap();
    assert_eq!(
        restarted_state, state_after_refresh,
        "restart lost applied management state"
    );
    assert!(blocked(&online, "changed.block.test.", false).await);

    // Cache-view proof: the rehydrated managed fetcher reports the SAME
    // downloaded hash and fetched_at as before the restart, with no new
    // failure/quarantine. Bundle DNS alone would not catch cache loss.
    let after_restart = online
        .subscription_status()
        .expect("restarted runtime missing")
        .0
        .into_iter()
        .find(|source| source.id == "remote-list")
        .expect("managed fetcher was not rehydrated");
    assert_eq!(
        after_restart.content_version, before_restart.content_version,
        "restart lost the downloaded list hash"
    );
    assert_eq!(
        after_restart.fetched_at.map(|t| t.timestamp_micros()),
        before_restart.fetched_at.map(|t| t.timestamp_micros()),
        "restart lost the original fetched_at"
    );
    assert_eq!(
        after_restart
            .content_changed_at
            .map(|t| t.timestamp_micros()),
        before_restart
            .content_changed_at
            .map(|t| t.timestamp_micros())
    );
    assert_eq!(after_restart.bytes, before_restart.bytes);
    assert_eq!(after_restart.rule_count, before_restart.rule_count);
    assert_eq!(after_restart.download, before_restart.download);
    assert_eq!(after_restart.failure_count, before_restart.failure_count);
    assert!(!after_restart.stale, "rehydrated source reported stale");

    // Negative: the list cannot be fetched. One full 10 s poll cycle later,
    // no new ack and no new receipt may exist -- an ack without a fetch is the
    // residual restart bug this assertion is designed to catch.
    *list_state.fail.lock().unwrap() = true;
    sqlx::query(
        "UPDATE network_dns_refresh_request \
         SET requested_at = NOW() - INTERVAL '61 seconds' \
         WHERE household_id = $1 AND source_id = 'remote-list'",
    )
    .bind(hid)
    .execute(&pool)
    .await
    .unwrap();
    let (status, refresh_failed) = http.post(&refresh_path, json!({})).await;
    assert_eq!(status, 200, "refresh failed: {refresh_failed}");
    let seq_failed = refresh_failed["refresh_seq"].as_u64().unwrap();
    tokio::time::sleep(Duration::from_secs(12)).await;
    let ack_after_failure: Option<(i64, i64)> = sqlx::query_as(
        "SELECT refresh_seq, config_version FROM network_dns_refresh_ack \
         WHERE household_id = $1 AND gateway_id = $2 AND source_id = 'remote-list'",
    )
    .bind(hid)
    .bind(gid)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        ack_after_failure.is_none(),
        "server acked refresh_seq {seq_failed} with no successful fetch: {ack_after_failure:?}"
    );
    let state_after_failure = online.management_state().unwrap();
    assert_eq!(state_after_failure.receipts.len(), 1);
    assert_eq!(state_after_failure.receipts[0].refresh_seq, refresh_seq);
    assert!(blocked(&online, "changed.block.test.", false).await);

    // Positive: restore the list with different bytes; the next cycle fetches,
    // recompiles, publishes and only then reports/acks.
    *list_state.body.lock().unwrap() = b"other.block.test\n".to_vec();
    *list_state.fail.lock().unwrap() = false;
    sqlx::query(
        "UPDATE network_dns_refresh_request \
         SET requested_at = NOW() - INTERVAL '61 seconds' \
         WHERE household_id = $1 AND source_id = 'remote-list'",
    )
    .bind(hid)
    .execute(&pool)
    .await
    .unwrap();
    let (status, refresh_ok) = http.post(&refresh_path, json!({})).await;
    assert_eq!(status, 200, "refresh failed: {refresh_ok}");
    let seq_ok = refresh_ok["refresh_seq"].as_u64().unwrap();
    wait_until(30, "post-restart fetch changes the DNS answer", || async {
        blocked(&online, "other.block.test.", false).await
            && !blocked(&online, "changed.block.test.", false).await
    })
    .await;
    assert!(
        blocked(&online, "other.block.test.", true).await,
        "post-restart TCP answer"
    );
    wait_until(30, "server records the post-restart refresh ack", || {
        let pool = &pool;
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT refresh_seq FROM network_dns_refresh_ack \
                 WHERE household_id = $1 AND gateway_id = $2 AND source_id = 'remote-list'",
            )
            .bind(hid)
            .bind(gid)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
                == Some(seq_ok as i64)
        }
    })
    .await;
    let ack_after_fetch: (i64, i64) = sqlx::query_as(
        "SELECT refresh_seq, config_version FROM network_dns_refresh_ack \
         WHERE household_id = $1 AND gateway_id = $2 AND source_id = 'remote-list'",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ack_after_fetch.0 as u64, seq_ok);
    assert_eq!(ack_after_fetch.1, 1);
    let state_after_fetch = online.management_state().unwrap();
    assert_eq!(state_after_fetch.config_version, 1);
    assert_eq!(state_after_fetch.digest, digest_v1);
    assert_eq!(state_after_fetch.applied_at, state_v1.applied_at);
    assert_eq!(state_after_fetch.receipts.len(), 1);
    assert_eq!(state_after_fetch.receipts[0].refresh_seq, seq_ok);
    wait_until(
        30,
        "post-restart downloaded digest reaches the server",
        || async {
            let (code, body) = http.get(&status_path).await;
            if code != 200 {
                return false;
            }
            body["gateways"].as_array().unwrap().iter().any(|g| {
                g["gateway_id"] == json!(gid.to_string())
                    && g["status"]["sources"][0]["downloaded_sha256"].as_str()
                        != Some(second_downloaded.as_str())
            })
        },
    )
    .await;

    // ── Phase 6: real desired runtime settings applied by the worker ─────────
    // The single current config carries ONLY the supported cache/deny fields;
    // policy revision, publication age and local operator fields stay untouched.
    let runtime = json!({
        "cache": {
            "enabled": true,
            "max_entries": 64,
            "positive_min_ttl_secs": 60,
            "positive_max_ttl_secs": 60,
            "negative_min_ttl_secs": null,
            "negative_max_ttl_secs": null
        },
        "deny": { "mode": "refused" }
    });
    let (status, body) = http
        .patch(
            &mgmt_path,
            patch_with(
                1,
                vec![json!({"op":"set_runtime_settings","runtime":runtime})],
            ),
        )
        .await;
    assert_eq!(status, 200, "settings PATCH failed: {body}");
    assert!(body["desired"].get("schema_version").is_none());
    assert_eq!(
        body["desired"]["config"]["runtime"]["cache"]["max_entries"],
        64
    );
    let digest_current = body["desired"]["body_sha256"].as_str().unwrap().to_owned();
    wait_until(30, "worker reports the applied settings", || {
        let online = &online;
        let expected = digest_current.clone();
        async move {
            online
                .management_state()
                .is_some_and(|state| state.config_version == 2 && state.digest == expected)
        }
    })
    .await;
    let applied_settings = online.management_state().unwrap();
    let status_after_settings = online.status();
    assert_eq!(
        status_after_settings.policy_revision, install_status.policy_revision,
        "settings changed the policy revision"
    );
    assert_eq!(
        status_after_settings.policy_published_at, install_status.policy_published_at,
        "settings freshened the policy publication time"
    );
    assert_eq!(
        online.local_config().cache.max_entries,
        64,
        "settings were not persisted in the bundle"
    );
    // A NEW settings apply legitimately records a new applied time; what must
    // never freshen is the policy publication age or a cached body's age.
    assert!(applied_settings.applied_at >= state_after_fetch.applied_at);

    // Effect, not just fields: two UDP and two TCP queries of a fresh name
    // produce exactly ONE origin hit because the maintained cache answers the
    // second query on each transport path.
    let before_hits = origin.hits();
    for tcp in [false, true] {
        for _ in 0..2 {
            assert!(answered(&online, "cached.origin.test.", tcp).await);
        }
    }
    assert_eq!(
        origin.hits() - before_hits,
        1,
        "cache did not collapse repeated forwarded queries"
    );

    // A cache clear targets the CURRENT cache only: no settings/policy change,
    // no generation bump, no entries count, and a real new origin hit follows.
    let generation_before_clear = online.status().bundle_generation;
    let clear_path = format!("/api/network/households/{hid}/dns/cache/clear");
    let (status, clear) = http
        .post(&clear_path, json!({"expected_config_version": 2}))
        .await;
    assert_eq!(status, 200, "clear request failed: {clear}");
    assert_eq!(clear["clear_seq"], 1);
    assert!(clear.get("entries_count").is_none());
    wait_until(30, "worker acknowledges the delivered clear", || {
        let http = &http;
        let status_path = status_path.clone();
        async move {
            let (code, body) = http.get(&status_path).await;
            code == 200
                && body["gateways"].as_array().is_some_and(|gateways| {
                    gateways.iter().any(|gateway| {
                        gateway["gateway_id"] == json!(gid.to_string())
                            && gateway["cache_clear"]["acked_at"].is_string()
                            && gateway["cache_clear"]["clear_seq"] == json!(1)
                    })
                })
        }
    })
    .await;
    let after_clear = online.status();
    assert_eq!(
        after_clear.bundle_generation, generation_before_clear,
        "cache clear bumped the bundle generation"
    );
    assert_eq!(after_clear.policy_revision, install_status.policy_revision);
    assert_eq!(
        after_clear.policy_published_at,
        install_status.policy_published_at
    );
    let state_after_clear = online.management_state().unwrap();
    assert_eq!(state_after_clear.config_version, 2);
    assert_eq!(state_after_clear.digest, digest_current);
    assert_eq!(state_after_clear.applied_at, applied_settings.applied_at);
    let hits_before_query = origin.hits();
    assert!(answered(&online, "cached.origin.test.", false).await);
    assert_eq!(
        origin.hits() - hits_before_query,
        1,
        "clear did not evict the cache"
    );
    assert!(answered(&online, "cached.origin.test.", true).await);
    assert_eq!(
        origin.hits(),
        hits_before_query + 1,
        "in-flight repopulation was not observed as a cache hit"
    );

    // Disabling the cache is an actual settings change, not a reported field:
    // each query now reaches the origin.
    let mut disabled = runtime.clone();
    disabled["cache"]["enabled"] = json!(false);
    let (status, body) = http
        .patch(
            &mgmt_path,
            patch_with(
                2,
                vec![json!({"op":"set_runtime_settings","runtime":disabled})],
            ),
        )
        .await;
    assert_eq!(status, 200, "disable PATCH failed: {body}");
    let digest_disabled = body["desired"]["body_sha256"].as_str().unwrap().to_owned();
    wait_until(30, "worker applies the disabled cache", || {
        let online = &online;
        let expected = digest_disabled.clone();
        async move {
            online
                .management_state()
                .is_some_and(|state| state.config_version == 3 && state.digest == expected)
        }
    })
    .await;
    let hits_before_disabled = origin.hits();
    for tcp in [false, true] {
        assert!(answered(&online, "cached.origin.test.", tcp).await);
        assert!(answered(&online, "cached.origin.test.", tcp).await);
    }
    assert_eq!(
        origin.hits() - hits_before_disabled,
        4,
        "a disabled cache still answered from cache"
    );

    worker2.shutdown().await;
    online.stop_shared().await;
}

/// A new cache-clear cycle retires the old delivery/ack cascade. When the next
/// desired version then fails to apply, the worker must not resend the cached
/// ack from the retired cycle: the server would reject it with 409 and roll
/// back the entire status report on every poll until a successful apply or a
/// restart. This drives the real worker against the real router and PostgreSQL
/// and proves the report is accepted, the apply error is visible, no stale ack
/// is recorded and the previously applied last-known-good bundle is untouched.
#[sqlx::test]
async fn stale_clear_ack_is_not_resent_after_new_cycle_and_failed_apply(pool: PgPool) {
    let st = fixture("stale-ack");
    let origin = CountingUpstream::start().await;
    let (base, ca_pem, _server_guard) = spawn_server(pool.clone()).await;
    let (list_base, list_ca, list_state, _list_guard) = start_list_server().await;

    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let mgmt_base = base.clone();
    let http = Http::new(base, &ca_pem, token, csrf);
    let hid = bootstrap_as(&http, "E2E household").await;
    let gid = create_gateway(&http, hid).await;
    let bearer = issue_cred(&http, hid, gid).await;

    let mgmt_path = format!("/api/network/households/{hid}/dns/management");
    let status_path = format!("/api/network/households/{hid}/dns/status");
    let clear_path = format!("/api/network/households/{hid}/dns/cache/clear");
    let list_url = format!("{list_base}/list");

    // Desired v1 carries one real, fetchable source.
    let (status, body) = http
        .patch(&mgmt_path, patch_with(0, desired_ops(&list_url)))
        .await;
    assert_eq!(status, 200, "PATCH v1 failed: {body}");
    let digest_v1 = body["desired"]["body_sha256"].as_str().unwrap().to_owned();

    let published = published_at();
    let (server, worker) = start_worker(
        &st,
        hid,
        gid,
        published,
        &list_ca,
        &mgmt_base,
        &ca_pem,
        &bearer,
        origin.addr,
    )
    .await;
    worker.start(Arc::downgrade(&server));

    wait_until(30, "v1 applied", || async {
        server
            .management_state()
            .is_some_and(|state| state.config_version == 1)
    })
    .await;
    let lkg = server.management_state().unwrap();
    let lkg_applied_at = lkg.applied_at.clone().expect("v1 applied_at");
    assert_eq!(lkg.digest, digest_v1);

    // First cycle: the worker really clears the live cache and acks seq 1.
    let (status, clear) = http
        .post(&clear_path, json!({"expected_config_version": 1}))
        .await;
    assert_eq!(status, 200, "clear v1 failed: {clear}");
    assert_eq!(clear["clear_seq"], 1);
    wait_until(30, "seq 1 acked", || {
        let http = &http;
        let status_path = status_path.clone();
        async move {
            let (code, view) = http.get(&status_path).await;
            code == 200
                && view["gateways"].as_array().is_some_and(|gateways| {
                    gateways.iter().any(|gateway| {
                        gateway["gateway_id"] == json!(gid.to_string())
                            && gateway["cache_clear"]["clear_seq"] == json!(1)
                            && gateway["cache_clear"]["acked_at"].is_string()
                    })
                })
        }
    })
    .await;

    // New desired version with a brand-new source, then a new clear cycle.
    // The new source has no cached last-good, so making the list server fail
    // forces apply of v2 to fail after a real fetch attempt.
    *list_state.fail.lock().unwrap() = true;
    let failing_ops = vec![json!({"op":"add_list", "source": {
        "id": "failing-list",
        "url": list_url,
        "format": "hosts",
        "enabled": true,
        "interval_secs": 300,
        "max_stale_secs": 3600,
        "metadata": {"title":"E2E failing list","publisher":"Operator","license":"asserted"}
    }})];
    let (status, body) = http.patch(&mgmt_path, patch_with(1, failing_ops)).await;
    assert_eq!(status, 200, "PATCH v2 failed: {body}");
    assert_eq!(body["desired"]["config_version"], 2);
    let digest_v2 = body["desired"]["body_sha256"].as_str().unwrap().to_owned();
    assert_ne!(digest_v2, digest_v1);

    // Test-only: skip the real 60 s cooldown so the new cycle starts now.
    sqlx::query(
        "UPDATE network_dns_cache_clear_request \
         SET requested_at = NOW() - INTERVAL '61 seconds' WHERE household_id = $1",
    )
    .bind(hid)
    .execute(&pool)
    .await
    .unwrap();
    let (status, clear2) = http
        .post(&clear_path, json!({"expected_config_version": 2}))
        .await;
    assert_eq!(status, 200, "clear v2 failed: {clear2}");
    assert_eq!(clear2["clear_seq"], 2);

    // The worker now reports v2 without applying it. With no stale ack from
    // the retired seq-1 cycle the server accepts the whole report transaction.
    wait_until(30, "v2 reported with v1 still applied", || {
        let http = &http;
        let status_path = status_path.clone();
        async move {
            let (code, view) = http.get(&status_path).await;
            code == 200
                && view["gateways"].as_array().is_some_and(|gateways| {
                    gateways.iter().any(|gateway| {
                        gateway["gateway_id"] == json!(gid.to_string())
                            && gateway["status"]["config_version"] == json!(2)
                            && gateway["status"]["applied"]["config_version"] == json!(1)
                    })
                })
        }
    })
    .await;

    let (_, view) = http.get(&status_path).await;
    let gateway = view["gateways"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["gateway_id"] == json!(gid.to_string()))
        .unwrap();
    // Status accepted for v2, the apply error is visible, and the old applied
    // bundle is still the last known good. The server pins reported_version to
    // the applied version, so it must remain 1 while the report itself is v2.
    assert_eq!(gateway["status"]["config_version"], json!(2));
    assert_eq!(gateway["reported_version"], json!(1));
    let applied = &gateway["status"]["applied"];
    assert_eq!(applied["config_version"], json!(1));
    assert_eq!(applied["body_sha256"], json!(digest_v1));
    assert_same_instant(
        &applied["applied_at"],
        lkg_applied_at,
        "reported LKG applied_at changed",
    );
    assert!(
        applied["last_error"]
            .as_str()
            .is_some_and(|e| !e.is_empty()),
        "failed-apply error was not visible in the accepted status"
    );
    // The new cycle carries no ack: the retired seq-1 ack was never resent.
    assert_eq!(gateway["cache_clear"]["clear_seq"], json!(2));
    assert!(
        gateway["cache_clear"]["acked_at"].is_null(),
        "stale ack from the retired cycle was accepted"
    );

    let state = server.management_state().unwrap();
    assert_eq!(state.config_version, 1);
    assert_eq!(state.digest, digest_v1);
    assert_eq!(state.applied_at, lkg.applied_at);

    *list_state.fail.lock().unwrap() = false;
    worker.shutdown().await;
    server.stop_shared().await;
}

// ─── Full pre-0085 -> 0085 -> 0086 upgrade E2E ───────────────────────────────
//
// A real pre-migration database holds an applied prior-shape bundle at version
// V with the old three-field digest. The operator evidence scripts are fed as
// their exact SQL text (only the psql meta-command line is removed), and 0085
// plus 0086 run through the real SQLx migrator so the ledger checksums are
// genuine. After the offline converter runs, the real server/worker deliver and
// apply V+1 once, and a durable restart recovers the current bundle.

const UPGRADE_PRIOR_BODY: &str = r#"{"sources":[],"catalog":null,"selected_services":[]}"#;
/// Byte-exact result of 0085 appending its default runtime to the prior body.
const UPGRADE_CURRENT_BODY: &str = r#"{"sources":[],"catalog":null,"selected_services":[],"runtime":{"cache":{"enabled":true,"max_entries":4096,"positive_min_ttl_secs":null,"positive_max_ttl_secs":null,"negative_min_ttl_secs":null,"negative_max_ttl_secs":null},"deny":{"mode":"nxdomain"}}}"#;
const UPGRADE_NEXT_BODY: &str = r#"{"sources":[],"catalog":null,"selected_services":[],"runtime":{"cache":{"enabled":false,"max_entries":4096,"positive_min_ttl_secs":null,"positive_max_ttl_secs":null,"negative_min_ttl_secs":null,"negative_max_ttl_secs":null},"deny":{"mode":"nxdomain"}}}"#;
const UPGRADE_VERSION: i64 = 7;
const UPGRADE_POLICY_REVISION: u64 = 4;

/// Strip ONLY the psql meta-command; every SQL statement stays byte-exact.
fn upgrade_sql(script: &str) -> String {
    script
        .lines()
        .filter(|line| !line.trim_start().starts_with("\\set "))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A synthetic prior-shape applied bundle built from the exact production
/// config/policy types. Counters, private-file shape and the old three-field
/// digest are coherent; no real household or host bundle is copied.
fn upgrade_prior_bundle(published: DateTime<Utc>, d_old: &str) -> Vec<u8> {
    let raw = dns_config(0, UPGRADE_POLICY_REVISION, published, None);
    let config = Config::parse(&raw).unwrap();
    let policy_value = serde_json::to_value(&config.policy_at(published)).unwrap();
    let revision = policy_value["revision"].as_u64().unwrap();
    let household = config.household_id.clone();
    let generation = 12u64;
    let envelope = json!({
        "schema": 1u32,
        "household_id": household,
        "worker_id": "upgrade-e2e-worker",
        "highwater": generation,
        "policy": {
            "config": serde_json::to_value(&config).unwrap(),
            "policy": policy_value,
            "filter": Value::Null,
            "generation": generation,
            "policy_highwater": revision,
            "filter_generation": 0u64,
            "management": {
                "config_version": UPGRADE_VERSION as u64,
                "digest": d_old,
                "config": {
                    "sources": [],
                    "catalog": Value::Null,
                    "selected_services": []
                },
                "filter_identity": "upgrade-e2e",
                "receipts": [],
                "receipt_expiry": {},
                "schema_version": 1,
                "applied_at": published,
                "last_error": Value::Null
            }
        },
        "saved_at": published
    });
    serde_json::to_vec(&envelope).unwrap()
}

/// Seed a coherent pre-0085 household: desired V with the old three-field body
/// and digest, plus delivery/status/pins and policy/refresh/clear/audit ledger
/// evidence that neither 0085/0086 nor the worker may reset.
async fn seed_upgrade_db(pool: &PgPool, name: &str, d_old: &str) -> (Uuid, Uuid, Uuid) {
    let actor = insert_user(pool, &format!("{name}-actor"), "admin").await;
    let hid: Uuid =
        sqlx::query_scalar("INSERT INTO network_households (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(pool)
            .await
            .unwrap();
    let gid: Uuid = sqlx::query_scalar(
        "INSERT INTO network_gateways (household_id, kind, label) VALUES ($1, 'dns', $2) RETURNING id",
    )
    .bind(hid)
    .bind(format!("{name}-dns"))
    .fetch_one(pool)
    .await
    .unwrap();
    let secret_hash = digest(format!("secret-{name}").as_bytes());
    let cid: Uuid = sqlx::query_scalar(
        "INSERT INTO network_gateway_credentials \
         (household_id, gateway_id, kind, audience, allowed_commands, secret_hash, expires_at) \
         VALUES ($1, $2, 'dns', 'vantyr-gateway-worker', \
                 ARRAY['heartbeat','read_dns_management','report_dns_status']::text[], \
                 $3, NOW() + INTERVAL '1 hour') RETURNING id",
    )
    .bind(hid)
    .bind(gid)
    .bind(secret_hash.as_str())
    .fetch_one(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO network_dns_management_config \
         (household_id, config_version, schema_version, body, body_sha256, \
          created_at, updated_at, updated_by) \
         VALUES ($1, $2, 1, $3, $4, '2026-01-01T00:00:00+00', '2026-01-01T00:00:00+00', $5)",
    )
    .bind(hid)
    .bind(UPGRADE_VERSION)
    .bind(UPGRADE_PRIOR_BODY.as_bytes())
    .bind(d_old)
    .bind(actor)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_delivery \
         (household_id, gateway_id, kind, config_version, body_sha256, delivered_at) \
         VALUES ($1, $2, 'dns', $3, $4, '2026-01-02T00:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .bind(d_old)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_gateway_state \
         (household_id, gateway_id, kind, delivered_version, delivered_sha256, \
          reported_version, reported_sha256, reported_at, updated_at) \
         VALUES ($1, $2, 'dns', $3, $4, $3, $4, \
                 '2026-01-03T00:00:00+00', '2026-01-03T00:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .bind(d_old)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_status \
         (household_id, gateway_id, credential_id, report_id, config_version, body_sha256, \
          reported_at, received_at, applied_version, applied_at, generation, \
          filter_generation, filter_identity, sources) \
         VALUES ($1, $2, $3, $4, $5, $6, \
                 '2026-01-04T00:00:00+00', '2026-01-04T00:01:00+00', $5, \
                 '2026-01-04T00:02:00+00', 4, 2, 'id-2', '[]'::jsonb)",
    )
    .bind(hid)
    .bind(gid)
    .bind(cid)
    .bind(Uuid::new_v4())
    .bind(UPGRADE_VERSION)
    .bind(d_old)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO network_dns_refresh_request \
         (household_id, source_id, refresh_seq, config_version, requested_at, expires_at, requested_by) \
         VALUES ($1, 'src1', 1, $2, '2026-01-05T00:00:00+00', '2026-01-06T00:00:00+00', $3)",
    )
    .bind(hid)
    .bind(UPGRADE_VERSION)
    .bind(actor)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_refresh_delivery \
         (household_id, gateway_id, source_id, refresh_seq, config_version, delivered_at) \
         VALUES ($1, $2, 'src1', 1, $3, '2026-01-05T01:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_refresh_ack \
         (household_id, gateway_id, source_id, refresh_seq, config_version, acked_at) \
         VALUES ($1, $2, 'src1', 1, $3, '2026-01-05T02:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO network_dns_cache_clear_request \
         (household_id, clear_seq, config_version, requested_at, expires_at, requested_by) \
         VALUES ($1, 1, $2, '2026-01-07T00:00:00+00', '2026-01-08T00:00:00+00', $3)",
    )
    .bind(hid)
    .bind(UPGRADE_VERSION)
    .bind(actor)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_cache_clear_delivery \
         (household_id, gateway_id, kind, clear_seq, config_version, requested_at, delivered_at) \
         VALUES ($1, $2, 'dns', 1, $3, '2026-01-07T00:00:00+00', '2026-01-07T01:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_dns_cache_clear_ack \
         (household_id, gateway_id, clear_seq, config_version, attempted_at, acked_at) \
         VALUES ($1, $2, 1, $3, '2026-01-07T02:00:00+00', '2026-01-07T03:00:00+00')",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .execute(pool)
    .await
    .unwrap();

    let policy_body = b"upgrade-policy-body";
    let policy_digest = digest(policy_body);
    sqlx::query(
        "INSERT INTO network_policies \
         (household_id, revision, schema_version, body, body_sha256, source_kind, published_at, published_by) \
         VALUES ($1, 1, 1, $2, $3, 'publish', '2026-01-09T00:00:00+00', $4)",
    )
    .bind(hid)
    .bind(policy_body.as_slice())
    .bind(policy_digest.as_str())
    .bind(actor)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_gateway_desired_policy \
         (household_id, gateway_id, kind, revision, assigned_at, assigned_by) \
         VALUES ($1, $2, 'dns', 1, '2026-01-09T00:00:00+00', $3)",
    )
    .bind(hid)
    .bind(gid)
    .bind(actor)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_audit (household_id, actor, action, detail, ts) \
         VALUES ($1, 'upgrade-test', 'dns.management.save', '{}'::jsonb, '2026-01-10T00:00:00+00')",
    )
    .bind(hid)
    .execute(pool)
    .await
    .unwrap();

    (hid, gid, actor)
}

#[sqlx::test(migrations = false)]
async fn full_upgrade_0085_0086_preserves_evidence_and_applies_once(pool: PgPool) {
    // Two-step migrator: everything below 0085, with genuine SQLx checksums.
    let all = super::dns_management_tests::migrate_before_version(&pool, 85).await;
    let d_old = digest(UPGRADE_PRIOR_BODY.as_bytes());
    let d_new = digest(UPGRADE_CURRENT_BODY.as_bytes());
    let (hid, gid, actor) = seed_upgrade_db(&pool, "upgrade", &d_old).await;
    let published = published_at();

    // Synthetic prior-shape applied bundle on disk, owner-private.
    let st = fixture("upgrade");
    let prior_bytes = upgrade_prior_bundle(published, &d_old);
    fs::write(
        &st.config,
        dns_config(0, UPGRADE_POLICY_REVISION, published, None),
    )
    .unwrap();
    fs::write(&st.state, &prior_bytes).unwrap();
    #[cfg(unix)]
    {
        private(&st.config);
        private(&st.state);
    }

    // The strict current worker refuses the old bundle and leaves the bytes
    // untouched: no runtime legacy reader or on-load repair exists.
    let rejected = DnsServer::start_durable(DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER_ID.to_owned(),
        config_path: Some(st.config.clone()),
        now: published,
        hooks: None,
    })
    .await;
    assert!(
        rejected.is_err(),
        "strict worker accepted a prior-shape bundle"
    );
    assert_eq!(
        fs::read(&st.state).unwrap(),
        prior_bytes,
        "rejecting the old bundle mutated it on disk"
    );

    // Explicit operator evidence snapshot, then the real 0085 + 0086 migrations.
    let snapshot_sql = upgrade_sql(include_str!(
        "../../scripts/offline0085_evidence_snapshot.sql"
    ));
    // Audited: the SQL is the checked-in operator script with only a psql
    // meta-command removed; no runtime or user input is interpolated.
    sqlx::raw_sql(sqlx::AssertSqlSafe(snapshot_sql))
        .execute(&pool)
        .await
        .expect("offline evidence snapshot must succeed before 0085");
    let snap: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT kind, original_digest, converted_digest, config_version \
         FROM operator_offline0085_dns_evidence_snapshot \
         WHERE household_id = $1 ORDER BY kind",
    )
    .bind(hid)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!snap.is_empty(), "snapshot captured no evidence");
    for (kind, original, converted, version) in &snap {
        assert_eq!(original, &d_old, "{kind} original digest was not preserved");
        assert_eq!(converted, &d_new, "{kind} converted digest was miscomputed");
        assert_eq!(*version, UPGRADE_VERSION, "{kind} snapshot version");
    }

    all.run(&pool)
        .await
        .expect("0085 + 0086 must apply with genuine ledger checksums");
    let desired: (i64, Vec<u8>, String) = sqlx::query_as(
        "SELECT config_version, body, body_sha256 \
         FROM network_dns_management_config WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(desired.0, UPGRADE_VERSION + 1, "0086 did not bump V to V+1");
    assert_eq!(
        desired.1,
        UPGRADE_CURRENT_BODY.as_bytes(),
        "0085 body changed"
    );
    assert_eq!(desired.2, d_new, "0085 converted digest changed");

    // Restore the original evidence at V, after verifying V+1/Dnew.
    let restore_sql = upgrade_sql(include_str!(
        "../../scripts/offline0085_evidence_restore.sql"
    ));
    // Audited: the SQL is the checked-in operator script with only a psql
    // meta-command removed; no runtime or user input is interpolated.
    sqlx::raw_sql(sqlx::AssertSqlSafe(restore_sql))
        .execute(&pool)
        .await
        .expect("offline evidence restore must succeed after 0085 + 0086");
    for (table, column) in [
        ("network_dns_delivery", "body_sha256"),
        ("network_dns_gateway_state", "delivered_sha256"),
        ("network_dns_gateway_state", "reported_sha256"),
        ("network_dns_status", "body_sha256"),
    ] {
        // Audited: table/column come from the fixed local list below, never
        // from input; only identifiers are interpolated.
        let restored: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT {column} FROM {table} WHERE household_id = $1 AND gateway_id = $2 LIMIT 1"
        )))
        .bind(hid)
        .bind(gid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(restored, d_old, "{table}.{column} was not restored to V");
    }
    let delivered_version: i64 = sqlx::query_scalar(
        "SELECT delivered_version FROM network_dns_gateway_state \
         WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(delivered_version, UPGRADE_VERSION, "pins were advanced");
    let before = super::dns_management_tests::evidence_snapshot(&pool, hid).await;

    // Offline converter: check is read-only; apply keeps an exact private backup.
    let backup = st.state.with_extension("bak");
    family_dns::bundle_convert::check_file(&st.state)
        .expect("prior bundle must be convertible in a dry run");
    assert_eq!(
        fs::read(&st.state).unwrap(),
        prior_bytes,
        "check_file mutated source"
    );
    assert!(!backup.exists(), "check_file created a backup");
    let converted =
        family_dns::bundle_convert::apply_file(&st.state).expect("prior bundle must apply offline");
    assert_eq!(converted.source_schema, 1);
    assert_eq!(converted.source_config_version, UPGRADE_VERSION as u64);
    assert_eq!(
        fs::read(&backup).unwrap(),
        prior_bytes,
        "backup is not byte-exact"
    );
    let converted_bytes = fs::read(&st.state).unwrap();
    assert_ne!(
        converted_bytes, prior_bytes,
        "apply_file did not convert the bundle"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&st.state, &backup] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600,
                "converted bundle or backup is not private"
            );
        }
    }
    assert!(
        family_dns::bundle_convert::check_file(&st.state).is_err(),
        "conversion is not one-shot"
    );

    // Real server + worker over the real router/PG and verified loopback TLS.
    let (base, ca_pem, _server_guard) = spawn_server(pool.clone()).await;
    let origin = CountingUpstream::start().await;
    let user = insert_user(&pool, "upgrade-admin", "admin").await;
    // The household was seeded directly below 0085, so it has no bootstrap
    // grant. Give this admin the same explicit network_admin grant bootstrap
    // would have created; no platform role implies it.
    {
        let mut conn = pool.acquire().await.unwrap();
        super::db::insert_grant_on_conn(
            &mut conn,
            hid,
            user,
            super::authz::NetworkGrant::Admin,
            user,
        )
        .await
        .unwrap();
    }
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(base.clone(), &ca_pem, token, csrf);
    let bearer = issue_cred(&http, hid, gid).await;
    let (server, worker) = start_worker(
        &st,
        hid,
        gid,
        published,
        "unused-list-ca",
        &base,
        &ca_pem,
        &bearer,
        origin.addr,
    )
    .await;
    worker.start(Arc::downgrade(&server));
    wait_until(30, "worker applies the repaired V+1", || async {
        server.management_state().is_some_and(|state| {
            state.config_version == (UPGRADE_VERSION + 1) as u64 && state.digest == d_new
        })
    })
    .await;
    let applied = server.management_state().unwrap();
    assert!(
        applied.applied_at.is_some(),
        "no applied_at on the repaired bundle"
    );

    // Truthful worker status ack, delivered/reported/applied all at V+1/Dnew.
    let status_path = format!("/api/network/households/{hid}/dns/status");
    let expected = (UPGRADE_VERSION + 1) as u64;
    let d_new_json = json!(d_new);
    wait_until(30, "server records the repaired apply", || {
        let http = &http;
        let status_path = status_path.clone();
        let d_new_json = d_new_json.clone();
        async move {
            let (code, view) = http.get(&status_path).await;
            code == 200
                && view["gateways"].as_array().is_some_and(|gateways| {
                    gateways.iter().any(|gateway| {
                        gateway["gateway_id"] == json!(gid.to_string())
                            && gateway["delivered_version"] == json!(expected)
                            && gateway["reported_version"] == json!(expected)
                            && gateway["status"]["config_version"] == json!(expected)
                            && gateway["status"]["applied"]["config_version"] == json!(expected)
                            && gateway["status"]["applied"]["body_sha256"] == d_new_json
                    })
                })
        }
    })
    .await;
    let deliveries: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM network_dns_delivery \
         WHERE household_id = $1 AND gateway_id = $2 AND config_version = $3",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION + 1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deliveries, 1, "V+1 was delivered more than once");

    // Next poll is idempotent: no re-apply, no new delivery, no generation bump.
    let status_before = server.status();
    tokio::time::sleep(Duration::from_secs(12)).await;
    assert_eq!(
        server.management_state().unwrap(),
        applied,
        "poll re-applied V+1"
    );
    assert_eq!(
        server.status(),
        status_before,
        "poll bumped the bundle generation"
    );
    let deliveries_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM network_dns_delivery \
         WHERE household_id = $1 AND gateway_id = $2 AND config_version = $3",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION + 1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deliveries_after, 1, "next poll created a second delivery");

    // Policy revision/history/CAS space and audit were never reset; the old V
    // status row still carries its original digest and generation counters.
    let after = super::dns_management_tests::evidence_snapshot(&pool, hid).await;
    assert_eq!(
        after["policies"], before["policies"],
        "policy history was reset"
    );
    assert_eq!(
        after["desired_policy"], before["desired_policy"],
        "assignment was reset"
    );
    assert_eq!(after["audit"], before["audit"], "audit evidence was reset");
    let old: (String, i64, i64) = sqlx::query_as(
        "SELECT body_sha256, generation, filter_generation FROM network_dns_status \
         WHERE household_id = $1 AND gateway_id = $2 AND config_version = $3",
    )
    .bind(hid)
    .bind(gid)
    .bind(UPGRADE_VERSION)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(old.0, d_old, "old V status digest was rewritten");
    assert_eq!(old.1, 4, "old V bundle generation was reset");
    assert_eq!(old.2, 2, "old V filter generation was reset");

    // Durable restart from the single converted bundle, with a stale external
    // config file, recovers the exact applied state and status.
    worker.shutdown().await;
    server.stop_shared().await;
    fs::write(&st.config, dns_config(0, 99, published, None)).unwrap();
    let recovered = DnsServer::start_durable(DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER_ID.to_owned(),
        config_path: Some(st.config.clone()),
        now: Utc::now(),
        hooks: None,
    })
    .await
    .expect("converted bundle must recover after restart");
    assert_eq!(
        recovered.management_state().unwrap(),
        applied,
        "restart lost V+1"
    );
    assert_eq!(recovered.status(), status_before, "restart changed status");

    // CAS semantics survive the upgrade: V and V+1 are stale, V+2 is admitted.
    let next_digest = digest(UPGRADE_NEXT_BODY.as_bytes());
    {
        let mut conn = pool.acquire().await.unwrap();
        assert!(
            !super::dns_management_db::upsert_desired_on_conn(
                &mut conn,
                hid,
                UPGRADE_VERSION,
                UPGRADE_NEXT_BODY.as_bytes(),
                &next_digest,
                Utc::now(),
                actor,
            )
            .await
            .unwrap(),
            "pre-upgrade V is still a writable CAS base"
        );
        assert!(
            !super::dns_management_db::upsert_desired_on_conn(
                &mut conn,
                hid,
                UPGRADE_VERSION + 1,
                UPGRADE_NEXT_BODY.as_bytes(),
                &next_digest,
                Utc::now(),
                actor,
            )
            .await
            .unwrap(),
            "current V+1 is a writable CAS base"
        );
        assert!(
            super::dns_management_db::upsert_desired_on_conn(
                &mut conn,
                hid,
                UPGRADE_VERSION + 2,
                UPGRADE_NEXT_BODY.as_bytes(),
                &next_digest,
                Utc::now(),
                actor,
            )
            .await
            .unwrap(),
            "one version above V+1 must be admitted"
        );
    }
    let after_cas: i64 = sqlx::query_scalar(
        "SELECT config_version FROM network_dns_management_config WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after_cas, UPGRADE_VERSION + 2);

    recovered.stop().await;
}
