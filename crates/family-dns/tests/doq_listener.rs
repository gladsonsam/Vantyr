//! Real-loopback DoQ SERVER listener tests. The certificate/key material and
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
use futures_util::StreamExt;
use hickory_resolver::net::quic::QuicClientStream;
use hickory_resolver::net::xfer::DnsRequestSender;
use hickory_resolver::proto::op::{
    DnsRequest, DnsRequestOptions, Message, MessageType, OpCode, Query, ResponseCode,
};
use hickory_resolver::proto::rr::rdata::A as AData;
use hickory_resolver::proto::rr::{Name, RData, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::CertificateDer;
use serde_json::json;
use support::{assert_code, assert_flags, HOUSEHOLD};
use tokio::net::UdpSocket;

const WORKER: &str = "dns-doq-listener-worker";
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
    let mut ca_params = CertificateParams::new(vec!["local doq test ca".to_owned()]).unwrap();
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

fn two_free_ports() -> (u16, u16) {
    let a = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let b = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    (
        a.local_addr().unwrap().port(),
        b.local_addr().unwrap().port(),
    )
}

/// Four distinct ports reserved at once, so no two listeners in the
/// coexistence test can be assigned the same OS-chosen number.
fn four_free_ports() -> (u16, u16, u16, u16) {
    let holders: Vec<_> = (0..4)
        .map(|_| std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap())
        .collect();
    let ports: Vec<u16> = holders
        .iter()
        .map(|listener| listener.local_addr().unwrap().port())
        .collect();
    (ports[0], ports[1], ports[2], ports[3])
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
            "vantyr-doq-listener-{}-{name}-{serial}",
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

fn doq_spec(port: u16, cert: &str, key: &str, enabled: bool) -> serde_json::Value {
    json!({
        "enabled": enabled,
        "bind": { "address": "127.0.0.1", "port": port },
        "cert_path": cert,
        "key_path": key
    })
}

fn config(plain_port: u16, doq: serde_json::Value) -> Vec<u8> {
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
        "doq_listener": doq
    }))
    .unwrap()
}

/// A maintained Hickory QUIC client: real CA verification and real SNI with a
/// single `doq` ALPN, no custom verifier and no 0-RTT. The one response stream
/// is polled directly; no transport code is reimplemented here.
async fn doq_query(
    server: SocketAddr,
    name: &str,
    ca_pem: &str,
    server_name: &str,
) -> Result<Message, String> {
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
    // Hickory supplies the single `doq` ALPN; early data stays disabled.
    client.enable_early_data = false;

    let mut stream = QuicClientStream::builder()
        .crypto_config(client)
        .request_timeout(Duration::from_secs(6))
        .build(server, Arc::from(server_name))
        .await
        .map_err(|error| format!("quic handshake failed: {error}"))?;

    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
    let request = DnsRequest::new(message, DnsRequestOptions::default());
    let mut responses = stream.send_message(request);
    let response = tokio::time::timeout(Duration::from_secs(6), responses.next())
        .await
        .map_err(|_| "DoQ query timed out".to_owned())?
        .ok_or_else(|| "DoQ stream closed without a response".to_owned())?
        .map_err(|error| error.to_string())?;
    Ok(response.into_message())
}

#[tokio::test]
async fn trusted_doq_client_answers_allowed_and_denied_with_flags() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("trusted");
    st.write_material(&cert);
    let (plain_port, doq_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doq_spec(
            doq_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doq_port);

    let allowed = doq_query(
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
        "allowed query must carry the local-zone answer over DoQ"
    );

    let denied = doq_query(addr, "blocked.example.", &cert.ca_pem, "dns.example.test")
        .await
        .expect("trusted client must complete the handshake for a denied query");
    assert_code(&denied, ResponseCode::NXDomain);
    assert_flags(&denied);
    server.stop().await;
}

