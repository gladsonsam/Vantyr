//! End-to-end authz tests: each `#[sqlx::test]` gets a fresh migrated database,
//! a real router behind `require_auth` (session cookie + CSRF), and real users
//! and sessions in PostgreSQL. No mocked extractors or in-memory stand-ins.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::network::{db, dto};
use crate::state::AppState;

// ─── Test harness ────────────────────────────────────────────────────────────

async fn insert_user(pool: &PgPool, username: &str, role: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1, 'test-not-a-real-hash', $2) RETURNING id",
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
        Utc::now() + chrono::Duration::hours(1),
        None,
        &csrf,
    )
    .await
    .unwrap();
    (token, csrf)
}

async fn spawn_router(pool: PgPool) -> (String, JoinHandle<()>, Arc<AppState>) {
    let state = crate::test_support::app_state(pool);
    let app = crate::network::routes()
        .route_layer(from_fn_with_state(state.clone(), crate::auth::require_auth))
        .with_state(state.clone());
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
    (format!("http://127.0.0.1:{}", addr.port()), handle, state)
}

struct Http {
    base: String,
    client: reqwest::Client,
    token: String,
    csrf: String,
}

impl Http {
    fn new(base: String, token: String, csrf: String) -> Self {
        Self {
            base,
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
}

async fn bootstrap_as(base: &str, token: &str, csrf: &str, name: &str) -> Uuid {
    let http = Http::new(base.to_string(), token.to_string(), csrf.to_string());
    let (status, body) = http
        .post("/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[sqlx::test]
async fn bootstrap_is_admin_only_one_time_and_audited(pool: PgPool) {
    let (base, handle, state) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "root", "admin").await;
    let operator = insert_user(&pool, "op", "operator").await;
    let viewer = insert_user(&pool, "view", "viewer").await;
    let (at, ac) = session_for(&pool, admin, "admin").await;
    let (ot, oc) = session_for(&pool, operator, "op").await;
    let (vt, vc) = session_for(&pool, viewer, "view").await;
    let admin_http = Http::new(base.clone(), at.clone(), ac.clone());
    let op_http = Http::new(base.clone(), ot, oc);
    let view_http = Http::new(base.clone(), vt, vc);

    // The platform operator/viewer roles never authorize bootstrap.
    assert_eq!(
        op_http
            .post("/network/bootstrap", json!({ "name": "Nope" }))
            .await
            .0,
        403
    );
    assert_eq!(
        view_http
            .post("/network/bootstrap", json!({ "name": "Nope" }))
            .await
            .0,
        403
    );

    let hid = bootstrap_as(&base, &at, &ac, "Home").await;

    // Exactly one default household, one explicit grant, one audit row.
    let defaults: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM network_households WHERE is_default")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(defaults, 1);
    let grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_grants WHERE household_id = $1 AND user_id = $2 AND grant_name = 'network_admin'",
    )
    .bind(hid)
    .bind(admin)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grants, 1);
    let audits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'network_bootstrap'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audits, 1);

    // Race-safe one-time bootstrap: a second attempt is a conflict.
    let (status, _) = admin_http
        .post("/network/bootstrap", json!({ "name": "Again" }))
        .await;
    assert_eq!(status, 409);

    let (status, body) = admin_http.get("/network/households").await;
    assert_eq!(status, 200);
    assert_eq!(body["households"].as_array().unwrap().len(), 1);

    // Operator and viewer roles still have no inventory access.
    let path = format!("/network/households/{hid}/persons");
    assert_eq!(op_http.get(&path).await.0, 403);
    assert_eq!(view_http.get(&path).await.0, 403);

    let _ = state;
    handle.abort();
}

#[sqlx::test]
async fn admin_without_network_grant_is_denied_until_explicitly_granted(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "admin-a", "admin").await;
    let b = insert_user(&pool, "admin-b", "admin").await;
    let (at, ac) = session_for(&pool, a, "a").await;
    let (bt, bc) = session_for(&pool, b, "b").await;
    let hid = bootstrap_as(&base, &at, &ac, "Home").await;
    let admin_a = Http::new(base.clone(), at, ac);
    let admin_b = Http::new(base.clone(), bt, bc);
    let persons_path = format!("/network/households/{hid}/persons");

    // A second admin has no grant: no list, no read, no write, no grant management.
    let (status, body) = admin_b.get("/network/households").await;
    assert_eq!(status, 200);
    assert!(body["households"].as_array().unwrap().is_empty());
    assert_eq!(admin_b.get(&persons_path).await.0, 403);
    assert_eq!(
        admin_b
            .post(&persons_path, json!({ "display_name": "Intruder" }))
            .await
            .0,
        403
    );
    assert_eq!(
        admin_b
            .get(&format!("/network/households/{hid}/grants"))
            .await
            .0,
        403
    );

    // network_events alone does not authorize inventory reads.
    assert_eq!(
        admin_a
            .post(
                &format!("/network/households/{hid}/grants"),
                json!({ "user_id": b, "grant": "network_events" }),
            )
            .await
            .0,
        200
    );
    assert_eq!(admin_b.get(&persons_path).await.0, 403);

    // An explicit network_admin grant unlocks only that household.
    assert_eq!(
        admin_a
            .post(
                &format!("/network/households/{hid}/grants"),
                json!({ "user_id": b, "grant": "network_admin" }),
            )
            .await
            .0,
        200
    );
    assert_eq!(admin_b.get(&persons_path).await.0, 200);
    handle.abort();
}

