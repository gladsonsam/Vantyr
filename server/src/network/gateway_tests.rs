//! Real-database tests for the Vantyr Network gateway slice.
//!
//! Each `#[sqlx::test]` gets a fresh migrated Postgres database. The harness
//! mounts the admin API behind the real session + CSRF middleware and the
//! worker route at the top level outside it, exactly like `app::router`.

use std::net::SocketAddr;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::RequestBuilder;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

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
    let token = format!("tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("csrf-{label}");
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
        .merge(crate::platform::routes())
        .layer(from_fn_with_state(state.clone(), crate::auth::require_auth));
    let app = Router::new()
        .nest("/api", api)
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

    fn builder(&self, method: reqwest::Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("x-csrf-token", self.csrf.clone())
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(20))
    }

    async fn send(builder: RequestBuilder) -> (u16, Value) {
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

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }
}

/// Bearer-only client: no cookie, no CSRF header.
struct Worker {
    base: String,
    client: reqwest::Client,
    bearer: String,
}

impl Worker {
    fn new(base: &str, bearer: String) -> Self {
        Self {
            base: base.to_string(),
            client: reqwest::Client::new(),
            bearer,
        }
    }

    fn post_body(&self, body: Value) -> RequestBuilder {
        self.client
            .post(format!("{}/worker/network/gateway/heartbeat", self.base))
            .header("authorization", self.bearer.clone())
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(20))
            .json(&body)
    }

    async fn post(&self, body: Value) -> (u16, Value) {
        Http::send(self.post_body(body)).await
    }
}

const WORKER_PATH: &str = "/worker/network/gateway/heartbeat";

async fn bootstrap_as(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn grant_admin(owner: &Http, hid: Uuid, user_id: Uuid) {
    let (status, body) = owner
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": "network_admin" }),
        )
        .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

async fn create_gateway(http: &Http, hid: Uuid, kind: &str, label: &str) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": kind, "label": label }),
        )
        .await;
    assert_eq!(status, 200, "gateway create failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue(http: &Http, hid: Uuid, gid: Uuid) -> (Uuid, String) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "credential issue failed: {body}");
    let id = Uuid::parse_str(body["credential_id"].as_str().unwrap()).unwrap();
    let token = body["token"].as_str().unwrap().to_string();
    (id, token)
}

fn heartbeat_body(hid: Uuid, gid: Uuid, kind: &str) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "heartbeat",
        "household_id": hid,
        "gateway_id": gid,
        "kind": kind,
        "capabilities": ["dns", "heartbeat"],
        "desired_revision": "42",
        "applied_revision": "41",
        "failure": null
    })
}

// ─── Admin authz ─────────────────────────────────────────────────────────────

#[sqlx::test]
async fn platform_role_alone_never_implies_gateway_access(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let operator = insert_user(&pool, "op", "operator").await;
    let other_admin = insert_user(&pool, "other", "admin").await;
    let (ot, oc) = session_for(&pool, operator, "op").await;
    let (bt, bc) = session_for(&pool, other_admin, "other").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let op = Http::new(&base, ot, oc);
    let other = Http::new(&base, bt, bc);
    let hid = bootstrap_as(&admin, "Home").await;
    let path = format!("/api/network/households/{hid}/gateways");

    // Platform role alone, without an explicit network_admin grant, is denied.
    assert_eq!(op.get(&path).await.0, 403);
    assert_eq!(other.get(&path).await.0, 403);
    assert_eq!(
        op.post(&path, json!({ "kind": "dns", "label": "Nope" }))
            .await
            .0,
        403
    );
    assert_eq!(
        other
            .post(&path, json!({ "kind": "dns", "label": "Nope" }))
            .await
            .0,
        403
    );

    // Only an explicit household grant opens access; the platform role never
    // did. Once granted, the scoped operator may manage this household's
    // gateway inventory and credentials through the same audited endpoints.
    grant_admin(&admin, hid, operator).await;
    let (status, body) = op
        .post(&path, json!({ "kind": "dns", "label": "Op GW" }))
        .await;
    assert_eq!(status, 200, "explicit grant must allow inventory: {body}");
    let gid = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        op.post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({})
        )
        .await
        .0,
        200,
        "explicit network_admin grant authorizes scoped credential issuance"
    );
    handle.abort();
}

