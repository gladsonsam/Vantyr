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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::Listener;
use axum::Router;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use family_dns::{
    config_digest, DnsServer, DurableOptions, FormatValidator, ManagementClient, ManagementConfig,
    ManagementOptions, ManagementWorker, SubscriptionRuntime, SubscriptionSettings,
};
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::{Name as DnsName, RecordType};
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
use vantyr_network_subscriptions::config::{
    Limits, QueryPolicy, SourceMetadata, SubscriptionConfig, SubscriptionSource,
};
use vantyr_network_subscriptions::error::Error as SubscriptionError;
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::{HttpTransport, ReqwestTransport};

const WORKER_ID: &str = "dns-mgmt-e2e-worker";
const STAMP: &str = "2026-11-27T09:00:00Z";
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn mapped_source() -> IpAddr {
    // The adult profile in dns_config() maps this source IP.
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
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
    };
    let handle = tokio::spawn(async move {
        let _ = axum::serve(tls, router).await;
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
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
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
fn dns_config(port: u16, revision: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_published_at": STAMP,
        "policy_revision": revision,
        "bind": { "address": "127.0.0.1", "port": port },
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
                let cache = st.cache.clone();
                move |spec, _root, _ca| {
                    let limits = Limits::default();
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
                    let cfg = SubscriptionConfig {
                        sources: vec![SubscriptionSource {
                            id: spec.id.clone(),
                            url: spec.url.clone(),
                            enabled: spec.enabled,
                            interval_secs: spec.interval_secs,
                            max_stale_secs: spec.max_stale_secs,
                            metadata: SourceMetadata {
                                title: spec.metadata.title.clone(),
                                publisher: spec.metadata.publisher.clone(),
                                license: spec.metadata.license.clone(),
                            },
                        }],
                        limits: limits.clone(),
                        query_policy: QueryPolicy::Reject,
                    };
                    let transport = Arc::new(ReqwestTransport::from_client(
                        client,
                        limits.max_header_bytes,
                        limits.request_timeout(),
                    )) as Arc<dyn HttpTransport>;
                    Fetcher::with_transport(
                        cache.clone(),
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

async fn start_worker(
    st: &Fixture,
    hid: Uuid,
    gid: Uuid,
    list_ca: &str,
    mgmt_base: &str,
    mgmt_ca: &str,
    bearer: &str,
) -> (Arc<DnsServer>, Arc<ManagementWorker>) {
    fs::write(&st.config, dns_config(0, 2)).unwrap();
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
        now: STAMP.parse().unwrap(),
        hooks: None,
    };
    let server = DnsServer::start_durable_with_subscriptions(durable, Some(runtime.clone()))
        .await
        .unwrap();
    let worker = Arc::new(ManagementWorker::new(options, client, Some(runtime)));
    (server, worker)
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
    let desired_v1: ManagementConfig =
        serde_json::from_value(body["desired"]["config"].clone()).unwrap();
    assert_eq!(digest_v1, config_digest(&desired_v1));

    // Real worker: explicit credential file, options, CA (all owner-0600),
    // production fetcher/compiler, and the background coordinator loop.
    let (server, worker) =
        start_worker(&st, hid, gid, &list_ca, &mgmt_base, &ca_pem, &bearer).await;
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
    assert_eq!(
        install_status.policy_published_at,
        STAMP.parse::<DateTime<Utc>>().unwrap()
    );

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
    assert_eq!(
        applied["applied_at"],
        serde_json::to_value(state_v1.applied_at.unwrap()).unwrap()
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

    let state_v2 = server.management_state().expect("applied state lost");
    assert_eq!(
        state_v2.config_version, 1,
        "refresh must not bump config version"
    );
    assert_eq!(state_v2.digest, digest_v1);
    assert_eq!(
        state_v2.applied_at, state_v1.applied_at,
        "applied_at was freshened"
    );
    assert_eq!(state_v2.receipts.len(), 1);
    assert_eq!(state_v2.receipts[0].source_id, "remote-list");
    assert_eq!(state_v2.receipts[0].refresh_seq, refresh_seq);
    assert_eq!(state_v2.receipts[0].config_version, 1);
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
    assert_eq!(
        gw["status"]["applied"]["applied_at"],
        serde_json::to_value(state_v1.applied_at.unwrap()).unwrap()
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

    // Clean shutdown, then an OFFLINE restart from the single bundle only.
    // Cache files are deleted and the external config rewritten: the answer
    // can only come from the persisted bundle, never from a live provider.
    worker.shutdown().await;
    server.stop_shared().await;
    for entry in fs::read_dir(&st.cache).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            fs::remove_file(path).unwrap();
        }
    }
    fs::write(&st.config, dns_config(0, 99)).unwrap();
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
    assert_eq!(offline.management_state().unwrap(), state_v2);
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
        restarted_state, state_v2,
        "restart lost applied management state"
    );
    assert!(blocked(&online, "changed.block.test.", false).await);

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

    worker2.shutdown().await;
    online.stop_shared().await;
}
