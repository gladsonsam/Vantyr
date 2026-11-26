//! Verified encrypted UPSTREAM DoT/DoH against real local TLS servers with a
//! generated CA. All worker transport/security paths are production code;
//! only the mock resolvers are local test fixtures. No encrypted listener,
//! plaintext fallback, system resolver or live provider is used.

mod support;

use std::collections::BTreeMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_dns::{Config, DnsServer, DurableOptions, SyncCapability, MAX_CA_PEM_BYTES};
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::server::Server;
use hickory_server::zone_handler::{AxfrPolicy, Catalog, ZoneType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::json;
use support::{assert_code, assert_flags, udp_query, HOUSEHOLD};

const WORKER: &str = "dns-encrypted-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
const ANSWER: &str = "192.0.2.77";
static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Cert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

fn cert_for(names: &[&str]) -> Cert {
    let mut ca_params = CertificateParams::new(vec!["local test ca".to_owned()]).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();

    let dns_names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let leaf_params = CertificateParams::new(dns_names).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    Cert {
        ca_pem: ca_cert.pem(),
        cert_der: leaf.der().as_ref().to_vec(),
        key_der: leaf_key.serialize_der(),
    }
}

struct Guard(tokio::task::JoinHandle<()>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn tls_config(cert: &Cert, alpn: &[&str]) -> Arc<ServerConfig> {
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
    config.alpn_protocols = alpn.iter().map(|value| value.as_bytes().to_vec()).collect();
    Arc::new(config)
}

async fn mock_catalog() -> Catalog {
    let origin = Name::from_str("secure.example.").unwrap();
    let name = Name::from_str("app.secure.example.").unwrap();
    let mut map = BTreeMap::new();
    let soa = Record::from_rdata(
        origin.clone(),
        3600,
        RData::SOA(hickory_server::proto::rr::rdata::SOA::new(
            origin.clone(),
            Name::from_str("hostmaster.invalid.").unwrap(),
            1,
            3600,
            600,
            86400,
            60,
        )),
    );
    map.insert(
        RrKey::new(origin.clone().into(), RecordType::SOA),
        soa.into(),
    );
    let key = RrKey::new(name.clone().into(), RecordType::A);
    let mut set = RecordSet::with_ttl(name.clone(), RecordType::A, 60);
    set.insert(
        Record::from_rdata(
            name,
            60,
            RData::A(AData::from(ANSWER.parse::<Ipv4Addr>().unwrap())),
        ),
        0,
    );
    map.insert(key, set);
    let handler =
        hickory_server::store::in_memory::InMemoryZoneHandler::<TokioRuntimeProvider>::new(
            origin.clone(),
            map,
            ZoneType::Primary,
            AxfrPolicy::Deny,
        )
        .unwrap();
    let mut catalog = Catalog::new();
    catalog.upsert(origin.into(), vec![Arc::new(handler)]);
    catalog
}

async fn spawn_dot(names: &[&str], alpn: &[&str]) -> (u16, String, Guard) {
    let cert = cert_for(names);
    let ca_pem = cert.ca_pem.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = Server::new(mock_catalog().await);
    server
        .register_tls_listener_with_tls_config(
            listener,
            Duration::from_secs(5),
            tls_config(&cert, alpn),
        )
        .unwrap();
    let handle = tokio::spawn(async move {
        let _ = server.block_until_done().await;
    });
    (port, ca_pem, Guard(handle))
}

async fn spawn_doh(names: &[&str], endpoint: &str) -> (u16, String, Guard) {
    let cert = cert_for(names);
    let ca_pem = cert.ca_pem.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = Server::new(mock_catalog().await);
    server
        .register_https_listener_with_tls_config(
            listener,
            Duration::from_secs(5),
            tls_config(&cert, &["h2"]),
            None,
            endpoint.to_owned(),
        )
        .unwrap();
    let handle = tokio::spawn(async move {
        let _ = server.block_until_done().await;
    });
    (port, ca_pem, Guard(handle))
}

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-encrypted-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    Fixture {
        config: dir.join("dns.json"),
        state: dir.join("state.json"),
        dir,
    }
}

fn config(port: u16, revision: u64, spec: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "household_id": HOUSEHOLD,
        "policy_published_at": STAMP,
        "policy_revision": revision,
        "bind": { "address": "127.0.0.1", "port": port },
        "deny": { "mode": "nxdomain" },
        "local_zones": {},
        "profiles": {
            "adult": [{ "effect": "allow", "match": { "type": "suffix", "value": "example" }, "reason": "adult" }],
            "restricted": [{ "effect": "deny", "match": { "type": "suffix", "value": "example" }, "reason": "restricted" }]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "adult",
            "source_ips": ["127.0.0.2"]
        }],
        "encrypted_upstreams": [spec]
    }))
    .unwrap()
}

