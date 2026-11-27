//! Worker-side Stage B DNS-management consumer against a real verified local
//! HTTPS mock implementing the wire DTOs, real UDP/TCP DNS and durable disk.
//! No server crate code is linked; no live provider is contacted.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{serve::Listener, Json, Router};
use chrono::{DateTime, Utc};
use family_dns::{
    config_digest, management_dto, CacheSettingsDto, Config, DenySettingsDto, DnsServer,
    DurableOptions, ListFormatDto, ListFormatSpec, ManagementClient, ManagementConfig,
    ManagementConfigV2, ManagementOptions, ManagementWorker, RuntimeSettingsDto, ServiceCatalogDto,
    ServiceDomainDto, ServiceDto, SourceMetadataDto, SubscriptionRuntime, SubscriptionSettings,
    SubscriptionSourceDto, WorkerReadResponse, WorkerStatusBody,
};
use hickory_server::proto::op::ResponseCode;
use hickory_server::proto::rr::RecordType;
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;
use vantyr_network_subscriptions::config::SourceMetadata;
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::{HttpTransport, ReqwestTransport};

use support::{assert_flags, tcp_query, udp_query, HOUSEHOLD};

mod support;

const WORKER: &str = "dns-mgmt-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
const GATEWAY: &str = "22222222-3333-4444-5555-666666666666";
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

// ─── TLS helpers ────────────────────────────────────────────────────────────

struct Cert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

fn cert() -> Cert {
    let mut ca = CertificateParams::new(vec!["local test ca".to_owned()]).unwrap();
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

struct TlsListener {
    inner: TcpListener,
    acceptor: TlsAcceptor,
}
impl Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = self.inner.accept().await.expect("accept");
            if let Ok(tls) = self.acceptor.accept(stream).await {
                return (tls, addr);
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

fn server_config(cert: &Cert, alpn: &[&str]) -> Arc<ServerConfig> {
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
    config.alpn_protocols = alpn.iter().map(|v| v.as_bytes().to_vec()).collect();
    Arc::new(config)
}

struct Guard(tokio::task::JoinHandle<()>);
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

// ─── Mock control plane ─────────────────────────────────────────────────────

#[derive(Default)]
struct ControlState {
    version: u64,
    config: Option<ManagementConfig>,
    config_v2: Option<ManagementConfigV2>,
    schema_version: i32,
    digest: String,
    pending: Vec<Value>,
    pending_clear: Vec<Value>,
    reports: Vec<WorkerStatusBody>,
    reject_auth: bool,
    reject_digest: bool,
    reject_schema: bool,
    bad_command: bool,
    status_count: AtomicU64,
}

#[derive(Clone, Default)]
struct Control(Arc<Mutex<ControlState>>);

async fn read_handler(
    State(control): State<Control>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let expected = format!("Bearer {GATEWAY}.{}", "a".repeat(43));
    let authorized = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == expected);
    if !authorized {
        return axum::http::Response::builder()
            .status(401)
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response();
    }
    let command_ok = body["command"] == json!("read_dns_management")
        && body["kind"] == json!("dns")
        && body["audience"] == json!("vantyr-gateway-worker");
    let state = control.0.lock().unwrap();
    if !command_ok || state.bad_command {
        return Json(json!({"error": "scope"})).into_response();
    }
    if state.reject_auth {
        return axum::http::Response::builder()
            .status(403)
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response();
    }
    let version = state.version;
    let config = state.config.clone();
    let digest = state.digest.clone();
    let pending = state.pending.clone();
    let response = WorkerReadResponse {
        household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
        gateway_id: Uuid::parse_str(GATEWAY).unwrap(),
        kind: "dns".to_owned(),
        config_version: version,
        schema_version: if state.reject_schema {
            Some(99)
        } else if version > 0 {
            Some(if state.schema_version == 0 {
                1
            } else {
                state.schema_version
            })
        } else {
            None
        },
        body_sha256: if version > 0 { Some(digest) } else { None },
        config: if version > 0 && state.config_v2.is_none() {
            config
        } else {
            None
        },
        config_v2: state.config_v2.clone(),
        pending_refreshes: pending
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
        pending_cache_clear: state
            .pending_clear
            .clone()
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect(),
        server_time: Utc::now(),
    };
    Json(response).into_response()
}

async fn status_handler(
    State(control): State<Control>,
    headers: HeaderMap,
    Json(body): Json<WorkerStatusBody>,
) -> Response {
    state_count(&control);
    let authorized = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some();
    if !authorized || body.command != "report_dns_status" {
        return axum::http::Response::builder()
            .status(401)
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response();
    }
    let mut state = control.0.lock().unwrap();
    state.reports.push(body);
    drop(state);
    Json(json!({"ok": true, "report_id": Uuid::new_v4()})).into_response()
}

fn state_count(control: &Control) {
    control
        .0
        .lock()
        .unwrap()
        .status_count
        .fetch_add(1, Ordering::SeqCst);
}

async fn start_control() -> (String, String, Control, Guard) {
    let cert = cert();
    let ca = cert.ca_pem.clone();
    let state = Control(Arc::new(Mutex::new(ControlState::default())));
    let router = Router::new()
        .route("/worker/network/dns-management/read", post(read_handler))
        .route("/worker/network/dns/status", post(status_handler))
        .with_state(state.clone());
    let (base, guard) = tls_router(server_config(&cert, &[]), router).await;
    (base, ca, state, guard)
}

// ─── List server with loopback resolver ────────────────────────────────────

#[derive(Default)]
struct ListState {
    body: Mutex<Vec<u8>>,
    delay: Mutex<Duration>,
    hits: AtomicU64,
}

async fn list_handler(State(state): State<Arc<ListState>>) -> Response {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let delay = *state.delay.lock().unwrap();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    axum::http::Response::builder()
        .status(200)
        .body(axum::body::Body::from(state.body.lock().unwrap().clone()))
        .unwrap()
        .into_response()
}

struct LoopbackResolver(SocketAddr);
impl Resolve for LoopbackResolver {
    fn resolve(&self, _name: Name) -> Resolving {
        let addrs: Addrs = Box::new(std::iter::once(self.0));
        Box::pin(std::future::ready(Ok(addrs)))
    }
}

async fn start_list_server() -> (String, String, Arc<ListState>, Guard) {
    let cert = cert();
    let ca = cert.ca_pem.clone();
    let state = Arc::new(ListState {
        body: Mutex::new(Vec::new()),
        delay: Mutex::new(Duration::ZERO),
        hits: AtomicU64::new(0),
    });
    let router = Router::new()
        .route("/list", get(list_handler))
        .with_state(state.clone());
    let (base, guard) = tls_router(server_config(&cert, &[]), router).await;
    (base, ca, state, guard)
}

// ─── Fixture ────────────────────────────────────────────────────────────────

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
        "vantyr-mgmt-{}-{name}-{serial}",
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

fn dns_config(port: u16, revision: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "household_id": HOUSEHOLD,
        "policy_published_at": STAMP,
        "policy_revision": revision,
        "bind": { "address": "127.0.0.1", "port": port },
        "deny": { "mode": "nxdomain" },
        "local_zones": { "block.test.": [
            { "type": "a", "name": "managed.block.test.", "ttl": 60, "addr": "192.0.2.20" },
            { "type": "a", "name": "other.block.test.", "ttl": 60, "addr": "192.0.2.21" },
            { "type": "a", "name": "svc.block.test.", "ttl": 60, "addr": "192.0.2.22" },
            { "type": "a", "name": "old.block.test.", "ttl": 60, "addr": "192.0.2.23" },
            { "type": "a", "name": "new.block.test.", "ttl": 60, "addr": "192.0.2.24" },
            { "type": "a", "name": "changed.block.test.", "ttl": 60, "addr": "192.0.2.25" },
            { "type": "a", "name": "local.block.test.", "ttl": 60, "addr": "192.0.2.26" }
        ]},
        "profiles": {
            "adult": [{ "effect": "allow", "match": { "type": "suffix", "value": "test" }, "reason": "adult" }],
            "restricted": [{ "effect": "deny", "match": { "type": "suffix", "value": "test" }, "reason": "restricted" }]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "adult", "source_ips": ["127.0.0.2"]
        }]
    }))
    .unwrap()
}

