//! Real `vantyr-dns` process regression for the `--dns-events` opt-in.
//!
//! The binary is spawned as a process, a real UDP query is sent to its listener,
//! and the reporter's verified-HTTPS POST is observed by a local TLS collector
//! (no direct flush shortcut, no mocked wire DTO). The process is then SIGINTed
//! while queries are still possible and must exit cleanly with an honest final
//! status line. A second invocation restarts from the SAME durable bundle.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::serve::{Listener, ListenerExt};
use axum::Router;
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::{Name as DnsName, RecordType};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde_json::{json, Value};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::Mutex;
use tokio_rustls::TlsAcceptor;

#[derive(Clone)]
struct Cert {
    ca_pem: String,
    cert_der: Vec<u8>,
    key_der: Vec<u8>,
}

fn cert() -> Cert {
    let mut ca = CertificateParams::new(vec!["dns events process ca".to_owned()]).unwrap();
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
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
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

#[derive(Default)]
struct Collector {
    batches: Mutex<Vec<Value>>,
}

async fn collect(State(state): State<Arc<Collector>>, body: axum::body::Bytes) {
    if let Ok(value) = serde_json::from_slice::<Value>(&body) {
        state.batches.lock().await.push(value);
    }
}

async fn start_collector(c: &Cert) -> (String, Arc<Collector>, tokio::task::JoinHandle<()>) {
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
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tls = TlsListener {
        inner: listener,
        acceptor: TlsAcceptor::from(Arc::new(config)),
    }
    .tap_io(|_| {});
    let state = Arc::new(Collector::default());
    let router = Router::new()
        .route("/worker/network/dns/events", axum::routing::post(collect))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        let _ = axum::serve(tls, router).await;
    });
    (format!("https://localhost:{port}"), state, task)
}

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
    options: PathBuf,
    credential: PathBuf,
    ca: PathBuf,
    stderr: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("vantyr-dns-evt-proc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self {
            config: dir.join("dns.json"),
            state: dir.join("state.json"),
            options: dir.join("options.json"),
            credential: dir.join("credential"),
            ca: dir.join("ca.pem"),
            stderr: dir.join("stderr"),
            dir,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn private(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn config(port: u16, household: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "household_id": household,
        "policy_revision": 3,
        "bind": { "address": "127.0.0.1", "port": port },
        "deny": { "mode": "nxdomain" },
        "local_zones": { "test.": [
            { "type": "a", "name": "allow.test.", "ttl": 60, "addr": "192.0.2.10" }
        ]},
        "profiles": {
            "adult": [
                { "effect": "allow", "match": { "type": "suffix", "value": "test" }, "reason": "adult-allow" }
            ],
            "restricted": [
                { "effect": "deny", "match": { "type": "suffix", "value": "test" }, "reason": "restricted" }
            ]
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

fn question() -> Vec<u8> {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.add_query(Query::query(
        DnsName::from_str("allow.test.").unwrap(),
        RecordType::A,
    ));
    message.to_vec().unwrap()
}

async fn query(port: u16) -> Message {
    let source = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
    let socket = UdpSocket::bind(SocketAddr::new(source, 0)).await.unwrap();
    let bytes = question();
    for _ in 0..40 {
        socket
            .send_to(&bytes, format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        let mut buffer = vec![0u8; 4096];
        if let Ok(Ok((len, _))) =
            tokio::time::timeout(Duration::from_millis(250), socket.recv_from(&mut buffer)).await
        {
            return Message::from_vec(&buffer[..len]).unwrap();
        }
    }
    panic!("DNS listener never answered on {port}");
}

async fn wait_batches(state: &Arc<Collector>, n: usize) -> Vec<Value> {
    for _ in 0..120 {
        let batches = state.batches.lock().await.clone();
        if batches.len() >= n {
            return batches;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("reporter never delivered {n} batch(es)");
}

#[tokio::test]
async fn binary_opt_in_reports_events_and_stops_cleanly() {
    let st = Fixture::new("flow");
    let household = "11111111-2222-3333-4444-555555555555";
    let gateway = "22222222-3333-4444-5555-666666666666";
    let dns_port = free_port();
    let c = cert();
    let (origin, collector, collector_task) = start_collector(&c).await;

    fs::write(&st.config, config(dns_port, household)).unwrap();
    fs::write(&st.ca, c.ca_pem.as_bytes()).unwrap();
    fs::write(
        &st.credential,
        "Bearer 33333333-3333-3333-3333-333333333333.ZmFrZXNlY3JldA\n",
    )
    .unwrap();
    fs::write(
        &st.options,
        serde_json::to_vec(&json!({
            "origin": origin,
            "ca_pem_path": st.ca,
            "credential_file": st.credential,
            "household_id": household,
            "gateway_id": gateway,
            "flush_interval_secs": 1,
            "backoff_secs": 1,
            "max_backoff_secs": 1
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        private(&st.ca);
        private(&st.credential);
        private(&st.options);
    }

    let mut child = Command::new(env!("CARGO_BIN_EXE_vantyr-dns"))
        .args([
            "--config",
            st.config.to_str().unwrap(),
            "--state",
            st.state.to_str().unwrap(),
            "--worker",
            "evt-proc-worker",
            "--dns-events",
            st.options.to_str().unwrap(),
        ])
        .stderr(Stdio::from(fs::File::create(&st.stderr).unwrap()))
        .spawn()
        .unwrap();

    assert_ne!(query(dns_port).await.response_code, ResponseCode::NXDomain);
    let batches = wait_batches(&collector, 1).await;
    let events = batches[0]["events"].as_array().unwrap();
    assert_eq!(batches[0]["command"], "report_dns_events");
    assert_eq!(
        events[0]["cache_state"], "unknown",
        "no fabricated hit/miss"
    );
    assert_eq!(events[0]["upstream"], Value::Null);
    assert_eq!(events[0]["name"], "allow.test");
    assert_eq!(events[0]["protocol"], "udp");

    // Graceful stop while the listener is still live.
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGINT);
        }
    }
    #[cfg(not(unix))]
    child.kill().unwrap();
    for _ in 0..50 {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        child.try_wait().unwrap().is_some(),
        "process did not stop cleanly"
    );
    let stderr = fs::read_to_string(&st.stderr).unwrap();
    assert!(
        stderr.contains("event reporter final status"),
        "missing operator status: {stderr}"
    );
    assert!(stderr.contains("prior-run losses unknown"));
    collector_task.abort();

    // Restart from the SAME durable bundle with no config file argument: the
    // policy and filter state are unchanged and a fresh reporter sends again.
    let (origin2, collector2, collector_task2) = start_collector(&c).await;
    fs::write(
        &st.options,
        serde_json::to_vec(&json!({
            "origin": origin2,
            "ca_pem_path": st.ca,
            "credential_file": st.credential,
            "household_id": household,
            "gateway_id": gateway,
            "flush_interval_secs": 1,
            "backoff_secs": 1,
            "max_backoff_secs": 1
        }))
        .unwrap(),
    )
    .unwrap();
    let mut child2 = Command::new(env!("CARGO_BIN_EXE_vantyr-dns"))
        .args([
            "--state",
            st.state.to_str().unwrap(),
            "--worker",
            "evt-proc-worker",
            "--dns-events",
            st.options.to_str().unwrap(),
        ])
        .stderr(Stdio::from(fs::File::create(&st.stderr).unwrap()))
        .spawn()
        .unwrap();
    assert_ne!(query(dns_port).await.response_code, ResponseCode::NXDomain);
    let batches2 = wait_batches(&collector2, 1).await;
    assert_eq!(batches2[0]["command"], "report_dns_events");
    assert_eq!(batches2[0]["events"][0]["cache_state"], "unknown");

    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child2.id() as i32, libc::SIGINT);
        }
    }
    #[cfg(not(unix))]
    child2.kill().unwrap();
    for _ in 0..50 {
        if child2.try_wait().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(child2.try_wait().unwrap().is_some());
    let stderr2 = fs::read_to_string(&st.stderr).unwrap();
    assert!(stderr2.contains("event reporter final status"));
    collector_task2.abort();
}
