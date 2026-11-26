//! Real-TLS controller integration over the accepted read-policy contract.
//!
//! The mock controller is an actual HTTPS server with a local CA generated in
//! the test; the worker verifies the chain and hostname and never disables
//! TLS checks. DNS answers come from real UDP/TCP listeners, and the durable
//! bundle is persisted to real files.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{serve::Listener, Json, Router};
use chrono::{Duration as ChronoDuration, TimeZone, Utc};
use family_dns::{
    policy_digest, sync_once, ControllerClient, ControllerError, ControllerOptions,
    ControllerPoller, DnsServer, DurableOptions, PolicyReadResponse, SyncCapability,
};
use family_policy::{Effect, Policy, Rule, RuleMatcher};
use hickory_server::proto::op::{Message, ResponseCode};
use hickory_server::proto::rr::RecordType;
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;

use support::{assert_code, tcp_query, test_config, udp_query, HOUSEHOLD};

const WORKER: &str = "dns-worker-1";
const GATEWAY: &str = "22222222-3333-4444-5555-666666666666";
const BEARER: &str =
    "Bearer 22222222-3333-4444-5555-666666666666.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

// ─── Local TLS controller ───────────────────────────────────────────────────

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

#[derive(Clone, Default)]
struct Seen {
    audience: String,
    command: String,
    kind: String,
    authorization: String,
}

struct MockState {
    response: Mutex<PolicyReadResponse>,
    status: Mutex<Option<u16>>,
    seen: Mutex<Vec<Seen>>,
}

async fn mock_handler(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    let bytes = axum::body::to_bytes(body, 256 * 1024)
        .await
        .unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    state.seen.lock().unwrap().push(Seen {
        audience: value["audience"].as_str().unwrap_or_default().to_owned(),
        command: value["command"].as_str().unwrap_or_default().to_owned(),
        kind: value["kind"].as_str().unwrap_or_default().to_owned(),
        authorization: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
    });
    match *state.status.lock().unwrap() {
        Some(code) => axum::http::StatusCode::from_u16(code)
            .unwrap_or(axum::http::StatusCode::BAD_REQUEST)
            .into_response(),
        None => (
            axum::http::StatusCode::OK,
            Json(state.response.lock().unwrap().clone()),
        )
            .into_response(),
    }
}

struct MockGuard {
    task: JoinHandle<()>,
}