#[sqlx::test]
async fn gateway_ids_are_server_generated_and_kinds_are_bounded(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let path = format!("/api/network/households/{hid}/gateways");

    let (status, body) = admin
        .post(&path, json!({ "kind": "dhcp", "label": "Router" }))
        .await;
    assert_eq!(status, 400, "only DNS/Proxy gateways exist: {body}");
    let gid = create_gateway(&admin, hid, "DNS", "Core DNS").await;
    let (status, body) = admin.get(&path).await;
    assert_eq!(status, 200);
    let row = &body["gateways"][0];
    assert_eq!(row["kind"], "dns");
    assert_eq!(Uuid::parse_str(row["id"].as_str().unwrap()).unwrap(), gid);
    assert_eq!(row["enabled"], true);
    // No id/household_id may be taken from the body: the response id is the
    // immutable server-generated identity.
    let (status, _) = admin
        .post(
            &path,
            json!({ "kind": "proxy", "label": "P", "id": gid, "household_id": Uuid::new_v4() }),
        )
        .await;
    assert_eq!(status, 200, "extra body fields are ignored, never trusted");
    handle.abort();
}

// ─── Issuance / storage ──────────────────────────────────────────────────────

#[sqlx::test]
async fn credential_issued_once_stores_only_hash_and_list_has_no_hash(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let (cid, token) = issue(&admin, hid, gid).await;
    assert!(token.starts_with(&format!("Bearer {cid}.")));
    let secret = token.split('.').nth(1).unwrap();
    assert_eq!(secret.len(), 43);

    let hash: String =
        sqlx::query_scalar("SELECT secret_hash FROM network_gateway_credentials WHERE id = $1")
            .bind(cid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(hash.len(), 64);
    assert_ne!(hash, secret);
    assert_eq!(
        hash,
        crate::auth::secrets::sha256_hex_bytes(secret.as_bytes())
    );
    assert!(!hash.contains(secret));
    // Constant-time verification works against the stored hash only.
    assert!(super::gateway_auth::verify_secret(secret, &hash));
    assert!(!super::gateway_auth::verify_secret("wrong", &hash));

    let (status, body) = admin
        .get(&format!(
            "/api/network/households/{hid}/gateways/{gid}/credentials"
        ))
        .await;
    assert_eq!(status, 200);
    let text = serde_json::to_string(&body).unwrap();
    assert!(
        !text.contains("secret_hash"),
        "browser report leaks a hash: {text}"
    );
    assert!(
        !text.contains(secret),
        "browser report leaks the secret: {text}"
    );
    assert_eq!(body["credentials"][0]["id"], cid.to_string());

    // Household audit records the issuance without the secret; global audit is
    // a generic marker with no user info or ids.
    let audit: String = sqlx::query_scalar(
        "SELECT detail::text FROM network_audit WHERE action = 'network_gateway_credential_issue'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit.contains(&cid.to_string()));
    assert!(!audit.contains(secret));
    let global: Vec<String> =
        sqlx::query_scalar("SELECT detail::text FROM audit_log WHERE action = 'network_action'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        global.iter().all(|d| d == "{}"),
        "global marker leaked detail: {global:?}"
    );
    handle.abort();
}

#[sqlx::test]
async fn rotation_and_gateway_revocation_invalidate_old_credentials(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "proxy", "Edge").await;
    let (cid, token) = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token);
    assert_eq!(worker.post(heartbeat_body(hid, gid, "proxy")).await.0, 200);

    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials/{cid}/rotate"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "rotate failed: {body}");
    let new_cid = Uuid::parse_str(body["credential_id"].as_str().unwrap()).unwrap();
    let rotated_from: Option<Uuid> =
        sqlx::query_scalar("SELECT rotated_from FROM network_gateway_credentials WHERE id = $1")
            .bind(new_cid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rotated_from, Some(cid));
    let old_revoked: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM network_gateway_credentials WHERE id = $1",
    )
    .bind(cid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(old_revoked);

    let new_worker = Worker::new(&base, body["token"].as_str().unwrap().to_string());
    assert_eq!(
        new_worker.post(heartbeat_body(hid, gid, "proxy")).await.0,
        200
    );

    assert_eq!(
        admin
            .delete(&format!("/api/network/households/{hid}/gateways/{gid}"))
            .await
            .0,
        200
    );
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_gateway_credentials WHERE gateway_id = $1 AND revoked_at IS NULL",
    )
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active, 0, "revoking a gateway revokes all its credentials");
    handle.abort();
}

