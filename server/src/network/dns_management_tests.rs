//! Real-PostgreSQL, real-HTTP tests for Stage A DNS management. Each test gets
//! a fresh migrated database, the real router behind session/CSRF middleware
//! and the top-level cookie-free worker router. No mocks and no mock auth.

use std::net::SocketAddr;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::dns_management_dto::digest;

// ─── Harness ─────────────────────────────────────────────────────────────────

async fn insert_user(pool: &PgPool, username: &str, role: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1, 'test-hash', $2) RETURNING id",
    )
    .bind(username)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn session_for(pool: &PgPool, user_id: Uuid, label: &str) -> (String, String) {
    let token = format!("dns-mgmt-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("dns-mgmt-csrf-{label}");
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

async fn spawn_router(pool: PgPool) -> (String, JoinHandle<()>) {
    let state = crate::test_support::app_state(pool);
    let api = Router::new()
        .merge(super::routes())
        .merge(crate::platform::routes());
    let app = Router::new()
        .nest("/api", api)
        .route_layer(from_fn_with_state(state.clone(), crate::auth::require_auth))
        .merge(super::worker_routes())
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://127.0.0.1:{}", addr.port()), handle)
}

struct Http {
    base: String,
    client: reqwest::Client,
    token: String,
    csrf: String,
}

impl Http {
    fn new(base: &str, token: String, csrf: String) -> Self {
        Self {
            base: base.to_string(),
            client: reqwest::Client::new(),
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
            .timeout(Duration::from_secs(20))
    }

    async fn send(builder: reqwest::RequestBuilder) -> (u16, Value) {
        let response = builder.send().await.unwrap();
        let status = response.status().as_u16();
        let body = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, body)
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::GET, path)).await
    }

    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::POST, path).json(&body)).await
    }

    async fn patch(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::PATCH, path).json(&body)).await
    }

    async fn put(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::PUT, path).json(&body)).await
    }

    async fn worker(&self, path: &str, bearer: &str, body: Value) -> (u16, Value) {
        Self::send(
            self.client
                .post(format!("{}{}", self.base, path))
                .header("authorization", bearer)
                .header("content-type", "application/json")
                .json(&body)
                .timeout(Duration::from_secs(20)),
        )
        .await
    }

    async fn worker_no_bearer(&self, path: &str, body: Value) -> u16 {
        self.client
            .post(format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }
}

async fn bootstrap_as(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn create_gateway(http: &Http, hid: Uuid, kind: &str) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": kind, "label": "Worker" }),
        )
        .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue_cred(http: &Http, hid: Uuid, gid: Uuid, commands: Option<Vec<&str>>) -> String {
    let commands = commands.map(|v| v.into_iter().map(String::from).collect::<Vec<_>>());
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({ "expires_in_hours": 24, "commands": commands }),
        )
        .await;
    assert_eq!(status, 200, "credential failed: {body}");
    body["token"].as_str().unwrap().to_string()
}

fn source(id: &str) -> Value {
    json!({
        "id": id,
        "url": "https://raw.githubusercontent.com/o/r/main/hosts.txt",
        "format": "hosts",
        "enabled": true,
        "interval_secs": 86400,
        "max_stale_secs": 172800,
        "metadata": {"title":"List","publisher":"Publisher","license":"MIT"}
    })
}

fn patch_with(expect: u64, ops: Vec<Value>) -> Value {
    json!({ "expected_config_version": expect, "operations": ops })
}

fn read_body(hid: Uuid, gid: Uuid) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "read_dns_management",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns"
    })
}

async fn worker_read(http: &Http, token: &str, hid: Uuid, gid: Uuid) -> (u16, Value) {
    http.worker(
        "/worker/network/dns-management/read",
        token,
        read_body(hid, gid),
    )
    .await
}

/// The worker router keeps its original 5/s governor; a long ledger test can
/// outrun it even with pacing. Retry only on 429, never on other statuses.
async fn worker_read_paced(http: &Http, token: &str, hid: Uuid, gid: Uuid) -> (u16, Value) {
    for _ in 0..20 {
        let result = worker_read(http, token, hid, gid).await;
        if result.0 != 429 {
            return result;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    worker_read(http, token, hid, gid).await
}

async fn worker_status_paced(http: &Http, token: &str, body: Value) -> (u16, Value) {
    for _ in 0..20 {
        let result = http
            .worker("/worker/network/dns/status", token, body.clone())
            .await;
        if result.0 != 429 {
            return result;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    http.worker("/worker/network/dns/status", token, body).await
}

fn status_body(
    hid: Uuid,
    gid: Uuid,
    config_version: u64,
    digest_hex: &str,
    applied_version: u64,
    report_id: Uuid,
) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "report_dns_status",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns",
        "report_id": report_id,
        "config_version": config_version,
        "body_sha256": digest_hex,
        "reported_at": Utc::now(),
        "applied": {
            "config_version": applied_version,
            "generation": 4,
            "filter_generation": 2,
            "filter_identity": "id-2",
            "applied_at": Utc::now(),
            "last_error": null
        },
        "sources": [{
            "id": "list1",
            "download": "fresh",
            "checked_at": Utc::now(),
            "fetched_at": Utc::now(),
            "content_changed_at": Utc::now(),
            "next_due_at": Utc::now(),
            "stale": false,
            "failure_count": 0,
            "cooldown_until": null,
            "last_error": null,
            "bytes": 1024,
            "rule_count": 12,
            "downloaded_sha256": "a".repeat(64)
        }],
        "refresh_ack": []
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[sqlx::test]
async fn initial_get_is_null_then_cas_create_noop_and_safe_audit(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");

    let (status, body) = http.get(&path).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["desired"].is_null());
    assert_eq!(body["supported"]["worker_consumer"], "opt_in");
    assert_eq!(body["supported"]["verified"], false);
    assert_eq!(body["supported"]["serve_stale"], false);

    let (status, body) = http
        .patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], true);
    assert_eq!(body["desired"]["config_version"], 1);
    let digest_value = body["desired"]["body_sha256"].as_str().unwrap().to_string();
    assert_eq!(digest_value.len(), 64);

    // No-op: same canonical bytes, no version bump, no audit row.
    let count_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_audit WHERE household_id = $1 AND action = 'network_dns_management_patch'",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, body) = http
        .patch(
            &path,
            patch_with(1, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], false);
    assert_eq!(body["desired"]["config_version"], 1);
    let count_after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_audit WHERE household_id = $1 AND action = 'network_dns_management_patch'",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count_before, count_after);

    // Stale CAS and caller-supplied server-owned fields.
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"remove_list","id":"list1"})]),
        )
        .await
        .0,
        409
    );
    assert_eq!(
        http.patch(
            &path,
            json!({"expected_config_version":1,"operations":[],"config_version":9}),
        )
        .await
        .0,
        400
    );

    // Safe audit: no URL or metadata text is persisted.
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM network_audit WHERE household_id = $1 AND action = 'network_dns_management_patch'",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let rendered = detail.to_string();
    assert!(!rendered.contains("github"));
    assert!(!rendered.contains("Publisher"));
    assert_eq!(detail["operations"][0], "add_list");
}

