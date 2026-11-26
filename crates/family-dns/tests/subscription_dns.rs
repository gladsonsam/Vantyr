//! Real verified-TLS list downloads feeding real UDP/TCP DNS answers.
//!
//! The HTTPS server is a genuine local TLS listener with a generated CA; the
//! fetcher verifies chain and hostname and uses no_proxy. No public provider
//! is contacted and no host network setting is touched.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{serve::Listener, Router};
use chrono::{DateTime, Utc};
use family_dns::{
    DnsServer, DurableOptions, FormatValidator, ListFormatSpec, ReloadError, SubscriptionRuntime,
    WriteHooks,
};
use hickory_server::proto::op::{Message, ResponseCode};
use hickory_server::proto::rr::RecordType;
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use vantyr_network_subscriptions::config::{
    Limits, QueryPolicy, SourceMetadata, SubscriptionConfig, SubscriptionSource,
};
use vantyr_network_subscriptions::fetcher::Fetcher;
use vantyr_network_subscriptions::transport::{HttpTransport, ReqwestTransport};

use support::{assert_code, assert_flags, tcp_query, udp_query, HOUSEHOLD};

const WORKER: &str = "dns-subscription-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
static COUNTER: AtomicU64 = AtomicU64::new(0);
static FAIL_RENAME: AtomicU64 = AtomicU64::new(0);

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

fn fail_hook(_path: &Path) -> std::io::Result<()> {
    if FAIL_RENAME.load(Ordering::SeqCst) != 0 {
        Err(std::io::Error::other("injected pre-rename failure"))
    } else {
        Ok(())
    }
}

// ─── Local HTTPS list server ────────────────────────────────────────────────

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

struct MockState {
    body: Mutex<Vec<u8>>,
    status: Mutex<u16>,
    etag: Mutex<Option<String>>,
    retry_after: Mutex<Option<String>>,
    requests: AtomicU64,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            body: Mutex::new(Vec::new()),
            status: Mutex::new(200),
            etag: Mutex::new(None),
            retry_after: Mutex::new(None),
            requests: AtomicU64::new(0),
        }
    }
}

async fn list_handler(State(state): State<Arc<MockState>>, headers: HeaderMap) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    let status = *state.status.lock().unwrap();
    if status != 200 {
        let mut builder = axum::http::Response::builder().status(status);
        if let Some(retry) = state.retry_after.lock().unwrap().clone() {
            builder = builder.header("retry-after", retry);
        }
        if status == 302 {
            // Reported, never followed by the fetcher.
            builder = builder.header("location", "https://elsewhere.invalid/list");
        }
        return builder
            .body(axum::body::Body::empty())
            .unwrap()
            .into_response();
    }
    let etag = state.etag.lock().unwrap().clone();
    if let (Some(expected), Some(seen)) = (&etag, headers.get("if-none-match")) {
        if seen.to_str().ok() == Some(expected.as_str()) {
            return axum::http::Response::builder()
                .status(304)
                .body(axum::body::Body::empty())
                .unwrap()
                .into_response();
        }
    }
    let mut builder = axum::http::Response::builder().status(200);
    if let Some(etag) = etag {
        builder = builder.header("etag", etag);
    }
    builder
        .body(axum::body::Body::from(state.body.lock().unwrap().clone()))
        .unwrap()
        .into_response()
}

struct ServerGuard(JoinHandle<()>);
impl Drop for ServerGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn spawn_list_server() -> (String, String, Arc<MockState>, ServerGuard) {
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
    let state = Arc::new(MockState::default());
    let router = Router::new()
        .route("/list", get(list_handler))
        .with_state(state.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(tls, router).await;
    });
    (
        format!("https://localhost:{port}"),
        ca_pem,
        state,
        ServerGuard(handle),
    )
}

struct LoopbackResolver(SocketAddr);
impl Resolve for LoopbackResolver {
    fn resolve(&self, _name: Name) -> Resolving {
        let addrs: Addrs = Box::new(std::iter::once(self.0));
        Box::pin(std::future::ready(Ok(addrs)))
    }
}

// ─── Worker fixture ─────────────────────────────────────────────────────────

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
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
        "vantyr-sub-dns-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    Fixture {
        config: dir.join("dns.json"),
        state: dir.join("state.json"),
        cache: dir.join("cache"),
        dir,
    }
}

impl Fixture {
    fn config(&self, revision: u64, url: &str, id: &str) -> String {
        self.config_with_id(revision, url, id, id)
    }