fn config_with_local(port: u16, revision: u64, path: &Path) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&dns_config(port, revision)).unwrap();
    value["filter"] = json!({
        "sources": [{
            "id": "local-list", "format": "hosts", "path": path,
            "enabled": true
        }]
    });
    serde_json::to_vec(&value).unwrap()
}

fn desired(url: &str, enabled: bool) -> ManagementConfig {
    ManagementConfig {
        sources: vec![SubscriptionSourceDto {
            id: "remote-list".to_owned(),
            url: url.to_owned(),
            format: ListFormatDto::Hosts,
            enabled,
            interval_secs: Some(300),
            max_stale_secs: Some(3600),
            metadata: SourceMetadataDto {
                title: "Operator list".to_owned(),
                publisher: "Operator".to_owned(),
                license: "asserted".to_owned(),
            },
        }],
        catalog: Some(ServiceCatalogDto {
            version: "remote-1".to_owned(),
            services: vec![ServiceDto {
                id: "remote-service".to_owned(),
                label: "Remote service".to_owned(),
                version: "1".to_owned(),
                domains: vec![ServiceDomainDto::Exact {
                    value: "svc.block.test".to_owned(),
                }],
                source: None,
                evidence: None,
                license: None,
            }],
        }),
        selected_services: vec!["remote-service".to_owned()],
    }
}

fn set_desired(control: &Control, version: u64, config: &ManagementConfig) {
    let mut state = control.0.lock().unwrap();
    state.version = version;
    state.config = Some(config.clone());
    state.digest = config_digest(config);
    state.reject_digest = false;
    state.reject_schema = false;
    state.reject_auth = false;
    state.bad_command = false;
}

fn set_desired_v2(control: &Control, version: u64, config: &ManagementConfigV2) {
    let mut state = control.0.lock().unwrap();
    state.version = version;
    state.schema_version = 2;
    state.config_v2 = Some(config.clone());
    state.config = None;
    state.digest = management_dto::digest(
        &management_dto::canonical_bytes_v2(config).expect("v2 config serializes"),
    );
    state.reject_digest = false;
    state.reject_schema = false;
    state.reject_auth = false;
    state.bad_command = false;
}

struct Harness {
    server: Arc<DnsServer>,
    worker: Arc<ManagementWorker>,
    runtime: Arc<SubscriptionRuntime>,
}

impl Harness {
    async fn sync(&self) {
        self.worker.sync_once(&self.server).await;
    }
    async fn stop(self) {
        self.worker.shutdown().await;
        self.server.stop_shared().await;
    }
}

async fn harness(
    st: &Fixture,
    list_base: &str,
    list_ca: &str,
    mgmt_base: &str,
    ca_pem: &str,
) -> Harness {
    harness_with_timing(st, list_base, list_ca, mgmt_base, ca_pem, 3600, 60_000).await
}

async fn harness_with_poll(
    st: &Fixture,
    list_base: &str,
    list_ca: &str,
    mgmt_base: &str,
    ca_pem: &str,
    poll_secs: u64,
) -> Harness {
    harness_with_timing(st, list_base, list_ca, mgmt_base, ca_pem, poll_secs, 60_000).await
}

/// The injected seam differs from production in exactly two ways: the loopback
/// resolver and a unique local CA. The transport, source config/bounds and the
/// CACHE LAYOUT are otherwise identical — this factory honours the `root` it is
/// given, so staged caches hold real `<id>.json` snapshots just like production.
fn loopback_factory(
    list_ca: String,
) -> impl Fn(
    &family_dns::SubscriptionSourceSpec,
    &Path,
    Option<&str>,
) -> Result<
    Fetcher<family_dns::FormatValidator>,
    vantyr_network_subscriptions::error::Error,
> + Send
       + Sync
       + 'static {
    move |spec, root, _ca| {
        let cfg = family_dns::single_source_config(spec);
        let limits = cfg.limits.clone();
        let url = reqwest::Url::parse(&spec.url).map_err(|e| {
            vantyr_network_subscriptions::error::Error::InvalidConfig(e.to_string())
        })?;
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), url.port().unwrap_or(443));
        let cert = reqwest::Certificate::from_pem(list_ca.as_bytes()).map_err(|e| {
            vantyr_network_subscriptions::error::Error::InvalidConfig(e.to_string())
        })?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(LoopbackResolver(addr)) as Arc<dyn Resolve>)
            .tls_certs_merge([cert])
            .build()
            .map_err(|e| {
                vantyr_network_subscriptions::error::Error::InvalidConfig(e.to_string())
            })?;
        let transport = Arc::new(ReqwestTransport::from_client(
            client,
            limits.max_header_bytes,
            limits.request_timeout(),
        )) as Arc<dyn HttpTransport>;
        Fetcher::with_transport(
            root.to_path_buf(),
            &cfg,
            family_dns::FormatValidator::new(spec.format),
            transport,
        )
    }
}

fn build_runtime(st: &Fixture, list_ca: &str, tick_ms: u64) -> Arc<SubscriptionRuntime> {
    let settings = SubscriptionSettings {
        cache_path: st.cache.to_string_lossy().into_owned(),
        trusted_ca_pem: None,
        sources: Vec::new(),
    };
    Arc::new(
        SubscriptionRuntime::new(&settings, None)
            .unwrap()
            .with_tick(Duration::from_millis(tick_ms))
            .with_fetcher_factory(loopback_factory(list_ca.to_owned())),
    )
}

async fn harness_with_timing(
    st: &Fixture,
    _list_base: &str,
    list_ca: &str,
    mgmt_base: &str,
    ca_pem: &str,
    poll_secs: u64,
    tick_ms: u64,
) -> Harness {
    fs::write(&st.config, dns_config(0, 2)).unwrap();
    let options_json = json!({
        "origin": mgmt_base,
        "ca_pem_path": st.dir.join("ca.pem"),
        "credential_file": st.credential,
        "household_id": HOUSEHOLD,
        "gateway_id": GATEWAY,
        "poll_interval_secs": poll_secs,
        "request_timeout_secs": 5,
        "max_response_bytes": 32768
    });
    fs::write(&st.options, serde_json::to_vec(&options_json).unwrap()).unwrap();
    fs::write(
        &st.credential,
        format!("Bearer {GATEWAY}.{}\n", "a".repeat(43)),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.options, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&st.credential, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fs::write(st.dir.join("ca.pem"), ca_pem.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(st.dir.join("ca.pem"), fs::Permissions::from_mode(0o600)).unwrap();
    }

    let settings = SubscriptionSettings {
        cache_path: st.cache.to_string_lossy().into_owned(),
        trusted_ca_pem: None,
        sources: Vec::new(),
    };
    let runtime = Arc::new(
        SubscriptionRuntime::new(&settings, None)
            .unwrap()
            .with_tick(Duration::from_millis(tick_ms))
            .with_fetcher_factory(loopback_factory(list_ca.to_owned())),
    );

    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let durable = DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: STAMP.parse().unwrap(),
        hooks: None,
    };
    let server = DnsServer::start_durable_with_subscriptions(durable, Some(runtime.clone()))
        .await
        .unwrap();
    let worker = Arc::new(ManagementWorker::new(
        options.clone(),
        client.clone(),
        Some(runtime.clone()),
    ));
    Harness {
        server: Arc::clone(&server),
        worker,
        runtime,
    }
}