#[sqlx::test]
async fn patch_rejects_unsafe_urls_bad_bounds_and_unknown_fields(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");

    for bad in [
        "http://example.com/hosts",
        "https://user:pass@example.com/hosts",
        "https://example.com/hosts?token=abc",
        "https://example.com/hosts#frag",
        "https://127.0.0.1/hosts",
        "https://10.0.0.1/hosts",
        "https://github.com/o/r/blob/main/hosts",
        "https://raw.githubusercontent.com/o/r",
    ] {
        let mut s = source("bad");
        s["url"] = json!(bad);
        assert_eq!(
            http.patch(
                &path,
                patch_with(0, vec![json!({"op":"add_list","source":s})])
            )
            .await
            .0,
            400,
            "accepted {bad}"
        );
    }
    let mut s = source("bad");
    s["interval_secs"] = json!(10);
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":s})])
        )
        .await
        .0,
        400
    );
    let mut s = source("bad");
    s["format"] = json!("regex");
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":s})])
        )
        .await
        .0,
        400
    );
    assert_eq!(
        http.patch(
            &path,
            patch_with(
                0,
                vec![json!({"op":"select_services","ids":["not-in-catalog"]})],
            ),
        )
        .await
        .0,
        400
    );
    assert_eq!(
        http.patch(
            &path,
            json!({"expected_config_version":0,"operations":[{"op":"unknown"}]}),
        )
        .await
        .0,
        400
    );
    // Nothing was saved by any rejected request.
    assert!(http.get(&path).await.1["desired"].is_null());
}