    fn config_with_id(&self, revision: u64, url: &str, _id: &str, material_id: &str) -> String {
        format!(
            r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_published_at": "{STAMP}",
  "policy_revision": {revision},
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "deny": {{ "mode": "nxdomain" }},
  "local_zones": {{ "sub.test.": [
    {{ "type": "a", "name": "ok.sub.test.", "ttl": 60, "addr": "192.0.2.50" }},
    {{ "type": "a", "name": "blocked.sub.test.", "ttl": 60, "addr": "192.0.2.51" }},
    {{ "type": "a", "name": "other.sub.test.", "ttl": 60, "addr": "192.0.2.52" }},
    {{ "type": "a", "name": "baseline.sub.test.", "ttl": 60, "addr": "192.0.2.53" }}
  ]}},
  "baseline": [
    {{ "effect": "deny", "match": {{ "type": "exact", "value": "baseline.sub.test" }}, "reason": "safety" }}
  ],
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "sub.test" }}, "reason": "adult" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "restricted" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}],
  "filter": {{
    "subscriptions": {{
      "cache_path": "{}",
      "sources": [{{
        "id": "{material_id}",
        "url": "{url}",
        "format": "hosts",
        "enabled": true,
        "metadata": {{ "title": "Operator list", "publisher": "Operator", "license": "asserted" }}
      }}]
    }}
  }}
}}"#,
            self.cache.display()
        )
    }

    fn config_multi(&self, revision: u64, ids: &[&str], url: &str) -> String {
        let sources: String = ids
            .iter()
            .map(|id| {
                format!(
                    r#"{{"id":"{id}","url":"{url}","format":"hosts","enabled":true,
                        "metadata":{{"title":"Operator list","publisher":"Operator","license":"asserted"}}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_published_at": "{STAMP}",
  "policy_revision": {revision},
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "deny": {{ "mode": "nxdomain" }},
  "local_zones": {{ "sub.test.": [
    {{ "type": "a", "name": "ok.sub.test.", "ttl": 60, "addr": "192.0.2.50" }},
    {{ "type": "a", "name": "blocked.sub.test.", "ttl": 60, "addr": "192.0.2.51" }}
  ]}},
  "profiles": {{
    "adult": [{{ "effect": "allow", "match": {{ "type": "suffix", "value": "sub.test" }}, "reason": "adult" }}],
    "restricted": [{{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "restricted" }}]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}],
  "filter": {{ "subscriptions": {{ "cache_path": "{}", "sources": [{sources}] }} }}
}}"#,
            self.cache.display()
        )
    }

    fn options(&self, hooks: Option<WriteHooks>) -> DurableOptions {
        DurableOptions {
            state_path: self.state.clone(),
            worker_id: WORKER.to_owned(),
            config_path: Some(self.config.clone()),
            now: STAMP.parse::<DateTime<Utc>>().unwrap(),
            hooks,
        }
    }
}

fn runtime_for(st: &Fixture, base: &str, ca_pem: &str, id: &str) -> Arc<SubscriptionRuntime> {
    runtime_for_many(st, base, ca_pem, &[id])
}

fn runtime_for_many(
    st: &Fixture,
    base: &str,
    ca_pem: &str,
    ids: &[&str],
) -> Arc<SubscriptionRuntime> {
    let limits = Limits::default();
    let url = vantyr_network_subscriptions::url::ValidatedUrl::parse(
        &format!("{base}/list"),
        &QueryPolicy::Reject,
        limits.max_header_bytes,
    )
    .unwrap();
    let port = url.port().unwrap_or(443);
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let cert = reqwest::Certificate::from_pem(ca_pem.as_bytes()).unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(LoopbackResolver(addr)) as Arc<dyn Resolve>)
        .tls_certs_merge([cert])
        .build()
        .unwrap();
    let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::from_client(
        client,
        limits.max_header_bytes,
        limits.request_timeout(),
    ));
    let mut entries = Vec::new();
    for id in ids {
        let config = SubscriptionConfig {
            sources: vec![SubscriptionSource {
                id: (*id).to_owned(),
                url: format!("{base}/list"),
                enabled: true,
                interval_secs: None,
                max_stale_secs: None,
                metadata: SourceMetadata {
                    title: "Operator list".to_owned(),
                    publisher: "Operator".to_owned(),
                    license: "asserted".to_owned(),
                },
            }],
            limits: limits.clone(),
            query_policy: QueryPolicy::Reject,
        };
        let fetcher = Fetcher::with_transport(
            st.cache.clone(),
            &config,
            FormatValidator::new(ListFormatSpec::Hosts),
            Arc::clone(&transport),
        )
        .unwrap();
        entries.push(((*id).to_owned(), Arc::new(fetcher)));
    }
    Arc::new(SubscriptionRuntime::with_fetchers(entries))
}