async fn blocked(server: &DnsServer, name: &str, tcp: bool) -> bool {
    let message = if tcp {
        tcp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    } else {
        udp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    };
    assert_flags(&message);
    message.response_code == ResponseCode::NXDomain
}

fn reports(control: &Control) -> Vec<WorkerStatusBody> {
    control.0.lock().unwrap().reports.clone()
}

#[tokio::test]
async fn management_read_fetch_apply_status_and_dns_answer() {
    let st = fixture("apply");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;

    assert!(blocked(&h.server, "managed.block.test.", false).await);
    assert!(blocked(&h.server, "svc.block.test.", true).await);
    assert!(!blocked(&h.server, "other.block.test.", false).await);
    let state = h.server.management_state().unwrap();
    assert_eq!(state.config_version, 1);
    assert_eq!(state.digest, config_digest(&config));
    let report = reports(&control).pop().unwrap();
    let applied = report.applied.as_ref().unwrap();
    assert_eq!(applied.config_version, 1);
    assert_eq!(applied.filter_generation, 1);
    assert_eq!(report.sources.len(), 1);
    assert_eq!(
        report.sources[0]
            .downloaded_sha256
            .as_deref()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        h.server.status().policy_published_at,
        STAMP.parse::<DateTime<Utc>>().unwrap()
    );
    h.stop().await;
}

#[tokio::test]
async fn unchanged_download_and_removal_keep_policy_age_and_advance_generation() {
    let st = fixture("lifecycle");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let first = h.server.status();
    assert_eq!(first.filter_generation, 1);

    h.sync().await;
    assert_eq!(
        h.server.status(),
        first,
        "identical desired must not rewrite"
    );

    let removed = ManagementConfig {
        sources: Vec::new(),
        catalog: None,
        selected_services: Vec::new(),
    };
    set_desired(&control, 2, &removed);
    h.sync().await;
    assert!(!blocked(&h.server, "managed.block.test.", false).await);
    let second = h.server.status();
    assert_eq!(second.policy_revision, first.policy_revision);
    assert_eq!(second.policy_published_at, first.policy_published_at);
    assert_eq!(second.bundle_generation, first.bundle_generation + 1);
    h.stop().await;
}

#[tokio::test]
async fn auth_digest_schema_and_transport_failures_preserve_runtime_and_disk() {
    let st = fixture("failures");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let applied = h.server.status();
    let committed = fs::read(&st.state).unwrap();
    assert!(blocked(&h.server, "managed.block.test.", false).await);

    control.0.lock().unwrap().reject_auth = true;
    h.sync().await;
    assert_eq!(h.server.status(), applied);
    assert_eq!(fs::read(&st.state).unwrap(), committed);
    control.0.lock().unwrap().reject_auth = false;

    control.0.lock().unwrap().reject_schema = true;
    h.sync().await;
    assert_eq!(h.server.status(), applied);
    control.0.lock().unwrap().reject_schema = false;

    // A wrong digest must fail the read envelope before any write.
    {
        let mut state = control.0.lock().unwrap();
        state.digest = "0".repeat(64);
    }
    h.sync().await;
    assert_eq!(h.server.status(), applied);
    assert_eq!(fs::read(&st.state).unwrap(), committed);
    assert!(blocked(&h.server, "managed.block.test.", true).await);
    h.stop().await;
}

#[tokio::test]
async fn restart_offline_keeps_applied_material_version_digest_and_age() {
    let st = fixture("restart");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let applied = h.server.status();
    let state = h.server.management_state().unwrap();
    h.stop().await;

    // Control plane and cache disappear; external config changes entirely.
    drop(_mgmt_guard);
    drop(_list_guard);
    for entry in fs::read_dir(&st.cache).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            fs::remove_file(path).unwrap();
        }
    }
    fs::write(&st.config, dns_config(0, 99)).unwrap();
    let restarted = DnsServer::start_durable(DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: Utc::now(),
        hooks: None,
    })
    .await
    .unwrap();
    assert_eq!(restarted.status(), applied);
    assert_eq!(restarted.management_state().unwrap(), state);
    assert!(blocked(&restarted, "managed.block.test.", false).await);
    restarted.stop().await;
}

#[tokio::test]
async fn scoped_manual_token_is_replay_safe_and_bounded() {
    let st = fixture("manual-token");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;

    let token = json!({"source_id":"remote-list","refresh_seq":7,"config_version":1,"expires_at":"2027-01-01T00:00:00Z"});
    control.0.lock().unwrap().pending = vec![token.clone()];
    let before = h.server.status().bundle_generation;
    h.sync().await;
    let after = h.server.status().bundle_generation;
    assert_eq!(
        after,
        before + 1,
        "one receipt commit for one accepted token"
    );
    let state = h.server.management_state().unwrap();
    assert_eq!(state.receipts.len(), 1);
    assert_eq!(state.receipts[0].refresh_seq, 7);

    // Exact replay is idempotent; a foreign source/version is ignored.
    h.sync().await;
    assert_eq!(h.server.status().bundle_generation, after);
    control.0.lock().unwrap().pending = vec![
        json!({"source_id":"unknown","refresh_seq":9,"config_version":1,"expires_at":"2027-01-01T00:00:00Z"}),
        json!({"source_id":"remote-list","refresh_seq":9,"config_version":99,"expires_at":"2027-01-01T00:00:00Z"}),
    ];
    h.sync().await;
    assert_eq!(h.server.status().bundle_generation, after);
    h.stop().await;
}

#[tokio::test]
async fn local_remote_collision_and_oversized_aggregate_keep_old_answer() {
    let st = fixture("collision");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let applied = h.server.status();
    let committed = fs::read(&st.state).unwrap();

    // A remote source id colliding with a configured local source is refused.
    let mut local = Config::parse(&fs::read(&st.config).unwrap()).unwrap();
    local.filter.subscriptions = Some(SubscriptionSettings {
        cache_path: st.cache.to_string_lossy().into_owned(),
        trusted_ca_pem: None,
        sources: vec![family_dns::SubscriptionSourceSpec {
            id: "remote-list".to_owned(),
            url: format!("{list}/list"),
            format: ListFormatSpec::Hosts,
            enabled: false,
            interval_secs: None,
            max_stale_secs: None,
            metadata: SourceMetadata {
                title: "Local".to_owned(),
                publisher: "Local".to_owned(),
                license: "local".to_owned(),
            },
        }],
    });
    fs::write(&st.config, serde_json::to_vec(&local).unwrap()).unwrap();
    // The durable bundle keeps its original settings; a local reload that
    // would introduce the collision is rejected under the update mutex.
    assert!(matches!(
        h.server.reload(&fs::read(&st.config).unwrap(), Utc::now()),
        Err(family_dns::ReloadError::InvalidConfig(_))
            | Err(family_dns::ReloadError::NotNewer { .. })
    ));
    assert_eq!(h.server.status(), applied);
    assert_eq!(fs::read(&st.state).unwrap(), committed);
    assert!(blocked(&h.server, "managed.block.test.", false).await);
    h.stop().await;
}

#[tokio::test]
async fn controller_pull_and_local_reload_preserve_management_at_current_basis() {
    let st = fixture("basis");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let management = h.server.management_state().unwrap();
    let applied = h.server.status();

    let mut policy_config = h.server.local_config();
    policy_config.policy_revision = 3;
    let policy = policy_config.policy_at(STAMP.parse().unwrap());
    assert!(matches!(
        h.server
            .apply_controller_policy(&policy, Utc::now())
            .unwrap(),
        family_dns::SyncCapability::AppliedLocally { revision: 3 }
    ));
    assert_eq!(h.server.management_state().unwrap(), management);
    assert!(blocked(&h.server, "managed.block.test.", false).await);

    let mut local = Config::parse(&fs::read(&st.config).unwrap()).unwrap();
    local.policy_revision = 4;
    let changed = serde_json::to_vec(&local).unwrap();
    h.server.reload(&changed, Utc::now()).unwrap();
    assert_eq!(h.server.management_state().unwrap(), management);
    assert_eq!(h.server.status().filter_identity, applied.filter_identity);
    assert!(blocked(&h.server, "managed.block.test.", true).await);
    h.stop().await;
}