fn dot_spec(port: u16, name: &str, ca: Option<&str>) -> serde_json::Value {
    let mut value = json!({
        "scheme": "dot",
        "bootstrap": "127.0.0.1",
        "port": port,
        "server_name": name
    });
    if let Some(ca) = ca {
        value["ca_pem"] = json!(ca);
    }
    value
}

fn doh_spec(port: u16, name: &str, path: &str, ca: Option<&str>) -> serde_json::Value {
    let mut value = json!({
        "scheme": "doh",
        "bootstrap": "127.0.0.1",
        "port": port,
        "server_name": name,
        "path": path
    });
    if let Some(ca) = ca {
        value["ca_pem"] = json!(ca);
    }
    value
}

async fn answer(server: &DnsServer) -> hickory_server::proto::op::Message {
    udp_query(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
        server.bind_addr(),
        "app.secure.example.",
        RecordType::A,
    )
    .await
}

fn assert_answered(message: &hickory_server::proto::op::Message) {
    assert_code(message, hickory_server::proto::op::ResponseCode::NoError);
    assert_flags(message);
    assert!(message.answers.iter().any(|record| match &record.data {
        RData::A(AData(ip)) => ip.to_string() == ANSWER,
        _ => false,
    }));
}

fn options(st: &Fixture, now: DateTime<Utc>) -> DurableOptions {
    DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now,
        hooks: None,
    }
}

#[tokio::test]
async fn dot_trusted_ca_answers_on_udp_and_tcp() {
    let (port, ca, _guard) = spawn_dot(&["dns.example.test"], &["dot"]).await;
    let st = fixture("dot-ok");
    fs::write(
        &st.config,
        config(0, 2, dot_spec(port, "dns.example.test", Some(&ca))),
    )
    .unwrap();
    let server = DnsServer::start(Config::parse(&fs::read(&st.config).unwrap()).unwrap())
        .await
        .unwrap();
    assert_answered(&answer(&server).await);
    let tcp = support::tcp_query(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
        server.bind_addr(),
        "app.secure.example.",
        RecordType::A,
    )
    .await;
    assert_answered(&tcp);
    server.stop().await;
}

#[tokio::test]
async fn doh_trusted_ca_and_custom_path_answers() {
    let (port, ca, _guard) = spawn_doh(&["dns.example.test"], "/custom-dns-query").await;
    let st = fixture("doh-ok");
    fs::write(
        &st.config,
        config(
            0,
            2,
            doh_spec(port, "dns.example.test", "/custom-dns-query", Some(&ca)),
        ),
    )
    .unwrap();
    let server = DnsServer::start(Config::parse(&fs::read(&st.config).unwrap()).unwrap())
        .await
        .unwrap();
    assert_answered(&answer(&server).await);
    server.stop().await;
}

#[tokio::test]
async fn dot_rejects_unrelated_ca_missing_ca_and_wrong_name() {
    let (port, ca, _guard) = spawn_dot(&["dns.example.test"], &["dot"]).await;
    let unrelated = cert_for(&["unrelated.invalid"]).ca_pem;
    let mut cases = Vec::new();
    cases.push(dot_spec(port, "dns.example.test", Some(&unrelated)));
    cases.push(dot_spec(port, "dns.example.test", None));
    cases.push(dot_spec(port, "other.example.test", Some(&ca)));
    for (index, spec) in cases.into_iter().enumerate() {
        let cfg = Config::parse(&config(0, 2, spec)).unwrap();
        let server = DnsServer::start(cfg).await.unwrap();
        let message = answer(&server).await;
        assert!(
            message.response_code != hickory_server::proto::op::ResponseCode::NoError
                || message.answers.is_empty(),
            "case {index} must not accept an unverified upstream"
        );
        server.stop().await;
    }
}

#[tokio::test]
async fn literal_bootstrap_succeeds_with_unresolvable_verified_name() {
    let name = "no-such-host.invalid";
    let (port, ca, _guard) = spawn_dot(&[name], &["dot"]).await;
    let cfg = Config::parse(&config(0, 2, dot_spec(port, name, Some(&ca)))).unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    assert_answered(&answer(&server).await);
    server.stop().await;
}

#[tokio::test]
async fn encrypted_route_never_falls_back_to_plaintext_on_the_same_port() {
    use std::sync::atomic::AtomicBool;

    let (port, ca, _guard) = spawn_dot(&["dns.example.test"], &["dot"]).await;
    // A plaintext UDP listener on the same port would receive any accidental
    // plaintext fallback. It answers nothing; we only count datagrams.
    let udp = std::net::UdpSocket::bind(("127.0.0.1", port)).unwrap();
    udp.set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let hits = Arc::new(AtomicU64::new(0));
    let stop_reader = stop.clone();
    let hits_reader = hits.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        while !stop_reader.load(Ordering::SeqCst) {
            match udp.recv_from(&mut buf) {
                Ok(_) => {
                    hits_reader.fetch_add(1, Ordering::SeqCst);
                }
                Err(ref error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
    });

    let cfg = Config::parse(&config(0, 2, dot_spec(port, "dns.example.test", Some(&ca)))).unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    assert_answered(&answer(&server).await);
    server.stop().await;
    stop.store(true, Ordering::SeqCst);
    reader.join().unwrap();
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "encrypted upstream must never send a plaintext query"
    );
}