#[sqlx::test]
async fn management_never_touches_policy_history_or_assignment(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;

    // Publish a policy and assign it before touching management.
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/policies"),
            json!({
                "baseline": [], "device_profiles": {}, "person_rules": {}, "exceptions": [],
                "default_effect": "deny", "timezone": "Australia/Sydney",
                "stale_after_secs": 3600, "event_retention_secs": 86400
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        http.put(
            &format!("/api/network/households/{hid}/gateways/{gid}/desired-policy"),
            json!({"revision":1}),
        )
        .await
        .0,
        200
    );
    let before: (i64, String) = sqlx::query_as(
        "SELECT revision, body_sha256 FROM network_policies WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let desired_before: i64 = sqlx::query_scalar(
        "SELECT revision FROM network_gateway_desired_policy WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();

    let (status, _) = http
        .patch(
            &format!("/api/network/households/{hid}/dns/management"),
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await;
    assert_eq!(status, 200);
    let after: (i64, String) = sqlx::query_as(
        "SELECT revision, body_sha256 FROM network_policies WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let desired_after: i64 = sqlx::query_scalar(
        "SELECT revision FROM network_gateway_desired_policy WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(desired_before, desired_after);
    assert_eq!(
        http.get(&format!("/api/network/households/{hid}/policies/current"))
            .await
            .1["policy"]["revision"],
        1
    );
}

#[sqlx::test]
async fn grants_csrf_and_auth_separation(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");
    let status_path = format!("/api/network/households/{hid}/dns/status");

    let viewer = insert_user(&pool, "viewer", "viewer").await;
    let (vtoken, vcsrf) = session_for(&pool, viewer, "viewer").await;
    let viewer_http = Http::new(&base, vtoken, vcsrf);
    assert_eq!(viewer_http.get(&path).await.0, 403);
    assert_eq!(viewer_http.get(&status_path).await.0, 403);
    grant(&http, hid, viewer, "network_events").await;
    assert_eq!(viewer_http.get(&status_path).await.0, 200);
    assert_eq!(viewer_http.get(&path).await.0, 403);
    assert_eq!(
        viewer_http
            .patch(
                &path,
                patch_with(0, vec![json!({"op":"add_list","source":source("l")})])
            )
            .await
            .0,
        403
    );

    // CSRF is inherited from /api for writes.
    let no_csrf = http
        .client
        .patch(format!("{}{}", base, path))
        .header("cookie", format!("session={}", http.token))
        .header("content-type", "application/json")
        .json(&patch_with(
            0,
            vec![json!({"op":"add_list","source":source("l")})],
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(no_csrf.status().as_u16(), 403);

    // A worker Bearer cannot authenticate a dashboard route and a cookie
    // cannot authenticate a worker route.
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(
        &http,
        hid,
        gid,
        Some(vec![
            "heartbeat",
            "read_dns_management",
            "report_dns_status",
        ]),
    )
    .await;
    let no_session = http
        .client
        .get(format!("{}{}", base, path))
        .header("authorization", &cred)
        .send()
        .await
        .unwrap();
    assert_eq!(no_session.status().as_u16(), 401);
    assert_eq!(
        http.worker_no_bearer("/worker/network/dns-management/read", read_body(hid, gid),)
            .await,
        401
    );
}

async fn grant(http: &Http, hid: Uuid, user_id: Uuid, name: &str) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": name }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
}

#[sqlx::test]
async fn worker_commands_are_explicit_scoped_and_dns_only(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let proxy_gid = create_gateway(&http, hid, "proxy").await;

    let old = issue_cred(&http, hid, gid, None).await;
    let read_policy_only = issue_cred(&http, hid, gid, Some(vec!["read_policy"])).await;
    let full = issue_cred(
        &http,
        hid,
        gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let proxy_full = issue_cred(
        &http,
        hid,
        proxy_gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;

    // Old credentials are never silently upgraded.
    assert_eq!(worker_read(&http, &old, hid, gid).await.0, 401);
    assert_eq!(worker_read(&http, &read_policy_only, hid, gid).await.0, 401);
    assert_eq!(
        http.worker(
            "/worker/network/dns/status",
            &old,
            status_body(hid, gid, 1, &"b".repeat(64), 1, Uuid::new_v4()),
        )
        .await
        .0,
        401
    );
    // Kind and tenant mismatch close identically.
    assert_eq!(worker_read(&http, &full, hid, proxy_gid).await.0, 401);
    assert_eq!(worker_read(&http, &proxy_full, hid, gid).await.0, 401);
    assert_eq!(worker_read(&http, &full, Uuid::new_v4(), gid).await.0, 401);
    // An explicit read_policy credential cannot use the new command name on
    // the new route even if the body claims it.
    let mut wrong = read_body(hid, gid);
    wrong["command"] = json!("read_policy");
    assert_eq!(
        http.worker("/worker/network/dns-management/read", &full, wrong)
            .await
            .0,
        401
    );

    // Disable and revoke close the worker route immediately.
    let other = issue_cred(&http, hid, gid, Some(vec!["read_dns_management"])).await;
    assert_eq!(worker_read(&http, &other, hid, gid).await.0, 200);
    assert_eq!(
        http.patch(
            &format!("/api/network/households/{hid}/gateways/{gid}"),
            json!({"enabled": false}),
        )
        .await
        .0,
        200
    );
    assert_eq!(worker_read(&http, &other, hid, gid).await.0, 401);
}

#[sqlx::test]
async fn delivery_ledger_accepts_lagging_applied_and_rejects_unknown(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(
        &http,
        hid,
        gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let path = format!("/api/network/households/{hid}/dns/management");
    // Version 1.
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await
        .0,
        200
    );
    let (status, read) = worker_read_paced(&http, &cred, hid, gid).await;
    assert_eq!(status, 200, "{read}");
    let digest1 = read["body_sha256"].as_str().unwrap().to_string();

    // Version 2 is delivered, but the worker reports applied version 1.
    assert_eq!(
        http.patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"set_list","id":"list1","patch":{"enabled":false}})],
            ),
        )
        .await
        .0,
        200
    );
    let (status, read2) = worker_read_paced(&http, &cred, hid, gid).await;
    assert_eq!(status, 200, "{read2}");
    let digest2 = read2["body_sha256"].as_str().unwrap().to_string();
    assert_ne!(digest1, digest2);

    let status_path = format!("/api/network/households/{hid}/dns/status");
    let report = status_body(hid, gid, 2, &digest2, 1, Uuid::new_v4());
    let (status, body) = http
        .worker("/worker/network/dns/status", &cred, report)
        .await;
    assert_eq!(status, 200, "{body}");
    let view = http.get(&status_path).await.1;
    let applied = &view["gateways"][0]["status"]["applied"];
    assert_eq!(applied["config_version"], 1);
    assert_eq!(applied["body_sha256"], digest1);
    assert_eq!(view["gateways"][0]["status"]["config_version"], 2);
    assert!(view["gateways"][0]["status"].get("verified").is_none());
    assert!(view["gateways"][0]["status"].get("enforced").is_none());

    // A version never delivered, or a mismatched digest, is refused. A future
    // version is refused even when it looks "close" to the latest.
    let (status, _) = http
        .worker(
            "/worker/network/dns/status",
            &cred,
            status_body(hid, gid, 3, &digest2, 1, Uuid::new_v4()),
        )
        .await;
    assert_eq!(status, 409);
    let (status, _) = http
        .worker(
            "/worker/network/dns/status",
            &cred,
            status_body(hid, gid, 2, &"c".repeat(64), 1, Uuid::new_v4()),
        )
        .await;
    assert_eq!(status, 409);
    // No applied/enforced/verified column can be set through the body.
    let mut reported = status_body(hid, gid, 2, &digest2, 1, Uuid::new_v4());
    reported["verified"] = json!(true);
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred, reported)
            .await
            .0,
        400
    );
}