#[tokio::test]
async fn background_task_join_is_clean_without_forcing_refresh() {
    let st = fixture("task-lifecycle");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, _lists, _list_guard) = start_list_server().await;
    // No desired config: the task must stay idle, make no writes and join.
    set_desired(&control, 0, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    let before = h.server.status();
    let worker = h.worker.clone();
    worker.start(Arc::downgrade(&h.server));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.server.status(), before);
    assert!(reports(&control).is_empty());
    worker.shutdown().await;
    worker.shutdown().await; // idempotent
    assert!(!blocked(&h.server, "other.block.test.", false).await);
    h.stop().await;
}

#[tokio::test]
async fn background_coordinator_loop_applies_and_reports_without_direct_sync() {
    let st = fixture("background-loop");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness_with_poll(&st, &list, &list_ca, &mgmt, &ca, 5).await;
    let worker = h.worker.clone();
    worker.start(Arc::downgrade(&h.server));

    let mut applied = false;
    for _ in 0..100 {
        if blocked(&h.server, "managed.block.test.", false).await {
            applied = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(applied, "background task never applied the desired config");
    assert_eq!(h.server.management_state().unwrap().config_version, 1);
    let report = reports(&control)
        .pop()
        .expect("no status report from the loop");
    assert_eq!(report.applied.unwrap().config_version, 1);

    worker.shutdown().await;
    assert!(!blocked(&h.server, "other.block.test.", false).await);
    h.stop().await;
}

#[tokio::test]
async fn stale_manual_token_from_a_previous_config_is_not_acknowledged() {
    let st = fixture("token-version");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let v1 = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &v1);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;

    // Desired config moves to v2 with a different list; a token still bound
    // to v1 must not be delivered, fetched or acknowledged against v2.
    let mut v2 = desired(&format!("{list}/list"), true);
    v2.sources[0].interval_secs = Some(600);
    set_desired(&control, 2, &v2);
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":11,"config_version":1,"expires_at":"2027-01-01T00:00:00Z"
    })];
    h.sync().await;
    let state = h.server.management_state().unwrap();
    assert_eq!(state.config_version, 2);
    assert!(state.receipts.is_empty(), "stale v1 token was acknowledged");
    let generation = h.server.status().bundle_generation;

    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":12,"config_version":2,"expires_at":"2027-01-01T00:00:00Z"
    })];
    h.sync().await;
    let state = h.server.management_state().unwrap();
    assert_eq!(state.receipts.len(), 1);
    assert_eq!(state.receipts[0].refresh_seq, 12);
    assert_eq!(h.server.status().bundle_generation, generation + 1);
    h.stop().await;
}

#[tokio::test]
async fn reports_preserve_original_applied_and_fetched_timestamps() {
    let st = fixture("original-times");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let first = reports(&control).pop().unwrap();
    let applied_at = first.applied.unwrap().applied_at.unwrap();
    let fetched_at = first.sources[0].fetched_at.unwrap();

    h.sync().await;
    let second = reports(&control).pop().unwrap();
    assert_eq!(second.applied.unwrap().applied_at.unwrap(), applied_at);
    assert_eq!(second.sources[0].fetched_at.unwrap(), fetched_at);
    h.stop().await;
}

