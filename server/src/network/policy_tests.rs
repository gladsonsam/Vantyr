//! Real-database tests for the versioned-policy / desired-assignment / scoped
//! worker-retrieval slice. Each `#[sqlx::test]` gets a fresh migrated database;
//! the harness mounts the admin API behind real session + CSRF middleware and
//! the worker routes at the top level, exactly like `app::router`.

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

use super::policy_dto::PolicyDraft;

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
    let token = format!("policy-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("policy-csrf-{label}");
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

    async fn put(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::PUT, path).json(&body)).await
    }

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }
}

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

    async fn read(&self, body: Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}/worker/network/policy/read", self.base))
            .header("authorization", self.bearer.clone())
            .header("content-type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        let json = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, json)
    }
}

async fn bootstrap_as(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn create_household(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/households", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "household create failed: {body}");
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

async fn issue(http: &Http, hid: Uuid, gid: Uuid, body: Value) -> (Uuid, String) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            body,
        )
        .await;
    assert_eq!(status, 200, "credential issue failed: {body}");
    let id = Uuid::parse_str(body["credential_id"].as_str().unwrap()).unwrap();
    let token = body["token"].as_str().unwrap().to_string();
    (id, token)
}

fn policy_body() -> Value {
    json!({
        "baseline": [
            {
                "id": "safety-malware",
                "effect": "deny",
                "matcher": { "domain_suffix": "malware.example" },
                "schedule": null,
                "reason": "safety baseline"
            }
        ],
        "device_profiles": {
            "family": [
                {
                    "id": "family-social",
                    "effect": "deny",
                    "matcher": { "domain_suffix": "social.example" },
                    "schedule": {
                        "weekdays": [0, 1, 2, 3, 4, 5, 6],
                        "start_minute": 0,
                        "end_minute": 1440,
                        "timezone": "Australia/Sydney"
                    },
                    "reason": "family profile"
                }
            ]
        },
        "person_rules": {},
        "exceptions": [],
        "default_effect": "deny",
        "timezone": "Australia/Sydney",
        "stale_after_secs": 3600,
        "event_retention_secs": 86400
    })
}

async fn publish(http: &Http, hid: Uuid, mut body: Value) -> (u16, Value) {
    if body.get("expected_revision").is_none() {
        body["expected_revision"] = Value::Null;
    }
    http.post(&format!("/api/network/households/{hid}/policies"), body)
        .await
}

fn read_body(hid: Uuid, gid: Uuid, kind: &str) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "read_policy",
        "household_id": hid,
        "gateway_id": gid,
        "kind": kind
    })
}

fn draft_from(value: Value) -> PolicyDraft {
    serde_json::from_value(value).expect("test body is a valid typed draft")
}

// ─── Admin authorization / CSRF / household scoping ─────────────────────────

#[sqlx::test]
async fn platform_role_without_scope_and_missing_csrf_are_denied(pool: PgPool) {
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

    let path = format!("/api/network/households/{hid}/policies");
    // Platform role alone never implies a network grant.
    assert_eq!(op.get(&path).await.0, 403);
    assert_eq!(other.get(&path).await.0, 403);
    assert_eq!(op.post(&path, policy_body()).await.0, 403);
    assert_eq!(other.post(&path, policy_body()).await.0, 403);

    // Even a granted user needs a valid CSRF token for a mutating request.
    grant_admin(&admin, hid, operator).await;
    let missing = op
        .client
        .post(format!("{base}{path}"))
        .header("cookie", format!("session={}", op.token))
        .header("content-type", "application/json")
        .json(&policy_body())
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status().as_u16(), 403, "CSRF is required");
    handle.abort();
}

#[sqlx::test]
async fn foreign_household_ids_never_read_or_write(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let stranger = insert_user(&pool, "stranger", "operator").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let (st, sc) = session_for(&pool, stranger, "stranger").await;
    let admin = Http::new(&base, at, ac);
    let stranger_http = Http::new(&base, st, sc);
    let hid_a = bootstrap_as(&admin, "A").await;
    let hid_b = create_household(&admin, "B").await;
    let gid_b = create_gateway(&admin, hid_b, "dns", "B DNS").await;

    let (status, _) = publish(&admin, hid_a, policy_body()).await;
    assert_eq!(status, 200);

    // B's admin grant cannot use it against A; a stranger has no grant at all.
    assert_eq!(
        stranger_http
            .get(&format!("/api/network/households/{hid_a}/policies"))
            .await
            .0,
        403
    );
    // A's gateway id is not a B scope: 403/404, never a foreign-row disclosure.
    assert_eq!(
        admin
            .get(&format!(
                "/api/network/households/{hid_a}/gateways/{gid_b}/desired-policy"
            ))
            .await
            .0,
        404
    );
    handle.abort();
}

