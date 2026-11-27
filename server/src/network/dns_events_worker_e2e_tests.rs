//! Real-server / real-worker Stage B integration test for DNS event reporting.
//!
//! This is NOT a mock control plane. The axum router mounted here is the real
//! `network::routes()` + `network::worker_routes()` behind the real session +
//! CSRF middleware over a fresh SQLx-migrated database, served over verified
//! loopback TLS with a per-run private CA. The worker side uses the real
//! `EventOptions` / `EventClient` / `EventQueue` / `EventWorker` and a real
//! UDP/TCP DNS listener. A real scoped `report_dns_events` credential is issued
//! through the dashboard API; no old default credential is upgraded.
//!
//! Reproduce against the dedicated throwaway PostgreSQL only:
//!
//! ```text
//! SQLX_OFFLINE=true \
//! DATABASE_URL=postgres://<user>:<pw>@127.0.0.1:58743/<db> \
//!   cargo test -p vantyr-server --locked --offline \
//!   network::dns_events_worker_e2e_tests -- --nocapture
//! ```
//!
//! No live provider, no host/router DNS change, no CA-trust change, no copied
//! auth or serializer logic and no insecure TLS verifier is introduced.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::middleware::from_fn_with_state;
use axum::serve::{Listener, ListenerExt};
use axum::Router;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use family_dns::{
    Config, DnsServer, DurableOptions, EventBatchBody, EventClient, EventOptions, EventQueue,
    EventWorker, EVENT_COMMAND, EVENT_KIND, MAX_EVENTS_PER_BATCH,
};
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::{Name as DnsName, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use reqwest::Certificate as ReqwestCertificate;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, UdpSocket};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;

/// Exact device UUID configured in the worker. It must match an inventory row
/// and assignment in the household or the server refuses to store the id.
const DEVICE_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn mapped_source() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}
fn unmapped_source() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 3))
}

// ─── Verified loopback TLS (same seam as the accepted management E2E test) ──

#[derive(Clone)]
struct Cert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

fn cert() -> Cert {
    let mut ca = CertificateParams::new(vec!["vantyr dns events e2e ca".to_owned()]).unwrap();
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
    type Io = tokio_rustls::server::TlsStream<TcpStreamAlias>;
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

type TcpStreamAlias = tokio::net::TcpStream;

fn server_config(c: &Cert) -> Arc<ServerConfig> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(c.cert_der.clone())],
            PrivateKeyDer::try_from(c.key_der.clone()).unwrap(),
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

// ─── Real admin HTTP client (cookie + CSRF) ──────────────────────────────────

struct Http {
    base: String,
    client: reqwest::Client,
    token: String,
    csrf: String,
}

impl Http {
    fn new(base: String, ca_pem: &str, token: String, csrf: String) -> Self {
        let ca = ReqwestCertificate::from_pem(ca_pem.as_bytes()).unwrap();
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

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::POST, path).json(&body)).await
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::GET, path)).await
    }

    /// Cookie-free worker route call, used only to replay the same typed body
    /// and observe idempotency. The worker itself uses its real typed client.
    async fn worker(&self, path: &str, bearer: &str, body: Value) -> (u16, Value) {
        Self::send(
            self.client
                .post(format!("{}{}", self.base, path))
                .header("authorization", bearer)
                .header("content-type", "application/json")
                .json(&body),
        )
        .await
    }
}

async fn insert_user(pool: &PgPool, username: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1, 'test-hash', 'admin') RETURNING id",
    )
    .bind(username)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn session_for(pool: &PgPool, user_id: Uuid, label: &str) -> (String, String) {
    let token = format!("dns-evt-e2e-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("dns-evt-e2e-csrf-{label}");
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
            json!({ "kind": "dns", "label": "E2E event worker" }),
        )
        .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue_cred(http: &Http, hid: Uuid, gid: Uuid, commands: Vec<&str>) -> String {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({
                "expires_in_hours": 24,
                "commands": commands.into_iter().map(String::from).collect::<Vec<_>>()
            }),
        )
        .await;
    assert_eq!(status, 200, "credential failed: {body}");
    body["token"].as_str().unwrap().to_string()
}

async fn grant_events(http: &Http, hid: Uuid, user_id: Uuid) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": "network_events" }),
        )
        .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