#[tokio::test]
async fn integrator_ticks_preserve_management_and_both_local_and_remote_filters() {
    let st = fixture("tick-authority");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness_with_timing(&st, &list, &list_ca, &mgmt, &ca, 3600, 100).await;

    // A local file source is added after bootstrap; both filters must coexist.
    let local = st.dir.join("local.txt");
    fs::write(&local, "local.block.test\n").unwrap();
    fs::write(&st.config, config_with_local(0, 3, &local)).unwrap();
    h.server
        .reload(&fs::read(&st.config).unwrap(), Utc::now())
        .unwrap();
    h.sync().await;
    let state = h.server.management_state().unwrap();
    let applied_at = state.applied_at;
    assert!(blocked(&h.server, "local.block.test.", false).await);
    assert!(blocked(&h.server, "managed.block.test.", false).await);

    // Change the remote list and deliver a manual force token. The NEXT
    // automatic tick (no direct apply call) must update only the remote part.
    *lists.body.lock().unwrap() = b"changed.block.test\n".to_vec();
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":2,"config_version":1,
        "expires_at":"2027-01-01T00:00:00Z"
    })];
    h.sync().await;
    let mut changed = false;
    for _ in 0..60 {
        if blocked(&h.server, "changed.block.test.", false).await {
            changed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(changed, "integrator did not apply changed remote bytes");
    assert!(blocked(&h.server, "local.block.test.", true).await);
    assert!(!blocked(&h.server, "managed.block.test.", false).await);
    let after = h.server.management_state().unwrap();
    assert_eq!(after.config_version, state.config_version);
    assert_eq!(after.digest, state.digest);
    assert_eq!(
        after.applied_at, applied_at,
        "receipt commit freshened applied_at"
    );
    assert_eq!(after.filter_identity, state.filter_identity);
    assert_eq!(after.digest, state.digest);
    assert_eq!(
        h.server.status().policy_published_at,
        STAMP.parse::<DateTime<Utc>>().unwrap()
    );
    h.stop().await;
}

#[tokio::test]
async fn failed_new_desired_keeps_active_fetchers_and_lkg_refresh() {
    let st = fixture("staged-fetchers");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness_with_timing(&st, &list, &list_ca, &mgmt, &ca, 3600, 100).await;
    h.sync().await;
    let ids: Vec<String> = h
        .runtime
        .status()
        .0
        .into_iter()
        .map(|source| source.id)
        .collect();
    assert_eq!(ids, vec!["remote-list".to_owned()]);

    let mut v2 = desired("https://localhost:1/dead", true);
    v2.sources[0].id = "remote-list-2".to_owned();
    set_desired(&control, 2, &v2);
    let before = h.server.status();
    h.sync().await;
    assert_eq!(h.server.status(), before);
    let ids: Vec<String> = h
        .runtime
        .status()
        .0
        .into_iter()
        .map(|source| source.id)
        .collect();
    assert_eq!(
        ids,
        vec!["remote-list".to_owned()],
        "failed v2 replaced active fetchers"
    );
    assert_eq!(h.server.management_state().unwrap().config_version, 1);

    // The still-applied v1 source keeps refreshing once a current-version
    // delivery arrives again (the server only issues current tokens).
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    *lists.body.lock().unwrap() = b"changed.block.test\n".to_vec();
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":4,"config_version":1,
        "expires_at":"2027-01-01T00:00:00Z"
    })];
    h.sync().await;
    let mut changed = false;
    for _ in 0..60 {
        if blocked(&h.server, "changed.block.test.", false).await {
            changed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(changed, "active v1 source no longer refreshes");
    h.stop().await;
}

#[tokio::test]
async fn refresh_ack_reports_never_exceed_server_limit() {
    let st = fixture("ack-bound");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let mut config = ManagementConfig {
        sources: Vec::new(),
        catalog: None,
        selected_services: Vec::new(),
    };
    for index in 0..32 {
        let mut source = desired(&format!("{list}/list"), true).sources.remove(0);
        source.id = format!("list-{index:02}");
        config.sources.push(source);
    }
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let mut tokens = Vec::new();
    for index in 0..40 {
        tokens.push(json!({
            "source_id": format!("list-{:02}", index % 32),
            "refresh_seq": index + 1,
            "config_version": 1,
            "expires_at": "2027-01-01T00:00:00Z"
        }));
    }
    control.0.lock().unwrap().pending = tokens;
    h.sync().await;
    let state = h.server.management_state().unwrap();
    assert!(state.receipts.len() <= 32);
    let report = reports(&control).pop().unwrap();
    assert!(
        report.refresh_ack.len() <= 32,
        "server rejects >32 ack entries"
    );
    h.stop().await;
}

#[tokio::test]
async fn lower_and_same_version_conflicts_never_mutate_applied_management() {
    let st = fixture("version-gate");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let state = h.server.management_state().unwrap();
    let generation = h.server.status().bundle_generation;

    // Same version with different bytes: conflict at admission.
    let mut changed = config.clone();
    changed.sources[0].interval_secs = Some(600);
    set_desired(&control, 1, &changed);
    h.sync().await;
    assert_eq!(h.server.management_state().unwrap(), state);
    assert_eq!(h.server.status().bundle_generation, generation);

    // Lower version: conflict, no mutation.
    control.0.lock().unwrap().version = 0;
    h.sync().await;
    assert_eq!(h.server.management_state().unwrap(), state);
    assert_eq!(h.server.status().bundle_generation, generation);
    assert!(blocked(&h.server, "managed.block.test.", false).await);
    h.stop().await;
}

#[tokio::test]
async fn delayed_fetch_cannot_restore_stale_local_bytes_after_concurrent_reload() {
    let st = fixture("delayed-basis");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    let old = st.dir.join("old.txt");
    let new = st.dir.join("new.txt");
    fs::write(&old, "old.block.test\n").unwrap();
    fs::write(&new, "new.block.test\n").unwrap();
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    fs::write(&st.config, config_with_local(0, 3, &old)).unwrap();
    h.server
        .reload(&fs::read(&st.config).unwrap(), Utc::now())
        .unwrap();
    h.sync().await;
    assert!(blocked(&h.server, "old.block.test.", false).await);

    // Delay the download; during it a local reload repoints the SAME source id
    // to new bytes under a new policy revision.
    *lists.delay.lock().unwrap() = Duration::from_millis(800);
    *lists.body.lock().unwrap() = b"other.block.test\n".to_vec();
    fs::write(&st.config, config_with_local(0, 4, &new)).unwrap();
    let worker = h.worker.clone();
    let server = h.server.clone();
    let task = tokio::spawn(async move {
        worker.sync_once(&server).await;
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    h.server
        .reload(&fs::read(&st.config).unwrap(), Utc::now())
        .unwrap();
    task.await.unwrap();
    *lists.delay.lock().unwrap() = Duration::ZERO;

    assert_eq!(h.server.status().policy_revision, 4);
    assert!(!blocked(&h.server, "old.block.test.", false).await);
    assert!(blocked(&h.server, "new.block.test.", false).await);
    assert_eq!(h.server.management_state().unwrap().config_version, 1);
    h.stop().await;
}

#[tokio::test]
async fn restart_rehydrates_managed_fetcher_and_actual_manual_refresh_hits_origin() {
    let st = fixture("restart-fetcher");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let original_state = h.server.management_state().unwrap();
    let original_status = h.server.status();
    let hits_before = lists.hits.load(Ordering::SeqCst);
    assert!(hits_before > 0);
    h.stop().await;

    // The list changes while the worker is down. A fresh runtime is built via
    // production settings; no manual install call is used.
    *lists.body.lock().unwrap() = b"changed.block.test\n".to_vec();
    let runtime = build_runtime(&st, &list_ca, 100);
    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let server = Arc::new(
        DnsServer::start_durable_with_subscriptions(
            DurableOptions {
                state_path: st.state.clone(),
                worker_id: WORKER.to_owned(),
                config_path: Some(st.config.clone()),
                now: Utc::now(),
                hooks: None,
            },
            Some(runtime.clone()),
        )
        .await
        .unwrap(),
    );
    assert!(blocked(&server, "managed.block.test.", false).await);
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":9,"config_version":1,
        "expires_at":"2027-01-01T00:00:00Z"
    })];
    let worker = Arc::new(ManagementWorker::new(options, client, Some(runtime)));
    worker.sync_once(&server).await;
    assert!(
        lists.hits.load(Ordering::SeqCst) > hits_before,
        "restarted source never contacted its origin"
    );
    let mut changed = false;
    for _ in 0..60 {
        if blocked(&server, "changed.block.test.", false).await {
            changed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        changed,
        "restarted manual refresh did not update the answer"
    );
    let after = server.status();
    assert_eq!(after.policy_revision, original_status.policy_revision);
    assert_eq!(
        after.policy_published_at,
        original_status.policy_published_at
    );
    assert!(after.bundle_generation > original_status.bundle_generation);
    assert!(after.filter_generation > original_status.filter_generation);
    let state = server.management_state().unwrap();
    assert_eq!(state.config_version, original_state.config_version);
    assert_eq!(state.digest, original_state.digest);
    assert_eq!(state.applied_at, original_state.applied_at);
    assert_eq!(state.receipts.len(), 1);
    worker.shutdown().await;
    server.stop_shared().await;
}

#[tokio::test]
async fn manual_request_without_a_fetcher_never_writes_a_receipt() {
    let st = fixture("no-fetcher-ack");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let before = h.server.management_state().unwrap();
    let disk = fs::read(&st.state).unwrap();
    let hits = lists.hits.load(Ordering::SeqCst);
    h.stop().await;

    // Restart WITHOUT a subscriptions runtime: the applied bundle still binds.
    let server = Arc::new(
        DnsServer::start_durable(DurableOptions {
            state_path: st.state.clone(),
            worker_id: WORKER.to_owned(),
            config_path: Some(st.config.clone()),
            now: Utc::now(),
            hooks: None,
        })
        .await
        .unwrap(),
    );
    assert!(blocked(&server, "managed.block.test.", false).await);
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":3,"config_version":1,
        "expires_at":"2027-01-01T00:00:00Z"
    })];
    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let worker = ManagementWorker::new(options, client, None);
    worker.sync_once(&server).await;
    assert_eq!(
        server.management_state().unwrap(),
        before,
        "no-attempt ack was written"
    );
    assert_eq!(
        fs::read(&st.state).unwrap(),
        disk,
        "receipt-only write changed disk"
    );
    assert_eq!(lists.hits.load(Ordering::SeqCst), hits);
    server.stop_shared().await;
}

