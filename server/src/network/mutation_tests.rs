//! Real-PostgreSQL HTTP tests for bounded household/gateway edits, conservative
//! inventory deletes and atomic default-profile selection. Each test gets a
//! fresh migrated database, a real router behind session + CSRF middleware and
//! real users/sessions. No mock extractors and no schema changes.

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
    let token = format!("mut-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("mut-csrf-{label}");
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

#[derive(Clone)]
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

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }

    async fn patch_no_csrf(&self, path: &str, body: Value) -> u16 {
        self.client
            .patch(format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    async fn delete_no_csrf(&self, path: &str) -> u16 {
        self.client
            .delete(format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
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

async fn create_household(http: &Http, name: &str) -> Uuid {
    let (status, body) = http
        .post("/api/network/households", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "{body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn grant(http: &Http, hid: Uuid, user_id: Uuid, name: &str) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": name }),
        )
        .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

fn policy_body() -> Value {
    json!({
        "baseline": [],
        "device_profiles": {},
        "person_rules": {},
        "exceptions": [],
        "default_effect": "deny",
        "timezone": "Australia/Sydney",
        "stale_after_secs": 3600,
        "event_retention_secs": 86400
    })
}

async fn publish(http: &Http, hid: Uuid) -> (u16, Value) {
    let mut body = policy_body();
    body["expected_revision"] = Value::Null;
    http.post(&format!("/api/network/households/{hid}/policies"), body)
        .await
}

async fn create_person(http: &Http, hid: Uuid, name: &str, default: bool) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/persons"),
            json!({ "display_name": name, "is_default_profile": default }),
        )
        .await;
    assert_eq!(status, 200, "person failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn create_device(http: &Http, hid: Uuid, key: &str) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/devices"),
            json!({ "canonical_key": key, "label": "Device", "device_type": "computer" }),
        )
        .await;
    assert_eq!(status, 200, "device failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn create_assignment(http: &Http, hid: Uuid, person: Uuid, device: Uuid) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/assignments"),
            json!({ "person_id": person, "device_id": device }),
        )
        .await;
    assert_eq!(status, 200, "assignment failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn create_connection(
    http: &Http,
    hid: Uuid,
    device: Uuid,
    assignment: Uuid,
    status: &str,
) -> Uuid {
    let (code, body) = http
        .post(
            &format!("/api/network/households/{hid}/connections"),
            json!({
                "device_id": device,
                "assignment_id": assignment,
                "kind": "dns",
                "status": status
            }),
        )
        .await;
    assert_eq!(code, 200, "connection failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn create_gateway(http: &Http, hid: Uuid) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": "dns", "label": "DNS" }),
        )
        .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue(http: &Http, hid: Uuid, gid: Uuid) -> String {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({ "commands": ["heartbeat", "read_policy"] }),
        )
        .await;
    assert_eq!(status, 200, "credential failed: {body}");
    body["token"].as_str().unwrap().to_string()
}

struct Worker {
    base: String,
    bearer: String,
}

impl Worker {
    fn new(base: &str, bearer: String) -> Self {
        Self {
            base: base.to_string(),
            bearer,
        }
    }

    async fn post(&self, path: &str, body: Value) -> u16 {
        reqwest::Client::new()
            .post(format!("{}{}", self.base, path))
            .header("authorization", self.bearer.clone())
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }
}

async fn count_defaults(pool: &PgPool, household_id: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM network_persons WHERE household_id = $1 AND is_default_profile",
    )
    .bind(household_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn person_is_default(pool: &PgPool, person_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT is_default_profile FROM network_persons WHERE id = $1")
        .bind(person_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn read_body(hid: Uuid, gid: Uuid) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "read_policy",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns"
    })
}

fn heartbeat_body(hid: Uuid, gid: Uuid) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "heartbeat",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns",
        "capabilities": ["dns"]
    })
}

// ─── Household edits ─────────────────────────────────────────────────────────