#[tokio::test]
async fn wrong_ca_and_wrong_hostname_are_rejected() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("verification");
    st.write_material(&cert);
    let (plain_port, doq_port) = two_free_ports();
    let cfg = Config::parse(&config(
        plain_port,
        doq_spec(
            doq_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doq_port);

    assert!(doq_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test"
    )
    .await
    .is_ok());
    let unrelated = cert_for(&["unrelated.invalid"], false).ca_pem;
    assert!(
        doq_query(
            addr,
            "www.allowed.example.",
            &unrelated,
            "dns.example.test"
        )
        .await
        .is_err(),
        "wrong CA must not verify the server chain"
    );
    assert!(
        doq_query(
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
async fn disabled_listener_binds_no_port_and_stop_releases_the_endpoint() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("disabled");
    st.write_material(&cert);
    let (plain_port, doq_port) = two_free_ports();

    let disabled_cfg = Config::parse(&config(
        plain_port,
        doq_spec(
            doq_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            false,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(disabled_cfg).await.unwrap();
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_ok(),
        "enabled = false must leave the DoQ port free"
    );
    server.stop().await;

    let enabled_cfg = Config::parse(&config(
        plain_port,
        doq_spec(
            doq_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    let server = DnsServer::start(enabled_cfg).await.unwrap();
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_err(),
        "the enabled DoQ listener must hold the UDP port"
    );
    server.stop().await;
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_ok(),
        "stop must release the QUIC endpoint and its UDP port"
    );
}

#[tokio::test]
async fn bad_custody_consistency_and_expiry_fail_before_a_listener_exists() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("custody");
    st.write_material(&cert);
    let (plain_port, doq_port) = two_free_ports();
    let spec = doq_spec(
        doq_port,
        st.cert.to_str().unwrap(),
        st.key.to_str().unwrap(),
        true,
    );

    let other = cert_for(&["dns.example.test"], false);
    fs::write(&st.key, &other.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(plain_port, spec.clone())).unwrap())
            .await
            .is_err()
    );
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_ok(),
        "a custody failure must leave no QUIC listener"
    );

    st.write_material(&cert);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(
        DnsServer::start(Config::parse(&config(plain_port, spec.clone())).unwrap())
            .await
            .is_err()
    );

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
        DnsServer::start(Config::parse(&config(plain_port, spec.clone())).unwrap())
            .await
            .is_err()
    );

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
            DnsServer::start(Config::parse(&config(plain_port, spec)).unwrap())
                .await
                .is_err(),
            "a symlinked private key must be rejected"
        );
    }
}