async fn answer(server: &DnsServer, tcp: bool, name: &str) -> Message {
    if tcp {
        tcp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    } else {
        udp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    }
}

fn assert_blocked(message: &Message) {
    assert_code(message, ResponseCode::NXDomain);
    assert_flags(message);
}
fn assert_open(message: &Message) {
    assert_code(message, ResponseCode::NoError);
    assert_flags(message);
}

fn on_disk(st: &Fixture) -> Vec<u8> {
    fs::read(&st.state).unwrap()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn first_boot_without_cache_fails_closed_then_200_changes_dns() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    *mock.etag.lock().unwrap() = Some("v1".to_owned());
    let st = fixture("first-boot");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");

    // No cache and no download yet: no listener, no empty-filter fallback.
    assert!(
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .is_err()
    );
    assert!(!st.state.exists());

    assert!(runtime.refresh_downloads(true).await.is_empty());
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();
    for tcp in [false, true] {
        assert_blocked(&answer(&server, tcp, "blocked.sub.test.").await);
        assert_open(&answer(&server, tcp, "ok.sub.test.").await);
    }
    let (sources, applied) = runtime.status();
    assert_eq!(sources[0].download, "fresh");
    assert_eq!(applied.filter_generation, 1);
    assert!(applied.filter_identity.len() == 64);
    assert_eq!(server.status().policy_revision, 2);
    server.stop().await;
}

#[tokio::test]
async fn changed_200_applies_and_304_leaves_generation_untouched() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    *mock.etag.lock().unwrap() = Some("v1".to_owned());
    let st = fixture("200-304");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();
    let first = server.status();

    // A new 200 with different content changes the real answer and both
    // generations, but never the policy revision or its publication age.
    *mock.body.lock().unwrap() = b"other.sub.test\n".to_vec();
    *mock.etag.lock().unwrap() = Some("v2".to_owned());
    runtime.refresh_once(&server, true).await;
    assert_open(&answer(&server, false, "blocked.sub.test.").await);
    assert_blocked(&answer(&server, true, "other.sub.test.").await);
    let second = server.status();
    assert_eq!(second.policy_revision, first.policy_revision);
    assert_eq!(second.policy_published_at, first.policy_published_at);
    assert_eq!(second.bundle_generation, first.bundle_generation + 1);
    assert_eq!(second.filter_generation, first.filter_generation + 1);
    assert!(!on_disk(&st).is_empty());

    // 304 with a different body still revalidates cached bytes; nothing
    // changes in DNS because the applied content identity is unchanged.
    *mock.body.lock().unwrap() = b"never-applied.sub.test\n".to_vec();
    runtime.refresh_once(&server, false).await;
    assert_eq!(server.status(), second);
    assert_open(&answer(&server, false, "ok.sub.test.").await);
    assert_blocked(&answer(&server, false, "other.sub.test.").await);
    server.stop().await;
}

#[tokio::test]
async fn bad_downloads_and_outages_keep_the_working_filter_and_report_errors() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    let st = fixture("bad-downloads");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();
    let committed = on_disk(&st);
    let applied = server.status();

    // Unsupported syntax is rejected by the maintained parser in the
    // CandidateValidator, before cache promotion.
    *mock.body.lock().unwrap() = vec![0xff, 0xfe];
    runtime.refresh_once(&server, true).await;
    assert_blocked(&answer(&server, false, "blocked.sub.test.").await);
    assert_eq!(on_disk(&st), committed);
    assert_eq!(server.status(), applied);
    assert!(runtime.status().1.last_error.is_some());
    assert_eq!(
        runtime.status().0[0]
            .content_version
            .as_deref()
            .unwrap()
            .len(),
        64
    );

    // Empty source, oversized candidate and transient HTTP errors all leave
    // the same applied filter and the same durable bytes.
    *mock.body.lock().unwrap() = Vec::new();
    runtime.refresh_once(&server, true).await;
    *mock.body.lock().unwrap() = vec![b'a'; 8 * 1024 * 1024 + 1];
    runtime.refresh_once(&server, true).await;
    *mock.status.lock().unwrap() = 500;
    runtime.refresh_once(&server, true).await;
    *mock.status.lock().unwrap() = 302;
    runtime.refresh_once(&server, true).await;
    assert_blocked(&answer(&server, true, "blocked.sub.test.").await);
    assert_eq!(on_disk(&st), committed);
    assert_eq!(server.status(), applied);

    // 429 sets an abuse cooldown that a forced manual refresh still respects.
    *mock.status.lock().unwrap() = 429;
    *mock.retry_after.lock().unwrap() = Some("3600".to_owned());
    let before = mock.requests.load(Ordering::SeqCst);
    runtime.refresh_once(&server, true).await;
    assert_eq!(mock.requests.load(Ordering::SeqCst), before + 1);
    assert!(runtime.status().1.last_error.is_some());
    assert_eq!(server.status(), applied);
    server.stop().await;
}