impl Drop for MockGuard {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_controller(
    response: PolicyReadResponse,
) -> (String, String, Arc<MockState>, MockGuard) {
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
    let state = Arc::new(MockState {
        response: Mutex::new(response),
        status: Mutex::new(None),
        seen: Mutex::new(Vec::new()),
    });
    let router = Router::new()
        .route("/worker/network/policy/read", post(mock_handler))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tls = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(Arc::new(server_config)),
    };
    let task = tokio::spawn(async move {
        let _ = axum::serve(tls, router).await;
    });
    (
        format!("https://localhost:{port}"),
        ca_pem,
        state,
        MockGuard { task },
    )
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

struct TestState {
    dir: PathBuf,
    config: PathBuf,
    bundle: PathBuf,
    options: PathBuf,
    credential: PathBuf,
    ca: PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn new_state(origin: &str, ca_pem: &str) -> TestState {
    let serial = DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-controller-{}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let config = dir.join("dns.json");
    let bundle = dir.join("state.json");
    let options = dir.join("controller.json");
    let credential = dir.join("credential");
    let ca = dir.join("ca.pem");
    fs::write(&config, test_config(0, "")).unwrap();
    write_private(&credential, BEARER.as_bytes());
    fs::write(&ca, ca_pem).unwrap();
    let opts = json!({
        "controller_origin": origin,
        "ca_pem_path": ca.to_string_lossy(),
        "credential_file": credential.to_string_lossy(),
        "household_id": HOUSEHOLD,
        "gateway_id": GATEWAY,
        "poll_interval_secs": 5,
        "backoff_secs": 1,
        "request_timeout_secs": 5,
        "max_response_bytes": 262144
    });
    write_private(&options, serde_json::to_vec(&opts).unwrap().as_slice());
    TestState {
        dir,
        config,
        bundle,
        options,
        credential,
        ca,
    }
}

fn rule(id: &str, effect: Effect, matcher: RuleMatcher) -> Rule {
    Rule {
        id: id.to_owned(),
        effect,
        matcher,
        schedule: None,
        reason: format!("{id} reason"),
    }
}

fn policy(revision: u64, published_at: chrono::DateTime<Utc>, deny_www: bool) -> Policy {
    let mut adult = vec![rule(
        "allow-example",
        Effect::Allow,
        RuleMatcher::DomainSuffix("example".into()),
    )];
    if deny_www {
        adult.push(rule(
            "deny-www",
            Effect::Deny,
            RuleMatcher::HostExact("www.lab.example".into()),
        ));
    }
    let mut profiles = std::collections::BTreeMap::new();
    profiles.insert("adult".to_owned(), adult);
    profiles.insert(
        "restricted".to_owned(),
        vec![rule(
            "restricted-deny",
            Effect::Deny,
            RuleMatcher::DomainSuffix("example".into()),
        )],
    );
    Policy {
        household_id: Uuid::parse_str(HOUSEHOLD).unwrap(),
        revision,
        baseline: Vec::new(),
        device_profiles: profiles,
        person_rules: std::collections::BTreeMap::new(),
        exceptions: Vec::new(),
        default_effect: Effect::Deny,
        timezone: "UTC".into(),
        stale_after_secs: 30 * 24 * 3600,
        event_retention_secs: 86_400,
        published_at,
    }
}

fn response(policy: Policy) -> PolicyReadResponse {
    let digest = policy_digest(&policy).unwrap();
    PolicyReadResponse {
        gateway_id: Uuid::parse_str(GATEWAY).unwrap(),
        revision: policy.revision,
        original_published_at: policy.published_at,
        schema_version: 1,
        policy,
        body_sha256: digest,
    }
}

async fn start_server(st: &TestState) -> DnsServer {
    DnsServer::start_durable(DurableOptions {
        state_path: st.bundle.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: Utc::now(),
        hooks: None,
    })
    .await
    .unwrap()
}

fn client(st: &TestState) -> ControllerClient {
    ControllerClient::new(&ControllerOptions::load(&st.options).unwrap()).unwrap()
}

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

async fn answer(server: &DnsServer, name: &str, tcp: bool) -> Message {
    if tcp {
        tcp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    } else {
        udp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    }
}

fn v4(message: &Message) -> Vec<IpAddr> {
    message
        .answers
        .iter()
        .filter_map(|record| match &record.data {
            hickory_server::proto::rr::RData::A(a) => Some(IpAddr::V4(a.0)),
            _ => None,
        })
        .collect()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn sync_over_real_tls_changes_udp_and_tcp_answers_without_restart() {
    let now = Utc::now();
    let (origin, ca, mock, _guard) = spawn_controller(response(policy(8, now, true))).await;
    let st = new_state(&origin, &ca);
    let server = start_server(&st).await;
    assert_eq!(server.revision(), 7);

    for tcp in [false, true] {
        let before = answer(&server, "www.lab.example.", tcp).await;
        assert_code(&before, ResponseCode::NoError);
        assert_eq!(v4(&before).len(), 2);
        let blocked = answer(&server, "blocked.lab.example.", tcp).await;
        assert_code(&blocked, ResponseCode::NXDomain);
    }

    let outcome = sync_once(&server, &client(&st), &server.local_config(), now)
        .await
        .unwrap();
    assert_eq!(outcome, SyncCapability::AppliedLocally { revision: 8 });
    assert!(outcome.available());
    assert_eq!(outcome.label(), "applied_locally");
    assert_eq!(server.revision(), 8);
    assert_eq!(server.published_at(), now);

    for tcp in [false, true] {
        let denied = answer(&server, "www.lab.example.", tcp).await;
        assert_code(&denied, ResponseCode::NXDomain);
        assert!(v4(&denied).is_empty());
        // The controller policy removed the exact deny, so this name now
        // resolves from the preserved local zone.
        let allowed = answer(&server, "blocked.lab.example.", tcp).await;
        assert_code(&allowed, ResponseCode::NoError);
        assert!(v4(&allowed).contains(&"192.0.2.99".parse().unwrap()));
    }

    let seen = mock.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].audience, "vantyr-gateway-worker");
    assert_eq!(seen[0].command, "read_policy");
    assert_eq!(seen[0].kind, "dns");
    assert_eq!(seen[0].authorization, BEARER);

