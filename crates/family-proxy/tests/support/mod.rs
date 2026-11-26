//! Local loopback test doubles. No host resolver, DHCP, router or CA changes.

#![allow(dead_code)]

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use family_proxy::{Config, ProxyServer};
use rama::dns::client::resolver::DnsAddressResolver;
use rama::error::BoxError;
use rama::futures::stream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub const GOOD_AUTH: &str =
    "Basic MjIyMjIyMjItMzMzMy00NDQ0LTU1NTUtNjY2NjY2NjY2NjY2OnZhbnR5ci1wcm94eS1ib290c3RyYXAtdG9rZW4tMDAwMQ==";
pub const WRONG_AUTH: &str =
    "Basic MjIyMjIyMjItMzMzMy00NDQ0LTU1NTUtNjY2NjY2NjY2NjY2Ondyb25nLXZhbnR5ci1wcm94eS1ib290c3RyYXAtdG9rZW4tMDAwMDAx";

pub fn free_addr() -> SocketAddr {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

/// A resolver that must never be called: all test destinations are narrow
/// explicit loopback pins, so no DNS lookup is allowed at all.
#[derive(Clone, Debug)]
pub struct NoDnsResolver;

impl DnsAddressResolver for NoDnsResolver {
    type Error = BoxError;

    fn lookup_ipv4(
        &self,
        _domain: rama::net::address::Domain,
    ) -> impl stream::Stream<Item = Result<Ipv4Addr, Self::Error>> + Send + '_ {
        panic!("a pinned test destination must not trigger DNS");
        #[allow(unreachable_code)]
        stream::empty()
    }

    fn lookup_ipv6(
        &self,
        _domain: rama::net::address::Domain,
    ) -> impl stream::Stream<Item = Result<Ipv6Addr, Self::Error>> + Send + '_ {
        panic!("a pinned test destination must not trigger DNS");
        #[allow(unreachable_code)]
        stream::empty()
    }
}

/// A hostile resolver: it reports a private address for any lookup. Because
/// the tested destination is pinned, its answer must never be used.
#[derive(Clone, Debug)]
pub struct RebindingResolver {
    pub calls: Arc<AtomicUsize>,
}

impl DnsAddressResolver for RebindingResolver {
    type Error = BoxError;

    fn lookup_ipv4(
        &self,
        _domain: rama::net::address::Domain,
    ) -> impl stream::Stream<Item = Result<Ipv4Addr, Self::Error>> + Send + '_ {
        self.calls.fetch_add(1, Ordering::SeqCst);
        stream::iter([Ok(Ipv4Addr::new(169, 254, 169, 254))])
    }

    fn lookup_ipv6(
        &self,
        _domain: rama::net::address::Domain,
    ) -> impl stream::Stream<Item = Result<Ipv6Addr, Self::Error>> + Send + '_ {
        self.calls.fetch_add(1, Ordering::SeqCst);
        stream::empty()
    }
}

pub struct HttpOrigin {
    pub addr: SocketAddr,
    pub hits: Arc<AtomicUsize>,
    pub seen: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl HttpOrigin {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (h, s) = (hits.clone(), seen.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let h = h.clone();
                let s = s.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while let Ok(n) = stream.read(&mut tmp).await {
                        if n == 0 || buf.len() > 16 * 1024 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    h.fetch_add(1, Ordering::SeqCst);
                    s.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buf).to_string());
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await;
                });
            }
        });
        Self {
            addr,
            hits,
            seen,
            task,
        }
    }

    pub fn connections(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for HttpOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct EchoOrigin {
    pub addr: SocketAddr,
    pub hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl EchoOrigin {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                h.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if stream.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        });
        Self { addr, hits, task }
    }

    pub fn connections(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for EchoOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// An upstream that accepts the connection but never answers. Used to prove
/// the full HTTP request/response deadline, not just the connect timeout.
pub struct StallOrigin {
    pub addr: SocketAddr,
    pub hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl StallOrigin {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                h.fetch_add(1, Ordering::SeqCst);
                // Hold the socket open without ever writing a response.
                tokio::spawn(async move {
                    let _held = stream;
                    std::future::pending::<()>().await;
                });
            }
        });
        Self { addr, hits, task }
    }

    pub fn connections(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for StallOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Origin that returns a large body so a client which stops reading creates
/// real write backpressure on the proxy's ingress socket.
pub struct LargeOrigin {
    pub addr: SocketAddr,
    task: JoinHandle<()>,
}

impl LargeOrigin {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf).await;
                    let body = "z".repeat(4 * 1024 * 1024);
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                    if stream.write_all(head.as_bytes()).await.is_ok() {
                        let _ = stream.write_all(body.as_bytes()).await;
                    }
                });
            }
        });
        Self { addr, task }
    }
}