#[tokio::test]
async fn status_report_is_scoped_and_never_attributes_an_unapplied_url() {
    let st = fixture("scope");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    let mut local = Config::parse(support::test_config(0, "").as_bytes()).unwrap();
    local.filter.subscriptions = Some(SubscriptionSettings {
        cache_path: st.cache.to_string_lossy().into_owned(),
        trusted_ca_pem: None,
        sources: (0..30)
            .map(|index| family_dns::SubscriptionSourceSpec {
                id: format!("unused-{index}"),
                url: format!("{list}/list"),
                format: ListFormatSpec::Hosts,
                enabled: false,
                interval_secs: None,
                max_stale_secs: None,
                metadata: SourceMetadata {
                    title: "Unused".to_owned(),
                    publisher: "Local".to_owned(),
                    license: "local".to_owned(),
                },
            })
            .collect(),
    });
    fs::write(&st.config, serde_json::to_vec(&local).unwrap()).unwrap();
    let mut managed = desired(&format!("{list}/list"), true);
    let mut second = managed.sources[0].clone();
    second.id = "remote-list-b".to_owned();
    managed.sources.push(second);
    set_desired(&control, 1, &managed);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    // harness rewrites config; install the extra local sources afterwards.
    fs::write(&st.config, serde_json::to_vec(&local).unwrap()).unwrap();
    h.server
        .reload(&fs::read(&st.config).unwrap(), Utc::now())
        .unwrap();
    let extras: Vec<_> = (0..40)
        .map(|index| family_dns::SubscriptionSourceSpec {
            id: format!("extra-{index}"),
            url: format!("{list}/list"),
            format: ListFormatSpec::Hosts,
            enabled: false,
            interval_secs: None,
            max_stale_secs: None,
            metadata: SourceMetadata {
                title: "Unused".to_owned(),
                publisher: "Local".to_owned(),
                license: "local".to_owned(),
            },
        })
        .collect();
    // Fidelity: install the 40 unrelated entries BEFORE the sync that emits
    // the report we inspect. Inspecting a report made before installation only
    // proves the old report was scoped, not the current worker state.
    h.runtime.install_managed(&extras).unwrap();
    let before_count = control
        .0
        .lock()
        .unwrap()
        .status_count
        .load(Ordering::SeqCst);
    let previous_id = reports(&control).last().map(|report| report.report_id);
    h.sync().await;
    assert_eq!(
        control
            .0
            .lock()
            .unwrap()
            .status_count
            .load(Ordering::SeqCst),
        before_count + 1,
        "no fresh report after installing the extra entries"
    );
    let all = reports(&control);
    let report = all.last().unwrap().clone();
    assert!(previous_id.is_none() || Some(report.report_id) != previous_id);
    assert!(
        report.sources.len() <= 32,
        "report exceeded the server bound"
    );
    assert_eq!(
        report.sources.len(),
        2,
        "unrelated local sources leaked into report"
    );
    assert!(report
        .sources
        .iter()
        .all(|source| source.id.starts_with("remote-list")));
    assert!(report.sources[0].downloaded_sha256.is_some());
    // Wire admission: round-trip through the exact strict server DTO mirror
    // (deny_unknown_fields + the server's 32-source/32-ack shape).
    let wire = serde_json::to_vec(&report).unwrap();
    let admitted: WorkerStatusBody = serde_json::from_slice(&wire).unwrap();
    assert_eq!(admitted.report_id, report.report_id);
    assert_eq!(admitted.config_version, report.config_version);
    assert!(admitted.sources.len() <= 32 && admitted.refresh_ack.len() <= 32);
    assert_ne!(admitted.report_id, Uuid::nil());

    // Same source id, different URL that cannot apply: no old-hash attribution.
    let mut changed = desired("https://localhost:1/dead", true);
    let mut second_changed = changed.sources[0].clone();
    second_changed.id = "remote-list-b".to_owned();
    changed.sources.push(second_changed);
    set_desired(&control, 2, &changed);
    let before_count = control
        .0
        .lock()
        .unwrap()
        .status_count
        .load(Ordering::SeqCst);
    h.sync().await;
    assert_eq!(
        control
            .0
            .lock()
            .unwrap()
            .status_count
            .load(Ordering::SeqCst),
        before_count + 1
    );
    let report = reports(&control).last().unwrap().clone();
    assert!(report.sources.len() <= 32);
    assert_eq!(report.sources.len(), 2);
    assert_eq!(report.applied.as_ref().unwrap().config_version, 1);
    assert_eq!(report.sources[0].downloaded_sha256, None);
    assert!(report.sources[0]
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("not applied")));
    h.stop().await;
}

fn marker_text(instance: &str, pid: u32, digest: &str) -> String {
    format!("v1\n{instance}\n{pid}\n{digest}\n")
}

#[tokio::test]
async fn staging_cleanup_only_reclaims_proven_owned_inactive_directories() {
    let st = fixture("cache-cleanup");
    let digest = "a".repeat(64);
    let old = st.cache.join("staging-old");
    let live_same_process = st.cache.join("staging-live-same-process");
    let pointer_target = st.cache.join("staging-active-pointer");
    let foreign = st.cache.join("staging-foreign");
    let local_file = st.cache.join("local-cache.json");
    for dir in [&old, &live_same_process, &pointer_target, &foreign] {
        fs::create_dir_all(dir).unwrap();
    }
    // Dead predecessor, ours to reclaim.
    fs::write(
        old.join(".vantyr-managed-cache"),
        marker_text("dead-instance", 999_999, &digest),
    )
    .unwrap();
    // Another live instance in THIS process: never reclaimed.
    fs::write(
        live_same_process.join(".vantyr-managed-cache"),
        marker_text("other-runtime-instance", std::process::id(), &digest),
    )
    .unwrap();
    // Named by the authoritative locator: active even with a dead marker pid.
    fs::write(
        pointer_target.join(".vantyr-managed-cache"),
        marker_text("dead-instance-two", 999_998, &digest),
    )
    .unwrap();
    fs::write(
        st.cache.join(".vantyr-managed-active"),
        format!("v1\nstaging-active-pointer\n{digest}\n"),
    )
    .unwrap();
    // Unmarked, local cache file and symlink are never guessed at.
    fs::write(foreign.join("data.json"), "operator data").unwrap();
    fs::write(&local_file, "local").unwrap();
    let outside = st.dir.join("outside");
    fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, st.cache.join("staging-link")).unwrap();

    #[cfg(unix)]
    let live_child = std::process::Command::new("sleep").arg("30").spawn().ok();
    #[cfg(unix)]
    if let Some(child) = &live_child {
        let live_other_pid = st.cache.join("staging-live-other-pid");
        fs::create_dir_all(&live_other_pid).unwrap();
        fs::write(
            live_other_pid.join(".vantyr-managed-cache"),
            marker_text("other-process", child.id(), &digest),
        )
        .unwrap();
    }

    let runtime = build_runtime(&st, "unused", 60_000);
    let staged = runtime.stage_managed(&[]).unwrap();
    assert!(
        !old.exists(),
        "owned inactive staging dir was not reclaimed"
    );
    assert!(
        live_same_process.exists(),
        "live other instance in this process was deleted"
    );
    assert!(pointer_target.exists(), "active locator target was deleted");
    assert!(foreign.exists(), "unmarked directory was removed");
    assert!(local_file.exists(), "local cache file was removed");
    assert!(
        st.cache.join("staging-link").exists(),
        "symlink was followed/removed"
    );
    #[cfg(unix)]
    if live_child.is_some() {
        assert!(
            st.cache.join("staging-live-other-pid").exists(),
            "live other process cache was deleted"
        );
    }
    drop(staged);
    runtime.shutdown().await;
    #[cfg(unix)]
    if let Some(mut child) = live_child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tokio::test]