#[sqlx::test]
async fn refresh_is_per_gateway_idempotent_and_version_bound(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid_a = create_gateway(&http, hid, "dns").await;
    let gid_b = create_gateway(&http, hid, "dns").await;
    let cred_a = issue_cred(
        &http,
        hid,
        gid_a,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let cred_b = issue_cred(
        &http,
        hid,
        gid_b,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let path = format!("/api/network/households/{hid}/dns/management");
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await
        .0,
        200
    );
    let refresh_path = format!("/api/network/households/{hid}/dns/lists/list1/refresh");
    let (status, first) = http.post(&refresh_path, json!({})).await;
    assert_eq!(status, 200, "{first}");
    let seq = first["refresh_seq"].as_u64().unwrap();
    assert_eq!(first["created"], true);
    // Cooldown: same token within 60s is idempotent, no second seq.
    let (_, second) = http.post(&refresh_path, json!({})).await;
    assert_eq!(second["refresh_seq"], seq);
    assert_eq!(second["created"], false);
    assert_eq!(second["expires_at"], first["expires_at"]);
    assert_eq!(second["config_version"], first["config_version"]);
    // Missing and disabled sources.
    assert_eq!(
        http.post(
            &format!("/api/network/households/{hid}/dns/lists/missing/refresh"),
            json!({}),
        )
        .await
        .0,
        404
    );
    assert_eq!(
        http.patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"set_list","id":"list1","patch":{"enabled":false}})],
            ),
        )
        .await
        .0,
        200
    );
    assert_eq!(http.post(&refresh_path, json!({})).await.0, 409);
    // Disabled source removed its pending token.
    assert_eq!(
        worker_read(&http, &cred_a, hid, gid_a).await.1["pending_refreshes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // Re-enable, create a fresh token and deliver to BOTH gateways.
    assert_eq!(
        http.patch(
            &path,
            patch_with(
                2,
                vec![json!({"op":"set_list","id":"list1","patch":{"enabled":true}})],
            ),
        )
        .await
        .0,
        200
    );
    let (_, third) = http.post(&refresh_path, json!({})).await;
    let seq2 = third["refresh_seq"].as_u64().unwrap();
    assert_eq!(third["config_version"], 3);
    let read_a = worker_read(&http, &cred_a, hid, gid_a).await.1;
    let read_b = worker_read(&http, &cred_b, hid, gid_b).await.1;
    assert_eq!(read_a["pending_refreshes"][0]["refresh_seq"], seq2);
    assert_eq!(read_b["pending_refreshes"][0]["refresh_seq"], seq2);

    // Ack by A only; B still sees the token. Exact replay by A is idempotent.
    let digest3 = read_a["body_sha256"].as_str().unwrap().to_string();
    let mut ack_a = status_body(hid, gid_a, 3, &digest3, 3, Uuid::new_v4());
    ack_a["refresh_ack"] = json!([{
        "source_id":"list1","refresh_seq":seq2,"config_version":3
    }]);
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred_a, ack_a.clone())
            .await
            .0,
        200
    );
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred_a, ack_a)
            .await
            .0,
        200
    );
    assert_eq!(
        worker_read(&http, &cred_a, hid, gid_a).await.1["pending_refreshes"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        worker_read(&http, &cred_b, hid, gid_b).await.1["pending_refreshes"][0]["refresh_seq"],
        seq2
    );
    // A future/non-delivered token is refused.
    let mut forged = status_body(hid, gid_b, 3, &digest3, 3, Uuid::new_v4());
    forged["refresh_ack"] = json!([{
        "source_id":"list1","refresh_seq":999,"config_version":3
    }]);
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred_b, forged)
            .await
            .0,
        409
    );
    // Subsequent complete cycles for both gateways must replace stale delivery
    // and ack evidence, not make a new sequence permanently unacknowledgeable.
    let mut previous = seq2;
    for _ in 0..2 {
        sqlx::query("UPDATE network_dns_refresh_request SET requested_at = NOW() - INTERVAL '61 seconds' WHERE household_id = $1 AND source_id = 'list1'")
            .bind(hid).execute(&pool).await.unwrap();
        let (code, next) = http.post(&refresh_path, json!({})).await;
        assert_eq!(code, 200, "{next}");
        let seq = next["refresh_seq"].as_u64().unwrap();
        assert!(seq > previous);
        previous = seq;
        for (gid, cred) in [(gid_a, &cred_a), (gid_b, &cred_b)] {
            let (code, view) = worker_read_paced(&http, cred, hid, gid).await;
            assert_eq!(code, 200, "{view}");
            assert_eq!(view["pending_refreshes"][0]["refresh_seq"], seq);
            let mut ack = status_body(hid, gid, 3, &digest3, 3, Uuid::new_v4());
            ack["refresh_ack"] =
                json!([{"source_id":"list1","refresh_seq":seq,"config_version":3}]);
            let (code, body) = worker_status_paced(&http, cred, ack.clone()).await;
            assert_eq!(code, 200, "{body}");
            assert_eq!(worker_status_paced(&http, cred, ack).await.0, 200);
            let view = worker_read_paced(&http, cred, hid, gid).await.1;
            assert!(view["pending_refreshes"].as_array().unwrap().is_empty());
        }
    }
}