// ─── Monotonic revisions, stale tokens, rollback ────────────────────────────

#[sqlx::test]
async fn concurrent_publish_allocates_distinct_monotonic_revisions(pool: PgPool) {
    let owner = insert_user(&pool, "owner", "admin").await;
    // Bootstrap directly so this test only needs the service layer.
    let hid = super::service::bootstrap_default_household(
        &pool,
        &crate::http::AuthUser {
            user_id: owner,
            username: "owner".into(),
            role: "admin".into(),
            display_name: String::new(),
            display_icon: None,
            csrf_token: "x".into(),
        },
        "Home",
        "Australia/Sydney",
    )
    .await
    .unwrap();

    let mut tasks = Vec::new();
    for _ in 0..6 {
        let p = pool.clone();
        let d = draft_from(policy_body());
        tasks.push(tokio::spawn(async move {
            super::policy_service::publish(&p, owner, hid, d, Utc::now())
                .await
                .map(|r| r.revision)
        }));
    }
    let results = tokio::time::timeout(
        Duration::from_secs(20),
        futures_util::future::join_all(tasks),
    )
    .await
    .expect("publish deadlock");
    let mut revisions: Vec<u64> = results
        .into_iter()
        .map(|r| r.expect("publish task"))
        .map(|r| r.expect("publish ok"))
        .collect();
    revisions.sort_unstable();
    assert_eq!(
        revisions,
        vec![1, 2, 3, 4, 5, 6],
        "revisions are unique and monotonic"
    );

    let rows = super::policy_db::list_versions(&pool, hid, 50, 0)
        .await
        .unwrap();
    assert_eq!(rows.len(), 6, "history retains every version at this bound");
    assert_eq!(rows[0].revision, 6);
}

#[sqlx::test]
async fn stale_expected_revision_is_409_and_rollback_creates_new_revision(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;

    assert_eq!(publish(&admin, hid, policy_body()).await.0, 200);
    // Correct token advances; stale token is refused without touching storage.
    let mut with_token = policy_body();
    with_token["expected_revision"] = json!(1);
    let (status, body) = publish(&admin, hid, with_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["revision"], 2);
    let mut stale = policy_body();
    stale["expected_revision"] = json!(1);
    assert_eq!(publish(&admin, hid, stale).await.0, 409);

    // A caller-supplied revision/household is an unknown field -> typed 400.
    let mut forged = policy_body();
    forged["revision"] = json!(99);
    forged["household_id"] = json!(Uuid::new_v4());
    assert_eq!(publish(&admin, hid, forged).await.0, 400);

    // Rollback copies revision 1 content into a NEW revision 3, keeping history.
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/policies/rollback"),
            json!({ "source_revision": 1 }),
        )
        .await;
    assert_eq!(status, 200, "rollback failed: {body}");
    assert_eq!(body["revision"], 3);
    assert_eq!(body["status"], "saved");
    let rows = super::policy_db::list_versions(&pool, hid, 50, 0)
        .await
        .unwrap();
    assert_eq!(rows.len(), 3);
    let rolled_back = rows.iter().find(|r| r.revision == 3).unwrap();
    assert_eq!(rolled_back.source_kind, "rollback");
    assert_eq!(rolled_back.rolled_back_from_revision, Some(1));
    assert_eq!(
        rows.iter().find(|r| r.revision == 1).unwrap().published_by,
        Some(owner)
    );
    handle.abort();
}

// ─── Desired assignment ──────────────────────────────────────────────────────

#[sqlx::test]
async fn desired_assignment_is_saved_only_and_foreign_refs_deny(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let other_hid = create_household(&admin, "Other").await;
    let dns_gid = create_gateway(&admin, hid, "dns", "DNS").await;
    let proxy_gid = create_gateway(&admin, hid, "proxy", "Proxy").await;
    // A revision that only exists in the OTHER household is not a valid
    // desired ref in this one: the assignment is scoped by household first.
    publish(&admin, other_hid, policy_body()).await;
    let path = format!("/api/network/households/{hid}/gateways/{dns_gid}/desired-policy");
    assert_eq!(
        admin.put(&path, json!({ "revision": 1 })).await.0,
        404,
        "foreign/unknown revision is denied in this household"
    );

    publish(&admin, hid, policy_body()).await;
    assert_eq!(admin.put(&path, json!({ "revision": 1 })).await.0, 200);
    let foreign = admin.put(&path, json!({ "revision": 99 })).await;
    assert_eq!(foreign.0, 404, "unknown revision in this household is 404");

    let (status, body) = admin.get(&path).await;
    assert_eq!(status, 200);
    assert_eq!(body["desired"]["revision"], 1);
    assert_eq!(body["desired"]["kind"], "dns");
    // No applied/enforced state is exposed by the saved assignment.
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("applied"));
    assert!(!text.contains("enforced"));

    // The gateway's own stored kind wins; a proxy gateway has kind proxy.
    let proxy_path = format!("/api/network/households/{hid}/gateways/{proxy_gid}/desired-policy");
    assert_eq!(
        admin.put(&proxy_path, json!({ "revision": 1 })).await.0,
        200
    );
    let (_, body) = admin.get(&proxy_path).await;
    assert_eq!(body["desired"]["kind"], "proxy");
    handle.abort();
}

