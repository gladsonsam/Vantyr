//! Real server + real worker integration for proxy sign-in credentials.
//!
//! A fresh migrated PostgreSQL backs the real router. The real worker library
//! (`family-proxy`) syncs hash-only credentials and introspects evidence over
//! loopback HTTP against that router, then serves real HTTP GET and CONNECT
//! requests to local origins. No mocked authority, no mocked extractor and no
//! DTO-only proof: every accept/deny is enforced against authoritative rows.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chrono::{Duration as ChronoDuration, Utc};
use family_proxy::server_authority::{HttpEvidenceVerifier, RemoteCredentialStore};
use family_proxy::{Config, ProxyServer};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::gateway_auth;

/// Both cases drive process-global worker plumbing (governor buckets and the
/// synchronous introspection bridge); serialize them inside this test binary.
static E2E_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Origin {
    addr: SocketAddr,
    hits: Arc<AtomicUsize>,
    seen: Arc<std::sync::Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}

impl Origin {
    async fn start(echo: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (h, s) = (Arc::clone(&hits), Arc::clone(&seen));
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let h = Arc::clone(&h);
                let s = Arc::clone(&s);
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
                    if echo {
                        let _ = stream.write_all(b"echo-reply").await;
                    } else {
                        let _ = stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                            .await;
                    }
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

async fn session(pool: &PgPool, user_id: Uuid) -> (String, String) {
    let token = format!("e2e-tok-{}", Uuid::new_v4());
    let csrf = format!("e2e-csrf-{}", Uuid::new_v4());
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

#[derive(Clone)]
struct Http {
    base: String,
    token: String,
    csrf: String,
    client: reqwest::Client,
}

impl Http {
    fn new(base: &str, token: String, csrf: String) -> Self {
        Self {
            base: base.to_string(),
            token,
            csrf,
            client: reqwest::Client::new(),
        }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .request(method, format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("x-csrf-token", self.csrf.as_str())
            .header("content-type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, value)
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, body).await
    }

    async fn delete(&self, path: &str) -> (u16, Value) {
        self.call(reqwest::Method::DELETE, path, json!({})).await
    }
}

struct Fixture {
    base: String,
    _server: std::thread::JoinHandle<()>,
    admin: Http,
    user: Http,
    hid: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    gateway_id: Uuid,
    bearer: String,
    origin: Origin,
    echo: Origin,
}

async fn setup(pool: &PgPool) -> Fixture {
    let state = crate::test_support::app_state(pool.clone());
    let api = Router::new().merge(super::routes());
    let app = Router::new()
        .nest("/api", api)
        .route_layer(from_fn_with_state(state.clone(), crate::auth::require_auth))
        .merge(super::proxy_worker_routes())
        .with_state(state);
    // The worker's synchronous verifier blocks its calling task while it waits
    // for introspection. The server therefore lives on its OWN runtime thread so
    // it can answer even when the test's Tokio runtime is current-thread.
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std_listener.set_nonblocking(true).unwrap();
    let base = format!(
        "http://127.0.0.1:{}",
        std_listener.local_addr().unwrap().port()
    );
    let server = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let listener = TcpListener::from_std(std_listener).unwrap();
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
    });

    let admin_id = insert_user(pool, "e2e-admin").await;
    let (at, ac) = session(pool, admin_id).await;
    let admin = Http::new(&base, at, ac);
    let (status, body) = admin
        .post("/api/network/bootstrap", json!({"name": "E2E"}))
        .await;
    assert_eq!(status, 200, "bootstrap: {body}");
    let hid = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();

    let user_id = insert_user(pool, "e2e-user").await;
    // Role is irrelevant: the explicit household grant is the only authority.
    sqlx::query("UPDATE dashboard_users SET role = 'viewer' WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    let (ut, uc) = session(pool, user_id).await;
    let user = Http::new(&base, ut, uc);
    assert_eq!(
        admin
            .post(
                &format!("/api/network/households/{hid}/grants"),
                json!({"user_id": user_id, "grant": "network_enroll"}),
            )
            .await
            .0,
        200
    );
    let (_, body) = admin
        .post(
            &format!("/api/network/households/{hid}/persons"),
            json!({"display_name": "Teen"}),
        )
        .await;
    let person_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        admin
            .post(
                &format!("/api/network/households/{hid}/bindings"),
                json!({"person_id": person_id, "user_id": user_id}),
            )
            .await
            .0,
        200
    );
    let (status, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/devices"),
            json!({"label": "Laptop", "device_type": "computer"}),
        )
        .await;
    assert_eq!(status, 200, "device: {body}");
    let device_id = Uuid::parse_str(body["device_id"].as_str().unwrap()).unwrap();
    // Active assignment: the worker's evidence verifier attributes a person
    // only when an active assignment actually binds them to this device.
    assert_eq!(
        admin
            .post(
                &format!("/api/network/households/{hid}/assignments"),
                json!({
                    "person_id": person_id,
                    "device_id": device_id,
                    "role": "member",
                    "active": true,
                }),
            )
            .await
            .0,
        200
    );

    // OIDC-backed session via BYOD grant consume.
    let (_, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/grants"),
            json!({"device_id": device_id, "purpose": "proxy_setup", "expires_in_secs": 600}),
        )
        .await;
    let grant_id = body["grant_id"].as_str().unwrap();
    let grant_secret = body["secret"].as_str().unwrap();
    assert_eq!(
        user.post(
            &format!("/api/network/households/{hid}/enroll/grants/consume"),
            json!({"grant_id": grant_id, "secret": grant_secret, "purpose": "proxy_setup", "device_id": device_id}),
        )
        .await
        .0,
        200
    );

    let (_, body) = admin
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({"kind": "proxy", "label": "Proxy"}),
        )
        .await;
    let gateway_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/gateways/{gateway_id}/credentials"),
            json!({"expires_in_hours": 24, "commands": ["introspect_proxy"]}),
        )
        .await;
    assert_eq!(status, 200, "worker credential: {body}");
    let bearer = body["token"].as_str().unwrap().to_string();

