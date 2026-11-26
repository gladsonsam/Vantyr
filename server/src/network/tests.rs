//! End-to-end authz tests: each `#[sqlx::test]` gets a fresh migrated database,
//! a real router behind `require_auth` (session cookie + CSRF), and real users
//! and sessions in PostgreSQL. No mocked extractors or in-memory stand-ins.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::network::{db, dto, service};
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

/// Mounts the feature routes under `/api` together with the platform audit
/// route, then applies the real session + CSRF middleware.
async fn spawn_router(pool: PgPool) -> (String, JoinHandle<()>, Arc<AppState>) {
    let state = crate::test_support::app_state(pool);
    let api = Router::new()
        .merge(crate::network::routes())
        .merge(crate::platform::routes());
    let app = Router::new()
        .nest("/api", api)
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

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }
}

async fn bootstrap_as(base: &str, token: &str, csrf: &str, name: &str) -> Uuid {
    let http = Http::new(base.to_string(), token.to_string(), csrf.to_string());
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": name }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap()
}

async fn grant_admin(_base: &str, owner: &Http, hid: Uuid, user_id: Uuid) {
    let (status, body) = owner
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": "network_admin" }),
        )
        .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

fn actor(user_id: Uuid) -> crate::http::AuthUser {
    crate::http::AuthUser {
        user_id,
        username: "no-such-user".into(),
        role: "admin".into(),
        display_name: String::new(),
        display_icon: None,
        csrf_token: String::new(),
    }
}

// ─── Core authz / bootstrap tests ────────────────────────────────────────────