// ─── Worker retrieval scope ──────────────────────────────────────────────────

#[sqlx::test]
async fn worker_read_requires_explicit_scope_and_no_implicit_upgrade(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "DNS").await;
    let (_hb_id, heartbeat_token) = issue(&admin, hid, gid, json!({})).await;
    let (scope_id, scope_token) = issue(
        &admin,
        hid,
        gid,
        json!({ "commands": ["heartbeat", "read_policy"] }),
    )
    .await;

    // Default issuance stays heartbeat-only; the scoped one carries both.
    let (_, list) = admin
        .get(&format!(
            "/api/network/households/{hid}/gateways/{gid}/credentials"
        ))
        .await;
    let cmds = |id: Uuid| -> Vec<String> {
        list["credentials"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"].as_str() == Some(&id.to_string()))
            .unwrap()["allowed_commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(cmds(_hb_id), vec!["heartbeat"]);
    assert_eq!(cmds(scope_id), vec!["heartbeat", "read_policy"]);

    let (status, _) = publish(&admin, hid, policy_body()).await;
    assert_eq!(status, 200);
    admin
        .put(
            &format!("/api/network/households/{hid}/gateways/{gid}/desired-policy"),
            json!({ "revision": 1 }),
        )
        .await;

    // Heartbeat-only credential cannot read, even though a policy is assigned.
    let hb = Worker::new(&base, heartbeat_token.clone());
    assert_eq!(hb.read(read_body(hid, gid, "dns")).await.0, 401);

    // Explicitly scoped credential can read its OWN assigned policy.
    let worker = Worker::new(&base, scope_token);
    let (status, body) = worker.read(read_body(hid, gid, "dns")).await;
    assert_eq!(status, 200, "scoped read failed: {body}");
    assert_eq!(body["revision"], 1);
    assert_eq!(body["schema_version"], 1);
    assert_eq!(
        body["original_published_at"].as_str().unwrap(),
        body["policy"]["published_at"].as_str().unwrap()
    );
    assert_eq!(body["policy"]["default_effect"], "deny");
    assert_eq!(
        body["policy"]["baseline"][0]["matcher"]["domain_suffix"],
        "malware.example"
    );
    let checksum = body["body_sha256"].as_str().unwrap();
    assert_eq!(checksum.len(), 64);
    // Digest is of the exact stored canonical bytes, not a fresh signature.
    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT body FROM network_policies WHERE household_id = $1 AND revision = 1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let policy: vantyr_network_policy::Policy = serde_json::from_slice(&stored).unwrap();
    let canonical = super::policy_dto::canonical_bytes(&policy).unwrap();
    assert_eq!(checksum, crate::auth::secrets::sha256_hex_bytes(&canonical));
    let text = serde_json::to_string(&body).unwrap();
    for forbidden in ["applied", "enforced", "token", "secret_hash", "signature"] {
        assert!(
            !text.contains(forbidden),
            "response leaks {forbidden}: {text}"
        );
    }

    // Legacy heartbeat still works with the default credential (back compat).
    let hb_body = json!({
        "audience": "vantyr-gateway-worker",
        "command": "heartbeat",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns",
        "capabilities": ["dns", "heartbeat"]
    });
    assert_eq!(
        hb.client
            .post(format!("{base}/worker/network/gateway/heartbeat"))
            .header("authorization", heartbeat_token.clone())
            .json(&hb_body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        200
    );
    handle.abort();
}

#[sqlx::test]
async fn revoked_expired_wrong_kind_and_unassigned_reads_fail(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let dns = create_gateway(&admin, hid, "dns", "DNS").await;
    let proxy = create_gateway(&admin, hid, "proxy", "Proxy").await;
    let (cid, token) = issue(&admin, hid, dns, json!({ "commands": ["read_policy"] })).await;
    publish(&admin, hid, policy_body()).await;

    // No assignment yet -> scoped 404, not a proof of foreign existence.
    let worker = Worker::new(&base, token.clone());
    assert_eq!(worker.read(read_body(hid, dns, "dns")).await.0, 404);

    admin
        .put(
            &format!("/api/network/households/{hid}/gateways/{dns}/desired-policy"),
            json!({ "revision": 1 }),
        )
        .await;

    // Wrong kind claim against the same credential is refused.
    assert_eq!(worker.read(read_body(hid, dns, "proxy")).await.0, 401);
    // Wrong gateway id cannot widen the credential's own scope.
    assert_eq!(worker.read(read_body(hid, proxy, "dns")).await.0, 401);
    // Dashboard cookie can never authenticate a worker route.
    let cookie_only = admin
        .client
        .post(format!("{base}/worker/network/policy/read"))
        .header("cookie", format!("session={}", admin.token))
        .json(&read_body(hid, dns, "dns"))
        .send()
        .await
        .unwrap();
    assert_eq!(cookie_only.status().as_u16(), 401);

    // Expiry is rechecked from the locked row on every read. Keep the
    // `expires_at > issued_at` CHECK satisfied while forcing an expired row.
    sqlx::query(
        "UPDATE network_gateway_credentials
         SET issued_at = NOW() - interval '2 hours', expires_at = NOW() - interval '1 hour'
         WHERE id = $1",
    )
    .bind(cid)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(worker.read(read_body(hid, dns, "dns")).await.0, 401);
    sqlx::query(
        "UPDATE network_gateway_credentials
         SET issued_at = NOW() - interval '1 hour', expires_at = NOW() + interval '1 hour'
         WHERE id = $1",
    )
    .bind(cid)
    .execute(&pool)
    .await
    .unwrap();
    // Revocation takes effect immediately (same connection-scoped lookup).
    assert_eq!(
        admin
            .delete(&format!(
                "/api/network/households/{hid}/gateways/{dns}/credentials/{cid}"
            ))
            .await
            .0,
        200
    );
    assert_eq!(worker.read(read_body(hid, dns, "dns")).await.0, 401);
    handle.abort();
}

#[sqlx::test]
async fn bounded_history_keeps_pinned_versions_and_never_claims_enforcement(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid, "dns", "DNS").await;
    let (_cid, token) = issue(&admin, hid, gid, json!({ "commands": ["read_policy"] })).await;

    // Pin revision 1 while it still exists, then publish far beyond the cap.
    assert_eq!(publish(&admin, hid, policy_body()).await.0, 200);
    assert_eq!(
        admin
            .put(
                &format!("/api/network/households/{hid}/gateways/{gid}/desired-policy"),
                json!({ "revision": 1 }),
            )
            .await
            .0,
        200
    );
    let extra = super::policy_dto::MAX_POLICY_HISTORY as u64 + 6;
    for _ in 0..extra {
        assert_eq!(publish(&admin, hid, policy_body()).await.0, 200);
    }
    let mut current = extra + 1;
    // Rolling back the current head repeatedly must not pin an unlimited
    // chain of predecessor payloads. Provenance survives as revision metadata.
    for _ in 0..40 {
        let (status, body) = admin
            .post(
                &format!("/api/network/households/{hid}/policies/rollback"),
                json!({ "source_revision": current, "expected_revision": current }),
            )
            .await;
        assert_eq!(status, 200, "rollback failed: {body}");
        current += 1;
        assert_eq!(body["revision"], current);
    }

    let rows = super::policy_db::list_versions(&pool, hid, 1000, 0)
        .await
        .unwrap();
    let revisions: Vec<i64> = rows.iter().map(|r| r.revision).collect();
    assert!(
        revisions.contains(&1),
        "pinned desired revision survives pruning"
    );
    assert!(
        revisions.contains(&(current as i64)),
        "current revision is never pruned"
    );
    assert!(
        revisions.len() <= super::policy_dto::MAX_POLICY_HISTORY as usize + 1,
        "history is bounded: got {} rows",
        revisions.len()
    );
    // Count is reported, not only a paginated slice.
    let (status, body) = admin
        .get(&format!("/api/network/households/{hid}/policies"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["count"].as_u64().unwrap() as usize, revisions.len());

    // The fetched policy still carries no enforcement/ack claim, and no ack
    // or apply route exists in this slice.
    let worker = Worker::new(&base, token);
    let (status, body) = worker.read(read_body(hid, gid, "dns")).await;
    assert_eq!(status, 200);
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("\"applied\""));
    assert!(!text.contains("\"enforced\""));
    for path in [
        format!("/api/network/households/{hid}/policies/1/apply"),
        format!("/api/network/households/{hid}/gateways/{gid}/ack"),
    ] {
        assert_eq!(admin.post(&path, json!({})).await.0, 404);
    }
    handle.abort();
}