impl Drop for LargeOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Origin that sends a complete 200 head announcing a body and then stalls
/// forever before writing any body bytes.
pub struct StallBodyOrigin {
    pub addr: SocketAddr,
    pub hits: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl StallBodyOrigin {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                h.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf).await;
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                        .await;
                    std::future::pending::<()>().await;
                });
            }
        });
        Self { addr, hits, task }
    }

    pub fn connections(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

impl Drop for StallBodyOrigin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Build a valid config with two pinned loopback destinations plus a
/// policy-denied hostname. Every destination is a narrow explicit exception.
pub fn test_config(origin: SocketAddr, echo: SocketAddr) -> Config {
    test_config_with_limits(origin, echo, 128, 60)
}

pub fn test_config_with_limits(
    origin: SocketAddr,
    echo: SocketAddr,
    max_connections: usize,
    tunnel_idle_secs: u64,
) -> Config {
    let value = serde_json::json!({
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 1,
        "bind": { "address": "127.0.0.1", "port": 0 },
        "limits": {
            "max_connections": max_connections,
            "max_header_bytes": 16384,
            "max_body_bytes": 65536,
            "connect_timeout_ms": 1000,
            "request_timeout_secs": 2,
            "tunnel_idle_secs": tunnel_idle_secs
        },
        "profiles": { "restricted": [
            { "effect": "allow", "match": { "type": "suffix", "value": "origin.test" } },
            { "effect": "allow", "match": { "type": "suffix", "value": "echo.test" } },
            { "effect": "allow", "match": { "type": "suffix", "value": "rebind.test" } },
            { "effect": "deny",  "match": { "type": "suffix", "value": "blocked.test" } }
        ]},
        "default_device_profile": "restricted",
        "devices": [{ "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "default_profile": "restricted" }],
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "vantyr-proxy-bootstrap-token-0001",
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        }],
        "destinations": [
            { "host": "origin.test",  "port": origin.port(), "pin": format!("127.0.0.1:{}", origin.port()) },
            { "host": "echo.test",    "port": echo.port(),   "pin": format!("127.0.0.1:{}", echo.port()) },
            { "host": "rebind.test",  "port": echo.port(),   "pin": format!("127.0.0.1:{}", echo.port()) },
            { "host": "blocked.test", "port": origin.port(), "pin": format!("127.0.0.1:{}", origin.port()) }
        ]
    });
    Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap()
}

pub async fn connect(addr: SocketAddr) -> TcpStream {
    tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(addr))
        .await
        .expect("connect timeout")
        .expect("connect failed")
}

pub async fn send(stream: &mut TcpStream, request: &str) {
    stream.write_all(request.as_bytes()).await.unwrap();
}

/// Read until a complete HTTP response head is present, or time out.
pub async fn read_head(stream: &mut TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(4), async {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        loop {
            let n = stream.read(&mut tmp).await.expect("read failed");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if buf.len() > 64 * 1024 {
                break;
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    })
    .await
    .expect("response timeout")
}

pub fn status_line(head: &str) -> u16 {
    let line = head.lines().next().unwrap_or("");
    let code = line.split_whitespace().nth(1).unwrap_or("000");
    code.parse().unwrap_or(0)
}

pub async fn start_proxy(config: Config) -> ProxyServer {
    ProxyServer::start_with(config, NoDnsResolver)
        .await
        .expect("proxy start")
}
