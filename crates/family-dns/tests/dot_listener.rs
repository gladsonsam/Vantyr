//! Real-loopback DoT SERVER listener tests. The certificate/key material and
//! the client are generated locally with maintained crates; the client uses a
//! normal rustls verifier with the generated CA in its root store (no
//! `dangerous()` / verification skip), and a wrong CA or wrong name must fail
//! the handshake. Only the worker config/state paths are test fixtures; all
//! listener, policy and custody code under test is production code.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use family_dns::{Config, DnsServer, DurableOptions, ReloadError};
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{Name, RData, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, ServerName};
use serde_json::json;
use support::{assert_code, assert_flags, HOUSEHOLD};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const WORKER: &str = "dns-dot-listener-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
const ANSWER: &str = "192.0.2.55";
static COUNTER: AtomicU64 = AtomicU64::new(0);

struct Cert {
    ca_pem: String,
    cert_pem: String,
    key_pem: String,
}

/// Generate a leaf signed by a fresh local CA. `expired` produces a leaf whose
/// whole validity window is in the past, without touching the host clock.
fn cert_for(names: &[&str], expired: bool) -> Cert {
    let mut ca_params = CertificateParams::new(vec!["local dot test ca".to_owned()]).unwrap();
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

/// Two distinct ports held at once: the plaintext listener and the DoT
/// listener must never collide in these tests.
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
            "vantyr-dot-listener-{}-{name}-{serial}",
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

fn dot_spec(port: u16, cert: &str, key: &str, enabled: bool) -> serde_json::Value {
    json!({
        "enabled": enabled,
        "bind": { "address": "127.0.0.1", "port": port },
        "cert_path": cert,
        "key_path": key
    })
}

fn config(plain_port: u16, dot: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
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
        "dot_listener": dot
    }))
    .unwrap()
}

/// A maintained rustls DoT client: real CA verification and real SNI. No
/// custom verifier and no `dangerous()` configuration exists on this path.
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
    let blocks = pem::parse_many(ca_pem).map_err(|error| error.to_string())?;
    for block in blocks {
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
        .map_err(|error| format!("tls handshake failed: {error}"))?;

    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
    let bytes = message.to_vec().unwrap();
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
async fn trusted_dot_client_answers_allowed_and_denied_with_flags() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("trusted");
    st.write_material(&cert);
    let (plain_port, dot_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        dot_spec(
            dot_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), dot_port);

    let allowed = dot_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test",
    )
    .await
    .expect("trusted client must complete the handshake");
    assert_code(&allowed, ResponseCode::NoError);
    assert_flags(&allowed);
    assert!(
        allowed.answers.iter().any(|record| matches!(
            &record.data,
            RData::A(AData(ip)) if ip.to_string() == ANSWER
        )),
        "allowed query must carry the local-zone answer over DoT"
    );

    let denied = dot_query(addr, "blocked.example.", &cert.ca_pem, "dns.example.test")
        .await
        .expect("trusted client must complete the handshake for a denied query");
    assert_code(&denied, ResponseCode::NxDomain);
    assert_flags(&denied);
    server.stop().await;
}

#[tokio::test]
async fn wrong_ca_and_wrong_hostname_are_rejected() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("verification");
    st.write_material(&cert);
    let (plain_port, dot_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        dot_spec(
            dot_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), dot_port);

    // Control: the correct CA and name work.
    assert!(dot_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test"
    )
    .await
    .is_ok());
    // Unrelated CA and wrong verification name both fail the real handshake.
    let unrelated = cert_for(&["unrelated.invalid"], false).ca_pem;
    assert!(
        dot_query(addr, "www.allowed.example.", &unrelated, "dns.example.test")
            .await
            .is_err(),
        "wrong CA must not verify the server chain"
    );
    assert!(
        dot_query(
            addr,
            "www.allowed.example.",
            &cert.ca_pem,
            "wrong.example.test"
        )
        .await
        .is_err(),
        "wrong hostname must not verify the server chain"
    );
    server.stop().await;
}

