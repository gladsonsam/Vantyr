//! Real-loopback DoH SERVER listener tests. The certificate/key material and
//! the client are generated locally with maintained crates; the DoH client is
//! reqwest with its http2 feature (real CA verification and real SNI, no
//! `danger()` / verification skip). Only the worker config/state paths are test
//! fixtures; all listener, policy and custody code under test is production
//! code. The client source is always the accepted socket: no forwarding header
//! is consulted, and per-client path identities are deliberately not tested
//! because they are out of scope.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use family_dns::{Config, DnsServer, DurableOptions};
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{Name, RData, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use reqwest::Method;
use rustls::pki_types::{CertificateDer, ServerName};
use serde_json::{json, Value};
use support::{assert_code, assert_flags, HOUSEHOLD};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const WORKER: &str = "dns-doh-listener-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
const ANSWER: &str = "192.0.2.55";
const HOSTNAME: &str = "dns.example.test";
const PATH: &str = "/dns-query";
static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Cert {
    ca_pem: String,
    cert_pem: String,
    key_pem: String,
}

/// Generate a leaf signed by a fresh local CA. `expired` produces a leaf whose
/// whole validity window is in the past, without touching the host clock.
fn cert_for(names: &[&str], expired: bool) -> Cert {
    let mut ca_params = CertificateParams::new(vec!["local doh test ca".to_owned()]).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();

    let dns_names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let mut leaf_params = CertificateParams::new(dns_names).unwrap();
    if expired {
        leaf_params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        leaf_params.not_after = rcgen::date_time_ymd(2021, 1, 1);
    }
    let leaf_key = KeyPair::generate().unwrap();
    let issuer = Issuer::from_params(&ca_params, &ca_key);
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    Cert {
        ca_pem: ca_cert.pem(),
        cert_pem: leaf.pem(),
        key_pem: leaf_key.serialize_pem(),
    }
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}

/// Two distinct ports held at once: the plaintext and encrypted listeners
/// must never collide in these tests.
fn two_free_ports() -> (u16, u16) {
    let a = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let b = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    (
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    )
}

struct Fixture {
    dir: PathBuf,
    cert: PathBuf,
    key: PathBuf,
    config: PathBuf,
    state: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn new(name: &str) -> Self {
        let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "vantyr-doh-listener-{}-{name}-{serial}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self {
            cert: dir.join("server.pem"),
            key: dir.join("server.key"),
            config: dir.join("dns.json"),
            state: dir.join("state.json"),
            dir,
        }
    }

    /// Write material with the protected 0600 key mode the worker requires.
    fn write_material(&self, cert: &Cert) {
        fs::write(&self.cert, &cert.cert_pem).unwrap();
        fs::write(&self.key, &cert.key_pem).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.key, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}

fn doh_spec(port: u16, cert: &str, key: &str, enabled: bool) -> Value {
    json!({
        "enabled": enabled,
        "bind": { "address": "127.0.0.1", "port": port },
        "hostname": HOSTNAME,
        "path": PATH,
        "cert_path": cert,
        "key_path": key
    })
}

fn dot_spec(port: u16, cert: &str, key: &str) -> Value {
    json!({
        "enabled": true,
        "bind": { "address": "127.0.0.1", "port": port },
        "cert_path": cert,
        "key_path": key
    })
}

fn config(plain_port: u16, doh: Value, dot: Option<Value>) -> Vec<u8> {
    let mut value = json!({
        "household_id": HOUSEHOLD,
        "policy_published_at": STAMP,
        "policy_revision": 2,
        "bind": { "address": "127.0.0.1", "port": plain_port },
        "deny": { "mode": "nxdomain" },
        "local_zones": { "allowed.example.": [
            { "type": "a", "name": "www.allowed.example.", "ttl": 60, "addr": ANSWER }
        ]},
        "profiles": {
            "test": [
                { "effect": "allow", "match": { "type": "exact", "value": "www.allowed.example" }, "reason": "allow" },
                { "effect": "deny", "match": { "type": "exact", "value": "blocked.example" }, "reason": "deny" }
            ],
            "restricted": [
                { "effect": "deny", "match": { "type": "any" }, "reason": "default deny" }
            ]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "test",
            "source_ips": ["127.0.0.1"]
        }],
        "doh_listener": doh
    });
    if let Some(dot) = dot {
        value["dot_listener"] = dot;
    }
    serde_json::to_vec(&value).unwrap()
}