/// A fresh durable start must reject bad certificate custody BEFORE it writes
/// the state file or binds any socket.
#[tokio::test]
async fn fresh_durable_start_with_invalid_custody_writes_no_state_and_releases_ports() {
    let valid = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("durable-invalid");
    st.write_material(&valid);
    let (plain_port, doq_port) = two_free_ports();
    fs::write(
        &st.config,
        config(
            plain_port,
            doq_spec(
                doq_port,
                st.cert.to_str().unwrap(),
                st.key.to_str().unwrap(),
                true,
            ),
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

    let other = cert_for(&["dns.example.test"], false);
    fs::write(&st.key, &other.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(DnsServer::start_durable(options.clone()).await.is_err());
    assert!(
        !st.state.exists(),
        "a failed durable start must not write the state file"
    );
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_ok(),
        "a failed durable start must release the DoQ port"
    );

    st.write_material(&valid);
    let expired = cert_for(&["dns.example.test"], true);
    fs::write(&st.cert, &expired.cert_pem).unwrap();
    fs::write(&st.key, &expired.key_pem).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(DnsServer::start_durable(options.clone()).await.is_err());
    assert!(!st.state.exists(), "expiry must not write state");
    assert!(
        UdpSocket::bind(("127.0.0.1", doq_port)).await.is_ok(),
        "expiry must release the DoQ port"
    );

    st.write_material(&valid);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&st.key, fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(DnsServer::start_durable(options).await.is_err());
    assert!(!st.state.exists(), "an insecure key must not write state");
}

/// A valid durable start persists state and serves DoQ; a restart serves the
/// listener from the persisted bundle, not from a changed bootstrap file.
#[tokio::test]
async fn valid_durable_doq_start_and_restart_serve_the_persisted_listener() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("durable-valid");
    st.write_material(&cert);
    let (plain_port, doq_port) = two_free_ports();
    let cfg = config(
        plain_port,
        doq_spec(
            doq_port,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    );
    fs::write(&st.config, &cfg).unwrap();
    let options = || DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now: STAMP.parse().unwrap(),
        hooks: None,
    };
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doq_port);

    let server = DnsServer::start_durable(options()).await.unwrap();
    assert!(st.state.exists());
    let persisted = fs::read(&st.state).unwrap();
    let allowed = doq_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test",
    )
    .await
    .expect("a fresh durable start must serve DoQ");
    assert_code(&allowed, ResponseCode::NoError);
    assert_flags(&allowed);
    server.stop().await;

    fs::write(
        &st.config,
        config(
            plain_port,
            doq_spec(
                doq_port,
                "/nonexistent/vantyr-doq-cert.pem",
                "/nonexistent/vantyr-doq-key.pem",
                true,
            ),
        ),
    )
    .unwrap();
    let server = DnsServer::start_durable(options()).await.unwrap();
    assert_eq!(
        fs::read(&st.state).unwrap(),
        persisted,
        "a restart must not rewrite the last good state"
    );
    let allowed = doq_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test",
    )
    .await
    .expect("a restart must serve DoQ from the persisted bundle");
    assert_code(&allowed, ResponseCode::NoError);
    assert_flags(&allowed);
    server.stop().await;
}