    Fixture {
        base,
        _server: server,
        admin,
        user,
        hid,
        person_id,
        device_id,
        gateway_id,
        bearer,
        origin: Origin::start(false).await,
        echo: Origin::start(true).await,
    }
}

fn worker_config(f: &Fixture) -> Config {
    let value = json!({
        "household_id": f.hid.to_string(),
        "policy_revision": 1,
        "bind": { "address": "127.0.0.1", "port": 0 },
        "limits": {
            "max_connections": 128,
            "max_header_bytes": 16384,
            "max_body_bytes": 65536,
            "connect_timeout_ms": 1000,
            "request_timeout_secs": 2,
            "tunnel_idle_secs": 60
        },
        "profiles": { "restricted": [
            { "effect": "allow", "match": { "type": "suffix", "value": "origin.test" } },
            { "effect": "allow", "match": { "type": "suffix", "value": "echo.test" } },
            { "effect": "deny",  "match": { "type": "suffix", "value": "blocked.test" } }
        ]},
        "default_device_profile": "restricted",
        // Centrally issued credentials are person-scoped ("personal"); the
        // worker config must describe this device the same way or the binding
        // kind check denies every request before evidence is even consulted.
        "devices": [{ "id": f.device_id.to_string(), "shared": false, "default_profile": "restricted" }],
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "vantyr-proxy-bootstrap-token-0001",
            "device_id": f.device_id.to_string()
        }],
        "destinations": [
            { "host": "origin.test", "port": f.origin.addr.port(), "pin": format!("127.0.0.1:{}", f.origin.addr.port()) },
            { "host": "echo.test", "port": f.echo.addr.port(), "pin": format!("127.0.0.1:{}", f.echo.addr.port()) },
            { "host": "blocked.test", "port": f.origin.addr.port(), "pin": format!("127.0.0.1:{}", f.origin.addr.port()) }
        ]
    });
    Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn auth_header(id: Uuid, secret: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{id}:{secret}")))
}

fn get_request(auth: &str, evidence: Option<&str>, target: &str, path: &str) -> String {
    let evidence = evidence
        .map(|e| format!("x-vantyr-session-evidence: {e}\r\n"))
        .unwrap_or_default();
    format!(
        "GET http://{target}{path} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: {auth}\r\n{evidence}Connection: close\r\n\r\n"
    )
}

fn connect_request(auth: &str, evidence: Option<&str>, host: &str, port: u16) -> String {
    let evidence = evidence
        .map(|e| format!("x-vantyr-session-evidence: {e}\r\n"))
        .unwrap_or_default();
    format!(
        "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nProxy-Authorization: {auth}\r\n{evidence}\r\n"
    )
}

async fn request(addr: SocketAddr, request: &str) -> String {
    let mut stream = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(addr))
        .await
        .unwrap()
        .unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut tmp = [0u8; 1024];
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            head.extend_from_slice(&tmp[..n]);
            if head.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
    })
    .await
    .unwrap();
    String::from_utf8_lossy(&head).to_string()
}

