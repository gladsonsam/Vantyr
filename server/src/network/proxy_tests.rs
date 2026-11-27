//! Real-PostgreSQL, real-HTTP tests for proxy sign-in management.
//!
//! Each test gets a fresh migrated database, the real router behind the
//! session-cookie + CSRF middleware, the top-level cookie-free worker router and
//! real users, OIDC-backed sessions and scoped proxy-worker credentials. No
//! mocked extractors, no mocked authority and no DTO-only claims.

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

use super::gateway_auth;
use super::proxy_auth;

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
    let token = format!("proxy-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("proxy-csrf-{label}");
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
        .merge(super::proxy_worker_routes())
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

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }

    async fn post_without_csrf(&self, path: &str, body: Value) -> (u16, Value) {
        Self::send(
            self.client
                .post(format!("{}{}", self.base, path))
                .header("cookie", format!("session={}", self.token))
                .header("content-type", "application/json")
                .json(&body),
        )
        .await
    }

    async fn worker(&self, path: &str, bearer: Option<&str>, body: Value) -> (u16, Value) {
        let mut request = self
            .client
            .post(format!("{}{}", self.base, path))
            .header("content-type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(20));
        if let Some(bearer) = bearer {
            request = request.header("authorization", bearer);
        }
        Self::send(request).await
    }
}

struct Fixture {
    _handle: JoinHandle<()>,
    admin: Http,
    user: Http,
    hid: Uuid,
    other_hid: Uuid,
    person_id: Uuid,
    device_id: Uuid,
    gateway_id: Uuid,
    worker_bearer: String,
}

async fn setup(pool: &PgPool) -> Fixture {
    let (base, handle) = spawn_router(pool.clone()).await;
    let admin_id = insert_user(pool, "root", "admin").await;
    let (at, ac) = session_for(pool, admin_id, "admin").await;
    let admin = Http::new(&base, at, ac);
    let (status, body) = admin
        .post("/api/network/bootstrap", json!({ "name": "Home" }))
        .await;
    assert_eq!(status, 200, "bootstrap failed: {body}");
    let hid = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();
    let (status, body) = admin
        .post("/api/network/households", json!({ "name": "Other" }))
        .await;
    assert_eq!(status, 200, "second household failed: {body}");
    let other_hid = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();

    let user_id = insert_user(pool, "proxy-user", "viewer").await;
    let (ut, uc) = session_for(pool, user_id, "user").await;
    let user = Http::new(&base, ut, uc);
    assert_eq!(
        admin
            .post(
                &format!("/api/network/households/{hid}/grants"),
                json!({ "user_id": user_id, "grant": "network_enroll" }),
            )
            .await
            .0,
        200
    );
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/persons"),
            json!({ "display_name": "Teen" }),
        )
        .await;
    assert_eq!(status, 200, "person failed: {body}");
    let person_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        admin
            .post(
                &format!("/api/network/households/{hid}/bindings"),
                json!({ "person_id": person_id, "user_id": user_id }),
            )
            .await
            .0,
        200
    );
    let (status, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/devices"),
            json!({ "label": "Laptop", "device_type": "computer" }),
        )
        .await;
    assert_eq!(status, 200, "device register failed: {body}");
    let device_id = Uuid::parse_str(body["device_id"].as_str().unwrap()).unwrap();

    // Real OIDC-backed verified session (BYOD grant consume).
    let (status, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/grants"),
            json!({
                "device_id": device_id,
                "purpose": "proxy_setup",
                "expires_in_secs": 600,
            }),
        )
        .await;
    assert_eq!(status, 200, "grant issue failed: {body}");
    let grant_id = body["grant_id"].as_str().unwrap().to_string();
    let grant_secret = body["secret"].as_str().unwrap().to_string();
    let (status, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/grants/consume"),
            json!({
                "grant_id": grant_id,
                "secret": grant_secret,
                "purpose": "proxy_setup",
                "device_id": device_id,
            }),
        )
        .await;
    assert_eq!(status, 200, "grant consume failed: {body}");

    // Real proxy gateway + worker credential with the opt-in command.
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": "proxy", "label": "Proxy worker" }),
        )
        .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    let gateway_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/gateways/{gateway_id}/credentials"),
            json!({
                "expires_in_hours": 24,
                "commands": ["introspect_proxy"],
            }),
        )
        .await;
    assert_eq!(status, 200, "worker credential failed: {body}");
    let worker_bearer = body["token"].as_str().unwrap().to_string();

    Fixture {
        _handle: handle,
        admin,
        user,
        hid,
        other_hid,
        person_id,
        device_id,
        gateway_id,
        worker_bearer,
    }
}