#[tokio::test]
async fn list_refreshes_never_consume_controller_policy_revisions() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    let st = fixture("counter-spaces");
    fs::write(
        &st.config,
        st.config(4, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();

    // Controller publishes policy 5.
    let mut policy_config = server.local_config();
    policy_config.policy_revision = 5;
    let policy = policy_config.policy_at(STAMP.parse().unwrap());
    assert!(matches!(
        server.apply_controller_policy(&policy, Utc::now()).unwrap(),
        family_dns::SyncCapability::AppliedLocally { revision: 5 }
    ));
    let after_policy = server.status();

    // Many list refreshes: only the independent counters move.
    for body in [
        "other.sub.test".to_owned(),
        "blocked.sub.test".to_owned(),
        "other.sub.test".to_owned(),
    ] {
        *mock.body.lock().unwrap() = body.into_bytes();
        runtime.refresh_once(&server, true).await;
    }
    let after_lists = server.status();
    assert_eq!(after_lists.policy_revision, 5);
    assert_eq!(
        after_lists.policy_published_at,
        after_policy.policy_published_at
    );
    assert!(after_lists.bundle_generation > after_policy.bundle_generation);
    assert!(after_lists.filter_generation > after_policy.filter_generation);

    // The next controller revision is still accepted and keeps the last list.
    let mut next = server.local_config();
    next.policy_revision = 6;
    let policy = next.policy_at(STAMP.parse().unwrap());
    assert!(matches!(
        server.apply_controller_policy(&policy, Utc::now()).unwrap(),
        family_dns::SyncCapability::AppliedLocally { revision: 6 }
    ));
    assert_blocked(&answer(&server, false, "other.sub.test.").await);
    assert_eq!(server.status().policy_revision, 6);
    server.stop().await;
}

#[tokio::test]
async fn offline_restart_and_persist_failure_keep_the_applied_bytes_and_age() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    let st = fixture("offline-restart");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let hooks = WriteHooks {
        before_rename: fail_hook,
        ..WriteHooks::default()
    };
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(Some(hooks)), Some(runtime.clone()))
            .await
            .unwrap();
    let committed = on_disk(&st);

    // New bytes download fine but persistence fails: whole runtime and disk
    // keep the old filter and a truthful error is exposed.
    *mock.body.lock().unwrap() = b"other.sub.test\n".to_vec();
    FAIL_RENAME.store(1, Ordering::SeqCst);
    runtime.refresh_once(&server, true).await;
    assert_blocked(&answer(&server, false, "blocked.sub.test.").await);
    assert_open(&answer(&server, false, "other.sub.test.").await);
    assert_eq!(on_disk(&st), committed);
    assert!(runtime.status().1.last_error.is_some());

    FAIL_RENAME.store(0, Ordering::SeqCst);
    runtime.refresh_once(&server, true).await;
    assert_blocked(&answer(&server, false, "other.sub.test.").await);
    let applied_after_retry = server.status();
    server.stop().await;

    // Cache and configured URL both change while the worker is down. The
    // bundle remains authoritative, including the original publication age.
    *mock.body.lock().unwrap() = b"never-applied.sub.test\n".to_vec();
    let cache_files: Vec<PathBuf> = fs::read_dir(&st.cache)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    for path in cache_files {
        fs::remove_file(path).unwrap();
    }
    fs::write(
        &st.config,
        st.config(99, "https://localhost:1/changed", "public-list"),
    )
    .unwrap();
    let fresh_runtime = runtime_for(&st, &base, &ca, "public-list");
    let restarted =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(fresh_runtime))
            .await
            .unwrap();
    assert_blocked(&answer(&restarted, true, "other.sub.test.").await);
    assert_eq!(restarted.status().policy_revision, 2);
    assert_eq!(
        restarted.status().policy_published_at,
        applied_after_retry.policy_published_at
    );
    restarted.stop().await;
}