#[sqlx::test]
async fn never_applied_is_reported_as_null_and_tristate_set_clear(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(
        &http,
        hid,
        gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let path = format!("/api/network/households/{hid}/dns/management");
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await
        .0,
        200
    );
    let read = worker_read_paced(&http, &cred, hid, gid).await.1;
    let digest1 = read["body_sha256"].as_str().unwrap().to_string();

    // Download/compile failed: the worker has the desired config but no
    // applied management version. It must not invent one.
    let mut report = status_body(hid, gid, 1, &digest1, 1, Uuid::new_v4());
    report["applied"] = Value::Null;
    let (status, body) = http
        .worker("/worker/network/dns/status", &cred, report)
        .await;
    assert_eq!(status, 200, "{body}");
    let view = http
        .get(&format!("/api/network/households/{hid}/dns/status"))
        .await
        .1;
    assert!(view["gateways"][0]["status"]["applied"].is_null());
    assert!(view["gateways"][0]["reported_version"].is_null());
    // Delivery evidence still exists for an honest reread.
    assert_eq!(view["gateways"][0]["delivered_version"], 1);

    // Tri-state: absent keeps, explicit null clears, value sets.
    let (status, body) = http
        .patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"set_list","id":"list1","patch":{
                    "interval_secs":null,"max_stale_secs":null
                }})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let s = &body["desired"]["config"]["sources"][0];
    assert!(s["interval_secs"].is_null());
    assert!(s["max_stale_secs"].is_null());

    let (status, body) = http
        .patch(
            &path,
            patch_with(
                2,
                vec![json!({"op":"set_list","id":"list1","patch":{
                    "interval_secs":3600,"max_stale_secs":7200
                }})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let s = &body["desired"]["config"]["sources"][0];
    assert_eq!(s["interval_secs"], 3600);
    assert_eq!(s["max_stale_secs"], 7200);

    // Omission in a later patch preserves the set values.
    let (status, body) = http
        .patch(
            &path,
            patch_with(
                3,
                vec![json!({"op":"set_list","id":"list1","patch":{"enabled":false}})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let s = &body["desired"]["config"]["sources"][0];
    assert_eq!(s["interval_secs"], 3600);
    assert_eq!(s["max_stale_secs"], 7200);
}

#[sqlx::test]
async fn concurrent_cas_allows_exactly_one_writer(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let hid = bootstrap_as(&Http::new(&base, token.clone(), csrf.clone()), "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");
    let a = Http::new(&base, token.clone(), csrf.clone());
    let b = Http::new(&base, token, csrf);
    let patch = patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]);
    let (left, right) = tokio::join!(a.patch(&path, patch.clone()), b.patch(&path, patch),);
    let statuses = [left.0, right.0];
    assert_eq!(
        statuses.iter().filter(|s| **s == 200).count(),
        1,
        "{statuses:?}"
    );
    assert_eq!(
        statuses.iter().filter(|s| **s == 409).count(),
        1,
        "{statuses:?}"
    );
    let versions: Vec<i64> = sqlx::query_scalar(
        "SELECT config_version FROM network_dns_management_config WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(versions, vec![1]);
}

/// Save version `version` and deliver it to the gateway. Worker-router calls
/// stay under the existing burst-20 / one-token-per-5s governor.
async fn save_and_deliver(http: &Http, hid: Uuid, gid: Uuid, cred: &str, version: u64) {
    let path = format!("/api/network/households/{hid}/dns/management");
    let ops = if version == 1 {
        vec![json!({"op":"add_list","source":source("list1")})]
    } else {
        vec![json!({"op":"set_list","id":"list1","patch":{"enabled": version % 2 == 1}})]
    };
    let (status, body) = http.patch(&path, patch_with(version - 1, ops)).await;
    assert_eq!(status, 200, "version {version}: {body}");
    let (status, body) = worker_read_paced(http, cred, hid, gid).await;
    assert_eq!(status, 200, "{body}");
}

#[sqlx::test]
async fn delivery_ledger_is_bounded(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, Some(vec!["read_dns_management"])).await;

    for version in 1..=17u64 {
        save_and_deliver(&http, hid, gid, &cred, version).await;
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_dns_delivery WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count <= 16, "ledger grew to {count}");
}

#[sqlx::test]
async fn delivery_pin_survives_pruning_and_pruned_evidence_conflicts(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(
        &http,
        hid,
        gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    for version in 1..=12u64 {
        save_and_deliver(&http, hid, gid, &cred, version).await;
    }
    let digest12: String = sqlx::query_scalar(
        "SELECT body_sha256 FROM network_dns_delivery \
         WHERE household_id = $1 AND gateway_id = $2 AND config_version = 12",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, body) = worker_status_paced(
        &http,
        &cred,
        status_body(hid, gid, 12, &digest12, 1, Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    // A later delivery must not prune the ledger evidence referenced by the
    // latest status's TOP-LEVEL version (which can differ from its applied one).
    save_and_deliver(&http, hid, gid, &cred, 13).await;
    {
        let mut conn = pool.acquire().await.unwrap();
        let (delivered, applied, mut pins) =
            super::dns_management_db::delivery_pins_on_conn(&mut conn, hid, gid)
                .await
                .unwrap();
        assert_eq!(delivered, Some(13));
        assert!(
            pins.contains(&12),
            "latest status version must remain pinned"
        );
        pins.extend(delivered);
        pins.extend(applied);
        super::dns_management_db::prune_delivery_on_conn(&mut conn, hid, gid, 1, &pins)
            .await
            .unwrap();
    }

    // Force the bounded cleanup with a small window. The current delivered
    // (12) and reported-applied (1) pins must survive; older versions do not.
    {
        let mut conn = pool.acquire().await.unwrap();
        super::dns_management_db::prune_delivery_on_conn(&mut conn, hid, gid, 4, &[1, 12])
            .await
            .unwrap();
    }
    let pinned: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_dns_delivery WHERE household_id = $1 AND gateway_id = $2 AND config_version = 1)",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(pinned, "reported-applied pin was pruned");
    let exists2: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_dns_delivery WHERE household_id = $1 AND gateway_id = $2 AND config_version = 2)",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!exists2, "unpinned version 2 should have been pruned");

    // Version 2 has no evidence: honest 409, never a fabricated applied state
    // accepted merely because 2 <= 12.
    let (status, body) = worker_status_paced(
        &http,
        &cred,
        status_body(hid, gid, 12, &digest12, 2, Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 409, "{body}");
}

#[sqlx::test]
async fn catalog_provenance_is_operator_declared_and_body_is_capped(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");
    let catalog = json!({
        "version": "operator-2026-11",
        "services": [{
            "id": "video_site",
            "label": "Video Site",
            "version": "1",
            "domains": [{"type":"suffix","value":"video.example"}],
            "source": "https://example.org/operator-list",
            "evidence": "operator declared domains only",
            "license": "operator-declared"
        }]
    });
    let (status, body) = http
        .patch(
            &path,
            patch_with(
                0,
                vec![
                    json!({"op":"set_catalog","catalog":catalog}),
                    json!({"op":"select_services","ids":["video_site"]}),
                ],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let service = &body["desired"]["config"]["catalog"]["services"][0];
    assert_eq!(service["license"], "operator-declared");
    assert_eq!(service["source"], "https://example.org/operator-list");
    assert_eq!(
        body["desired"]["config"]["selected_services"][0],
        "video_site"
    );

    // A body over the 32 KiB route cap is refused before deserialization.
    let huge = "x".repeat(40 * 1024);
    let (status, _) = http
        .patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"add_list","source":{
                    "id":"big","url":"https://example.com/hosts","format":"hosts",
                    "enabled":true,"metadata":{"title":huge,"publisher":"p","license":"MIT"}
                }})],
            ),
        )
        .await;
    assert_eq!(status, 413);
    // The rejected oversized body did not change the saved config.
    let view = http.get(&path).await.1;
    assert_eq!(view["desired"]["config_version"], 1);
}

#[sqlx::test]
async fn status_rejects_untrusted_fields_timestamps_and_oversize(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(
        &http,
        hid,
        gid,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let path = format!("/api/network/households/{hid}/dns/management");
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})]),
        )
        .await
        .0,
        200
    );
    let digest_value = worker_read_paced(&http, &cred, hid, gid).await.1["body_sha256"]
        .as_str()
        .unwrap()
        .to_string();

    // URL in an error string is refused; no row is written.
    let mut report = status_body(hid, gid, 1, &digest_value, 1, Uuid::new_v4());
    report["sources"][0]["last_error"] = json!("failed https://example.com/list");
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred, report)
            .await
            .0,
        400
    );
    // Far-future timestamp is refused.
    let mut report = status_body(hid, gid, 1, &digest_value, 1, Uuid::new_v4());
    report["reported_at"] = json!(Utc::now() + ChronoDuration::days(2));
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred, report)
            .await
            .0,
        400
    );
    // 33 sources exceed the fixed bound.
    let mut report = status_body(hid, gid, 1, &digest_value, 1, Uuid::new_v4());
    report["sources"] = json!((0..33)
        .map(|i| json!({
            "id": format!("s{i}"),
            "download": "fresh",
            "bytes": 1,
        }))
        .collect::<Vec<Value>>());
    assert_eq!(
        http.worker("/worker/network/dns/status", &cred, report)
            .await
            .0,
        400
    );
    // Canonical digest in the DB matches the exact stored bytes.
    let (stored, digest_column): (Vec<u8>, String) = sqlx::query_as(
        "SELECT body, body_sha256 FROM network_dns_management_config WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(digest(&stored), digest_column);
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM network_dns_status WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
    let mut valid = status_body(hid, gid, 1, &digest_value, 1, Uuid::new_v4());
    valid["applied"]["applied_at"] = json!(Utc::now() - ChronoDuration::days(400));
    for field in ["checked_at", "fetched_at", "content_changed_at"] {
        valid["sources"][0][field] = json!(Utc::now() - ChronoDuration::days(400));
    }
    valid["sources"][0]["next_due_at"] = json!(Utc::now() + ChronoDuration::days(7));
    valid["sources"][0]["cooldown_until"] = json!(Utc::now() + ChronoDuration::days(1));
    let (status, result) = worker_status_paced(&http, &cred, valid.clone()).await;
    assert_eq!(status, 200, "{result}");
    for (field, value) in [
        ("next_due_at", Utc::now() + ChronoDuration::days(8)),
        ("checked_at", Utc::now() + ChronoDuration::minutes(2)),
    ] {
        let mut invalid = valid.clone();
        invalid["sources"][0][field] = json!(value);
        assert_eq!(worker_status_paced(&http, &cred, invalid).await.0, 400);
    }
    let mut invalid = valid.clone();
    invalid["config_version"] = json!(u64::MAX);
    assert_eq!(worker_status_paced(&http, &cred, invalid).await.0, 400);
    let mut invalid = valid;
    invalid["refresh_ack"] =
        json!([{"source_id":"list1","refresh_seq":u64::MAX,"config_version":1}]);
    assert_eq!(worker_status_paced(&http, &cred, invalid).await.0, 400);
}