fn dns_query_bytes(name: &str) -> Vec<u8> {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
    message.to_vec().unwrap()
}

struct TlsTrust<'a> {
    ca_pem: &'a str,
    server_name: &'a str,
}

/// One raw DoH request through a normal verifying reqwest client. Every part
/// of the request (method, path, headers, body, trust root and verification
/// name) is caller-controlled so malformed cases are expressible here.
async fn doh_request(
    server: SocketAddr,
    method: Method,
    path_and_query: &str,
    accept: Option<&str>,
    content_type: Option<&str>,
    body: Option<Vec<u8>>,
    trust: TlsTrust<'_>,
) -> Result<Vec<u8>, String> {
    let TlsTrust {
        ca_pem,
        server_name,
    } = trust;
    let cert =
        reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|error| error.to_string())?;
    // `tls_certs_only` trusts exactly this generated CA: real rustls path and
    // hostname verification, with no platform roots and no verifier bypass.
    let client = reqwest::Client::builder()
        .tls_certs_only([cert])
        .resolve(server_name, server)
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("https://{server_name}:{}{}", server.port(), path_and_query);
    let mut request = client.request(method, &url);
    if let Some(value) = accept {
        request = request.header(reqwest::header::ACCEPT, value);
    }
    if let Some(value) = content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, value);
    }
    if let Some(value) = body {
        request = request.body(value);
    }
    let response = tokio::time::timeout(Duration::from_secs(8), request.send())
        .await
        .map_err(|_| "DoH request timed out".to_owned())?
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("unexpected HTTP status {}", response.status()));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

async fn doh_get(
    server: SocketAddr,
    name: &str,
    ca_pem: &str,
    server_name: &str,
    path: &str,
) -> Result<Message, String> {
    let encoded = URL_SAFE_NO_PAD.encode(dns_query_bytes(name));
    let bytes = doh_request(
        server,
        Method::GET,
        &format!("{path}?dns={encoded}"),
        Some("application/dns-message"),
        None,
        None,
        TlsTrust {
            ca_pem,
            server_name,
        },
    )
    .await?;
    Message::from_vec(&bytes).map_err(|error| error.to_string())
}

async fn doh_post(
    server: SocketAddr,
    name: &str,
    ca_pem: &str,
    server_name: &str,
    path: &str,
    content_type: &str,
) -> Result<Message, String> {
    let bytes = doh_request(
        server,
        Method::POST,
        path,
        Some("application/dns-message"),
        Some(content_type),
        Some(dns_query_bytes(name)),
        TlsTrust {
            ca_pem,
            server_name,
        },
    )
    .await?;
    Message::from_vec(&bytes).map_err(|error| error.to_string())
}

/// Maintained rustls DoT client, used only by the coexistence test.
async fn dot_query(
    server: SocketAddr,
    name: &str,
    ca_pem: &str,
    server_name: &str,
) -> Result<Message, String> {
    let tcp = tokio::net::TcpStream::connect(server)
        .await
        .map_err(|error| error.to_string())?;
    let mut roots = rustls::RootCertStore::empty();
    for block in pem::parse_many(ca_pem).map_err(|error| error.to_string())? {
        roots
            .add(CertificateDer::from(block.contents().to_vec()))
            .map_err(|error| error.to_string())?;
    }
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut client = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    client.alpn_protocols = vec![b"dot".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let sni = ServerName::try_from(server_name)
        .map_err(|error| error.to_string())?
        .to_owned();
    let mut stream = connector
        .connect(sni, tcp)
        .await
        .map_err(|error| format!("TLS handshake failed: {error}"))?;
    let bytes = dns_query_bytes(name);
    stream
        .write_all(&(bytes.len() as u16).to_be_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut prefix))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; u16::from_be_bytes(prefix) as usize];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut buffer))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Message::from_vec(&buffer).map_err(|error| error.to_string())
}