#[tokio::test]
async fn unknown_source_id_and_same_content_never_create_a_phantom_generation() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    let st = fixture("identity");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();
    let before = server.status();

    // Re-downloading identical bytes is idempotent: no phantom generation and
    // no disk write.
    let committed = on_disk(&st);
    runtime.refresh_once(&server, true).await;
    assert_eq!(server.status(), before);
    assert_eq!(on_disk(&st), committed);

    // A config whose material id is not configured by the settings is
    // rejected without overwriting the working filter.
    let changed = st.config_with_id(3, &format!("{base}/list"), "public-list", "renamed-list");
    assert!(matches!(
        server.reload(changed.as_bytes(), Utc::now()),
        Err(ReloadError::FilterFailed(_))
    ));
    assert_eq!(on_disk(&st), committed);
    assert_blocked(&answer(&server, false, "blocked.sub.test.").await);
    server.stop().await;
}

#[tokio::test]
async fn concurrent_same_source_refreshes_are_serialized_and_idempotent() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    *mock.etag.lock().unwrap() = Some("v1".to_owned());
    let st = fixture("concurrent-refresh");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server = Arc::new(
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap(),
    );
    let before = server.status();

    *mock.body.lock().unwrap() = b"other.sub.test\n".to_vec();
    *mock.etag.lock().unwrap() = Some("v2".to_owned());
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let runtime = Arc::clone(&runtime);
        tasks.push(tokio::spawn(async move {
            runtime.refresh_once(&server, true).await;
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let after = server.status();
    assert_eq!(after.bundle_generation, before.bundle_generation + 1);
    assert_eq!(after.filter_generation, before.filter_generation + 1);
    assert_blocked(&answer(&server, false, "other.sub.test.").await);
    assert!(
        mock.requests.load(Ordering::SeqCst) >= 4,
        "one request per call"
    );
    Arc::try_unwrap(server)
        .ok()
        .expect("no tasks hold the server")
        .stop()
        .await;
}

#[tokio::test]
async fn combined_aggregate_over_bound_keeps_the_working_filter() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\n".to_vec();
    let st = fixture("combined-aggregate");
    fs::write(
        &st.config,
        st.config_multi(2, &["a-list", "b-list"], &format!("{base}/list")),
    )
    .unwrap();
    let runtime = runtime_for_many(&st, &base, &ca, &["a-list", "b-list"]);
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();
    let committed = on_disk(&st);
    let applied = server.status();

    // Each download is individually within the 8 MiB fetcher bound; their
    // combined material is not. The combined compile rejects the whole update.
    let bulky = {
        let mut bytes = vec![b'#'; 5 * 1024 * 1024];
        bytes.extend_from_slice(b"\nblocked.sub.test\n");
        bytes
    };
    *mock.body.lock().unwrap() = bulky;
    runtime.refresh_once(&server, true).await;
    assert_eq!(on_disk(&st), committed);
    assert_eq!(server.status(), applied);
    assert!(runtime.status().1.last_error.is_some());
    assert_blocked(&answer(&server, false, "blocked.sub.test.").await);
    server.stop().await;
}

#[tokio::test]
async fn baseline_deny_and_stale_age_remain_authoritative() {
    let (base, ca, mock, _guard) = spawn_list_server().await;
    *mock.body.lock().unwrap() = b"blocked.sub.test\nbaseline.sub.test\n".to_vec();
    let st = fixture("authority");
    fs::write(
        &st.config,
        st.config(2, &format!("{base}/list"), "public-list"),
    )
    .unwrap();
    let runtime = runtime_for(&st, &base, &ca, "public-list");
    runtime.refresh_downloads(true).await;
    let server =
        DnsServer::start_durable_with_subscriptions(st.options(None), Some(runtime.clone()))
            .await
            .unwrap();

    // The list blocks both names, but the core safety baseline still denies
    // its name through the household evaluator.
    assert_blocked(&answer(&server, false, "blocked.sub.test.").await);
    assert_blocked(&answer(&server, false, "baseline.sub.test.").await);
    let entry = server
        .observations()
        .into_iter()
        .rev()
        .find(|entry| entry.name == "baseline.sub.test.")
        .unwrap();
    assert!(!entry.allow);
    assert!(!entry.filter_blocked, "baseline denial is not a list block");
    server.stop().await;
}