/// The worker's configured device id must name a REAL inventory device that is
/// assigned inside this household. No UUID is silently fabricated.
async fn create_mapped_device(pool: &PgPool, hid: Uuid) {
    let person: Uuid = sqlx::query_scalar(
        "INSERT INTO network_persons (household_id, display_name) VALUES ($1, 'Device owner') RETURNING id",
    )
    .bind(hid)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_devices (id, household_id, canonical_key, label, device_type) VALUES ($1, $2, $3, 'E2E device', 'computer')",
    )
    .bind(Uuid::parse_str(DEVICE_ID).unwrap())
    .bind(hid)
    .bind(format!("dns-evt-e2e-{}", Uuid::new_v4()).replace('-', ""))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_assignments (household_id, person_id, device_id, role) VALUES ($1, $2, $3, 'member')",
    )
    .bind(hid)
    .bind(person)
    .bind(Uuid::parse_str(DEVICE_ID).unwrap())
    .execute(pool)
    .await
    .unwrap();
}

// ─── Real DNS queries over UDP and TCP ───────────────────────────────────────

fn question(name: &str, qtype: RecordType) -> Message {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(DnsName::from_str(name).unwrap(), qtype));
    message
}

async fn udp_query(server: SocketAddr, name: &str, source: IpAddr) -> Message {
    let client = UdpSocket::bind(SocketAddr::new(source, 0)).await.unwrap();
    let bytes = question(name, RecordType::A).to_vec().unwrap();
    client.send_to(&bytes, server).await.unwrap();
    let mut buffer = vec![0u8; 4096];
    let (len, _) = tokio::time::timeout(Duration::from_secs(6), client.recv_from(&mut buffer))
        .await
        .expect("UDP query timed out")
        .unwrap();
    Message::from_vec(&buffer[..len]).unwrap()
}

async fn tcp_query(server: SocketAddr, name: &str, source: IpAddr) -> Message {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(source, 0)).unwrap();
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

// ─── Fixture ─────────────────────────────────────────────────────────────────

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
    options: PathBuf,
    credential: PathBuf,
    ca: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-events-e2e-{name}-{serial}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    Fixture {
        config: dir.join("dns.json"),
        state: dir.join("state.json"),
        options: dir.join("options.json"),
        credential: dir.join("credential"),
        ca: dir.join("ca.pem"),
        dir,
    }
}

#[cfg(unix)]
fn private(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn dns_config(hid: Uuid, published: DateTime<Utc>) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "household_id": hid,
        "policy_published_at": published,
        "policy_revision": 1,
        "bind": { "address": "127.0.0.1", "port": 0 },
        "deny": { "mode": "nxdomain" },
        "local_zones": { "test.": [
            { "type": "a", "name": "allow.test.", "ttl": 60, "addr": "192.0.2.10" },
            { "type": "cname", "name": "alias.test.", "ttl": 60, "target": "blocked.test." }
        ]},
        "profiles": {
            "adult": [
                { "effect": "deny", "match": { "type": "suffix", "value": "blocked.test" }, "reason": "adult-blocked" },
                { "effect": "allow", "match": { "type": "suffix", "value": "test" }, "reason": "adult-allow" }
            ],
            "restricted": [
                { "effect": "deny", "match": { "type": "suffix", "value": "test" }, "reason": "restricted" }
            ]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": DEVICE_ID,
            "default_profile": "adult",
            "source_ips": ["127.0.0.2"]
        }]
    }))
    .unwrap()
}