#[tokio::test]
async fn trusted_doh_client_get_and_post_answer_allowed_and_denied_with_flags() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("trusted");
    st.write_material(&cert);
    let (plain_port, doh_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
        None,
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doh_port);

    for response in [
        doh_get(addr, "www.allowed.example.", &cert.ca_pem, HOSTNAME, PATH)
            .await
            .expect("trusted GET must complete the handshake"),
        doh_post(
            addr,
            "www.allowed.example.",
            &cert.ca_pem,
            HOSTNAME,
            PATH,
            "application/dns-message",
        )
        .await
        .expect("trusted POST must complete the handshake"),
    ] {
        assert_code(&response, ResponseCode::NoError);
        assert_flags(&response);
        assert!(
            response.answers.iter().any(|record| matches!(
                &record.data,
                RData::A(AData(ip)) if ip.to_string() == ANSWER
            )),
            "allowed query must carry the local-zone answer over DoH"
        );
    }
    for response in [
        doh_get(addr, "blocked.example.", &cert.ca_pem, HOSTNAME, PATH)
            .await
            .expect("trusted GET must answer a denied query"),
        doh_post(
            addr,
            "blocked.example.",
            &cert.ca_pem,
            HOSTNAME,
            PATH,
            "application/dns-message",
        )
        .await
        .expect("trusted POST must answer a denied query"),
    ] {
        assert_code(&response, ResponseCode::NXDomain);
        assert_flags(&response);
    }
    server.stop().await;
}

#[tokio::test]
async fn wrong_ca_and_wrong_hostname_are_rejected() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("verification");
    st.write_material(&cert);
    let (plain_port, doh_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
        None,
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doh_port);

    assert!(
        doh_get(addr, "www.allowed.example.", &cert.ca_pem, HOSTNAME, PATH)
            .await
            .is_ok()
    );
    let unrelated = cert_for(&["unrelated.invalid"], false).ca_pem;
    assert!(
        doh_get(addr, "www.allowed.example.", &unrelated, HOSTNAME, PATH)
            .await
            .is_err(),
        "wrong CA must not verify the server chain"
    );
    assert!(
        doh_get(
            addr,
            "www.allowed.example.",
            &cert.ca_pem,
            "wrong.example.test",
            PATH
        )
        .await
        .is_err(),
        "wrong hostname must not verify the server chain"
    );
    server.stop().await;
}

#[tokio::test]
async fn malformed_method_path_and_content_type_produce_no_dns_egress() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("malformed");
    st.write_material(&cert);
    let (plain_port, doh_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
        None,
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doh_port);
    let encoded = URL_SAFE_NO_PAD.encode(dns_query_bytes("www.allowed.example."));

    let bad_method = doh_request(
        addr,
        Method::PUT,
        PATH,
        Some("application/dns-message"),
        Some("application/dns-message"),
        Some(dns_query_bytes("www.allowed.example.")),
        TlsTrust {
            ca_pem: &cert.ca_pem,
            server_name: HOSTNAME,
        },
    )
    .await
    .map(|_| ());
    let bad_path = doh_request(
        addr,
        Method::GET,
        &format!("/not-dns-query?dns={encoded}"),
        Some("application/dns-message"),
        None,
        None,
        TlsTrust {
            ca_pem: &cert.ca_pem,
            server_name: HOSTNAME,
        },
    )
    .await
    .map(|_| ());
    let bad_content_type = doh_post(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        HOSTNAME,
        PATH,
        "text/plain",
    )
    .await
    .map(|_| ());

    for (label, result) in [
        ("method", bad_method),
        ("path", bad_path),
        ("content type", bad_content_type),
    ] {
        assert!(
            result.is_err(),
            "malformed {label} must not produce a DNS answer"
        );
    }
    // No request reached the policy handler, so no decision was observed and
    // no DNS lookup was issued on any path.
    assert!(
        server.observations().is_empty(),
        "malformed requests must not reach the DNS handler"
    );
    server.stop().await;
}