fn status(head: &str) -> u16 {
    head.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

async fn issue_proxy_credential(f: &Fixture) -> (Uuid, String) {
    let (status, body) = f
        .admin
        .post(
            &format!("/api/network/households/{}/proxy/credentials", f.hid),
            json!({
                "person_id": f.person_id,
                "device_id": f.device_id,
                "label": "Teen laptop",
                "expires_in_hours": 8,
            }),
        )
        .await;
    assert_eq!(status, 200, "issue: {body}");
    let id = Uuid::parse_str(body["credential"]["id"].as_str().unwrap()).unwrap();
    (id, body["secret"].as_str().unwrap().to_string())
}

async fn issue_evidence(f: &Fixture, id: Uuid, command: &str) -> String {
    let (status, body) = f
        .user
        .post(
            &format!("/api/network/households/{}/proxy/evidence", f.hid),
            json!({"credential_id": id, "command": command}),
        )
        .await;
    assert_eq!(status, 200, "evidence: {body}");
    body["evidence"].as_str().unwrap().to_string()
}

/// The synchronous verifier blocks its calling task while the scoped HTTP
/// authority answers. Run the case on a dedicated multi-thread runtime so the
/// pool's background tasks and the server can progress while it waits.
async fn run_on_thread<F>(pool: PgPool, case: F)
where
    F: FnOnce(PgPool) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + 'static,
{
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(case(pool));
        let _ = done_tx.send(());
    });
    tokio::task::spawn_blocking(move || done_rx.recv())
        .await
        .expect("case thread join")
        .expect("case thread completed");
}

#[sqlx::test]
async fn real_server_and_worker_http_connect_positive_and_negative(pool: PgPool) {
    let _guard = E2E_GUARD.lock().await;
    run_on_thread(pool, |pool| {
        Box::pin(async move { case_http_connect(pool).await })
    })
    .await;
}

async fn case_http_connect(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, secret) = issue_proxy_credential(&f).await;
    let http_evidence = issue_evidence(&f, id, "proxy_http").await;
    let connect_evidence = issue_evidence(&f, id, "proxy_connect").await;

    // A generous TTL keeps this case deterministic under parallel test load;
    // the dedicated stale-cache case exercises the 1-second fail-closed path.
    let authority =
        RemoteCredentialStore::new(&f.base, f.bearer.clone(), f.hid, f.gateway_id, 60).unwrap();
    assert_eq!(authority.sync().unwrap(), 1);
    let verifier = HttpEvidenceVerifier::new(
        &f.base,
        f.bearer.clone(),
        f.hid,
        f.gateway_id,
        authority.fresh_gate(),
    )
    .unwrap();
    let proxy = ProxyServer::start_with_session_auth_system(
        worker_config(&f),
        authority.credential_store(),
        Arc::new(verifier),
        (*authority.assignments()).clone(),
    )
    .await
    .unwrap();
    let auth = auth_header(id, &secret);
    let target = format!("origin.test:{}", f.origin.addr.port());

    // Positive GET: real origin contact, no credential/evidence leakage.
    let head = request(
        proxy.bind_addr(),
        &get_request(&auth, Some(&http_evidence), &target, "/allowed?q=1"),
    )
    .await;
    assert_eq!(status(&head), 200, "positive GET: {head:?}");
    assert_eq!(f.origin.hits.load(Ordering::SeqCst), 1);
    let seen = f.origin.seen.lock().unwrap().clone();
    assert!(!seen[0].to_ascii_lowercase().contains("proxy-authorization"));
    assert!(!seen[0]
        .to_ascii_lowercase()
        .contains("x-vantyr-session-evidence"));

    // Replayed evidence: the server consumed it; the worker denies before egress.
    let before = f.origin.hits.load(Ordering::SeqCst);
    let head = request(
        proxy.bind_addr(),
        &get_request(&auth, Some(&http_evidence), &target, "/"),
    )
    .await;
    assert_eq!(status(&head), 403, "replay: {head:?}");
    assert_eq!(f.origin.hits.load(Ordering::SeqCst), before);

    // Policy baseline: blocked.test is denied before egress. A fresh receipt
    // isolates the policy decision from the replay case above.
    let blocked_evidence = issue_evidence(&f, id, "proxy_http").await;
    let blocked = format!("blocked.test:{}", f.origin.addr.port());
    let before = f.origin.hits.load(Ordering::SeqCst);
    let head = request(
        proxy.bind_addr(),
        &get_request(&auth, Some(&blocked_evidence), &blocked, "/"),
    )
    .await;
    assert_eq!(status(&head), 403);
    assert_eq!(f.origin.hits.load(Ordering::SeqCst), before);

    // Positive CONNECT to a local echo origin with a matching command.
    let head = request(
        proxy.bind_addr(),
        &connect_request(
            &auth,
            Some(&connect_evidence),
            "echo.test",
            f.echo.addr.port(),
        ),
    )
    .await;
    assert_eq!(status(&head), 200, "positive CONNECT: {head:?}");
    assert_eq!(f.echo.hits.load(Ordering::SeqCst), 1);

    // Revocation propagates on the next authoritative sync; no egress after it.
    let post_revoke_evidence = issue_evidence(&f, id, "proxy_http").await;
    assert_eq!(
        f.admin
            .delete(&format!(
                "/api/network/households/{}/proxy/credentials/{id}",
                f.hid
            ))
            .await
            .0,
        200
    );
    authority.sync().unwrap();
    let before = f.origin.hits.load(Ordering::SeqCst);
    let head = request(
        proxy.bind_addr(),
        &get_request(&auth, Some(&post_revoke_evidence), &target, "/"),
    )
    .await;
    assert_eq!(status(&head), 407, "revoked credential: {head:?}");
    assert_eq!(f.origin.hits.load(Ordering::SeqCst), before);

    // Old bootstrap-only behavior is unchanged: a bootstrap credential with a
    // centrally issued secret never authenticates.
    let bootstrap = auth_header(id, "vantyr-proxy-bootstrap-token-0001");
    let head = request(
        proxy.bind_addr(),
        &get_request(&bootstrap, None, &target, "/"),
    )
    .await;
    assert_eq!(status(&head), 407);

    proxy.stop().await;
    f.origin.task.abort();
    f.echo.task.abort();
}