#[sqlx::test]
async fn bootstrap_is_admin_only_one_time_and_audited(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "root", "admin").await;
    let operator = insert_user(&pool, "op", "operator").await;
    let viewer = insert_user(&pool, "view", "viewer").await;
    let (at, ac) = session_for(&pool, admin, "admin").await;
    let (ot, oc) = session_for(&pool, operator, "op").await;
    let (vt, vc) = session_for(&pool, viewer, "view").await;
    let admin_http = Http::new(base.clone(), at.clone(), ac.clone());
    let op_http = Http::new(base.clone(), ot, oc);
    let view_http = Http::new(base.clone(), vt, vc);

    assert_eq!(
        op_http
            .post("/api/network/bootstrap", json!({ "name": "Nope" }))
            .await
            .0,
        403
    );
    assert_eq!(
        view_http
            .post("/api/network/bootstrap", json!({ "name": "Nope" }))
            .await
            .0,
        403
    );

    let hid = bootstrap_as(&base, &at, &ac, "Home").await;

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
    let scoped_audits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM network_audit WHERE action = 'network_bootstrap'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(scoped_audits, 1);
    let (status, body) = admin_http
        .get(&format!("/api/network/households/{hid}/audit"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["rows"][0]["action"], "network_bootstrap");

    assert_eq!(
        admin_http
            .post("/api/network/bootstrap", json!({ "name": "Again" }))
            .await
            .0,
        409
    );
    let (status, body) = admin_http.get("/api/network/households").await;
    assert_eq!(status, 200);
    assert_eq!(body["households"].as_array().unwrap().len(), 1);
    assert_eq!(body["households"][0]["timezone"], "UTC");

    let path = format!("/api/network/households/{hid}/persons");
    assert_eq!(op_http.get(&path).await.0, 403);
    assert_eq!(view_http.get(&path).await.0, 403);
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
    let persons_path = format!("/api/network/households/{hid}/persons");

    let (status, body) = admin_b.get("/api/network/households").await;
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
            .get(&format!("/api/network/households/{hid}/grants"))
            .await
            .0,
        403
    );

    // network_events alone never authorizes inventory reads.
    assert_eq!(
        admin_a
            .post(
                &format!("/api/network/households/{hid}/grants"),
                json!({ "user_id": b, "grant": "network_events" }),
            )
            .await
            .0,
        200
    );
    assert_eq!(admin_b.get(&persons_path).await.0, 403);
    grant_admin(&base, &admin_a, hid, b).await;
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
    let owner = Http::new(base.clone(), at, ac);
    let (status, body) = owner
        .post(
            "/api/network/households",
            json!({ "name": "House B", "timezone": "Asia/Kuala_Lumpur" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let hb = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();
    assert_ne!(ha, hb);

    let pa: Uuid = {
        let (s, b) = owner
            .post(
                &format!("/api/network/households/{ha}/persons"),
                json!({ "display_name": "Alice" }),
            )
            .await;
        assert_eq!(s, 200, "{b}");
        Uuid::parse_str(b["id"].as_str().unwrap()).unwrap()
    };
    let pb: Uuid = {
        let (s, b) = owner
            .post(
                &format!("/api/network/households/{hb}/persons"),
                json!({ "display_name": "Bob" }),
            )
            .await;
        assert_eq!(s, 200, "{b}");
        Uuid::parse_str(b["id"].as_str().unwrap()).unwrap()
    };

    grant_admin(&base, &owner, ha, c).await;
    let member = Http::new(base.clone(), ct, cc);

    let (status, body) = member
        .get(&format!("/api/network/households/{ha}/persons"))
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
            .get(&format!("/api/network/households/{hb}/persons"))
            .await
            .0,
        403
    );
    assert_eq!(
        member
            .post(
                &format!("/api/network/households/{hb}/persons"),
                json!({ "display_name": "Eve" }),
            )
            .await
            .0,
        403
    );
    let (status, body) = member
        .patch(
            &format!("/api/network/households/{hb}/persons/{pa}"),
            json!({ "display_name": "Hacked" }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = member
        .patch(
            &format!("/api/network/households/{ha}/persons/{pb}"),
            json!({ "display_name": "Hacked" }),
        )
        .await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(
        member
            .get(&format!("/api/network/households/{hb}/grants"))
            .await
            .0,
        403
    );
    handle.abort();
}

// ─── P0: household-owned devices, no global key oracle ──────────────────────

#[sqlx::test]
async fn devices_are_household_owned_same_key_allowed_and_no_global_oracle(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "owner", "admin").await;
    let c = insert_user(&pool, "member", "viewer").await;
    let (at, ac) = session_for(&pool, a, "owner").await;
    let (ct, cc) = session_for(&pool, c, "member").await;
    let ha = bootstrap_as(&base, &at, &ac, "House A").await;
    let owner = Http::new(base.clone(), at, ac);
    let (s, b) = owner
        .post("/api/network/households", json!({ "name": "House B" }))
        .await;
    assert_eq!(s, 200, "{b}");
    let hb = Uuid::parse_str(b["household_id"].as_str().unwrap()).unwrap();
    grant_admin(&base, &owner, ha, c).await;
    let member = Http::new(base.clone(), ct, cc);

    // Unassigned devices are visible immediately in their own household.
    let (s, b) = member
        .post(
            &format!("/api/network/households/{ha}/devices"),
            json!({ "canonical_key": "SharedKey001", "label": "TV", "device_type": "tv" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let da = Uuid::parse_str(b["id"].as_str().unwrap()).unwrap();
    let (s, b) = owner
        .post(
            &format!("/api/network/households/{hb}/devices"),
            json!({ "canonical_key": "sharedkey001", "label": "TV B", "device_type": "tv" }),
        )
        .await;
    assert_eq!(s, 200, "same key in another household must be allowed: {b}");
    let db_id = Uuid::parse_str(b["id"].as_str().unwrap()).unwrap();

    let (s, b) = member
        .get(&format!("/api/network/households/{ha}/devices"))
        .await;
    assert_eq!(s, 200);
    let keys: Vec<&str> = b["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["canonical_key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["sharedkey001"]);
    assert_eq!(
        member
            .get(&format!("/api/network/households/{hb}/devices"))
            .await
            .0,
        403
    );
    assert_eq!(
        member
            .post(
                &format!("/api/network/households/{hb}/devices"),
                json!({ "canonical_key": "anykey123", "label": "Sneak" }),
            )
            .await
            .0,
        403
    );

    // Cross-household mutation and assignment attempts are denied.
    let (s, b) = member
        .patch(
            &format!("/api/network/households/{hb}/devices/{da}"),
            json!({ "label": "Stolen" }),
        )
        .await;
    assert_eq!(s, 403, "{b}");
    let (s, b) = member
        .patch(
            &format!("/api/network/households/{ha}/devices/{db_id}"),
            json!({ "label": "Stolen" }),
        )
        .await;
    assert_eq!(s, 404, "{b}");
    let (s, b) = owner
        .post(
            &format!("/api/network/households/{ha}/persons"),
            json!({ "display_name": "Alice" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let person = Uuid::parse_str(b["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        member
            .post(
                &format!("/api/network/households/{ha}/assignments"),
                json!({ "person_id": person, "device_id": db_id }),
            )
            .await
            .0,
        404
    );

    // Same normalized key in the same household is still a conflict.
    assert_eq!(
        member
            .post(
                &format!("/api/network/households/{ha}/devices"),
                json!({ "canonical_key": "shared-key-001", "label": "Dup" }),
            )
            .await
            .0,
        409
    );
    handle.abort();
}

#[sqlx::test]
async fn cross_household_fks_reject_and_agent_link_is_explicit(pool: PgPool) {
    let a = insert_user(&pool, "owner", "admin").await;
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
    .bind(a).fetch_one(&pool).await.unwrap();
    let hb = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO network_households (name, created_by) VALUES ('B', $1) RETURNING id",
    )
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();

    let pa = db::insert_person(&pool, ha, "Alice", None, false)
        .await
        .unwrap();
    let pb = db::insert_person(&pool, hb, "Bob", None, false)
        .await
        .unwrap();
    let da = db::insert_device(&pool, ha, "dev001", "Router", "router", false)
        .await
        .unwrap();
    let dbb = db::insert_device(&pool, hb, "dev001", "Router B", "router", false)
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

    // Person, device and agent must all belong to the assignment's household.
    for (label, person, device, linked_agent) in [
        ("cross-household person", pb, da, None),
        ("cross-household device", pa, dbb, None),
        ("cross-household enrolled agent", pa, da, Some(agent)),
    ] {
        let res = sqlx::query(
            "INSERT INTO network_assignments (household_id, person_id, device_id, agent_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(ha).bind(person).bind(device).bind(linked_agent)
        .execute(&pool).await;
        assert!(res.is_err(), "{label} must be rejected by composite FK");
    }

    let bare = db::insert_assignment(&pool, ha, pa, da, None, "member", true, None)
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
        db::insert_assignment(&pool, hb, pb, dbb, Some(agent), "member", true, None)
            .await
            .unwrap();
    let wrong_connection = sqlx::query(
        "INSERT INTO network_connections (household_id, device_id, assignment_id, kind) VALUES ($1, $2, $3, 'dns')",
    )
    .bind(ha).bind(dbb).bind(enrolled_assignment)
    .execute(&pool).await;
    assert!(
        wrong_connection.is_err(),
        "cross-household device FK must reject"
    );

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
        "no module/token/Recall writes"
    );
}

// ─── P1: device-owned connections with no person ────────────────────────────

#[sqlx::test]
async fn tv_device_owns_dns_connection_without_person_or_assignment(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "owner", "admin").await;
    let (at, ac) = session_for(&pool, a, "owner").await;
    let hid = bootstrap_as(&base, &at, &ac, "Home").await;
    let owner = Http::new(base.clone(), at, ac);
    let (s, b) = owner
        .post(
            &format!("/api/network/households/{hid}/devices"),
            json!({ "canonical_key": "tv0001", "label": "Living Room TV", "device_type": "tv" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let device = Uuid::parse_str(b["id"].as_str().unwrap()).unwrap();

    let (s, b) = owner
        .post(
            &format!("/api/network/households/{hid}/connections"),
            json!({
                "device_id": device,
                "kind": "dns",
                "provenance": "dns",
                "capabilities": ["resolver"],
                "status": "active",
                "last_seen_at": "2026-11-26T10:00:00Z"
            }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let cid = Uuid::parse_str(b["id"].as_str().unwrap()).unwrap();
    let (s, b) = owner
        .get(&format!(
            "/api/network/households/{hid}/connections?kind=dns"
        ))
        .await;
    assert_eq!(s, 200);
    assert_eq!(b["connections"][0]["device_id"], device.to_string());
    assert!(b["connections"][0]["assignment_id"].is_null());
    assert!(b["connections"][0]["enrolled_agent_id"].is_null());
    let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_persons")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(people, 0, "no person was fabricated for this connection");

    let (s, b) = owner
        .patch(
            &format!("/api/network/households/{hid}/connections/{cid}"),
            json!({ "status": "revoked", "revoked_at": "2026-11-26T11:00:00Z" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let (s, b) = owner
        .get(&format!("/api/network/households/{hid}/connections"))
        .await;
    assert_eq!(s, 200);
    assert_eq!(b["connections"][0]["status"], "revoked");
    assert!(!b["connections"][0]["revoked_at"].is_null());

    // Omission preserves the timestamp; an explicit JSON null clears it.
    let path = format!("/api/network/households/{hid}/connections/{cid}");
    let (s, b) = owner.patch(&path, json!({ "status": "active" })).await;
    assert_eq!(s, 200, "{b}");
    let (_, b) = owner
        .get(&format!("/api/network/households/{hid}/connections"))
        .await;
    assert!(!b["connections"][0]["revoked_at"].is_null());
    let (s, b) = owner
        .patch(&path, json!({ "status": "active", "revoked_at": null }))
        .await;
    assert_eq!(s, 200, "{b}");
    let (s, b) = owner
        .get(&format!("/api/network/households/{hid}/connections"))
        .await;
    assert_eq!(s, 200);
    assert_eq!(b["connections"][0]["status"], "active");
    assert!(b["connections"][0]["revoked_at"].is_null());
    handle.abort();
}

// ─── P2: enrollment authority, last-admin guard, atomic create ──────────────

#[sqlx::test]
async fn enrollment_requires_platform_admin_and_household_network_scope(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let root = insert_user(&pool, "root", "admin").await;
    let other_admin = insert_user(&pool, "other-admin", "admin").await;
    let operator = insert_user(&pool, "op", "operator").await;
    let viewer = insert_user(&pool, "view", "viewer").await;
    let (rt, rc) = session_for(&pool, root, "root").await;
    let (ot, oc) = session_for(&pool, other_admin, "other").await;
    let (opt, opc) = session_for(&pool, operator, "op").await;
    let (vt, vc) = session_for(&pool, viewer, "view").await;
    let hid = bootstrap_as(&base, &rt, &rc, "Home").await;
    let root_http = Http::new(base.clone(), rt, rc);
    grant_admin(&base, &root_http, hid, operator).await;
    grant_admin(&base, &root_http, hid, viewer).await;

    let agent = Uuid::new_v4();
    crate::test_support::insert_agent(&pool, agent)
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET api_token_hash = 'sentinel-token-hash' WHERE id = $1")
        .bind(agent)
        .execute(&pool)
        .await
        .unwrap();
    let path = format!("/api/network/households/{hid}/agent-enrollments");
    let body = json!({ "agent_id": agent });

    // Operator role, even with an explicit household grant, cannot enroll.
    assert_eq!(
        Http::new(base.clone(), opt, opc)
            .post(&path, body.clone())
            .await
            .0,
        403
    );
    // Viewer role likewise.
    assert_eq!(
        Http::new(base.clone(), vt, vc)
            .post(&path, body.clone())
            .await
            .0,
        403
    );
    // Platform admin without a household grant cannot claim a fleet agent.
    assert_eq!(
        Http::new(base.clone(), ot, oc)
            .post(&path, body.clone())
            .await
            .0,
        403
    );
    // Platform admin WITH explicit household scope can.
    assert_eq!(root_http.post(&path, body).await.0, 200);

    let token_hash: String = sqlx::query_scalar("SELECT api_token_hash FROM agents WHERE id = $1")
        .bind(agent)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(token_hash, "sentinel-token-hash");
    for count in [
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_module_reports")
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM recall_settings_agent")
            .fetch_one(&pool)
            .await
            .unwrap(),
    ] {
        assert_eq!(count, 0);
    }
    handle.abort();
}

#[sqlx::test]
async fn last_network_admin_guard_and_atomic_household_create(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "a", "admin").await;
    let b = insert_user(&pool, "b", "admin").await;
    let (at, ac) = session_for(&pool, a, "a").await;
    let (bt, bc) = session_for(&pool, b, "b").await;
    let hid = bootstrap_as(&base, &at, &ac, "Home").await;
    let ha = Http::new(base.clone(), at.clone(), ac.clone());
    let hb = Http::new(base.clone(), bt, bc);

    // The only admin cannot revoke themselves.
    let (s, body) = ha
        .delete(&format!(
            "/api/network/households/{hid}/grants/{a}/network_admin"
        ))
        .await;
    assert_eq!(s, 409, "{body}");

    grant_admin(&base, &ha, hid, b).await;
    // Two concurrent revokes serialize on the household row; one survives.
    let path_a = format!("/api/network/households/{hid}/grants/{a}/network_admin");
    let path_b = format!("/api/network/households/{hid}/grants/{b}/network_admin");
    let (ra, rb) = tokio::join!(ha.delete(&path_a), hb.delete(&path_b));
    assert_eq!([ra.0, rb.0].iter().filter(|&&s| s == 200).count(), 1);
    assert_eq!([ra.0, rb.0].iter().filter(|&&s| s == 409).count(), 1);
    let admins: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_grants WHERE household_id = $1 AND grant_name = 'network_admin'",
    )
    .bind(hid).fetch_one(&pool).await.unwrap();
    assert_eq!(admins, 1);

    // A grant failure rolls the whole household insert back.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_households")
        .fetch_one(&pool)
        .await
        .unwrap();
    let bogus = actor(Uuid::new_v4());
    assert!(service::create_household(&pool, &bogus, "Orphan", "UTC")
        .await
        .is_err());
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_households")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, before, "household create must be atomic");
    let _ = (ha, at, ac);
    handle.abort();
}

// ─── Scoped audit vs globally readable audit ────────────────────────────────

#[sqlx::test]
async fn network_audit_is_scoped_and_global_audit_has_no_sensitive_details(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let a = insert_user(&pool, "owner", "admin").await;
    let c = insert_user(&pool, "viewer", "viewer").await;
    let (at, ac) = session_for(&pool, a, "owner").await;
    let (ct, cc) = session_for(&pool, c, "viewer").await;
    let ha = bootstrap_as(&base, &at, &ac, "House A").await;
    let owner = Http::new(base.clone(), at, ac);
    let (s, b) = owner
        .post("/api/network/households", json!({ "name": "House B" }))
        .await;
    assert_eq!(s, 200, "{b}");
    let hb = Uuid::parse_str(b["household_id"].as_str().unwrap()).unwrap();
    grant_admin(&base, &owner, ha, c).await;
    let member = Http::new(base.clone(), ct, cc);

    let (s, b) = member
        .post(
            &format!("/api/network/households/{ha}/devices"),
            json!({ "canonical_key": "sensitiveKey99", "label": "Private" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let device_id = b["id"].as_str().unwrap().to_string();
    let (s, b) = member
        .post(
            &format!("/api/network/households/{ha}/persons"),
            json!({ "display_name": "Private Person" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");
    let person_id = b["id"].as_str().unwrap().to_string();

    let (s, b) = member
        .get(&format!("/api/network/households/{ha}/audit"))
        .await;
    assert_eq!(s, 200);
    let scoped = b.to_string();
    assert!(scoped.contains("sensitivekey99"));
    assert!(scoped.contains(&device_id));
    assert_eq!(
        member
            .get(&format!("/api/network/households/{hb}/audit"))
            .await
            .0,
        403
    );

    // The global audit route is readable by any session, but must not carry
    // any network ids, keys or scope identifiers.
    let (s, b) = member.get("/api/audit").await;
    assert_eq!(s, 200, "{b}");
    let global = b.to_string();
    for secret in [
        "sensitivekey99",
        &device_id,
        &person_id,
        &ha.to_string(),
        &hb.to_string(),
    ] {
        assert!(!global.contains(secret), "global audit leaked {secret}");
    }
    let rows = b["rows"].as_array().unwrap();
    assert!(
        rows.iter().all(|r| {
            let action = r["action"].as_str().unwrap_or("");
            !action.starts_with("network_") || action == "network_action"
        }),
        "only the generic network_action marker may be globally visible"
    );
    handle.abort();
}

// ─── CSRF / pagination / normalization ──────────────────────────────────────

#[sqlx::test]
async fn csrf_is_enforced_inputs_normalized_and_pages_capped(pool: PgPool) {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "root", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let hid = bootstrap_as(&base, &token, &csrf, "Home").await;
    let http = Http::new(base.clone(), token.clone(), csrf.clone());
    let path = format!("/api/network/households/{hid}/persons");

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
    assert_eq!(http.get(&format!("{path}?limit=5000")).await.0, 400);

    // Invalid timezone is rejected; a valid one is stored on the household.
    assert_eq!(
        http.post(
            "/api/network/households",
            json!({ "name": "Bad TZ", "timezone": "Mars/Olympus" }),
        )
        .await
        .0,
        400
    );
    let (s, b) = http
        .post(
            "/api/network/households",
            json!({ "name": "Good TZ", "timezone": "Asia/Kuala_Lumpur" }),
        )
        .await;
    assert_eq!(s, 200, "{b}");

    let devices_path = format!("/api/network/households/{hid}/devices");
    let (status, body) = http
        .post(
            &devices_path,
            json!({ "canonical_key": " AA-BB:cc_dd.11 ", "label": "Laptop", "shared": true }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = http.get(&devices_path).await;
    assert_eq!(status, 200);
    assert_eq!(body["devices"][0]["canonical_key"], "aabbccdd11");
    assert_eq!(body["devices"][0]["shared"], true);
    assert_eq!(
        http.post(
            &devices_path,
            json!({ "canonical_key": "aabbccdd11", "label": "Duplicate" }),
        )
        .await
        .0,
        409
    );

    let too_many: Vec<String> = (0..33).map(|i| format!("c{i}")).collect();
    assert!(dto::normalize_capabilities(&Some(too_many)).is_err());
    handle.abort();
}