fn write_inputs(st: &Fixture, base: &str, ca_pem: &str, bearer: &str, hid: Uuid, gid: Uuid) {
    fs::write(&st.credential, format!("{bearer}\n")).unwrap();
    fs::write(&st.ca, ca_pem.as_bytes()).unwrap();
    fs::write(
        &st.options,
        serde_json::to_vec(&json!({
            "origin": base,
            "ca_pem_path": st.ca,
            "credential_file": st.credential,
            "household_id": hid,
            "gateway_id": gid,
            "flush_interval_secs": 1,
            "max_batch": MAX_EVENTS_PER_BATCH,
            "request_timeout_secs": 5,
            "max_response_bytes": 32768,
            "queue_capacity": 64,
            "backoff_secs": 1,
            "max_backoff_secs": 2
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        private(&st.credential);
        private(&st.ca);
        private(&st.options);
    }
}

fn worker_parts(st: &Fixture) -> (Arc<EventQueue>, Arc<EventClient>, EventOptions) {
    let options = EventOptions::load(&st.options).unwrap();
    let queue = Arc::new(EventQueue::new(options.queue_capacity()));
    let client = Arc::new(EventClient::new(&options).unwrap());
    (queue, client, options)
}

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

use std::future::Future;

/// One locally-built, valid observation used only by the negative test. It
/// carries no secret, URL or person identity.
fn synthetic_event(name: &str) -> family_dns::DnsEventDto {
    use family_dns::{FinalDecision, FlagsDto};
    FinalDecision {
        event_id: Uuid::new_v4(),
        observed_at: Utc::now(),
        device_id: None,
        name: name.to_owned(),
        query_type: "A".to_owned(),
        protocol: "udp".to_owned(),
        allow: false,
        reason_code: "device_profile_deny".to_owned(),
        policy_revision: Some(1),
        applied_rule: None,
        filter_blocked: false,
        filter_source_id: None,
        filter_source_kind: None,
        denied_alias_target: None,
        flags: FlagsDto::default(),
    }
    .into_event()
    .unwrap()
}

// ─── One complete real flow ──────────────────────────────────────────────────

#[sqlx::test]
async fn real_server_and_worker_dns_events_flow(pool: PgPool) {
    let st = fixture("flow");
    let (base, ca_pem, _guard) = spawn_server(pool.clone()).await;
    let user = insert_user(&pool, "events-admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(base.clone(), &ca_pem, token, csrf);
    let hid = bootstrap_as(&http, "DNS events household").await;
    let gid = create_gateway(&http, hid).await;
    let bearer = issue_cred(&http, hid, gid, vec![EVENT_COMMAND]).await;
    grant_events(&http, hid, user).await;
    create_mapped_device(&pool, hid).await;
    write_inputs(&st, &base, &ca_pem, &bearer, hid, gid);

    let (queue, client, options) = worker_parts(&st);
    let published = Utc::now() - ChronoDuration::hours(1);
    let server = DnsServer::start_with_events(
        Config::parse(&dns_config(hid, published)).unwrap(),
        Arc::clone(&queue),
    )
    .await
    .unwrap();
    let worker = Arc::new(EventWorker::new(
        &options,
        Arc::clone(&queue),
        Arc::clone(&client),
    ));
    worker.start();

    // Real UDP deny, TCP allow, UDP alias-chain deny, a repeated (cached) allow
    // and an unmapped-source deny. Each is ONE observation.
    assert_eq!(
        udp_query(server.bind_addr(), "blocked.test.", mapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    assert_ne!(
        tcp_query(server.bind_addr(), "allow.test.", mapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    assert_eq!(
        udp_query(server.bind_addr(), "alias.test.", mapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    let _ = udp_query(server.bind_addr(), "allow.test.", mapped_source()).await;
    assert_eq!(
        udp_query(server.bind_addr(), "allow.test.", unmapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    // Privacy edge: a secret-marked name is rejected LOCALLY and counted, so
    // it cannot poison a batch that also carries valid observations.
    let _ = udp_query(
        server.bind_addr(),
        "password.example.test.",
        mapped_source(),
    )
    .await;

    wait_until(30, "five accepted observations", || async {
        let (_, body) = http
            .get(&format!(
                "/api/network/households/{hid}/dns/stats?window=24h"
            ))
            .await;
        body["total_queries"].as_u64() == Some(5)
    })
    .await;

    let (_, stats) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=24h"
        ))
        .await;
    assert_eq!(stats["allowed"].as_u64(), Some(2), "stats: {stats}");
    assert_eq!(stats["blocked"].as_u64(), Some(3), "stats: {stats}");
    let series: u64 = stats["time_series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bucket| bucket["count"].as_u64().unwrap_or(0))
        .sum();
    assert_eq!(series, 5, "time_series must sum to total_queries");
    assert_eq!(stats["observed_only"], true);
    assert_eq!(stats["sources"][0], "dns");

    let (_, allowed) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?domain=allow.test&limit=10"
        ))
        .await;
    let items = allowed["rows"].as_array().unwrap();
    // Two mapped allows plus the unmapped-source deny for the same name.
    assert_eq!(items.len(), 3, "allow.test search: {allowed}");
    let protocols: Vec<&str> = items
        .iter()
        .filter(|item| item["effect"] == "allow")
        .map(|item| item["protocol"].as_str().unwrap())
        .collect();
    assert!(protocols.contains(&"tcp"), "TCP protocol was not reported");
    assert!(protocols.contains(&"udp"), "UDP protocol was not reported");
    for item in items {
        assert_eq!(item["person_label"], Value::Null);
        assert_eq!(item["evidence"], "network_observation");
        assert_eq!(
            item["cache_state"], "unknown",
            "no fabricated cache hit/miss"
        );
        assert_eq!(item["upstream"], Value::Null, "no fabricated upstream");
        assert!(!item.to_string().contains("password"));
        if item["effect"] == "allow" {
            assert_eq!(item["device_id"], DEVICE_ID);
        }
    }

    let (_, alias) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?domain=alias.test&limit=10"
        ))
        .await;
    let alias_items = alias["rows"].as_array().unwrap();
    assert_eq!(alias_items.len(), 1, "alias search: {alias}");
    assert_eq!(alias_items[0]["allow"], false);
    assert_eq!(
        alias_items[0]["denied_alias_target"].as_str(),
        Some("blocked.test")
    );

    let (_, unassigned) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?domain=allow.test&decision=deny&limit=10"
        ))
        .await;
    let unknowns = unassigned["rows"].as_array().unwrap();
    assert_eq!(
        unknowns.len(),
        1,
        "unmapped-device deny search: {unassigned}"
    );
    assert_eq!(unknowns[0]["device_id"], Value::Null, "no fabricated UUID");
    assert_eq!(
        queue.metrics().invalid,
        1,
        "secret-marked name must be counted"
    );

    // Exact replay of one accepted batch is acknowledged without inserting
    // anything; event ids stay stable and no duplicates are created.
    // The worker already flushed these, so rebuild the exact accepted events
    // from the read rows using their stable server-side event ids.
    let drained: Vec<family_dns::DnsEventDto> = allowed["rows"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .map(|row| {
            let mut event = synthetic_event("allow.test.");
            event.event_id = Uuid::parse_str(row["event_id"].as_str().unwrap()).unwrap();
            event.device_id = row["device_id"]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok());
            event.allow = row["allow"].as_bool().unwrap();
            event
        })
        .collect();
    assert_eq!(drained.len(), 2);
    let body = EventBatchBody {
        audience: "vantyr-gateway-worker".to_owned(),
        command: EVENT_COMMAND.to_owned(),
        household_id: hid,
        gateway_id: gid,
        kind: EVENT_KIND.to_owned(),
        batch_id: Uuid::new_v4(),
        events: drained.clone(),
    };
    let (status, first) = http
        .worker(
            "/worker/network/dns/events",
            &bearer,
            serde_json::to_value(&body).unwrap(),
        )
        .await;
    assert_eq!(status, 200, "first batch: {first}");
    assert_eq!(first["inserted"].as_u64(), Some(0));
    assert_eq!(first["duplicates"].as_u64(), Some(2));
    let (status, replay) = http
        .worker(
            "/worker/network/dns/events",
            &bearer,
            serde_json::to_value(&body).unwrap(),
        )
        .await;
    assert_eq!(status, 200, "replay: {replay}");
    assert_eq!(replay["replayed"], true);
    let (_, after) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=24h"
        ))
        .await;
    assert_eq!(
        after["total_queries"].as_u64(),
        Some(5),
        "replay double-counted"
    );

    // Stop the reporter while real queries are in flight. The DNS path never
    // awaits reporting, so every query still completes and shutdown joins.
    let addr = server.bind_addr();
    let queries = tokio::spawn(async move {
        for _ in 0..24 {
            let message = udp_query(addr, "allow.test.", mapped_source()).await;
            assert_ne!(message.response_code, ResponseCode::NXDomain);
        }
    });
    worker.shutdown().await;
    tokio::time::timeout(Duration::from_secs(10), queries)
        .await
        .expect("queries hung during reporter shutdown")
        .unwrap();
    server.stop().await;
}

// ─── Durable restart through the real constructor ───────────────────────────

#[sqlx::test]
async fn real_durable_worker_restart_preserves_policy_age_and_filter_state(pool: PgPool) {
    let st = fixture("durable");
    let (base, ca_pem, _guard) = spawn_server(pool.clone()).await;
    let user = insert_user(&pool, "events-durable").await;
    let (token, csrf) = session_for(&pool, user, "durable").await;
    let http = Http::new(base.clone(), &ca_pem, token, csrf);
    let hid = bootstrap_as(&http, "Durable household").await;
    let gid = create_gateway(&http, hid).await;
    let bearer = issue_cred(&http, hid, gid, vec![EVENT_COMMAND]).await;
    grant_events(&http, hid, user).await;
    create_mapped_device(&pool, hid).await;
    write_inputs(&st, &base, &ca_pem, &bearer, hid, gid);

    let published = Utc::now() - ChronoDuration::hours(1);
    fs::write(&st.config, dns_config(hid, published)).unwrap();
    let durable = |now: DateTime<Utc>| DurableOptions {
        state_path: st.state.clone(),
        worker_id: "dns-events-e2e-durable".to_owned(),
        config_path: Some(st.config.clone()),
        now,
        hooks: None,
    };

    // First run: real durable constructor, real reporter loop, no flush call.
    let (queue, client, options) = worker_parts(&st);
    let server = DnsServer::start_durable_with_events(durable(published), None, Arc::clone(&queue))
        .await
        .unwrap();
    let worker = Arc::new(EventWorker::new(&options, queue, client));
    worker.start();
    assert_ne!(
        udp_query(server.bind_addr(), "allow.test.", mapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    wait_until(30, "first durable observation", || async {
        let (_, body) = http
            .get(&format!(
                "/api/network/households/{hid}/dns/stats?window=24h"
            ))
            .await;
        body["total_queries"].as_u64() == Some(1)
    })
    .await;
    let before = server.status();
    assert_eq!(
        before.policy_published_at.timestamp_micros(),
        published.timestamp_micros(),
        "policy age must not be freshened by the event reporter"
    );
    assert!(
        server.management_state().is_none(),
        "no management was configured"
    );
    // Stats become visible on the server before the reporter observes its ack;
    // wait for the operator counter instead of asserting a racing instant.
    wait_until(15, "reporter acknowledgement", || async {
        worker.metrics().acked >= 1
    })
    .await;
    worker.shutdown().await;
    server.stop_shared().await;

    // Restart from the SAME bundle with a different wall clock: the persisted
    // policy age, counters and filter identity survive; only the volatile
    // event queue and its counters start fresh (prior losses stay unknown).
    let (queue2, client2, options2) = worker_parts(&st);
    let restarted =
        DnsServer::start_durable_with_events(durable(Utc::now()), None, Arc::clone(&queue2))
            .await
            .unwrap();
    let after = restarted.status();
    assert_eq!(after.policy_revision, before.policy_revision);
    assert_eq!(
        after.policy_published_at.timestamp_micros(),
        before.policy_published_at.timestamp_micros()
    );
    assert_eq!(after.bundle_generation, before.bundle_generation);
    assert_eq!(after.filter_generation, before.filter_generation);
    assert_eq!(after.filter_identity, before.filter_identity);
    assert!(restarted.management_state().is_none());

    let worker2 = Arc::new(EventWorker::new(&options2, queue2, client2));
    assert_eq!(
        worker2.metrics().emitted,
        0,
        "restarted counters must be honest"
    );
    worker2.start();
    assert_ne!(
        udp_query(restarted.bind_addr(), "allow.test.", mapped_source())
            .await
            .response_code,
        ResponseCode::NXDomain
    );
    wait_until(30, "post-restart observation", || async {
        let (_, body) = http
            .get(&format!(
                "/api/network/households/{hid}/dns/stats?window=24h"
            ))
            .await;
        body["total_queries"].as_u64() == Some(2)
    })
    .await;
    let (_, rows) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?domain=allow.test&limit=10"
        ))
        .await;
    for item in rows["rows"].as_array().unwrap() {
        assert_eq!(item["cache_state"], "unknown");
        assert_eq!(item["upstream"], Value::Null);
    }
    worker2.shutdown().await;
    restarted.stop_shared().await;
}

// ─── Fail-closed negative cases ──────────────────────────────────────────────

#[sqlx::test]
async fn event_worker_fails_closed_on_outage_auth_denial_and_shutdown(pool: PgPool) {
    let st = fixture("negative");
    let (base, ca_pem, _guard) = spawn_server(pool.clone()).await;
    let user = insert_user(&pool, "events-negative").await;
    let (token, csrf) = session_for(&pool, user, "negative").await;
    let http = Http::new(base.clone(), &ca_pem, token, csrf);
    let hid = bootstrap_as(&http, "Negative household").await;
    let gid = create_gateway(&http, hid).await;
    // A credential WITHOUT the explicit command must never gain the scope.
    let weak = issue_cred(&http, hid, gid, vec!["heartbeat"]).await;
    write_inputs(&st, &base, &ca_pem, &weak, hid, gid);

    // Corrupt the origin to an unserved local port: verified TLS against the
    // same CA, but no listener. Reporting must not affect DNS answers.
    let origin_bad = {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let raw = serde_json::json!({
            "origin": format!("https://localhost:{port}"),
            "ca_pem_path": st.ca,
            "credential_file": st.credential,
            "household_id": hid,
            "gateway_id": gid,
            "flush_interval_secs": 1,
            "max_batch": 8,
            "request_timeout_secs": 1,
            "max_response_bytes": 32768,
            "queue_capacity": 8,
            "backoff_secs": 1,
            "max_backoff_secs": 1
        });
        fs::write(&st.options, serde_json::to_vec(&raw).unwrap()).unwrap();
        #[cfg(unix)]
        private(&st.options);
        EventOptions::load(&st.options).unwrap()
    };
    let queue = Arc::new(EventQueue::new(origin_bad.queue_capacity()));
    let client = Arc::new(EventClient::new(&origin_bad).unwrap());
    let worker = Arc::new(EventWorker::new(
        &origin_bad,
        Arc::clone(&queue),
        Arc::clone(&client),
    ));

    let event = synthetic_event("blocked.test.");
    queue.push(event.clone());

    // The REAL loop (no direct flush shortcut): one attempt, exactly one
    // retry, then a counted drop visible through operator metrics.
    worker.start();
    wait_until(15, "one bounded retry then counted drop", || async {
        worker.metrics().dropped_retry >= 1
    })
    .await;
    assert_eq!(worker.metrics().sent, 0);
    worker.shutdown().await;

    // Now point at the real server with a credential that LACKS the command:
    // a permanent 401/403 is counted as rejected, never retried or fabricated.
    write_inputs(&st, &base, &ca_pem, &weak, hid, gid);
    let good = EventOptions::load(&st.options).unwrap();
    let auth_queue = Arc::new(EventQueue::new(8));
    let auth_client = Arc::new(EventClient::new(&good).unwrap());
    let auth_worker = Arc::new(EventWorker::new(
        &good,
        Arc::clone(&auth_queue),
        Arc::clone(&auth_client),
    ));
    auth_queue.push(event);
    auth_worker.start();
    wait_until(15, "scoped auth denial", || async {
        auth_worker.metrics().rejected >= 1
    })
    .await;
    assert_eq!(auth_worker.metrics().sent, 0);
    auth_worker.shutdown().await;
    let (_, stats) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=24h"
        ))
        .await;
    assert_eq!(
        stats["total_queries"].as_u64(),
        Some(0),
        "unscoped credential wrote events"
    );

    // Bounded queue loss: drop-newest with an explicit counter.
    let small = EventQueue::new(2);
    assert!(small.push(synthetic_event("one.test.")));
    assert!(small.push(synthetic_event("two.test.")));
    assert!(!small.push(synthetic_event("three.test.")));
    assert_eq!(small.metrics().lost_queue, 1);

    // Shutdown joins cleanly and restores any in-flight work rather than
    // losing it silently.
    let shutdown_queue = Arc::new(EventQueue::new(8));
    let shutdown_worker = Arc::new(EventWorker::new(
        &good,
        Arc::clone(&shutdown_queue),
        Arc::clone(&auth_client),
    ));
    shutdown_worker.start();
    shutdown_worker.shutdown().await;
    // Join returned; no detached task or socket survives shutdown.
    assert_eq!(shutdown_worker.metrics().sent, 0);
    assert_eq!(shutdown_worker.metrics().queued, 0);
}