#[sqlx::test]
async fn household_b_cannot_read_or_mutate_household_a_objects(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "owner", "admin").await;
    let c = insert_user(&pool, "member", "viewer").await;
    let (at, ac) = session_for(&pool, a, "owner").await;
    let (ct, cc) = session_for(&pool, c, "member").await;
    let ha = bootstrap_as(&base, &at, &ac, "House A").await;
    let owner = Http::new(base.clone(), at.clone(), ac.clone());
    let (status, body) = owner
        .post("/network/households", json!({ "name": "House B" }))
        .await;
    assert_eq!(status, 200, "{body}");
    let hb = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();
    assert_ne!(ha, hb);

    let pa: Uuid = {
        let (s, b) = owner
            .post(
                &format!("/network/households/{ha}/persons"),
                json!({ "display_name": "Alice" }),
            )
            .await;
        assert_eq!(s, 200, "{b}");
        Uuid::parse_str(b["id"].as_str().unwrap()).unwrap()
    };
    let pb: Uuid = {
        let (s, b) = owner
            .post(
                &format!("/network/households/{hb}/persons"),
                json!({ "display_name": "Bob" }),
            )
            .await;
        assert_eq!(s, 200, "{b}");
        Uuid::parse_str(b["id"].as_str().unwrap()).unwrap()
    };

    // Viewer C gets an explicit admin grant on A only.
    assert_eq!(
        owner
            .post(
                &format!("/network/households/{ha}/grants"),
                json!({ "user_id": c, "grant": "network_admin" }),
            )
            .await
            .0,
        200
    );
    let member = Http::new(base.clone(), ct, cc);

    let (status, body) = member
        .get(&format!("/network/households/{ha}/persons"))
        .await;
    assert_eq!(status, 200);
    let names: Vec<&str> = body["persons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["display_name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["Alice"]);

    assert_eq!(
        member
            .get(&format!("/network/households/{hb}/persons"))
            .await
            .0,
        403
    );
    assert_eq!(
        member
            .post(
                &format!("/network/households/{hb}/persons"),
                json!({ "display_name": "Eve" }),
            )
            .await
            .0,
        403
    );
    // A's grant must not authorize PATCH on a B-scoped path, with either id.
    assert_eq!(
        member
            .patch(
                &format!("/network/households/{hb}/persons/{pa}"),
                json!({ "display_name": "Hacked" }),
            )
            .await
            .0,
        403
    );
    // Even on the authorized household, a B object id must not be reachable.
    let (status, body) = member
        .patch(
            &format!("/network/households/{ha}/persons/{pb}"),
            json!({ "display_name": "Hacked" }),
        )
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(
        member
            .get(&format!("/network/households/{hb}/grants"))
            .await
            .0,
        403
    );
    handle.abort();
}