#[sqlx::test]
async fn household_patch_is_bounded_scoped_and_never_republishes_policy(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let operator = insert_user(&pool, "operator", "operator").await;
    let events = insert_user(&pool, "events", "viewer").await;
    let other = insert_user(&pool, "other", "admin").await;
    let (ot, oc) = session_for(&pool, operator, "operator").await;
    let (et, ec) = session_for(&pool, events, "events").await;
    let (bt, bc) = session_for(&pool, other, "other").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let op = Http::new(&base, ot, oc);
    let ev = Http::new(&base, et, ec);
    let other_http = Http::new(&base, bt, bc);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    grant(&admin, hid, events, "network_events").await;
    grant(&admin, hid_b, other, "network_admin").await;
    assert_eq!(publish(&admin, hid).await.0, 200);

    let path = format!("/api/network/households/{hid}");
    assert_eq!(op.patch(&path, json!({ "name": "X" })).await.0, 403);
    assert_eq!(ev.patch(&path, json!({ "name": "X" })).await.0, 403);
    assert_eq!(other_http.patch(&path, json!({ "name": "X" })).await.0, 403);
    assert_eq!(
        admin.patch_no_csrf(&path, json!({ "name": "X" })).await,
        403
    );

    for body in [
        json!({}),
        json!({ "name": "  " }),
        json!({ "timezone": "Mars/Olympus" }),
        json!({ "name": "x", "unknown": true }),
    ] {
        assert_eq!(
            admin.patch(&path, body.clone()).await.0,
            400,
            "invalid patch: {body}"
        );
    }

    let current = admin
        .get(&format!("/api/network/households/{hid}/policies/current"))
        .await
        .1;
    let audit_before =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();

    let (status, body) = admin
        .patch(&path, json!({ "name": "Home", "timezone": "UTC" }))
        .await;
    assert_eq!(status, 200, "no-op patch failed: {body}");
    assert_eq!(body["changed_fields"].as_array().unwrap().len(), 0);

    let (status, body) = admin
        .patch(
            &path,
            json!({ "name": "Renamed Home", "timezone": "Australia/Melbourne" }),
        )
        .await;
    assert_eq!(status, 200, "patch failed: {body}");
    assert_eq!(body["household"]["name"], "Renamed Home");
    assert_eq!(body["household"]["timezone"], "Australia/Melbourne");
    let changed: Vec<&str> = body["changed_fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(changed, vec!["name", "timezone"]);

    // Configuration edit does not touch immutable policy or its digest.
    let after = admin
        .get(&format!("/api/network/households/{hid}/policies/current"))
        .await
        .1;
    assert_eq!(current, after);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM network_policies WHERE household_id = $1"
        )
        .bind(hid)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let audit_after =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        audit_after,
        audit_before + 1,
        "only real changes are audited"
    );
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM network_audit WHERE household_id = $1 AND action = 'network_household_update'",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(detail["changed_fields"][0], "name");
    assert!(!detail.to_string().contains("secret"));
    handle.abort();
}

// ─── Gateway enablement ──────────────────────────────────────────────────────