#[tokio::test]
async fn disabled_listener_binds_no_port_and_stop_releases_the_listener() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("disabled");
    st.write_material(&cert);
    let (plain_port, doh_port) = two_free_ports();

    let disabled = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            false,
        ),
        None,
    ))
    .unwrap();
    let server = DnsServer::start(disabled).await.unwrap();
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh_port))
            .await
            .is_ok(),
        "enabled = false must leave the DoH port free"
    );
    server.stop().await;

    let enabled = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
        None,
    ))
    .unwrap();
    let server = DnsServer::start(enabled).await.unwrap();
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh_port))
            .await
            .is_err(),
        "the enabled DoH listener must hold the port"
    );
    server.stop().await;
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh_port))
            .await
            .is_ok(),
        "stop must release the listener"
    );
}

#[tokio::test]
async fn bad_custody_consistency_and_expiry_fail_before_a_listener_exists() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("custody");
    st.write_material(&cert);
    let doh_port = free_port();
    let spec = doh_spec(
        doh_port,
        st.cert.to_str().unwrap(),
        st.key.to_str().unwrap(),
        true,
    );

    // Mismatched key: rustls consistency check rejects before a bind.
    let other = cert_for(&[HOSTNAME], false);
    fs::write(&st.key, &other.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(free_port(), spec.clone(), None)).unwrap())
            .await
            .is_err()
    );
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh_port))
            .await
            .is_ok(),
        "a custody failure must leave no listener"
    );

    // 0644 private key: protected reading rejects it.
    st.write_material(&cert);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(free_port(), spec.clone(), None)).unwrap())
            .await
            .is_err()
    );

    // Expired leaf: maintained X.509 validity parser rejects it.
    st.write_material(&cert);
    let expired = cert_for(&[HOSTNAME], true);
    fs::write(&st.key, &expired.key_pem).unwrap();
    fs::write(&st.cert, &expired.cert_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(free_port(), spec.clone(), None)).unwrap())
            .await
            .is_err()
    );

    // Symlinked key: no-symlink rule rejects it.
    st.write_material(&cert);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let real = st.dir.join("real.key");
        fs::write(&real, &cert.key_pem).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let _ = fs::remove_file(&st.key);
        std::os::unix::fs::symlink(&real, &st.key).unwrap();
        assert!(
            DnsServer::start(Config::parse(&config(free_port(), spec, None)).unwrap())
                .await
                .is_err(),
            "a symlinked private key must be rejected"
        );
    }
}

/// A fresh durable start must reject bad certificate custody BEFORE it writes
/// the state file or binds either socket.
#[tokio::test]
async fn fresh_durable_start_with_invalid_custody_writes_no_state_and_releases_ports() {
    let valid = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("durable-invalid");
    st.write_material(&valid);
    let (plain_port, doh_port) = two_free_ports();
    fs::write(
        &st.config,
        config(
            plain_port,
            doh_spec(
                doh_port,
                st.cert.to_str().unwrap(),
                st.key.to_str().unwrap(),
                true,
            ),
            None,
        ),
    )
    .unwrap();
    let options = DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: STAMP.parse().unwrap(),
        hooks: None,
    };

    // Mismatched key: rustls consistency rejects before the bundle is applied.
    let other = cert_for(&[HOSTNAME], false);
    fs::write(&st.key, &other.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(DnsServer::start_durable(options.clone()).await.is_err());
    assert!(
        !st.state.exists(),
        "a failed durable start must not write state"
    );
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", plain_port))
            .await
            .is_ok(),
        "the plaintext port must be released after a failed start"
    );
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh_port))
            .await
            .is_ok(),
        "the DoH port must be released after a failed start"
    );

    // Expired leaf: the maintained X.509 validity parser rejects it.
    st.write_material(&valid);
    let expired = cert_for(&[HOSTNAME], true);
    fs::write(&st.cert, &expired.cert_pem).unwrap();
    fs::write(&st.key, &expired.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(DnsServer::start_durable(options.clone()).await.is_err());
    assert!(!st.state.exists(), "expiry must not write state");

    // Insecure key mode: protected custody rejects it before any write.
    st.write_material(&valid);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(DnsServer::start_durable(options).await.is_err());
    assert!(!st.state.exists(), "an insecure key must not write state");
}