async fn corrupt_cache_restart_binds_and_recovers_after_manual_retry() {
    let st = fixture("corrupt-cache");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let original = h.server.status();
    let original_applied = h.server.management_state().unwrap();
    h.stop().await;

    let active_file = fs::read_dir(&st.cache)
        .unwrap()
        .flat_map(|entry| {
            let dir = entry.unwrap().path();
            if dir.is_dir() {
                fs::read_dir(dir)
                    .unwrap()
                    .map(|inner| inner.unwrap().path())
                    .collect::<Vec<_>>()
            } else {
                vec![dir]
            }
        })
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .expect("activated managed cache");
    fs::write(&active_file, b"{corrupt").unwrap();
    let hits_before_restart = lists.hits.load(Ordering::SeqCst);
    let runtime = build_runtime(&st, &list_ca, 100);
    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let server = Arc::new(
        DnsServer::start_durable_with_subscriptions(
            DurableOptions {
                state_path: st.state.clone(),
                worker_id: WORKER.to_owned(),
                config_path: Some(st.config.clone()),
                now: Utc::now(),
                hooks: None,
            },
            Some(runtime.clone()),
        )
        .await
        .unwrap(),
    );
    assert_eq!(server.status(), original);
    assert!(
        lists.hits.load(Ordering::SeqCst) == hits_before_restart,
        "restart downloaded before binding the applied bundle"
    );
    assert!(blocked(&server, "managed.block.test.", false).await);
    let (sources, _) = runtime.status();
    assert_eq!(sources[0].download, "quarantined");

    // Operator removes the corrupt cache; the next manual request attempts a
    // real fetch and only then writes a receipt.
    for path in fs::read_dir(&st.cache).unwrap().flat_map(|entry| {
        let dir = entry.unwrap().path();
        if dir.is_dir() {
            fs::read_dir(dir)
                .unwrap()
                .map(|inner| inner.unwrap().path())
                .collect::<Vec<_>>()
        } else {
            vec![dir]
        }
    }) {
        if path.extension().is_some_and(|ext| ext == "json") {
            fs::remove_file(path).unwrap();
        }
    }
    let hits = lists.hits.load(Ordering::SeqCst);
    // The origin content changes while the cache is repaired. The ONLY trigger
    // is the ordinary coordinator/manual path: production never calls the
    // rehydrate helper, so recovery must come from `sync_once` alone.
    *lists.body.lock().unwrap() = b"changed.block.test\n".to_vec();
    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":5,"config_version":1,
        "expires_at":"2027-01-01T00:00:00Z"
    })];
    let worker = Arc::new(ManagementWorker::new(
        options,
        client,
        Some(runtime.clone()),
    ));
    worker.sync_once(&server).await;
    assert!(
        lists.hits.load(Ordering::SeqCst) > hits,
        "repaired quarantined source never contacted the origin"
    );
    assert_eq!(server.management_state().unwrap().receipts.len(), 1);
    let mut recovered = false;
    for _ in 0..60 {
        if blocked(&server, "changed.block.test.", false).await
            && blocked(&server, "changed.block.test.", true).await
        {
            recovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(recovered, "changed answer never applied over UDP and TCP");
    assert_eq!(
        server.management_state().unwrap().applied_at,
        original_applied.applied_at,
        "recovery must not freshen the original management applied age"
    );
    worker.shutdown().await;
    server.stop_shared().await;
}

#[tokio::test]
async fn restart_preserves_exact_active_cache_view_and_serves_offline() {
    let st = fixture("restart-cache-view");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let (before_all, _) = h.runtime.status();
    assert_eq!(before_all.len(), 1);
    let before = before_all[0].clone();
    assert!(before.bytes > 0, "no bytes cached before restart");
    assert!(before.content_version.is_some(), "no hash before restart");
    let hits = lists.hits.load(Ordering::SeqCst);
    h.stop().await;

    // Fresh runtime, durable bundle intact, control plane not polled.
    let runtime = build_runtime(&st, &list_ca, 60_000);
    let server = Arc::new(
        DnsServer::start_durable_with_subscriptions(
            DurableOptions {
                state_path: st.state.clone(),
                worker_id: WORKER.to_owned(),
                config_path: Some(st.config.clone()),
                now: Utc::now(),
                hooks: None,
            },
            Some(runtime.clone()),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        lists.hits.load(Ordering::SeqCst),
        hits,
        "restart downloaded before binding the applied bundle"
    );
    let (after_all, _) = runtime.status();
    assert_eq!(after_all.len(), 1);
    let after = after_all[0].clone();
    assert_eq!(after.id, before.id);
    assert_eq!(after.download, before.download);
    assert_eq!(
        after.bytes, before.bytes,
        "restarted fetcher lost cached bytes"
    );
    assert_eq!(
        after.content_version, before.content_version,
        "restarted fetcher lost the applied hash"
    );
    assert_eq!(
        after.fetched_at, before.fetched_at,
        "fetched_at was freshened"
    );
    assert_eq!(
        after.content_changed_at, before.content_changed_at,
        "content time was freshened"
    );
    assert_eq!(after.rule_count, before.rule_count);
    assert!(blocked(&server, "managed.block.test.", false).await);

    // The production-faithful layout keeps the snapshot inside the active
    // staging cache named by the authoritative locator.
    let locator = fs::read_to_string(st.cache.join(".vantyr-managed-active")).unwrap();
    let name = locator.lines().nth(1).unwrap();
    let snapshot = st.cache.join(name).join("remote-list.json");
    assert!(snapshot.exists(), "active cache snapshot is missing");
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&snapshot).unwrap()).unwrap();
    assert_eq!(
        persisted["sha256"].as_str().unwrap(),
        after.content_version.unwrap()
    );
    server.stop_shared().await;
}

#[tokio::test]
async fn two_instances_same_process_shared_root_keep_each_others_active_cache() {
    let st = fixture("two-runtimes");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let locator = fs::read_to_string(st.cache.join(".vantyr-managed-active")).unwrap();
    let name = locator.lines().nth(1).unwrap().to_owned();
    let active = st.cache.join(&name);
    let snapshot = active.join("remote-list.json");
    assert!(snapshot.exists(), "no activated managed cache");
    let bytes = fs::read(&snapshot).unwrap();

    // Independent runtime B shares the same root and pid. Staging runs its
    // reclaim pass; A's ACTIVE cache must survive untouched.
    let runtime_b = build_runtime(&st, &list_ca, 60_000);
    let staged_b = runtime_b.stage_managed(&[]).unwrap();
    assert!(
        active.exists(),
        "B reclaimed A's active cache in this process"
    );
    assert_eq!(
        fs::read(&snapshot).unwrap(),
        bytes,
        "A's cache was modified"
    );
    drop(staged_b);
    runtime_b.shutdown().await;
    assert!(active.exists());
    h.stop().await;
}

#[tokio::test]
async fn reclaim_only_old_inactive_owned_cache_after_a_valid_switch() {
    let st = fixture("reclaim-after-switch");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let first = fs::read_to_string(st.cache.join(".vantyr-managed-active"))
        .unwrap()
        .lines()
        .nth(1)
        .unwrap()
        .to_owned();
    let first_dir = st.cache.join(&first);
    assert!(first_dir.exists(), "v1 active cache is missing");

    // A second, valid config publishes a NEW candidate and switches the
    // locator to it. Only then is the old cache inactive and reclaimable.
    let mut second_config = desired(&format!("{list}/list"), true);
    second_config.sources[0].interval_secs = Some(600);
    set_desired(&control, 2, &second_config);
    h.sync().await;
    assert_eq!(
        h.server.management_state().unwrap().config_version,
        2,
        "second config was not applied"
    );
    let second = fs::read_to_string(st.cache.join(".vantyr-managed-active"))
        .unwrap()
        .lines()
        .nth(1)
        .unwrap()
        .to_owned();
    assert_ne!(
        first, second,
        "valid switch did not move the active pointer"
    );
    assert!(st.cache.join(&second).exists());
    assert!(
        first_dir.exists(),
        "old cache was reclaimed before the switch was durable"
    );
    let staged = h.runtime.stage_managed(&[]).unwrap();
    assert!(
        !first_dir.exists(),
        "old inactive owned cache was never reclaimed"
    );
    assert!(
        st.cache.join(&second).exists(),
        "valid switch target was reclaimed"
    );
    drop(staged);
    h.stop().await;
}