    let on_disk: Value = serde_json::from_slice(&fs::read(&st.bundle).unwrap()).unwrap();
    assert_eq!(on_disk["highwater"], 8);
    let stored_publication: chrono::DateTime<Utc> = on_disk["policy"]["policy"]["published_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(stored_publication, now);
    server.stop().await;
}

#[tokio::test]
async fn mismatches_rejections_and_outage_keep_last_known_good() {
    let now = Utc::now();
    let (origin, ca, mock, _guard) = spawn_controller(response(policy(9, now, true))).await;
    let st = new_state(&origin, &ca);
    let server = start_server(&st).await;
    let client = client(&st);
    let base = server.local_config();
    let committed = fs::read(&st.bundle).unwrap();

    // Content digest is integrity, not a signature: a body mismatch rejects.
    {
        let mut bad = mock.response.lock().unwrap().clone();
        bad.body_sha256 = "00".repeat(32);
        *mock.response.lock().unwrap() = bad;
    }
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::Integrity(_))
    ));

    // Outer identity/version/publication mismatches reject before build.
    let original = response(policy(9, now, true));
    let mut cases = Vec::new();
    let mut other_gateway = original.clone();
    other_gateway.gateway_id = Uuid::new_v4();
    cases.push(other_gateway);
    let mut other_household = original.clone();
    other_household.policy.household_id = Uuid::new_v4();
    cases.push(other_household);
    let mut outer_revision = original.clone();
    outer_revision.revision = 10;
    cases.push(outer_revision);
    let mut publication = original.clone();
    publication.original_published_at = now + ChronoDuration::minutes(1);
    cases.push(publication);
    let mut schema = original.clone();
    schema.schema_version = 2;
    cases.push(schema);
    for bad in cases {
        *mock.response.lock().unwrap() = bad;
        assert!(matches!(
            sync_once(&server, &client, &base, now).await,
            Err(ControllerError::Integrity(_))
        ));
    }

    // Unverifiable person rules, category rules and an older revision are
    // refused without touching the served version.
    let mut person = response(policy(9, now, true));
    person
        .policy
        .person_rules
        .insert(Uuid::new_v4(), Vec::new());
    person.body_sha256 = policy_digest(&person.policy).unwrap();
    *mock.response.lock().unwrap() = person;
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::Unsupported(_))
    ));
    let mut category = response(policy(9, now, true));
    if let Some(rules) = category.policy.device_profiles.get_mut("adult") {
        rules[0].matcher = RuleMatcher::Category("social".into());
    }
    category.body_sha256 = policy_digest(&category.policy).unwrap();
    *mock.response.lock().unwrap() = category;
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::Unsupported(_))
    ));
    *mock.response.lock().unwrap() = response(policy(6, now, true));
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::StaleRevision { .. })
    ));

    // Credential expiry/revocation and a missing assignment are decided by
    // the controller's status code; the worker never infers them locally.
    *mock.status.lock().unwrap() = Some(401);
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::AuthDenied)
    ));
    *mock.status.lock().unwrap() = Some(404);
    assert!(matches!(
        sync_once(&server, &client, &base, now).await,
        Err(ControllerError::MissingAssignment)
    ));

    assert_eq!(server.revision(), 7);
    assert_eq!(fs::read(&st.bundle).unwrap(), committed);
    let still_allowed = answer(&server, "www.lab.example.", false).await;
    assert_code(&still_allowed, ResponseCode::NoError);
    assert_eq!(v4(&still_allowed).len(), 2);
    server.stop().await;
}