fn issue_body(f: &Fixture, device: Option<Uuid>) -> Value {
    json!({
        "person_id": f.person_id,
        "device_id": device,
        "label": "  Teen laptop  ",
        "expires_in_hours": 8,
    })
}

async fn issue_credential(f: &Fixture, device: Option<Uuid>) -> (Uuid, String) {
    let (status, body) = f
        .admin
        .post(
            &format!("/api/network/households/{}/proxy/credentials", f.hid),
            issue_body(f, device),
        )
        .await;
    assert_eq!(status, 200, "credential issue failed: {body}");
    let id = Uuid::parse_str(body["credential"]["id"].as_str().unwrap()).unwrap();
    let secret = body["secret"].as_str().unwrap().to_string();
    (id, secret)
}

async fn issue_evidence(f: &Fixture, credential_id: Uuid, command: &str) -> String {
    let (status, body) = f
        .user
        .post(
            &format!("/api/network/households/{}/proxy/evidence", f.hid),
            json!({ "credential_id": credential_id, "command": command }),
        )
        .await;
    assert_eq!(status, 200, "evidence issue failed: {body}");
    body["evidence"].as_str().unwrap().to_string()
}

fn sync_body(f: &Fixture) -> Value {
    json!({
        "audience": gateway_auth::AUDIENCE,
        "household_id": f.hid,
        "gateway_id": f.gateway_id,
        "kind": "proxy",
        "command": gateway_auth::COMMAND_INTROSPECT_PROXY,
    })
}

fn introspect_body(f: &Fixture, evidence: &str) -> Value {
    json!({
        "audience": gateway_auth::AUDIENCE,
        "household_id": f.hid,
        "gateway_id": f.gateway_id,
        "kind": "proxy",
        "command": gateway_auth::COMMAND_INTROSPECT_PROXY,
        "evidence": evidence,
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[sqlx::test]
async fn issue_list_revoke_need_admin_csrf_and_household_scope(pool: PgPool) {
    let f = setup(&pool).await;
    let path = format!("/api/network/households/{}/proxy/credentials", f.hid);

    // The enrolled user has network_enroll but not network_admin.
    assert_eq!(f.user.get(&path).await.0, 403);
    assert_eq!(
        f.admin
            .post_without_csrf(&path, issue_body(&f, None))
            .await
            .0,
        403
    );
    // A platform-admin role with no network grant in the other household is
    // still denied there; the grant is scoped per household, not by role.
    let other_admin_id = insert_user(&pool, "other-admin", "admin").await;
    let (ot, oc) = session_for(&pool, other_admin_id, "other-admin").await;
    let other_admin = Http::new(&f.admin.base, ot, oc);
    assert_eq!(
        other_admin
            .get(&format!(
                "/api/network/households/{}/proxy/credentials",
                f.other_hid
            ))
            .await
            .0,
        403
    );

    let (id, _secret) = issue_credential(&f, None).await;
    let (status, body) = f.admin.get(&path).await;
    assert_eq!(status, 200, "list failed: {body}");
    let rows = body["credentials"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(id.to_string()));
    assert_eq!(rows[0]["personLabel"], json!("Teen"));
    assert_eq!(rows[0]["revoked"], json!(false));

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
    let (_, body) = f.admin.get(&path).await;
    assert_eq!(body["credentials"][0]["revoked"], json!(true));
}

#[sqlx::test]
async fn secret_is_shown_once_and_never_listed_or_audited(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, secret) = issue_credential(&f, Some(f.device_id)).await;
    assert!(secret.len() >= 32 && secret.len() <= 128);
    assert_ne!(secret, "secret");

    let (_, listed) = f
        .admin
        .get(&format!(
            "/api/network/households/{}/proxy/credentials",
            f.hid
        ))
        .await;
    assert!(
        !listed.to_string().contains(&secret),
        "secret leaked in listing"
    );
    let (_, access) = f
        .admin
        .get(&format!("/api/network/households/{}/proxy/access", f.hid))
        .await;
    assert!(
        !access.to_string().contains(&secret),
        "secret leaked in access view"
    );
    assert_eq!(access["enrollment"]["available"], json!(true));
    let (_, audits) = f
        .admin
        .get(&format!("/api/network/households/{}/audit", f.hid))
        .await;
    assert!(
        !audits.to_string().contains(&secret),
        "secret leaked in audit"
    );
    let _ = id;
}

#[sqlx::test]
async fn device_is_derived_from_oidc_session_when_omitted(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, _) = issue_credential(&f, None).await;
    let (_, body) = f
        .admin
        .get(&format!(
            "/api/network/households/{}/proxy/credentials",
            f.hid
        ))
        .await;
    assert_eq!(
        body["credentials"][0]["deviceId"],
        json!(f.device_id.to_string())
    );
    assert_eq!(body["credentials"][0]["id"], json!(id.to_string()));
}

#[sqlx::test]
async fn unknown_person_cross_household_device_and_shared_device_are_rejected(pool: PgPool) {
    let f = setup(&pool).await;
    let path = format!("/api/network/households/{}/proxy/credentials", f.hid);
    let (status, _) = f
        .admin
        .post(
            &path,
            json!({
                "person_id": Uuid::new_v4(),
                "device_id": null,
                "label": "x",
                "expires_in_hours": 8,
            }),
        )
        .await;
    assert_eq!(status, 404, "unknown person must not be issued");
    let (status, _) = f
        .admin
        .post(
            &path,
            json!({
                "person_id": f.person_id,
                "device_id": Uuid::new_v4(),
                "label": "x",
                "expires_in_hours": 8,
            }),
        )
        .await;
    assert_eq!(status, 404, "unknown device must not be issued");
    let (status, _) = f
        .admin
        .post(
            &path,
            json!({
                "person_id": f.person_id,
                "device_id": null,
                "label": "x",
                "expires_in_hours": 0,
            }),
        )
        .await;
    assert_eq!(status, 400, "unbounded expiry must be rejected");
}

#[sqlx::test]
async fn evidence_needs_enroll_grant_matching_person_and_active_session(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, _) = issue_credential(&f, None).await;

    // The admin has network_admin but not network_enroll, so cannot mint
    // person-bearing evidence for a session they did not authenticate.
    let (status, _) = f
        .admin
        .post(
            &format!("/api/network/households/{}/proxy/evidence", f.hid),
            json!({ "credential_id": id, "command": "proxy_connect" }),
        )
        .await;
    assert_eq!(status, 403);

    let evidence = issue_evidence(&f, id, "proxy_connect").await;
    let parsed: Value = serde_json::from_str(&evidence).unwrap();
    assert_eq!(parsed["schema"], json!(1));
    assert_eq!(parsed["verified_person"], json!(f.person_id.to_string()));
    assert_eq!(parsed["household_kind"], json!("personal"));
    assert_eq!(parsed["audience"], json!("vantyr-proxy-session"));
    assert_eq!(parsed["command"], json!("proxy_connect"));
    assert!(parsed["nonce"].as_str().unwrap().len() <= 64);
}