#[tokio::test]
async fn plaintext_upstreams_are_never_added_and_bounds_fail_before_bind() {
    let good = dot_spec(853, "dns.example.test", Some("unused"));
    let mixed = json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "bind": { "address": "127.0.0.1", "port": 15400 },
        "upstreams": ["127.0.0.1:5353"],
        "encrypted_upstreams": [good.clone()]
    });
    assert!(Config::parse(serde_json::to_vec(&mixed).unwrap().as_slice()).is_err());

    let self_loop = json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "bind": { "address": "127.0.0.1", "port": 15400 },
        "encrypted_upstreams": [dot_spec(15400, "dns.example.test", None)]
    });
    assert!(Config::parse(serde_json::to_vec(&self_loop).unwrap().as_slice()).is_err());

    let url_bootstrap = json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "encrypted_upstreams": [{
            "scheme": "doh", "bootstrap": "https://example.invalid@1.2.3.4",
            "server_name": "dns.example.test", "path": "/dns-query"
        }]
    });
    assert!(Config::parse(serde_json::to_vec(&url_bootstrap).unwrap().as_slice()).is_err());

    let oversized_ca = json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "encrypted_upstreams": [dot_spec(853, "dns.example.test", Some(&"x".repeat(MAX_CA_PEM_BYTES + 1)))]
    });
    assert!(Config::parse(serde_json::to_vec(&oversized_ca).unwrap().as_slice()).is_err());

    let zero_port = json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "encrypted_upstreams": [dot_spec(0, "dns.example.test", None)]
    });
    assert!(Config::parse(serde_json::to_vec(&zero_port).unwrap().as_slice()).is_err());
}

#[tokio::test]
async fn failed_reload_and_controller_pull_keep_the_encrypted_route() {
    let (port, ca, _guard) = spawn_dot(&["dns.example.test"], &["dot"]).await;
    let st = fixture("reload-controller");
    let valid = config(0, 2, dot_spec(port, "dns.example.test", Some(&ca)));
    fs::write(&st.config, &valid).unwrap();
    let server = DnsServer::start_durable(options(&st, STAMP.parse().unwrap()))
        .await
        .unwrap();
    assert_answered(&answer(&server).await);

    // A candidate with an unverifiable CA is rejected entirely.
    let bad = config(0, 3, dot_spec(port, "dns.example.test", Some("not-a-ca")));
    assert!(server.reload(&bad, Utc::now()).is_err());
    assert_answered(&answer(&server).await);

    // A controller policy update preserves the local encrypted upstream.
    let mut local = server.local_config();
    local.policy_revision = 4;
    let policy = local.policy_at(STAMP.parse().unwrap());
    assert!(matches!(
        server.apply_controller_policy(&policy, Utc::now()).unwrap(),
        SyncCapability::AppliedLocally { revision: 4 }
    ));
    assert_answered(&answer(&server).await);
    server.stop().await;
}

#[tokio::test]
async fn durable_restart_keeps_encrypted_route_after_external_config_change() {
    let (port, ca, _guard) = spawn_dot(&["dns.example.test"], &["dot"]).await;
    let st = fixture("restart");
    let valid = config(0, 2, dot_spec(port, "dns.example.test", Some(&ca)));
    fs::write(&st.config, &valid).unwrap();
    let server = DnsServer::start_durable(options(&st, STAMP.parse().unwrap()))
        .await
        .unwrap();
    assert_answered(&answer(&server).await);
    server.stop().await;

    // The external config changes to a plaintext upstream and the CA file
    // disappears; the single bundle remains authoritative with original age.
    fs::write(
        &st.config,
        serde_json::to_vec(&json!({
            "household_id": HOUSEHOLD,
            "policy_revision": 99,
            "bind": { "address": "127.0.0.1", "port": 0 },
            "upstreams": ["127.0.0.1:5353"]
        }))
        .unwrap(),
    )
    .unwrap();
    let restarted = DnsServer::start_durable(options(&st, Utc::now()))
        .await
        .unwrap();
    assert_eq!(
        restarted.published_at(),
        STAMP.parse::<DateTime<Utc>>().unwrap()
    );
    assert_eq!(restarted.revision(), 2);
    assert_answered(&answer(&restarted).await);
    restarted.stop().await;
}