#[tokio::test]
async fn plain_http_and_wrong_ca_never_reach_a_successful_pull() {
    let now = Utc::now();
    let (origin, ca, _mock, _guard) = spawn_controller(response(policy(8, now, true))).await;
    let st = new_state(&origin, &ca);
    let server = start_server(&st).await;
    let committed = fs::read(&st.bundle).unwrap();

    // A plain-HTTP origin is rejected before any listener or request exists.
    let mut opts: Value = serde_json::from_slice(&fs::read(&st.options).unwrap()).unwrap();
    opts["controller_origin"] = json!(origin.replace("https://", "http://"));
    let mut plain = st.options.clone();
    plain.set_file_name("plain.json");
    write_private(&plain, serde_json::to_vec(&opts).unwrap().as_slice());
    assert!(ControllerOptions::load(&plain).is_err());

    // A different, untrusted CA cannot complete the TLS handshake.
    let other = test_cert();
    let mut wrong_ca = st.ca.clone();
    wrong_ca.set_file_name("wrong-ca.pem");
    fs::write(&wrong_ca, other.ca_pem).unwrap();
    opts["controller_origin"] = json!(origin);
    opts["ca_pem_path"] = json!(wrong_ca.to_string_lossy());
    let mut wrong_opts = st.options.clone();
    wrong_opts.set_file_name("wrong-ca.json");
    write_private(&wrong_opts, serde_json::to_vec(&opts).unwrap().as_slice());
    let client = ControllerClient::new(&ControllerOptions::load(&wrong_opts).unwrap()).unwrap();
    assert!(matches!(
        sync_once(&server, &client, &server.local_config(), now).await,
        Err(ControllerError::Transport)
    ));

    assert_eq!(server.revision(), 7);
    assert_eq!(fs::read(&st.bundle).unwrap(), committed);
    server.stop().await;
}

#[tokio::test]
async fn same_revision_is_idempotent_or_conflicting_and_never_freshens_age() {
    let published = Utc.timestamp_opt(1_760_000_000, 0).unwrap();
    let (origin, ca, mock, _guard) = spawn_controller(response(policy(8, published, true))).await;
    let st = new_state(&origin, &ca);
    let server = start_server(&st).await;
    let client = client(&st);
    let base = server.local_config();

    assert_eq!(
        sync_once(&server, &client, &base, Utc::now())
            .await
            .unwrap(),
        SyncCapability::AppliedLocally { revision: 8 }
    );
    let committed = fs::read(&st.bundle).unwrap();
    assert_eq!(server.published_at(), published);

    // Same revision, same content: no write and no reset of the save time.
    assert_eq!(
        sync_once(
            &server,
            &client,
            &base,
            Utc::now() + ChronoDuration::hours(1)
        )
        .await
        .unwrap(),
        SyncCapability::Unchanged { revision: 8 }
    );
    assert_eq!(fs::read(&st.bundle).unwrap(), committed);
    assert_eq!(server.published_at(), published);

    // Same revision, different content is rejected before any persistence.
    let mut changed = response(policy(8, published, true));
    if let Some(rules) = changed.policy.device_profiles.get_mut("adult") {
        rules[0].reason = "different reason".into();
    }
    changed.body_sha256 = policy_digest(&changed.policy).unwrap();
    *mock.response.lock().unwrap() = changed;
    assert!(matches!(
        sync_once(&server, &client, &base, Utc::now()).await,
        Err(ControllerError::SameRevisionConflict(8))
    ));
    assert_eq!(fs::read(&st.bundle).unwrap(), committed);
    assert_eq!(server.revision(), 8);
    assert_eq!(server.published_at(), published);
    server.stop().await;
}