#[sqlx::test]
async fn deduped_refresh_keeps_stored_version_expiry_and_checks_overflow(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let path = format!("/api/network/households/{hid}/dns/management");
    assert_eq!(
        http.patch(
            &path,
            patch_with(0, vec![json!({"op":"add_list","source":source("list1")})])
        )
        .await
        .0,
        200
    );
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, Some(vec!["read_dns_management"])).await;
    let refresh = format!("/api/network/households/{hid}/dns/lists/list1/refresh");
    let first = http.post(&refresh, json!({})).await.1;
    assert_eq!(
        http.patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"set_list","id":"list1","patch":{"interval_secs":3600}})]
            )
        )
        .await
        .0,
        200
    );
    let second = http.post(&refresh, json!({})).await.1;
    assert_eq!(second["created"], false);
    assert_eq!(second["config_version"], first["config_version"]);
    assert_eq!(second["expires_at"], first["expires_at"]);
    // This gateway never received config1. Reading current config2 must not
    // fabricate a config1 delivery or hit the refresh-delivery foreign key.
    let (code, view) = worker_read_paced(&http, &cred, hid, gid).await;
    assert_eq!(code, 200, "{view}");
    assert_eq!(view["config_version"], 2);
    assert!(view["pending_refreshes"].as_array().unwrap().is_empty());
    sqlx::query("UPDATE network_dns_refresh_request SET refresh_seq = $2, requested_at = NOW() - INTERVAL '61 seconds' WHERE household_id = $1")
        .bind(hid).bind(i64::MAX).execute(&pool).await.unwrap();
    assert_eq!(http.post(&refresh, json!({})).await.0, 409);
}