#[tokio::test]
async fn reload_rejects_doq_listener_transport_change() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("reload");
    st.write_material(&cert);
    let (plain, doq) = two_free_ports();
    let valid = config(
        plain,
        doq_spec(
            doq,
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

    let changed = String::from_utf8(config(
        plain,
        doq_spec(
            free_port(),
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap()
    .replace("\"policy_revision\": 2", "\"policy_revision\": 3");
    assert!(matches!(
        server.reload(changed.as_bytes(), Utc::now()),
        Err(ReloadError::TransportChange(_))
    ));
    assert_eq!(
        fs::read(&st.state).unwrap(),
        before,
        "a rejected reload must not mutate persisted state"
    );
    server.stop().await;
}

#[test]
fn doq_listener_bind_public_privileged_and_self_loop_invariants() {
    let (plain, doq) = two_free_ports();
    let base = doq_spec(doq, "/tmp/cert.pem", "/tmp/key.pem", true);

    assert!(Config::parse(&config(
        plain,
        json!({
            "enabled": true,
            "bind": {"address":"203.0.113.5","port":doq,"allow_non_loopback":true},
            "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
        })
    ))
    .is_err());
    assert!(Config::parse(&config(
        plain,
        json!({
            "enabled": true,
            "bind": {"address":"10.0.0.5","port":doq},
            "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
        })
    ))
    .is_err());
    assert!(Config::parse(&config(
        plain,
        json!({
            "enabled": true,
            "bind": {"address":"10.0.0.5","port":doq,"allow_non_loopback":true},
            "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
        })
    ))
    .is_ok());

    assert!(Config::parse(&config(
        plain,
        json!({
            "enabled": true,
            "bind": {"address":"127.0.0.1","port":53},
            "cert_path":"/tmp/cert.pem","key_path":"/tmp/key.pem"
        })
    ))
    .is_err());
    assert!(Config::parse(&config(
        plain,
        doq_spec(plain, "/tmp/cert.pem", "/tmp/key.pem", true)
    ))
    .is_err());

    let with_upstream = serde_json::to_vec(&json!({
        "household_id": HOUSEHOLD,
        "policy_revision": 2,
        "bind": {"address":"127.0.0.1","port":plain},
        "upstreams": [format!("127.0.0.1:{doq}")],
        "doq_listener": base
    }))
    .unwrap();
    assert!(Config::parse(&with_upstream).is_err());
}

#[tokio::test]
async fn doq_coexists_with_dot_and_doh_on_one_handler() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("coexist");
    st.write_material(&cert);
    let (plain, dot, doq, doh) = four_free_ports();
    let value = json!({
        "household_id": HOUSEHOLD,
        "policy_published_at": STAMP,
        "policy_revision": 2,
        "bind": {"address":"127.0.0.1","port":plain},
        "local_zones": {"allowed.example.": [
            {"type":"a","name":"www.allowed.example.","ttl":60,"addr":ANSWER}
        ]},
        "profiles": {
            "test": [
                {"effect":"allow","match":{"type":"exact","value":"www.allowed.example"},"reason":"allow"}
            ],
            "restricted": [
                {"effect":"deny","match":{"type":"any"},"reason":"default deny"}
            ]
        },
        "default_device_profile": "restricted",
        "devices": [{
            "id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile":"test",
            "source_ips":["127.0.0.1"]
        }],
        "dot_listener": {
            "enabled": true,
            "bind": {"address":"127.0.0.1","port":dot},
            "cert_path": st.cert.to_str().unwrap(),
            "key_path": st.key.to_str().unwrap()
        },
        "doh_listener": {
            "enabled": true,
            "bind": {"address":"127.0.0.1","port":doh},
            "hostname": "dns.example.test",
            "path": "/dns-query",
            "cert_path": st.cert.to_str().unwrap(),
            "key_path": st.key.to_str().unwrap()
        },
        "doq_listener": doq_spec(
            doq,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true
        )
    });
    let cfg = Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", dot)).await.is_err(),
        "the DoT port must remain held"
    );
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", doh)).await.is_err(),
        "the DoH port must remain held"
    );
    assert!(
        UdpSocket::bind(("127.0.0.1", doq)).await.is_err(),
        "the DoQ port must remain held"
    );
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doq);
    let allowed = doq_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test",
    )
    .await
    .expect("all three listeners must share one handler");
    assert_code(&allowed, ResponseCode::NoError);
    assert_flags(&allowed);
    server.stop().await;
    assert!(
        UdpSocket::bind(("127.0.0.1", doq)).await.is_ok(),
        "stop must release the QUIC endpoint alongside the other listeners"
    );
}

#[tokio::test]
async fn doq_source_device_comes_from_the_accepted_socket_address() {
    let cert = cert_for(&["dns.example.test"], false);
    let st = Fixture::new("doq-cidr");
    st.write_material(&cert);
    let device = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let (plain, doq) = two_free_ports();

    let mut value: serde_json::Value = serde_json::from_slice(&config(
        plain,
        doq_spec(
            doq,
            st.cert.to_str().unwrap(),
            st.key.to_str().unwrap(),
            true,
        ),
    ))
    .unwrap();
    value["devices"] = json!([{
        "id": device,
        "default_profile": "restricted",
        "source_ranges": ["127.0.0.0/24"]
    }]);
    let cfg = Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    let server = DnsServer::start(cfg).await.unwrap();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), doq);
    let denied = doq_query(
        addr,
        "www.allowed.example.",
        &cert.ca_pem,
        "dns.example.test",
    )
    .await
    .expect("trusted client must complete the handshake");
    assert_code(&denied, ResponseCode::NXDomain);
    assert_flags(&denied);
    assert!(
        server.observations().iter().any(|o| o
            .device_id
            .as_ref()
            .is_some_and(|id| id.to_string() == device)),
        "the source range must select the configured device from the socket address"
    );
    server.stop().await;
}