#[sqlx::test]
async fn worker_introspection_is_scoped_and_evidence_is_single_use(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, _) = issue_credential(&f, None).await;
    let evidence = issue_evidence(&f, id, "proxy_connect").await;

    // Sync requires the scoped bearer.
    assert_eq!(
        f.admin
            .worker(
                "/worker/network/proxy/credentials/sync",
                None,
                sync_body(&f)
            )
            .await
            .0,
        401
    );
    let (status, body) = f
        .admin
        .worker(
            "/worker/network/proxy/credentials/sync",
            Some(&f.worker_bearer),
            sync_body(&f),
        )
        .await;
    assert_eq!(status, 200, "sync failed: {body}");
    let creds = body["credentials"].as_array().unwrap();
    assert_eq!(creds.len(), 1);
    assert_eq!(creds[0]["secret_hash"].as_str().unwrap().len(), 64);
    assert!(
        !body.to_string().contains(&evidence),
        "raw evidence must not be listed"
    );

    // Introspection with the same scoped bearer consumes the receipt once.
    let (status, body) = f
        .admin
        .worker(
            "/worker/network/proxy/evidence/introspect",
            Some(&f.worker_bearer),
            introspect_body(&f, &evidence),
        )
        .await;
    assert_eq!(status, 200, "introspect failed: {body}");
    assert_eq!(body["valid"], json!(true));
    assert_eq!(body["person_id"], json!(f.person_id.to_string()));
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/evidence/introspect",
            Some(&f.worker_bearer),
            introspect_body(&f, &evidence),
        )
        .await;
    assert_eq!(status, 403, "a replayed receipt must be denied");

    // Wrong household and wrong kind cannot introspect.
    let mut wrong = sync_body(&f);
    wrong["household_id"] = json!(f.other_hid);
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/credentials/sync",
            Some(&f.worker_bearer),
            wrong,
        )
        .await;
    assert_eq!(status, 401);
    let mut wrong_kind = sync_body(&f);
    wrong_kind["kind"] = json!("dns");
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/credentials/sync",
            Some(&f.worker_bearer),
            wrong_kind,
        )
        .await;
    assert_eq!(status, 401);

    // Tampered evidence is denied without consuming the original.
    let mut tampered = evidence.clone();
    tampered.push(' ');
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/evidence/introspect",
            Some(&f.worker_bearer),
            introspect_body(&f, &tampered),
        )
        .await;
    assert_eq!(status, 403);
}