#[sqlx::test]
async fn refresh_database_cap_allows_updates_but_not_a_33rd_insert(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    for i in 0..32 {
        sqlx::query("INSERT INTO network_dns_refresh_request (household_id,source_id,refresh_seq,config_version,expires_at) VALUES ($1,$2,1,1,NOW()+INTERVAL '10 minutes')")
            .bind(hid).bind(format!("s{i}")).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE network_dns_refresh_request SET expires_at = expires_at + INTERVAL '1 minute' WHERE household_id = $1 AND source_id = 's0'")
        .bind(hid).execute(&pool).await.unwrap();
    assert!(sqlx::query("INSERT INTO network_dns_refresh_request (household_id,source_id,refresh_seq,config_version,expires_at) VALUES ($1,'extra',1,1,NOW()+INTERVAL '10 minutes')")
        .bind(hid).execute(&pool).await.is_err());
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_dns_refresh_request WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 32);
}

// ─── Runtime settings (schema v2) and cache-clear command ────────────────────

fn runtime_settings() -> Value {
    json!({
        "cache": {
            "enabled": true,
            "max_entries": 1024,
            "positive_min_ttl_secs": 5,
            "positive_max_ttl_secs": 300,
            "negative_min_ttl_secs": null,
            "negative_max_ttl_secs": null
        },
        "deny": {
            "mode": "sinkhole",
            "ipv4": "0.0.0.0",
            "ipv6": null,
            "ttl_secs": 30
        }
    })
}

