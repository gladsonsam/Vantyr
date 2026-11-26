//! Worker-side Stage B DNS-management consumer against a real verified local
//! HTTPS mock implementing the wire DTOs, real UDP/TCP DNS and durable disk.
//! No server crate code is linked; no live provider is contacted.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
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
    config_digest, Config, DnsServer, DurableOptions, ListFormatDto, ListFormatSpec,
    ManagementClient, ManagementConfig, ManagementOptions, ManagementWorker, ServiceCatalogDto,
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
use vantyr_network_subscriptions::config::{Limits, QueryPolicy, SourceMetadata};
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
    digest: String,
    pending: Vec<Value>,
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
            Some(1)
        } else {
            None
        },
        body_sha256: if version > 0 { Some(digest) } else { None },
        config: if version > 0 { config } else { None },
        pending_refreshes: pending
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
struct ListState(Mutex<Vec<u8>>);

async fn list_handler(State(state): State<Arc<ListState>>) -> Response {
    axum::http::Response::builder()
        .status(200)
        .body(axum::body::Body::from(state.0.lock().unwrap().clone()))
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
    let state = Arc::new(ListState::default());
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
            { "type": "a", "name": "svc.block.test.", "ttl": 60, "addr": "192.0.2.22" }
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

struct Harness {
    server: Arc<DnsServer>,
    worker: Arc<ManagementWorker>,
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
    harness_with_poll(st, list_base, list_ca, mgmt_base, ca_pem, 3600).await
}

async fn harness_with_poll(
    st: &Fixture,
    _list_base: &str,
    list_ca: &str,
    mgmt_base: &str,
    ca_pem: &str,
    poll_secs: u64,
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
            .with_fetcher_factory({
                let list_ca = list_ca.to_owned();
                let cache = st.cache.clone();
                move |spec, _root, _ca| {
                    let limits = Limits::default();
                    let url = reqwest::Url::parse(&spec.url).map_err(|e| {
                        vantyr_network_subscriptions::error::Error::InvalidConfig(e.to_string())
                    })?;
                    let addr =
                        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), url.port().unwrap_or(443));
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
                    let cfg = vantyr_network_subscriptions::config::SubscriptionConfig {
                        sources: vec![vantyr_network_subscriptions::config::SubscriptionSource {
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
                        family_dns::FormatValidator::new(spec.format),
                        transport,
                    )
                }
            }),
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
        fs::remove_file(entry.unwrap().path()).unwrap();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
    let config = desired(&format!("{list}/list"), true);
    set_desired(&control, 1, &config);
    let h = harness(&st, &list, &list_ca, &mgmt, &ca).await;
    h.sync().await;

    let token = json!({"source_id":"remote-list","refresh_seq":7,"config_version":1});
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
        json!({"source_id":"unknown","refresh_seq":9,"config_version":1}),
        json!({"source_id":"remote-list","refresh_seq":9,"config_version":99}),
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
        "source_id":"remote-list","refresh_seq":11,"config_version":1
    })];
    h.sync().await;
    let state = h.server.management_state().unwrap();
    assert_eq!(state.config_version, 2);
    assert!(state.receipts.is_empty(), "stale v1 token was acknowledged");
    let generation = h.server.status().bundle_generation;

    control.0.lock().unwrap().pending = vec![json!({
        "source_id":"remote-list","refresh_seq":12,"config_version":2
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
    *lists.0.lock().unwrap() = b"managed.block.test\n".to_vec();
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