#[tokio::test]
async fn lost_ack_restart_and_stale_outage_keep_the_original_policy_age() {
    let stale_published = Utc::now() - ChronoDuration::days(10);
    let mut source = policy(8, stale_published, false);
    source.stale_after_secs = 3600;
    let (origin, ca, _mock, guard) = spawn_controller(response(source)).await;
    let st = new_state(&origin, &ca);
    let now = Utc::now();
    let first = DnsServer::start_durable(DurableOptions {
        state_path: st.bundle.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now,
        hooks: None,
    })
    .await
    .unwrap();
    sync_once(&first, &client(&st), &first.local_config(), now)
        .await
        .unwrap();
    // Fresh policy allows; an aged one fails closed for new allows.
    let denied = answer(&first, "www.lab.example.", false).await;
    assert_code(&denied, ResponseCode::NXDomain);
    assert!(first
        .observations()
        .iter()
        .any(|o| o.reason_code == "stale_policy_fail_closed"));
    first.stop().await;

    // The controller disappears and the local config advances, but a lost-ack
    // restart must keep the bundle and its original (already stale) age.
    drop(guard);
    fs::write(
        &st.config,
        support::test_config(0, "").replace("\"policy_revision\": 7", "\"policy_revision\": 42"),
    )
    .unwrap();
    let restarted = start_server(&st).await;
    assert_eq!(restarted.revision(), 8);
    assert_eq!(restarted.published_at(), stale_published);
    let still_denied = answer(&restarted, "www.lab.example.", true).await;
    assert_code(&still_denied, ResponseCode::NXDomain);
    let store = family_dns::BundleStore::open_from_snapshot(
        &st.bundle,
        WORKER,
        family_dns::BundleValidator,
    )
    .unwrap();
    assert_eq!(
        store.snapshot().unwrap().policy.published_at(),
        stale_published
    );
    restarted.stop().await;
}

#[tokio::test]
async fn concurrent_local_reload_and_controller_pull_stay_monotonic() {
    let now = Utc::now();
    let (origin, ca, _mock, _guard) = spawn_controller(response(policy(10, now, true))).await;
    let st = new_state(&origin, &ca);
    let server = Arc::new(start_server(&st).await);
    let base = server.local_config();
    let client = Arc::new(client(&st));

    let local = {
        let server = Arc::clone(&server);
        tokio::spawn(async move {
            let candidate = support::test_config(0, "")
                .replace("\"policy_revision\": 7", "\"policy_revision\": 9")
                .replace("192.0.2.10", "192.0.2.20");
            server.reload(candidate.as_bytes(), now).ok()
        })
    };
    let controller = {
        let server = Arc::clone(&server);
        async move { sync_once(&server, &client, &base, now).await.unwrap() }
    };
    let (local, controller) = tokio::join!(local, controller);
    let _local = local.unwrap();
    assert_eq!(controller, SyncCapability::AppliedLocally { revision: 10 });
    assert_eq!(server.revision(), 10);

    // The controller policy is authoritative and the version is whole.
    for _ in 0..8 {
        let response = answer(&server, "www.lab.example.", false).await;
        assert_code(&response, ResponseCode::NXDomain);
    }
    let server = Arc::try_unwrap(server)
        .ok()
        .expect("no tasks hold the server");
    server.stop().await;
}

#[tokio::test]
async fn poll_has_one_in_flight_pull_and_stops_cleanly() {
    let now = Utc::now();
    let (origin, ca, mock, _guard) = spawn_controller(response(policy(8, now, false))).await;
    let st = new_state(&origin, &ca);
    let server = Arc::new(start_server(&st).await);
    let options = ControllerOptions::load(&st.options).unwrap();
    let client = Arc::new(ControllerClient::new(&options).unwrap());
    let base = server.local_config();

    // No secret appears in any diagnostic rendering.
    let debug = format!("{:?} {:?} {:?}", options, client, st.credential);
    assert!(!debug.contains("aaaaaaaaaaaaaaaa"));
    assert!(format!("{}", ControllerError::AuthDenied).contains("401/403"));
    assert!(!format!("{:?}", ControllerError::AuthDenied).contains("aaaaaaaa"));

    let poller = ControllerPoller::start(Arc::clone(&server), client, base, options);
    // Poll interval is bounded to a minimum of five seconds.
    tokio::time::sleep(Duration::from_millis(5600)).await;
    poller.stop().await;
    let count = mock.seen.lock().unwrap().len();
    assert!(count >= 1, "the poll loop never pulled");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        mock.seen.lock().unwrap().len(),
        count,
        "poll kept running after stop"
    );
    assert_eq!(server.revision(), 8);
    let server = Arc::try_unwrap(server)
        .ok()
        .expect("poll task joined on stop");
    server.stop().await;
}