// ─── Worker heartbeat ────────────────────────────────────────────────────────

#[sqlx::test]
async fn heartbeat_records_reported_unverified_observations(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let (cid, token) = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token);
    let mut body = heartbeat_body(hid, gid, "dns");
    body["failure"] = json!("config reload delayed");
    let (status, response) = worker.post(body).await;
    assert_eq!(status, 200, "heartbeat failed: {response}");
    assert!(response["report_id"].is_i64());

    let row: (serde_json::Value, Option<String>, Option<String>, Option<String>, bool, bool) =
        sqlx::query_as(
            "SELECT capabilities, desired_revision, applied_revision, failure, verified, enforced FROM network_gateway_reports WHERE id = $1",
        )
        .bind(response["report_id"].as_i64().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, json!(["dns", "heartbeat"]));
    assert_eq!(row.1.as_deref(), Some("42"));
    assert_eq!(row.2.as_deref(), Some("41"));
    assert_eq!(row.3.as_deref(), Some("config reload delayed"));
    assert!(!row.4 && !row.5, "self-reports are never verified/enforced");

    let used: bool = sqlx::query_scalar(
        "SELECT last_used_at IS NOT NULL FROM network_gateway_credentials WHERE id = $1",
    )
    .bind(cid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(used);
    let (status, body) = admin
        .get(&format!(
            "/api/network/households/{hid}/gateways/{gid}/reports"
        ))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["reports"][0]["verified"], false);
    assert_eq!(body["reports"][0]["enforced"], false);
    handle.abort();
}

#[sqlx::test]
async fn worker_rejects_foreign_scope_wrong_command_and_bad_time(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let (status, body) = admin
        .post("/api/network/households", json!({ "name": "Other" }))
        .await;
    assert_eq!(status, 200);
    let other_hid = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let other_gid = create_gateway(&admin, other_hid, "dns", "Other Core").await;
    let (_, token) = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token);

    let mut body = heartbeat_body(hid, gid, "dns");
    body["household_id"] = json!(other_hid);
    assert_eq!(
        worker.post(body).await.0,
        401,
        "claimed other household denied"
    );
    let mut body = heartbeat_body(hid, gid, "dns");
    body["gateway_id"] = json!(other_gid);
    assert_eq!(
        worker.post(body).await.0,
        401,
        "claimed other gateway denied"
    );
    let mut body = heartbeat_body(hid, gid, "dns");
    body["kind"] = json!("proxy");
    assert_eq!(worker.post(body).await.0, 401, "mismatched kind denied");
    let mut body = heartbeat_body(hid, gid, "dns");
    body["command"] = json!("config-write");
    assert_eq!(
        worker.post(body).await.0,
        401,
        "command outside allowlist denied"
    );
    let mut body = heartbeat_body(hid, gid, "dns");
    body["audience"] = json!("dashboard");
    assert_eq!(worker.post(body).await.0, 401, "wrong audience denied");
    let mut body = heartbeat_body(hid, gid, "dns");
    body["observed_at"] = json!(Utc::now() + ChronoDuration::hours(1));
    assert_eq!(worker.post(body).await.0, 400, "future time denied");
    let mut body = heartbeat_body(hid, gid, "dns");
    body["observed_at"] = json!(Utc::now() - ChronoDuration::hours(1));
    assert_eq!(worker.post(body).await.0, 400, "stale time denied");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_gateway_reports")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "no rejected report was written");
    handle.abort();
}

#[sqlx::test]
async fn expiry_and_revocation_are_checked_on_every_request(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let (cid, token) = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token.clone());

    // Keep the schema's expiry > issued_at invariant: age both timestamps so
    // the credential is genuinely expired at request time.
    sqlx::query("UPDATE network_gateway_credentials SET issued_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1")
        .bind(cid)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        worker.post(heartbeat_body(hid, gid, "dns")).await.0,
        401,
        "expired denied"
    );
    sqlx::query("UPDATE network_gateway_credentials SET expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1")
        .bind(cid)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        worker.post(heartbeat_body(hid, gid, "dns")).await.0,
        200,
        "valid again"
    );
    assert_eq!(
        admin
            .delete(&format!(
                "/api/network/households/{hid}/gateways/{gid}/credentials/{cid}"
            ))
            .await
            .0,
        200
    );
    assert_eq!(
        worker.post(heartbeat_body(hid, gid, "dns")).await.0,
        401,
        "revoked denied"
    );
    handle.abort();
}