#[sqlx::test]
async fn runtime_settings_are_cas_versioned_schema_gated_and_policy_independent(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let bearer = issue_cred(&http, hid, gid, Some(vec!["read_dns_management"])).await;
    let path = format!("/api/network/households/{hid}/dns/management");
    let policies_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_policies")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, body) = http
        .patch(
            &path,
            patch_with(
                0,
                vec![json!({"op":"set_runtime_settings","runtime":runtime_settings()})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["desired"]["schema_version"], 2);
    assert!(body["desired"]["config"].is_null());
    assert!(body["desired"]["config_v2"].is_object());
    assert_eq!(
        body["desired"]["config_v2"]["runtime"]["cache"]["max_entries"],
        1024
    );
    assert_eq!(body["supported"]["cache_ttl_controls"], true);
    assert_eq!(body["supported"]["response_mode_controls"], true);
    assert_eq!(body["supported"]["cache_clear"], true);
    assert_eq!(body["supported"]["serve_stale"], false);
    assert_eq!(body["supported"]["verified"], false);
    let digest_v2 = body["desired"]["body_sha256"].as_str().unwrap().to_owned();

    // Strict worker read: schema and typed bytes agree, no v1 body is present.
    let (status, read) = worker_read_paced(&http, &bearer, hid, gid).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["schema_version"], 2);
    assert!(read["config"].is_null());
    assert!(read["config_v2"].is_object());
    assert_eq!(read["body_sha256"], digest_v2);
    let typed: super::dns_management_dto::ManagementConfigV2 =
        serde_json::from_value(read["config_v2"].clone()).unwrap();
    assert_eq!(
        digest(&super::dns_management_dto::canonical_bytes_v2(&typed).unwrap()),
        digest_v2
    );

    // No-op and unsupported settings are honest.
    let (status, body) = http
        .patch(
            &path,
            patch_with(
                1,
                vec![json!({"op":"set_runtime_settings","runtime":runtime_settings()})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], false);
    let mut bad = runtime_settings();
    bad["cache"]["serve_expired"] = json!(true);
    let (status, _) = http
        .patch(
            &path,
            patch_with(1, vec![json!({"op":"set_runtime_settings","runtime":bad})]),
        )
        .await;
    assert_eq!(status, 400);
    let mut bad = runtime_settings();
    bad["cache"]["max_entries"] = json!(70_000);
    let (status, _) = http
        .patch(
            &path,
            patch_with(1, vec![json!({"op":"set_runtime_settings","runtime":bad})]),
        )
        .await;
    assert_eq!(status, 400);

    // Explicit reset returns to the frozen v1 shape with a real version bump.
    let (status, body) = http
        .patch(
            &path,
            patch_with(1, vec![json!({"op":"reset_runtime_settings"})]),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["desired"]["schema_version"], 1);
    assert!(body["desired"]["config_v2"].is_null());
    assert_eq!(body["desired"]["config_version"], 2);
    let policies_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_policies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(policies_before, policies_after);
}

fn clear_ack_body(
    mut base: Value,
    clear_seq: u64,
    config_version: u64,
    cleared_at: chrono::DateTime<Utc>,
) -> Value {
    base["clear_ack"] = json!([{
        "clear_seq": clear_seq,
        "config_version": config_version,
        "cleared_at": cleared_at
    }]);
    base
}

#[sqlx::test]
async fn cache_clear_delivery_ack_cooldown_and_per_gateway_isolation_are_truthful(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let user = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, user, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid_a = create_gateway(&http, hid, "dns").await;
    let gid_b = create_gateway(&http, hid, "dns").await;
    let cred_a = issue_cred(
        &http,
        hid,
        gid_a,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let cred_b = issue_cred(
        &http,
        hid,
        gid_b,
        Some(vec!["read_dns_management", "report_dns_status"]),
    )
    .await;
    let path = format!("/api/network/households/{hid}/dns/management");
    let clear_path = format!("/api/network/households/{hid}/dns/cache/clear");
    let status_path = format!("/api/network/households/{hid}/dns/status");
    let (status, saved) = http
        .patch(
            &path,
            patch_with(
                0,
                vec![json!({"op":"set_runtime_settings","runtime":runtime_settings()})],
            ),
        )
        .await;
    assert_eq!(status, 200, "{saved}");
    let digest_v2 = saved["desired"]["body_sha256"].as_str().unwrap().to_owned();

    // Stale CAS and an absent desired config are refused.
    let (status, _) = http
        .post(&clear_path, json!({"expected_config_version": 0}))
        .await;
    assert_eq!(status, 409);

    let (status, first) = http
        .post(&clear_path, json!({"expected_config_version": 1}))
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["clear_seq"], 1);
    assert_eq!(first["created"], true);
    let (status, replay) = http
        .post(&clear_path, json!({"expected_config_version": 1}))
        .await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["clear_seq"], 1);
    assert_eq!(replay["created"], false);
    assert_eq!(replay["expires_at"], first["expires_at"]);
    assert!(first.get("entries_count").is_none());

    // Both gateways receive the exact token inside their scoped read only.
    for (cred, gid) in [(&cred_a, gid_a), (&cred_b, gid_b)] {
        let (status, read) = worker_read_paced(&http, cred, hid, gid).await;
        assert_eq!(status, 200, "{read}");
        let pending = read["pending_cache_clear"].as_array().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["clear_seq"], 1);
        assert_eq!(pending[0]["config_version"], 1);
    }

    let attempted = Utc::now() - ChronoDuration::seconds(2);
    let report_a = clear_ack_body(
        status_body(hid, gid_a, 1, &digest_v2, 1, Uuid::new_v4()),
        1,
        1,
        attempted,
    );
    let (status, _) = worker_status_paced(&http, &cred_a, report_a.clone()).await;
    assert_eq!(status, 200);
    // Exact replay is idempotent; a different gateway cannot ack this token.
    let (status, _) = worker_status_paced(&http, &cred_a, report_a).await;
    assert_eq!(status, 200);
    let forged = clear_ack_body(
        status_body(hid, gid_b, 1, &digest_v2, 1, Uuid::new_v4()),
        9,
        1,
        attempted,
    );
    let (status, _) = worker_status_paced(&http, &cred_b, forged).await;
    assert_eq!(status, 409);

    let (status, view) = http.get(&status_path).await;
    assert_eq!(status, 200, "{view}");
    let gateways = view["gateways"].as_array().unwrap();
    let gw_a = gateways
        .iter()
        .find(|g| g["gateway_id"] == json!(gid_a.to_string()))
        .unwrap();
    let gw_b = gateways
        .iter()
        .find(|g| g["gateway_id"] == json!(gid_b.to_string()))
        .unwrap();
    assert_eq!(gw_a["cache_clear"]["clear_seq"], 1);
    assert!(gw_a["cache_clear"]["delivered_at"].is_string());
    assert!(gw_a["cache_clear"]["attempted_at"].is_string());
    assert!(gw_a["cache_clear"]["acked_at"].is_string());
    let attempted_reported: chrono::DateTime<Utc> = gw_a["cache_clear"]["attempted_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    // PostgreSQL stores microseconds; compare at millisecond precision.
    assert_eq!(
        attempted_reported.timestamp_millis(),
        attempted.timestamp_millis()
    );
    assert!(
        gw_b["cache_clear"]["acked_at"].is_null(),
        "gateway A ack hid gateway B"
    );
    assert!(gw_b["cache_clear"]["delivered_at"].is_string());
    assert!(gw_a["cache_clear"].get("entries_count").is_none());

    // B reports its own exact ack; no settings or policy version is bumped.
    let report_b = clear_ack_body(
        status_body(hid, gid_b, 1, &digest_v2, 1, Uuid::new_v4()),
        1,
        1,
        attempted,
    );
    let (status, _) = worker_status_paced(&http, &cred_b, report_b).await;
    assert_eq!(status, 200);
    let (status, current) = http.get(&path).await;
    assert_eq!(status, 200);
    assert_eq!(current["desired"]["config_version"], 1);

    // A new cycle after cooldown invalidates the old delivery+ack; replaying
    // the old token is refused, and the new token is independently acked.
    sqlx::query("UPDATE network_dns_cache_clear_request SET requested_at = NOW() - INTERVAL '61 seconds' WHERE household_id = $1")
        .bind(hid)
        .execute(&pool)
        .await
        .unwrap();
    let (status, second) = http
        .post(&clear_path, json!({"expected_config_version": 1}))
        .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["clear_seq"], 2);
    assert_eq!(second["created"], true);
    let (status, _) = worker_status_paced(
        &http,
        &cred_a,
        clear_ack_body(
            status_body(hid, gid_a, 1, &digest_v2, 1, Uuid::new_v4()),
            1,
            1,
            attempted,
        ),
    )
    .await;
    assert_eq!(status, 409, "stale token was acked after a new cycle");
    let (status, read) = worker_read_paced(&http, &cred_a, hid, gid_a).await;
    assert_eq!(status, 200);
    assert_eq!(read["pending_cache_clear"][0]["clear_seq"], 2);
    let (status, _) = worker_status_paced(
        &http,
        &cred_a,
        clear_ack_body(
            status_body(hid, gid_a, 1, &digest_v2, 1, Uuid::new_v4()),
            2,
            1,
            attempted,
        ),
    )
    .await;
    assert_eq!(status, 200);
}