#[sqlx::test]
async fn cross_household_references_fail_and_agent_link_is_explicit(pool: PgPool) {
    let a = insert_user(&pool, "owner", "admin").await;
    // Snapshot module/Recall state before any inventory write; these tables must
    // be byte-for-byte unchanged (Recall has one seeded global row).
    let untouched_before = (
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_module_reports")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_module_disable_requests")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_settings_global")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_settings_agent")
            .fetch_one(&pool)
            .await
            .unwrap(),
    );
    let ha = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO network_households (name, is_default, created_by) VALUES ('A', true, $1) RETURNING id",
    )
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();
    let hb = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO network_households (name, created_by) VALUES ('B', $1) RETURNING id",
    )
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();

    let pa = db::insert_person(&pool, ha, "Alice", None).await.unwrap();
    let pb = db::insert_person(&pool, hb, "Bob", None).await.unwrap();
    let device = db::insert_device(&pool, "dev001", "Router", "router")
        .await
        .unwrap();

    let agent = Uuid::new_v4();
    crate::test_support::insert_agent(&pool, agent)
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET api_token_hash = 'sentinel-token-hash' WHERE id = $1")
        .bind(agent)
        .execute(&pool)
        .await
        .unwrap();
    db::insert_enrollment(&pool, hb, agent, a).await.unwrap();

    // Person from B cannot be assigned in A (composite FK).
    let wrong_person = sqlx::query(
        "INSERT INTO network_assignments (household_id, person_id, device_id) VALUES ($1, $2, $3)",
    )
    .bind(ha)
    .bind(pb)
    .bind(device)
    .execute(&pool)
    .await;
    assert!(
        wrong_person.is_err(),
        "cross-household person FK must reject"
    );

    // Agent enrolled in B cannot be linked to an assignment in A.
    let wrong_agent = sqlx::query(
        "INSERT INTO network_assignments (household_id, person_id, device_id, agent_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(ha)
    .bind(pa)
    .bind(device)
    .bind(agent)
    .execute(&pool)
    .await;
    assert!(wrong_agent.is_err(), "cross-household agent FK must reject");

    // No agent id means no agent is attributed (no IP/username inference).
    let bare = db::insert_assignment(&pool, ha, pa, device, None, "member", None)
        .await
        .unwrap();
    let stored: Option<Uuid> =
        sqlx::query_scalar("SELECT agent_id FROM network_assignments WHERE id = $1")
            .bind(bare)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(stored.is_none(), "agent must never be inferred");

    let enrolled_assignment =
        db::insert_assignment(&pool, hb, pb, device, Some(agent), "member", None)
            .await
            .unwrap();
    let wrong_connection = sqlx::query(
        "INSERT INTO network_connections (household_id, assignment_id, kind) VALUES ($1, $2, 'dns')",
    )
    .bind(ha)
    .bind(enrolled_assignment)
    .execute(&pool)
    .await;
    assert!(
        wrong_connection.is_err(),
        "cross-household connection FK must reject"
    );

    // No module grants, agent token or Recall settings were touched.
    let token_hash: String = sqlx::query_scalar("SELECT api_token_hash FROM agents WHERE id = $1")
        .bind(agent)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(token_hash, "sentinel-token-hash");
    let untouched_after = (
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_module_reports")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_module_disable_requests")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_settings_global")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_settings_agent")
            .fetch_one(&pool)
            .await
            .unwrap(),
    );
    assert_eq!(
        untouched_after, untouched_before,
        "inventory must not write module grants or Recall settings"
    );
}

#[sqlx::test]
async fn csrf_is_enforced_inputs_normalized_and_pages_capped(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "root", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let hid = bootstrap_as(&base, &token, &csrf, "Home").await;
    let http = Http::new(base.clone(), token.clone(), csrf.clone());
    let path = format!("/network/households/{hid}/persons");

    // The existing require_auth CSRF middleware applies to network POST/PATCH.
    let no_csrf = http
        .client
        .post(format!("{base}{path}"))
        .header("cookie", format!("session={token}"))
        .json(&json!({ "display_name": "No CSRF" }))
        .send()
        .await
        .unwrap();
    assert_eq!(no_csrf.status().as_u16(), 403);
    let body: Value = no_csrf.json().await.unwrap();
    assert_eq!(body["error"], "CSRF token missing or invalid");

    assert_eq!(
        http.post(&path, json!({ "display_name": "Carol" })).await.0,
        200
    );

    // Pagination and identifier normalization are bounded.
    assert_eq!(http.get(&format!("{path}?limit=5000")).await.0, 400);
    let devices_path = format!("/network/households/{hid}/devices");
    let (status, body) = http
        .post(
            &devices_path,
            json!({ "canonical_key": " AA-BB:cc_dd.11 ", "label": "Laptop" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let device_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    // Shared devices become visible in a household through an assignment.
    let (status, body) = http.post(&path, json!({ "display_name": "Dave" })).await;
    assert_eq!(status, 200, "{body}");
    let person_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, body) = http
        .post(
            &format!("/network/households/{hid}/assignments"),
            json!({ "person_id": person_id, "device_id": device_id }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = http.get(&devices_path).await;
    assert_eq!(status, 200);
    assert_eq!(body["devices"][0]["canonical_key"], "aabbccdd11");
    // The normalized duplicate key is rejected through the same path.
    assert_eq!(
        http.post(
            &devices_path,
            json!({ "canonical_key": "aabbccdd11", "label": "Duplicate" }),
        )
        .await
        .0,
        409
    );

    // The typed DTO validator rejects over-long capability lists.
    let too_many: Vec<String> = (0..33).map(|i| format!("c{i}")).collect();
    assert!(dto::normalize_capabilities(&Some(too_many)).is_err());

    handle.abort();
}