#[sqlx::test]
async fn cookie_cannot_impersonate_worker_and_bearer_cannot_reach_admin(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t.clone(), c.clone());
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let (_, token) = issue(&admin, hid, gid).await;

    // Cookie + CSRF on the worker endpoint: no bearer at all.
    let (status, _) = Http::send(
        admin
            .builder(reqwest::Method::POST, WORKER_PATH)
            .json(&heartbeat_body(hid, gid, "dns")),
    )
    .await;
    assert_eq!(
        status, 401,
        "dashboard cookie must not authenticate a worker"
    );

    // Bearer on an admin route: no cookie, no CSRF.
    let (status, _) = Http::send(
        reqwest::Client::new()
            .post(format!("{base}/api/network/households/{hid}/gateways"))
            .header("authorization", token.clone())
            .json(&json!({ "kind": "dns", "label": "Injected" })),
    )
    .await;
    assert_eq!(status, 401, "worker bearer must not reach an admin route");

    // Cookie without CSRF still cannot mutate an admin route.
    let (status, _) = Http::send(
        reqwest::Client::new()
            .post(format!("{base}/api/network/households/{hid}/gateways"))
            .header("cookie", format!("session={t}"))
            .json(&json!({ "kind": "dns", "label": "Injected" })),
    )
    .await;
    assert_eq!(status, 403, "CSRF is not bypassed by the worker mount");
    handle.abort();
}

#[sqlx::test]
async fn reports_are_bounded_and_gateway_ops_never_touch_agent_credentials(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (t, c) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, t, c);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "Core").await;
    let (_, token) = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token.clone());

    // A pre-existing agent identity and its module grant must be untouched.
    let agent_id = Uuid::new_v4();
    crate::test_support::insert_agent(&pool, agent_id)
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET api_token_hash = 'agent-secret-hash' WHERE id = $1")
        .bind(agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_module_reports (agent_id, state, conn_id) VALUES ($1, '{}'::jsonb, $2)",
    )
    .bind(agent_id)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    let before: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT api_token_hash FROM agents WHERE id = $1), \
                (SELECT COUNT(*) FROM agent_module_reports), \
                (SELECT COUNT(*) FROM network_grants), \
                (SELECT COUNT(*) FROM network_household_agents)",
    )
    .bind(agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let mut body = heartbeat_body(hid, gid, "dns");
    body["capabilities"] = json!(vec!["dns"; 33]);
    assert_eq!(
        worker.post(body).await.0,
        400,
        "unbounded collections denied"
    );
    let mut body = heartbeat_body(hid, gid, "dns");
    body["capabilities"] = json!(["file:///etc/passwd", "http://169.254.169.254/"]);
    assert_eq!(
        worker.post(body).await.0,
        400,
        "callback/SSRF-style values denied"
    );
    let huge = json!({ "failure": "x".repeat(5000) });
    assert!(
        Http::send(worker.post_body(huge)).await.0 == 413,
        "oversized body is capped before any DB work"
    );

    let after: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT api_token_hash FROM agents WHERE id = $1), \
                (SELECT COUNT(*) FROM agent_module_reports), \
                (SELECT COUNT(*) FROM network_grants), \
                (SELECT COUNT(*) FROM network_household_agents)",
    )
    .bind(agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "gateway slice touched agent/module/grant state"
    );

    // No secret reached either audit table.
    let secret = token.split('.').nth(1).unwrap();
    let household_audit: Vec<String> = sqlx::query_scalar("SELECT detail::text FROM network_audit")
        .fetch_all(&pool)
        .await
        .unwrap();
    let global_audit: Vec<String> = sqlx::query_scalar("SELECT detail::text FROM audit_log")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(household_audit
        .iter()
        .chain(global_audit.iter())
        .all(|d| !d.contains(secret)));
    handle.abort();
}