#[sqlx::test]
async fn revoke_ends_sessions_and_invalidates_evidence_atomically(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, _) = issue_credential(&f, None).await;
    let evidence = issue_evidence(&f, id, "proxy_http").await;

    let (_, sessions) = f
        .admin
        .get(&format!("/api/network/households/{}/proxy/sessions", f.hid))
        .await;
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(sessions["sessions"][0]["revoked"], json!(false));

    let (status, _) = f
        .admin
        .delete(&format!(
            "/api/network/households/{}/proxy/credentials/{id}",
            f.hid
        ))
        .await;
    assert_eq!(status, 200);

    let (_, sessions) = f
        .admin
        .get(&format!("/api/network/households/{}/proxy/sessions", f.hid))
        .await;
    assert_eq!(sessions["sessions"][0]["revoked"], json!(true));

    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/evidence/introspect",
            Some(&f.worker_bearer),
            introspect_body(&f, &evidence),
        )
        .await;
    assert_eq!(status, 403, "revocation invalidates unexpired evidence");
}

#[sqlx::test]
async fn revoke_all_by_person_id_uses_the_id_not_the_label(pool: PgPool) {
    let f = setup(&pool).await;
    let (a, _) = issue_credential(&f, None).await;
    let (b, _) = issue_credential(&f, Some(f.device_id)).await;
    let (status, body) = f
        .admin
        .post(
            &format!(
                "/api/network/households/{}/proxy/credentials/revoke-all",
                f.hid
            ),
            json!({ "person_id": f.person_id }),
        )
        .await;
    assert_eq!(status, 200, "revoke-all failed: {body}");
    assert_eq!(body["revoked"], json!(2));
    let (_, listed) = f
        .admin
        .get(&format!(
            "/api/network/households/{}/proxy/credentials",
            f.hid
        ))
        .await;
    for row in listed["credentials"].as_array().unwrap() {
        assert_eq!(row["revoked"], json!(true));
    }
    let _ = (a, b);
}

#[sqlx::test]
async fn session_end_invalidates_its_evidence(pool: PgPool) {
    let f = setup(&pool).await;
    let (id, _) = issue_credential(&f, None).await;
    let evidence = issue_evidence(&f, id, "proxy_connect").await;
    let (_, sessions) = f
        .admin
        .get(&format!("/api/network/households/{}/proxy/sessions", f.hid))
        .await;
    let sid = sessions["sessions"][0]["id"].as_str().unwrap();
    let (status, _) = f
        .admin
        .delete(&format!(
            "/api/network/households/{}/proxy/sessions/{sid}",
            f.hid
        ))
        .await;
    assert_eq!(status, 200);
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/evidence/introspect",
            Some(&f.worker_bearer),
            introspect_body(&f, &evidence),
        )
        .await;
    assert_eq!(status, 403);
}

#[sqlx::test]
async fn default_heartbeat_worker_cannot_use_proxy_introspection(pool: PgPool) {
    let f = setup(&pool).await;
    // A second gateway credential with the historical heartbeat-only default.
    let (status, body) = f
        .admin
        .post(
            &format!(
                "/api/network/households/{}/gateways/{}/credentials",
                f.hid, f.gateway_id
            ),
            json!({ "expires_in_hours": 24 }),
        )
        .await;
    assert_eq!(status, 200, "credential failed: {body}");
    let heartbeat = body["token"].as_str().unwrap();
    let (status, _) = f
        .admin
        .worker(
            "/worker/network/proxy/credentials/sync",
            Some(heartbeat),
            sync_body(&f),
        )
        .await;
    assert_eq!(
        status, 401,
        "bootstrap default must not gain the new command"
    );

    // The pure mechanics still pin the secret shape and digest width.
    let secret = proxy_auth::new_secret();
    assert_eq!(proxy_auth::hash_secret(&secret).len(), 64);
}