#[sqlx::test]
async fn stale_or_unauthenticated_authority_fails_closed(pool: PgPool) {
    let _guard = E2E_GUARD.lock().await;
    run_on_thread(pool, |pool| {
        Box::pin(async move { case_stale_authority(pool).await })
    })
    .await;
}

async fn case_stale_authority(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, secret) = issue_proxy_credential(&f).await;
    let evidence = issue_evidence(&f, id, "proxy_http").await;

    // A Bearer without the opt-in command cannot sync or introspect.
    let (code, _) = f
        .admin
        .worker_call(
            &f.base,
            None,
            "/worker/network/proxy/credentials/sync",
            json!({
                "audience": gateway_auth::AUDIENCE,
                "household_id": f.hid,
                "gateway_id": f.gateway_id,
                "kind": "proxy",
                "command": gateway_auth::COMMAND_INTROSPECT_PROXY,
            }),
        )
        .await;
    assert_eq!(code, 401);

    let authority =
        RemoteCredentialStore::new(&f.base, f.bearer.clone(), f.hid, f.gateway_id, 1).unwrap();
    assert_eq!(authority.sync().unwrap(), 1);
    let verifier = HttpEvidenceVerifier::new(
        &f.base,
        f.bearer.clone(),
        f.hid,
        f.gateway_id,
        authority.fresh_gate(),
    )
    .unwrap();
    let proxy = ProxyServer::start_with_session_auth_system(
        worker_config(&f),
        authority.credential_store(),
        Arc::new(verifier),
        (*authority.assignments()).clone(),
    )
    .await
    .unwrap();
    let auth = auth_header(id, &secret);
    let target = format!("origin.test:{}", f.origin.addr.port());

    // Wait past the cache TTL: the fail-closed gate must deny even a correct
    // credential/evidence pair without any server interaction.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let head = request(
        proxy.bind_addr(),
        &get_request(&auth, Some(&evidence), &target, "/"),
    )
    .await;
    assert_eq!(status(&head), 407, "stale cache must fail closed: {head:?}");
    assert_eq!(f.origin.hits.load(Ordering::SeqCst), 0);

    proxy.stop().await;
    f.origin.task.abort();
    f.echo.task.abort();
}

impl Http {
    async fn worker_call(
        &self,
        base: &str,
        bearer: Option<&str>,
        path: &str,
        body: Value,
    ) -> (u16, Value) {
        let mut request = self
            .client
            .post(format!("{base}{path}"))
            .header("content-type", "application/json")
            .json(&body);
        if let Some(bearer) = bearer {
            request = request.header("authorization", bearer);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    }
}