#[sqlx::test]
async fn gateway_disable_reenable_and_irreversible_revoke(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let gid = create_gateway(&admin, hid).await;
    let token = issue(&admin, hid, gid).await;
    let worker = Worker::new(&base, token);
    assert_eq!(publish(&admin, hid).await.0, 200);
    admin
        .put(
            &format!("/api/network/households/{hid}/gateways/{gid}/desired-policy"),
            json!({ "revision": 1 }),
        )
        .await;
    assert_eq!(
        worker
            .post("/worker/network/policy/read", read_body(hid, gid))
            .await,
        200
    );
    assert_eq!(
        worker
            .post(
                "/worker/network/gateway/heartbeat",
                heartbeat_body(hid, gid)
            )
            .await,
        200
    );

    let path = format!("/api/network/households/{hid}/gateways/{gid}");
    assert_eq!(
        admin
            .patch_no_csrf(&path, json!({ "enabled": false }))
            .await,
        403
    );
    for body in [
        json!({}),
        json!({ "kind": "proxy" }),
        json!({ "label": " " }),
    ] {
        assert_eq!(
            admin.patch(&path, body.clone()).await.0,
            400,
            "invalid patch: {body}"
        );
    }
    assert_eq!(
        admin
            .patch(
                &format!("/api/network/households/{hid}/gateways/{}", Uuid::new_v4()),
                json!({ "enabled": false })
            )
            .await
            .0,
        404
    );

    let (status, body) = admin
        .patch(&path, json!({ "label": "Front Door DNS" }))
        .await;
    assert_eq!(status, 200, "label patch failed: {body}");
    assert_eq!(body["gateway"]["label"], "Front Door DNS");
    assert_eq!(body["changed_fields"][0], "label");
    assert_eq!(body["gateway"]["enabled"], true);

    let (status, body) = admin.patch(&path, json!({ "enabled": false })).await;
    assert_eq!(status, 200, "disable failed: {body}");
    assert_eq!(body["gateway"]["enabled"], false);
    assert_eq!(body["changed_fields"][0], "enabled");
    // Existing credentials stay in place and keep their scope: only the stored
    // active check changes, so both worker routes fail immediately.
    assert_eq!(
        worker
            .post("/worker/network/policy/read", read_body(hid, gid))
            .await,
        401
    );
    assert_eq!(
        worker
            .post(
                "/worker/network/gateway/heartbeat",
                heartbeat_body(hid, gid)
            )
            .await,
        401
    );

    let (status, body) = admin.patch(&path, json!({ "enabled": true })).await;
    assert_eq!(status, 200, "re-enable failed: {body}");
    assert_eq!(body["gateway"]["enabled"], true);
    assert_eq!(
        worker
            .post("/worker/network/policy/read", read_body(hid, gid))
            .await,
        200
    );
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("applied") && !text.contains("protected"));

    // Revocation is irreversible; a revoked gateway cannot be re-enabled and
    // its credentials stay revoked.
    assert_eq!(admin.delete(&path).await.0, 200);
    assert_eq!(admin.patch(&path, json!({ "enabled": true })).await.0, 409);
    assert_eq!(
        worker
            .post("/worker/network/policy/read", read_body(hid, gid))
            .await,
        401
    );
    let creds = admin.get(&format!("{path}/credentials")).await.1;
    assert!(creds["credentials"][0]["revoked_at"].as_str().is_some());
    assert_eq!(
        creds["credentials"][0]["allowed_commands"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    handle.abort();
}

// ─── Conservative deletes ────────────────────────────────────────────────────

#[sqlx::test]
async fn referenced_inventory_deletes_are_refused_without_cascade(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let stranger = insert_user(&pool, "stranger", "admin").await;
    let (st, sc) = session_for(&pool, stranger, "stranger").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let other_http = Http::new(&base, st, sc);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    grant(&admin, hid_b, stranger, "network_admin").await;

    let person = create_person(&admin, hid, "Owner", false).await;
    let device = create_device(&admin, hid, "dev-one").await;
    let assignment = create_assignment(&admin, hid, person, device).await;
    let connection = create_connection(&admin, hid, device, assignment, "active").await;
    let free_person = create_person(&admin, hid, "Free", false).await;
    let free_device = create_device(&admin, hid, "dev-free").await;
    let foreign_person = create_person(&other_http, hid_b, "Foreign", false).await;

    let audit_before =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    let person_path = format!("/api/network/households/{hid}/persons/{person}");
    let device_path = format!("/api/network/households/{hid}/devices/{device}");
    let assignment_path = format!("/api/network/households/{hid}/assignments/{assignment}");
    let connection_path = format!("/api/network/households/{hid}/connections/{connection}");
    assert_eq!(admin.delete_no_csrf(&person_path).await, 403);
    assert_eq!(
        other_http.delete(&person_path).await.0,
        403,
        "no cross-household scope"
    );
    assert_eq!(
        admin
            .delete(&format!(
                "/api/network/households/{hid}/persons/{foreign_person}"
            ))
            .await
            .0,
        404,
        "foreign object id is not discoverable here"
    );

    for path in [
        &person_path,
        &device_path,
        &assignment_path,
        &connection_path,
    ] {
        let (status, body) = admin.delete(path).await;
        assert_eq!(status, 409, "referenced delete must be 409: {path} {body}");
        assert!(
            body["error"].as_str().unwrap().len() < 160,
            "error must stay bounded: {body}"
        );
    }
    // Every referenced row and the audit trail survive a rejected delete.
    let person_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_persons WHERE household_id = $1 AND id = $2)",
    )
    .bind(hid)
    .bind(person)
    .fetch_one(&pool)
    .await
    .unwrap();
    let device_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_devices WHERE household_id = $1 AND id = $2)",
    )
    .bind(hid)
    .bind(device)
    .fetch_one(&pool)
    .await
    .unwrap();
    let assignment_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_assignments WHERE household_id = $1 AND id = $2)",
    )
    .bind(hid)
    .bind(assignment)
    .fetch_one(&pool)
    .await
    .unwrap();
    let connection_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM network_connections WHERE household_id = $1 AND id = $2)",
    )
    .bind(hid)
    .bind(connection)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(person_exists && device_exists && assignment_exists && connection_exists);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap(),
        audit_before
    );

    // Active status blocks a connection until the admin records it inactive.
    assert_eq!(admin.delete(&connection_path).await.0, 409);
    assert_eq!(
        admin
            .patch(
                &connection_path,
                json!({ "status": "inactive", "revoked_at": null })
            )
            .await
            .0,
        200
    );
    assert_eq!(admin.delete(&connection_path).await.0, 200);
    assert_eq!(admin.delete(&connection_path).await.0, 404);
    assert_eq!(admin.delete(&assignment_path).await.0, 200);
    assert_eq!(admin.delete(&assignment_path).await.0, 404);
    assert_eq!(admin.delete(&device_path).await.0, 200);
    assert_eq!(admin.delete(&device_path).await.0, 404);

    // Unreferenced metadata deletes cleanly and repeats are 404.
    for path in [
        format!("/api/network/households/{hid}/persons/{free_person}"),
        format!("/api/network/households/{hid}/devices/{free_device}"),
    ] {
        assert_eq!(admin.delete(&path).await.0, 200, "delete failed: {path}");
        assert_eq!(admin.delete(&path).await.0, 404, "repeat must be 404");
    }
    let delete_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_audit \
         WHERE household_id = $1 AND action IN \
         ('network_person_delete','network_device_delete','network_assignment_delete','network_connection_delete')",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        delete_audits, 5,
        "each successful delete is audited; refusals are not"
    );
    handle.abort();
}