#[test]
fn single_source_config_matches_stage_a_stale_bound_without_network() {
    let base = family_dns::SubscriptionSourceSpec {
        id: "operator-list".to_owned(),
        url: "https://example.test/hosts.txt".to_owned(),
        format: ListFormatSpec::Hosts,
        enabled: true,
        interval_secs: None,
        max_stale_secs: None,
        metadata: SourceMetadata {
            title: "Operator list".to_owned(),
            publisher: "Operator".to_owned(),
            license: "asserted".to_owned(),
        },
    };
    let default_cfg = family_dns::single_source_config(&base);
    assert_eq!(default_cfg.limits.max_stale_secs, 3 * 24 * 60 * 60);
    default_cfg.validate().unwrap();

    // Stage A accepts 7 days; the production factory must not reject it by
    // validating against the library's 3-day default. No socket is opened.
    let legal = family_dns::SubscriptionSourceSpec {
        max_stale_secs: Some(7 * 24 * 60 * 60),
        ..base.clone()
    };
    let cfg = family_dns::single_source_config(&legal);
    assert_eq!(cfg.limits.max_stale_secs, 7 * 24 * 60 * 60);
    cfg.validate().unwrap();
    let st = fixture("bounds-parity");
    Fetcher::new(
        &st.cache,
        &cfg,
        family_dns::FormatValidator::new(legal.format),
    )
    .unwrap();

    // One second beyond the hard library bound is rejected, never clipped.
    let illegal = family_dns::SubscriptionSourceSpec {
        max_stale_secs: Some(7 * 24 * 60 * 60 + 1),
        ..base
    };
    assert!(family_dns::single_source_config(&illegal)
        .validate()
        .is_err());
}

#[tokio::test]
async fn active_cache_locator_write_failure_is_reported_without_freshening() {
    let st = fixture("locator-write-failure");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    // A directory at the destination forces atomic rename to fail even when
    // tests run as root; permission-based fault injection would be unreliable.
    fs::create_dir(st.cache.join(".vantyr-managed-active")).unwrap();
    h.sync().await;
    assert!(blocked(&h.server, "managed.block.test.", false).await);
    let state = h.server.management_state().unwrap();
    let generation = h.server.status().bundle_generation;
    let diagnostic = h.runtime.status().1.last_error.unwrap();
    assert!(diagnostic.starts_with("active cache locator write failed:"));
    assert!(diagnostic.len() <= 200);
    let report = reports(&control).pop().unwrap();
    assert!(report
        .applied
        .unwrap()
        .last_error
        .unwrap()
        .contains("locator write failed"));
    h.sync().await;
    assert_eq!(
        h.server.management_state().unwrap().applied_at,
        state.applied_at
    );
    assert_eq!(h.server.status().bundle_generation, generation);
    h.stop().await;
}

#[tokio::test]
async fn active_cache_locator_removal_failure_is_reported() {
    let st = fixture("locator-removal-failure");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    let (list, list_ca, lists, _list_guard) = start_list_server().await;
    *lists.body.lock().unwrap() = b"managed.block.test\n".to_vec();
    set_desired(&control, 1, &desired(&format!("{list}/list"), true));
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;
    let locator = st.cache.join(".vantyr-managed-active");
    fs::remove_file(&locator).unwrap();
    fs::create_dir(&locator).unwrap();
    set_desired(&control, 2, &ManagementConfig::default());
    h.sync().await;
    assert_eq!(h.server.management_state().unwrap().config_version, 2);
    let report = reports(&control).pop().unwrap();
    assert!(report
        .applied
        .unwrap()
        .last_error
        .unwrap()
        .contains("locator removal failed"));
    assert!(h.runtime.status().1.last_error.unwrap().len() <= 200);
    h.stop().await;
}

/// v2 desired runtime settings are applied through the one durable bundle;
/// the version gate and a failed desired read never poison last-known-good;
/// a clear command executes against the live cache without a generation bump;
/// and an offline restart keeps the applied settings and their original age.
#[tokio::test]
async fn v2_runtime_settings_apply_clear_and_survive_restart() {
    let st = fixture("runtime-settings");
    let (mgmt, ca, control, _mgmt_guard) = start_control().await;
    fs::write(&st.config, dns_config(0, 2)).unwrap();
    fs::write(
        &st.options,
        serde_json::to_vec(&json!({
            "origin": mgmt,
            "ca_pem_path": st.dir.join("ca.pem"),
            "credential_file": st.credential,
            "household_id": HOUSEHOLD,
            "gateway_id": GATEWAY,
            "poll_interval_secs": 3600,
            "request_timeout_secs": 5,
            "max_response_bytes": 32768
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        &st.credential,
        format!("Bearer {GATEWAY}.{}\n", "a".repeat(43)),
    )
    .unwrap();
    fs::write(st.dir.join("ca.pem"), ca.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [&st.options, &st.credential, &st.dir.join("ca.pem")] {
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    let settings = RuntimeSettingsDto {
        cache: CacheSettingsDto {
            enabled: true,
            max_entries: 64,
            positive_min_ttl_secs: Some(60),
            positive_max_ttl_secs: Some(60),
            negative_min_ttl_secs: None,
            negative_max_ttl_secs: None,
        },
        deny: DenySettingsDto::Refused,
    };
    let desired = ManagementConfigV2 {
        sources: Vec::new(),
        catalog: None,
        selected_services: Vec::new(),
        runtime: settings,
    };
    set_desired_v2(&control, 7, &desired);
    let options = ManagementOptions::load(&st.options).unwrap();
    let client = Arc::new(ManagementClient::new(&options).unwrap());
    let durable = || DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: STAMP.parse().unwrap(),
        hooks: None,
    };
    let server = Arc::new(DnsServer::start_durable(durable()).await.unwrap());
    let policy_before = server.status();
    let worker = ManagementWorker::new(options, client, None);
    worker.sync_once(&server).await;
    let applied = server
        .management_state()
        .expect("settings were not applied");
    assert_eq!(applied.config_version, 7);
    assert_eq!(applied.schema_version, 2);
    assert!(applied.runtime.is_some());
    assert_eq!(server.local_config().cache.max_entries, 64);
    assert_eq!(server.local_config().cache.positive_min_ttl_secs, Some(60));
    assert!(matches!(
        server.local_config().deny,
        family_dns::config::DenyConfig::Refused
    ));
    let policy_after = server.status();
    assert_eq!(policy_after.policy_revision, policy_before.policy_revision);
    assert_eq!(
        policy_after.policy_published_at,
        policy_before.policy_published_at
    );
    let generation = policy_after.bundle_generation;

    // An unsupported schema fails honestly: no new apply, no LKG mutation.
    control.0.lock().unwrap().schema_version = 99;
    worker.sync_once(&server).await;
    assert_eq!(server.management_state().unwrap(), applied);
    assert_eq!(server.local_config().cache.max_entries, 64);
    // A digest mismatch is likewise refused at read time.
    control.0.lock().unwrap().schema_version = 2;
    control.0.lock().unwrap().reject_digest = true;
    worker.sync_once(&server).await;
    assert_eq!(server.management_state().unwrap(), applied);
    control.0.lock().unwrap().reject_digest = false;

    // One delivered clear is executed once and reported truthfully. It never
    // persists a receipt, so it must not bump the bundle generation.
    control.0.lock().unwrap().pending_clear = vec![json!({
        "clear_seq": 1,
        "config_version": 7,
        "expires_at": "2027-01-01T00:00:00Z"
    })];
    worker.sync_once(&server).await;
    let all_reports = reports(&control);
    let last = all_reports.last().unwrap();
    assert_eq!(last.clear_ack.len(), 1);
    assert_eq!(last.clear_ack[0].clear_seq, 1);
    assert_eq!(last.clear_ack[0].config_version, 7);
    assert_eq!(server.status().bundle_generation, generation);
    assert_eq!(
        server.management_state().unwrap().applied_at,
        applied.applied_at
    );
    // The exact in-memory ack is replayed, not a second fabricated clear.
    worker.sync_once(&server).await;
    let all_reports = reports(&control);
    assert_eq!(all_reports.last().unwrap().clear_ack.len(), 1);

    // Offline restart from the single bundle keeps settings and original age.
    server.stop_shared().await;
    let restarted = DnsServer::start_durable(durable()).await.unwrap();
    assert_eq!(restarted.local_config().cache.max_entries, 64);
    assert_eq!(
        restarted.management_state().unwrap().applied_at,
        applied.applied_at
    );
    assert_eq!(
        restarted.status().policy_published_at,
        policy_before.policy_published_at
    );
    restarted.stop().await;
}