#[tokio::test]
async fn dot_and_doh_listeners_coexist_on_the_same_policy() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("coexistence");
    st.write_material(&cert);
    let plain_port = free_port();
    let (dot_port, doh_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doh_spec(
            doh_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
        Some(dot_spec(
            dot_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
        )),
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let dot_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), dot_port);
    let doh_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doh_port);

    let dot = dot_query(dot_addr, "www.allowed.example.", &cert.ca_pem, HOSTNAME)
        .await
        .expect("DoT listener must stay live beside DoH");
    assert_code(&dot, ResponseCode::NoError);
    assert_flags(&dot);
    let doh = doh_get(
        doh_addr,
        "www.allowed.example.",
        &cert.ca_pem,
        HOSTNAME,
        PATH,
    )
    .await
    .expect("DoH listener must stay live beside DoT");
    assert_code(&doh, ResponseCode::NoError);
    assert_flags(&doh);
    let denied = doh_get(doh_addr, "blocked.example.", &cert.ca_pem, HOSTNAME, PATH)
        .await
        .expect("shared policy must deny over DoH");
    assert_code(&denied, ResponseCode::NXDomain);
    server.stop().await;
}

#[test]
fn doh_config_bounds_and_port_invariants_are_rejected() {
    let cert = cert_for(&[HOSTNAME], false);
    let st = Fixture::new("config-bounds");
    st.write_material(&cert);
    let cert_path = st.cert.to_str().unwrap();
    let key_path = st.key.to_str().unwrap();

    let mut spec = doh_spec(4000, cert_path, key_path, true);
    spec["hostname"] = json!("bad host name");
    assert!(Config::parse(&config(3000, spec, None)).is_err());

    let mut spec = doh_spec(4000, cert_path, key_path, true);
    spec["path"] = json!("relative/path");
    assert!(Config::parse(&config(3000, spec, None)).is_err());

    let mut spec = doh_spec(4000, cert_path, key_path, true);
    spec["bind"]["address"] = json!("203.0.113.10");
    assert!(Config::parse(&config(3000, spec, None)).is_err());

    let mut spec = doh_spec(4000, cert_path, key_path, true);
    spec["bind"]["port"] = json!(80);
    assert!(Config::parse(&config(3000, spec, None)).is_err());

    // Same configured port as the plaintext listener is rejected up front.
    let spec = doh_spec(3000, cert_path, key_path, true);
    assert!(Config::parse(&config(3000, spec, None)).is_err());

    // Same configured port as an enabled DoT listener on the same address is
    // rejected before any bind.
    let spec = doh_spec(4000, cert_path, key_path, true);
    let dot = dot_spec(4000, cert_path, key_path);
    assert!(Config::parse(&config(3000, spec, Some(dot))).is_err());

    // A disabled block stays inert even with placeholder paths.
    let mut spec = doh_spec(4000, cert_path, key_path, false);
    spec["hostname"] = json!("bad host name");
    assert!(
        Config::parse(&config(3000, spec, None)).is_err(),
        "hostname bounds apply even when disabled"
    );
    let mut spec = doh_spec(4000, cert_path, key_path, false);
    spec["bind"]["address"] = json!("203.0.113.10");
    assert!(
        Config::parse(&config(3000, spec, None)).is_ok(),
        "a disabled listener does not bind, so bind checks do not apply"
    );
}