#[sqlx::test]
async fn target_row_lock_blocks_concurrent_fk_insert(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let person = create_person(&admin, hid, "Locked", false).await;
    let device = create_device(&admin, hid, "lock-device").await;

    // A delete mutator holds the household row lock and then the person row
    // FOR UPDATE before counting references. A concurrent FK insert that does
    // not lock the household must block on the person's KEY SHARE lock.
    let mut guard = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM network_households WHERE id = $1 FOR UPDATE")
        .bind(hid)
        .execute(&mut *guard)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM network_persons WHERE household_id = $1 AND id = $2 FOR UPDATE")
        .bind(hid)
        .bind(person)
        .execute(&mut *guard)
        .await
        .unwrap();

    let insert_pool = pool.clone();
    let insert_person = person;
    let mut pending = tokio::spawn(async move {
        sqlx::query(
            "INSERT INTO network_assignments (household_id, person_id, device_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(hid)
        .bind(insert_person)
        .bind(device)
        .execute(&insert_pool)
        .await
        .is_ok()
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(400), &mut pending)
            .await
            .is_err(),
        "FK insert must wait while the delete decision is being made"
    );
    guard.rollback().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap(),
        "insert succeeds once the lock is released"
    );
    assert_eq!(
        admin
            .delete(&format!("/api/network/households/{hid}/persons/{person}"))
            .await
            .0,
        409,
        "the new assignment now blocks the delete"
    );
    handle.abort();
}

// ─── Atomic default profile ──────────────────────────────────────────────────

#[sqlx::test]
async fn default_profile_selection_is_atomic_and_preserves_nullable_notes(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let hid = bootstrap_as(&admin, "Home").await;
    let other_hid = create_household(&admin, "Other").await;

    let a = create_person(&admin, hid, "A", true).await;
    let b = create_person(&admin, hid, "B", true).await;
    assert_eq!(count_defaults(&pool, hid).await, 1);
    assert!(!person_is_default(&pool, a).await && person_is_default(&pool, b).await);

    // A missing or foreign target cannot clear the existing default.
    assert_eq!(
        admin
            .patch(
                &format!("/api/network/households/{hid}/persons/{}", Uuid::new_v4()),
                json!({ "is_default_profile": true })
            )
            .await
            .0,
        404
    );
    let foreign = create_person(&admin, other_hid, "Foreign", false).await;
    assert_eq!(
        admin
            .patch(
                &format!("/api/network/households/{hid}/persons/{foreign}"),
                json!({ "is_default_profile": true })
            )
            .await
            .0,
        404
    );
    assert_eq!(count_defaults(&pool, hid).await, 1);
    assert!(person_is_default(&pool, b).await);

    // Unsetting leaves zero defaults legal; the next explicit create fills it.
    assert_eq!(
        admin
            .patch(
                &format!("/api/network/households/{hid}/persons/{b}"),
                json!({ "is_default_profile": false })
            )
            .await
            .0,
        200
    );
    assert_eq!(count_defaults(&pool, hid).await, 0);
    let c = create_person(&admin, hid, "C", true).await;
    assert_eq!(count_defaults(&pool, hid).await, 1);
    assert!(person_is_default(&pool, c).await);

    // Two concurrent promotions both succeed with exactly one final default.
    let path_a = format!("/api/network/households/{hid}/persons/{a}");
    let path_c = format!("/api/network/households/{hid}/persons/{c}");
    let client_a = admin.clone();
    let client_c = admin.clone();
    let (ra, rc) = tokio::join!(
        client_a.patch(&path_a, json!({ "is_default_profile": true })),
        client_c.patch(&path_c, json!({ "is_default_profile": true }))
    );
    assert_eq!(ra.0, 200, "{ra:?}");
    assert_eq!(rc.0, 200, "{rc:?}");
    assert_eq!(count_defaults(&pool, hid).await, 1);

    // Accepted nullable-note semantics: omission keeps, explicit null clears.
    let path = format!("/api/network/households/{hid}/persons/{a}");
    assert_eq!(admin.patch(&path, json!({ "note": "hello" })).await.0, 200);
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM network_persons WHERE id = $1")
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(note.as_deref(), Some("hello"));
    assert_eq!(
        admin.patch(&path, json!({ "display_name": "A2" })).await.0,
        200
    );
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM network_persons WHERE id = $1")
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        note.as_deref(),
        Some("hello"),
        "omission must keep the note"
    );
    assert_eq!(admin.patch(&path, json!({ "note": null })).await.0, 200);
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM network_persons WHERE id = $1")
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(note.is_none(), "explicit null must clear the note");
    handle.abort();
}