#[tokio::test]
async fn disabled_listener_binds_no_port_and_stop_releases_the_listener() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("disabled");
    st.write_material(&cert);
    let (plain_port, dot_port) = two_free_ports();

    let disabled_cfg = Config::parse(&config(
        plain_port,
        dot_spec(
            dot_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            false,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(disabled_cfg).await.unwrap();
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", dot_port))
            .await
            .is_ok(),
        "enabled = false must leave the DoT port free"
    );
    server.stop().await;

    let enabled_cfg = Config::parse(&config(
        plain_port,
        dot_spec(
            dot_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(enabled_cfg).await.unwrap();
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", dot_port))
            .await
            .is_err(),
        "the enabled DoT listener must hold the port"
    );
    server.stop().await;
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", dot_port))
            .await
            .is_ok(),
        "stop must release the listener"
    );
}

#[tokio::test]
async fn bad_custody_consistency_and_expiry_fail_before_a_listener_exists() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("custody");
    st.write_material(&cert);
    let dot_port = free_port();
    let spec = dot_spec(
        dot_port,
        st.cert.to_str().unwrap(),
        st.key.to_str().unwrap(),
        true,
    );

    // Mismatched key: rustls consistency check rejects before a bind.
    let other = cert_for(&["dns.example.test"], false);
    fs::write(&st.key, &other.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(free_port(), spec.clone())).unwrap())
            .await
            .is_err()
    );
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", dot_port))
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
        DnsServer::start(Config::parse(&config(free_port(), spec.clone())).unwrap())
            .await
            .is_err()
    );

    // Expired leaf: maintained X.509 validity parser rejects it.
    st.write_material(&cert);
    let expired = cert_for(&["dns.example.test"], true);
    fs::write(&st.key, &expired.key_pem).unwrap();
    fs::write(&st.cert, &expired.cert_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(free_port(), spec.clone())).unwrap())
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
            DnsServer::start(Config::parse(&config(free_port(), spec)).unwrap())
                .await
                .is_err(),
            "a symlinked private key must be rejected"
        );
    }
}

#[test]
fn dot_listener_bind_public_privileged_and_self_loop_invariants() {
    let (plain, dot) = two_free_ports();
    let base = dot_spec(dot, "/tmp/cert.pem", "/tmp/key.pem", true);

    // Public bind is rejected with or without opt-in.
    assert!(Config::parse(&config(
        plain,
        json!({
            "enabled": true,
            "bind": {"address":"8.8.8.8","port":dot,"allow_non_loopback":true},
            "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
        })
    ))
    .is_err());
    let missing_opt_in = json!({
        "enabled": true,
        "bind": {"address":"10.0.0.5","port":dot},
        "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
    });
    assert!(Config::parse(&config(plain, missing_opt_in)).is_err());
    let private_opt_in = json!({
        "enabled": true,
        "bind": {"address":"10.0.0.5","port":dot,"allow_non_loopback":true},
        "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
    });
    assert!(Config::parse(&config(plain, private_opt_in)).is_ok());

    let privileged = json!({
        "enabled": true,
        "bind": {"address":"127.0.0.1","port":53},
        "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
    });
    assert!(Config::parse(&config(plain, privileged)).is_err());

    // Same port as the plaintext listener is a transport collision.
    assert!(Config::parse(&config(
        plain,
        dot_spec(plain, "/tmp/cert.pem", "/tmp/key.pem", true)
    ))
    .is_err());

    // An upstream pointing back at the DoT listener is a self-loop.
    let with_upstream = serde_json::to_vec(&json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "bind": {"address":"127.0.0.1","port":plain},
        "upstreams": [format!("127.0.0.1:{dot}")],
        "dot_listener": base
    }))
    .unwrap();
    assert!(Config::parse(&with_upstream).is_err());
}

#[tokio::test]
async fn reload_rejects_dot_listener_transport_change() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("reload");
    st.write_material(&cert);
    let (plain, dot) = two_free_ports();
    let valid = config(
        plain,
        dot_spec(
            dot,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    );
    fs::write(&st.config, &valid).unwrap();
    let options = DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: STAMP.parse().unwrap(),
        hooks: None,
    };
    let server = DnsServer::start_durable(options).await.unwrap();
    let before = fs::read(&st.state).unwrap();

    // A newer policy that also changes the DoT listener is a transport change;
    // no snapshot is swapped and no file is written.
    let changed = config(
        plain,
        dot_spec(
            free_port(),
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    )
    .replace("\"policy_revision\": 2", "\"policy_revision\": 3");
    assert!(matches!(
        server.reload(&changed, Utc::now()),
        Err(ReloadError::TransportChange(_))
    ));
    assert_eq!(
        fs::read(&st.state).unwrap(),
        before,
        "a rejected reload must not mutate persisted state"
    );
    server.stop().await;
}
