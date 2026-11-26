//! Real-PostgreSQL end-to-end tests for authenticated BYOD enrollment.
//!
//! Each test gets a fresh migrated database, a real router behind the existing
//! session-cookie + CSRF middleware, and real users/sessions in PostgreSQL.
//! No mocked extractors or in-memory stand-ins. Settings are environment
//! independent: retention is exercised through explicit configs and the pure
//! prune functions, never by mutating process-wide env vars in parallel tests.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::network::enroll_db::{self, AttemptOutcome};
use crate::network::enroll_retention::AttemptRetention;
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
        Utc::now() + ChronoDuration::hours(1),
        None,
        &csrf,
    )
    .await
    .unwrap();
    (token, csrf)
}

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

#[derive(Clone)]
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

    async fn delete(&self, path: &str) -> (u16, Value) {
        Self::send(self.builder(reqwest::Method::DELETE, path)).await
    }

    /// Mutating request that deliberately omits the CSRF header.
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
}

struct Fixture {
    _handle: JoinHandle<()>,
    admin: Http,
    user: Http,
    hid: Uuid,
    other_hid: Uuid,
    user_id: Uuid,
    person_id: Uuid,
    binding_id: Uuid,
    device_id: Uuid,
}

async fn setup(pool: &PgPool) -> Fixture {
    let (base, handle, _state) = spawn_router(pool.clone()).await;
    let admin_id = insert_user(pool, "root", "admin").await;
    let (at, ac) = session_for(pool, admin_id, "admin").await;
    let admin = Http::new(base.clone(), at.clone(), ac.clone());
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

    let user_id = insert_user(pool, "byod-user", "viewer").await;
    let (ut, uc) = session_for(pool, user_id, "user").await;
    let user = Http::new(base, ut, uc);
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": "network_enroll" }),
        )
        .await;
    assert_eq!(status, 200, "enroll grant failed: {body}");
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/persons"),
            json!({ "display_name": "Teen" }),
        )
        .await;
    assert_eq!(status, 200, "person failed: {body}");
    let person_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/bindings"),
            json!({ "person_id": person_id, "user_id": user_id }),
        )
        .await;
    assert_eq!(status, 200, "binding failed: {body}");
    let binding_id = Uuid::parse_str(body["binding_id"].as_str().unwrap()).unwrap();
    let (status, body) = user
        .post(
            &format!("/api/network/households/{hid}/enroll/devices"),
            json!({ "label": "Laptop", "device_type": "computer" }),
        )
        .await;
    assert_eq!(status, 200, "self register failed: {body}");
    let device_id = Uuid::parse_str(body["device_id"].as_str().unwrap()).unwrap();
    Fixture {
        _handle: handle,
        admin,
        user,
        hid,
        other_hid,
        user_id,
        person_id,
        binding_id,
        device_id,
    }
}

async fn issue(
    http: &Http,
    hid: Uuid,
    device_id: Uuid,
    purpose: &str,
    secs: i64,
) -> (Uuid, String, Value) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/enroll/grants"),
            json!({
                "device_id": device_id,
                "purpose": purpose,
                "expires_in_secs": secs,
            }),
        )
        .await;
    assert_eq!(status, 200, "grant issue failed: {body}");
    let id = Uuid::parse_str(body["grant_id"].as_str().unwrap()).unwrap();
    let secret = body["secret"].as_str().unwrap().to_string();
    (id, secret, body)
}

async fn consume(
    http: &Http,
    hid: Uuid,
    grant_id: Uuid,
    secret: &str,
    purpose: &str,
    device_id: Uuid,
) -> (u16, Value) {
    http.post(
        &format!("/api/network/households/{hid}/enroll/grants/consume"),
        json!({
            "grant_id": grant_id,
            "secret": secret,
            "purpose": purpose,
            "device_id": device_id,
        }),
    )
    .await
}

fn devices_path(hid: Uuid) -> String {
    format!("/api/network/households/{hid}/enroll/devices")
}

// ─── Authorization, CSRF and household scoping ───────────────────────────────

#[sqlx::test]
async fn enrollment_needs_grant_and_binding_csrf_and_household_scope(pool: PgPool) {
    let f = setup(&pool).await;
    let path = devices_path(f.hid);
    let other_path = devices_path(f.other_hid);

    // Platform admin role without an explicit network grant is not enough.
    let (status, _) = f.admin.get(&path).await;
    // Bootstrap auto-grants network_admin to the admin, but not network_enroll.
    assert_eq!(status, 403);

    // A binding without the grant is not enough.
    let no_grant = insert_user(&pool, "no-grant", "viewer").await;
    let (t, c) = session_for(&pool, no_grant, "no-grant").await;
    let no_grant_http = Http::new(f.user.base.clone(), t, c);
    let (status, _) = admin_post_binding(&f.admin, f.hid, f.person_id, no_grant).await;
    assert_eq!(status, 200);
    assert_eq!(no_grant_http.get(&path).await.0, 403);

    // A grant without a binding is not enough (user was granted before binding
    // in setup, so verify with a fresh household/user pair instead).
    let grant_only = insert_user(&pool, "grant-only", "viewer").await;
    let (t, c) = session_for(&pool, grant_only, "grant-only").await;
    let grant_only_http = Http::new(f.user.base.clone(), t, c);
    let (status, _) = f
        .admin
        .post(
            &format!("/api/network/households/{}/grants", f.hid),
            json!({ "user_id": grant_only, "grant": "network_enroll" }),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(grant_only_http.get(&path).await.0, 403);

    // Authorized self access works, but not into another household.
    assert_eq!(f.user.get(&path).await.0, 200);
    assert_eq!(f.user.get(&other_path).await.0, 403);
    assert_eq!(
        f.user
            .post(
                &format!("/api/network/households/{}/enroll/devices", f.other_hid),
                json!({ "label": "Nope", "device_type": "computer" }),
            )
            .await
            .0,
        403
    );
    assert_eq!(
        f.user
            .post_without_csrf(
                &path,
                json!({ "label": "No CSRF", "device_type": "computer" }),
            )
            .await
            .0,
        403,
        "mutating enrollment routes are CSRF protected"
    );

    // network_enroll is narrowly scoped: no inventory, grants, policy or audit.
    assert_eq!(
        f.user
            .get(&format!("/api/network/households/{}/persons", f.hid))
            .await
            .0,
        403
    );
    assert_eq!(
        f.user
            .get(&format!("/api/network/households/{}/grants", f.hid))
            .await
            .0,
        403
    );
    assert_eq!(
        f.user
            .get(&format!("/api/network/households/{}/audit", f.hid))
            .await
            .0,
        403
    );
    assert_eq!(
        f.user
            .get(&format!("/api/network/households/{}/policies", f.hid))
            .await
            .0,
        403
    );
}

async fn admin_post_binding(
    admin: &Http,
    hid: Uuid,
    person_id: Uuid,
    user_id: Uuid,
) -> (u16, Value) {
    admin
        .post(
            &format!("/api/network/households/{hid}/bindings"),
            json!({ "person_id": person_id, "user_id": user_id }),
        )
        .await
}

// ─── Spoofed identity and foreign device claims ──────────────────────────────

#[sqlx::test]
async fn spoofed_person_user_and_foreign_device_claims_are_rejected(pool: PgPool) {
    let f = setup(&pool).await;

    // Unknown dashboard user and unknown person are rejected by the admin
    // mapping route; neither a row nor a grant is created.
    let unknown = Uuid::new_v4();
    assert_eq!(
        admin_post_binding(&f.admin, f.hid, f.person_id, unknown)
            .await
            .0,
        404
    );
    assert_eq!(
        admin_post_binding(&f.admin, f.hid, unknown, f.user_id)
            .await
            .0,
        404
    );
    let bindings: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_principal_bindings WHERE household_id = $1",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bindings, 1);

    // Self-service bodies that try to name an identity or a device are refused.
    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/devices", f.hid),
            json!({
                "label": "Spoof", "device_type": "computer",
                "user_id": f.user_id, "person_id": f.person_id, "device_id": f.device_id,
            }),
        )
        .await;
    assert_eq!(
        status, 422,
        "identity/device claims in a self body are denied"
    );
    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/grants", f.hid),
            json!({
                "device_id": f.device_id, "purpose": "proxy_setup",
                "expires_in_secs": 60, "person_id": f.person_id,
            }),
        )
        .await;
    assert_eq!(status, 422, "a person claim in a grant body is denied");

    // An existing household device that was never enrolled cannot be claimed.
    let (status, body) = f
        .admin
        .post(
            &format!("/api/network/households/{}/devices", f.hid),
            json!({
                "canonical_key": "existingdesk01", "label": "Desk", "device_type": "computer"
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let existing = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/grants", f.hid),
            json!({
                "device_id": existing, "purpose": "proxy_setup", "expires_in_secs": 60
            }),
        )
        .await;
    assert_eq!(
        status, 404,
        "an unenrolled household device cannot be claimed"
    );
    let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_enrollment_grants")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(grants, 0);
}

// The helper above asserts a successful issue; use an explicit failing check
// in the test below instead (kept separate to make the denial unambiguous).
#[sqlx::test]
async fn existing_device_requires_explicit_admin_preauthorization(pool: PgPool) {
    let f = setup(&pool).await;
    let (status, body) = f
        .admin
        .post(
            &format!("/api/network/households/{}/devices", f.hid),
            json!({
                "canonical_key": "existingdesk02", "label": "Desk", "device_type": "computer"
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let existing = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();

    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/grants", f.hid),
            json!({
                "device_id": existing, "purpose": "proxy_setup", "expires_in_secs": 60
            }),
        )
        .await;
    assert_eq!(status, 404, "no grant for an unenrolled device");

    // Self registration cannot be redirected to that specific UUID either.
    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/devices", f.hid),
            json!({ "label": "Spoof", "device_type": "computer", "id": existing }),
        )
        .await;
    assert_eq!(
        status, 422,
        "a device id cannot be injected into registration"
    );

    // Only an explicit admin authorization binds that device to this binding.
    let (status, body) = f
        .admin
        .post(
            &format!(
                "/api/network/households/{}/bindings/{}/device-authorizations",
                f.hid, f.binding_id
            ),
            json!({ "device_id": existing }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (grant_id, secret, issued) = issue(&f.user, f.hid, existing, "proxy_setup", 60).await;
    assert_eq!(issued["network_coverage"], "unverified");
    assert_eq!(issued["setup"], "pending_setup");

    // Cross-household device claim: a device in the second household, even with
    // the same UUID string known to the caller, is never in scope.
    let (status, body) = f
        .admin
        .post(
            &format!("/api/network/households/{}/devices", f.other_hid),
            json!({
                "canonical_key": "foreigndesk01", "label": "Foreign", "device_type": "computer"
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let foreign = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, _) = f
        .user
        .post(
            &format!("/api/network/households/{}/enroll/grants", f.other_hid),
            json!({
                "device_id": foreign, "purpose": "proxy_setup", "expires_in_secs": 60
            }),
        )
        .await;
    assert_eq!(status, 403);
    // The valid grant is untouched by all failed attempts.
    let unconsumed: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NULL AND revoked_at IS NULL FROM network_enrollment_grants WHERE id = $1",
    )
    .bind(grant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(unconsumed);
    assert_eq!(secret.len(), 43);
}

// ─── One-time consume, wrong scope and concurrency ───────────────────────────

#[sqlx::test]
async fn one_time_consume_is_atomic_and_wrong_scope_does_not_burn_grant(pool: PgPool) {
    let f = setup(&pool).await;
    let (grant_id, secret, issued) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    assert!(issued.to_string().contains("pending_setup"));
    assert!(issued.to_string().contains("unverified"));

    // Wrong purpose / device / actor all fail without consuming the grant.
    assert_eq!(
        consume(&f.user, f.hid, grant_id, &secret, "dns_setup", f.device_id)
            .await
            .0,
        403
    );
    assert_eq!(
        consume(
            &f.user,
            f.hid,
            grant_id,
            &secret,
            "proxy_setup",
            Uuid::new_v4()
        )
        .await
        .0,
        403
    );
    assert_eq!(
        consume(
            &f.user,
            f.other_hid,
            grant_id,
            &secret,
            "proxy_setup",
            f.device_id
        )
        .await
        .0,
        403
    );
    let bad_secret = "x".repeat(43);
    assert_eq!(
        consume(
            &f.user,
            f.hid,
            grant_id,
            &bad_secret,
            "proxy_setup",
            f.device_id
        )
        .await
        .0,
        403
    );
    let unconsumed: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NULL AND revoked_at IS NULL FROM network_enrollment_grants WHERE id = $1",
    )
    .bind(grant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(unconsumed, "failed attempts must not burn a valid grant");

    // Two parallel valid consumes: exactly one succeeds.
    let (a, b) = tokio::join!(
        consume(
            &f.user,
            f.hid,
            grant_id,
            &secret,
            "proxy_setup",
            f.device_id
        ),
        consume(
            &f.user,
            f.hid,
            grant_id,
            &secret,
            "proxy_setup",
            f.device_id
        ),
    );
    let statuses = [a.0, b.0];
    assert_eq!(
        statuses.iter().filter(|s| **s == 200).count(),
        1,
        "{statuses:?}"
    );
    assert_eq!(
        statuses.iter().filter(|s| **s == 403).count(),
        1,
        "{statuses:?}"
    );
    let ok = if a.0 == 200 { a.1 } else { b.1 };
    assert_eq!(ok["status"], "verified_session");
    assert_eq!(ok["verification_method"], "oidc_session");
    assert_eq!(ok["network_coverage"], "unverified_runtime_identity");

    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1 AND device_id = $2",
    )
    .bind(f.hid)
    .bind(f.device_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sessions, 1);
    assert_eq!(
        consume(
            &f.user,
            f.hid,
            grant_id,
            &secret,
            "proxy_setup",
            f.device_id
        )
        .await
        .0,
        403,
        "third consume is denied"
    );

    // Bounded outcome codes were recorded; no free text or secret column.
    let outcomes: Vec<String> = sqlx::query_scalar(
        "SELECT outcome FROM network_enrollment_attempts WHERE household_id = $1 ORDER BY id",
    )
    .bind(f.hid)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(outcomes.contains(&"wrong_purpose".to_string()));
    assert!(outcomes.contains(&"wrong_device".to_string()));
    assert!(outcomes.contains(&"wrong_secret".to_string()));
    assert!(outcomes.contains(&"revoked".to_string()));
    let secret_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'network_enrollment_attempts' AND column_name LIKE '%secret%')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!secret_column);
}

// ─── Expiry, generation revocation and concurrent device sessions ────────────

#[sqlx::test]
async fn expiry_generation_revocation_and_shared_device_sessions_are_consistent(pool: PgPool) {
    let f = setup(&pool).await;
    let (expired_id, secret, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    sqlx::query(
        "UPDATE network_enrollment_grants SET created_at = $2, expires_at = $3 WHERE id = $1",
    )
    .bind(expired_id)
    .bind(Utc::now() - ChronoDuration::hours(2))
    .bind(Utc::now() - ChronoDuration::hours(1))
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        consume(
            &f.user,
            f.hid,
            expired_id,
            &secret,
            "proxy_setup",
            f.device_id
        )
        .await
        .0,
        403
    );
    let expired_outcome: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_enrollment_attempts WHERE outcome = 'expired'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(expired_outcome, 1);

    // One live session per device: a second grant cannot start a second person
    // session until the first is explicitly ended.
    let (g1, s1, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    assert_eq!(
        consume(&f.user, f.hid, g1, &s1, "proxy_setup", f.device_id)
            .await
            .0,
        200
    );
    let (g2, s2, _) = issue(&f.user, f.hid, f.device_id, "dns_setup", 60).await;
    let conflict = consume(&f.user, f.hid, g2, &s2, "dns_setup", f.device_id).await;
    assert_eq!(
        conflict.0, 409,
        "conservative device-session policy: {conflict:?}"
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1 AND device_id = $2 AND ended_at IS NULL",
    )
    .bind(f.hid)
    .bind(f.device_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
    let sid: Uuid = sqlx::query_scalar(
        "SELECT id FROM network_verified_sessions WHERE household_id = $1 AND ended_at IS NULL",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        f.user
            .delete(&format!(
                "/api/network/households/{}/enroll/sessions/{sid}",
                f.hid
            ))
            .await
            .0,
        200
    );
    assert_eq!(
        consume(&f.user, f.hid, g2, &s2, "dns_setup", f.device_id)
            .await
            .0,
        200,
        "the still-valid grant works after the old session ends"
    );

    // Admin revocation invalidates outstanding grants and sessions and bumps
    // the generation in one transaction.
    let (g3, s3, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    let before_gen: i64 =
        sqlx::query_scalar("SELECT generation FROM network_principal_bindings WHERE id = $1")
            .bind(f.binding_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        f.admin
            .delete(&format!(
                "/api/network/households/{}/bindings/{}",
                f.hid, f.binding_id
            ))
            .await
            .0,
        200
    );
    let after_gen: i64 =
        sqlx::query_scalar("SELECT generation FROM network_principal_bindings WHERE id = $1")
            .bind(f.binding_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_gen, before_gen + 1);
    assert_eq!(
        consume(&f.user, f.hid, g3, &s3, "proxy_setup", f.device_id)
            .await
            .0,
        403
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1 AND ended_at IS NULL",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live, 0);
    let active_bindings: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_principal_bindings WHERE id = $1 AND active",
    )
    .bind(f.binding_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active_bindings, 0);
}

#[sqlx::test]
async fn revoke_racing_consume_leaves_no_live_grant_or_session(pool: PgPool) {
    let f = setup(&pool).await;
    let (grant_id, secret, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    let revoke_path = format!(
        "/api/network/households/{}/bindings/{}",
        f.hid, f.binding_id
    );
    let consume_path = format!("/api/network/households/{}/enroll/grants/consume", f.hid);
    let (revoke, consumed) = tokio::join!(
        f.admin.delete(&revoke_path),
        f.user.post(
            &consume_path,
            json!({
                "grant_id": grant_id, "secret": secret, "purpose": "proxy_setup",
                "device_id": f.device_id,
            }),
        ),
    );
    assert_eq!(revoke.0, 200);
    assert!(consumed.0 == 200 || consumed.0 == 403, "{consumed:?}");

    let live_sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1 AND ended_at IS NULL",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let live_grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_enrollment_grants WHERE household_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live_sessions, 0);
    assert_eq!(live_grants, 0);
}

// ─── Bounded side effects and no secret leakage ──────────────────────────────

#[sqlx::test]
async fn enrollment_does_not_touch_agent_control_pki_or_leak_secrets(pool: PgPool) {
    let f = setup(&pool).await;
    async fn count(pool: &PgPool, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
    }
    let baselines = [
        count(
            &pool,
            "SELECT COUNT(*) FROM agents WHERE api_token_hash IS NOT NULL",
        )
        .await,
        count(&pool, "SELECT COUNT(*) FROM agent_module_reports").await,
        count(&pool, "SELECT COUNT(*) FROM agent_module_disable_requests").await,
        count(&pool, "SELECT COUNT(*) FROM recall_settings_global").await,
        count(&pool, "SELECT COUNT(*) FROM recall_settings_agent").await,
        count(&pool, "SELECT COUNT(*) FROM network_household_agents").await,
        count(&pool, "SELECT COUNT(*) FROM network_gateway_credentials").await,
        count(&pool, "SELECT COUNT(*) FROM network_assignments").await,
    ];

    let (grant_id, secret, issued) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    let (status, consumed) = consume(
        &f.user,
        f.hid,
        grant_id,
        &secret,
        "proxy_setup",
        f.device_id,
    )
    .await;
    assert_eq!(status, 200, "{consumed}");
    let (_, grants) = f
        .user
        .get(&format!("/api/network/households/{}/enroll/grants", f.hid))
        .await;
    let (_, sessions) = f
        .user
        .get(&format!(
            "/api/network/households/{}/enroll/sessions",
            f.hid
        ))
        .await;
    let (_, devices) = f.user.get(&devices_path(f.hid)).await;

    // `issued` is the single sanctioned one-time response; every later
    // metadata/list response must be free of the secret.
    assert!(issued.to_string().contains(&secret));
    for body in [&consumed, &grants, &sessions, &devices] {
        assert!(
            !body.to_string().contains(&secret),
            "secret leaked in response"
        );
    }
    assert!(!grants.to_string().contains("secret_hash"));
    let (_, grant_list) = f
        .user
        .get(&format!("/api/network/households/{}/enroll/grants", f.hid))
        .await;
    assert!(grant_list["grants"][0]["id"].is_string());
    let audit_secret: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_audit WHERE household_id = $1 AND detail::text LIKE '%secret%'",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let global_secret: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE detail::text LIKE '%secret%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit_secret, 0);
    assert_eq!(global_secret, 0);

    let after = [
        count(
            &pool,
            "SELECT COUNT(*) FROM agents WHERE api_token_hash IS NOT NULL",
        )
        .await,
        count(&pool, "SELECT COUNT(*) FROM agent_module_reports").await,
        count(&pool, "SELECT COUNT(*) FROM agent_module_disable_requests").await,
        count(&pool, "SELECT COUNT(*) FROM recall_settings_global").await,
        count(&pool, "SELECT COUNT(*) FROM recall_settings_agent").await,
        count(&pool, "SELECT COUNT(*) FROM network_household_agents").await,
        count(&pool, "SELECT COUNT(*) FROM network_gateway_credentials").await,
        count(&pool, "SELECT COUNT(*) FROM network_assignments").await,
    ];
    assert_eq!(baselines, after, "no agent/control/PKI side effects");
}

// ─── Bounded attempt retention ───────────────────────────────────────────────

#[sqlx::test]
async fn retired_grants_and_sessions_are_bounded(pool: PgPool) {
    let f = setup(&pool).await;
    // Three retired grant/session pairs.
    for _ in 0..3 {
        let (gid, secret, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
        assert_eq!(
            consume(&f.user, f.hid, gid, &secret, "proxy_setup", f.device_id)
                .await
                .0,
            200
        );
        let sid: Uuid = sqlx::query_scalar(
            "SELECT id FROM network_verified_sessions WHERE household_id = $1 AND ended_at IS NULL",
        )
        .bind(f.hid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            f.user
                .delete(&format!(
                    "/api/network/households/{}/enroll/sessions/{sid}",
                    f.hid
                ))
                .await
                .0,
            200
        );
    }
    // One live session and one recent retired grant remain.
    let (gid, secret, _) = issue(&f.user, f.hid, f.device_id, "proxy_setup", 60).await;
    assert_eq!(
        consume(&f.user, f.hid, gid, &secret, "proxy_setup", f.device_id)
            .await
            .0,
        200
    );
    let old = Utc::now() - ChronoDuration::days(40);
    sqlx::query("UPDATE network_enrollment_grants SET created_at = $2 WHERE id <> $1")
        .bind(gid)
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE network_verified_sessions SET verified_at = $1 WHERE ended_at IS NOT NULL")
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();

    let removed = enroll_db::prune_all_records(&pool, old + ChronoDuration::days(7), Utc::now(), 1)
        .await
        .unwrap();
    assert!(removed >= 2, "aged retired rows were removed: {removed}");
    let grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_enrollment_grants WHERE household_id = $1",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grants, 1, "retired grants are bounded");
    assert_eq!(sessions, 1, "retired sessions are bounded");
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_verified_sessions WHERE household_id = $1 AND ended_at IS NULL",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live, 1, "the live session was never pruned");
    assert!(super::prune_enrollment_records(&pool).await.unwrap() <= 1);
}

#[sqlx::test]
async fn attempt_history_is_bounded_by_age_and_count(pool: PgPool) {
    let f = setup(&pool).await;
    let cfg = AttemptRetention {
        max_age_days: 1,
        max_per_household: 3,
    };
    let mut tx = pool.begin().await.unwrap();
    enroll_db::lock_household(&mut tx, f.hid).await.unwrap();
    for _ in 0..12 {
        enroll_db::record_attempt_on_conn(
            &mut tx,
            f.hid,
            Some(f.binding_id),
            None,
            Utc::now(),
            &cfg,
            AttemptOutcome::WrongSecret,
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_enrollment_attempts WHERE household_id = $1",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, cfg.max_per_household, "write-time count cap");

    // Age sweep plus count sweep from the periodic prune companion.
    sqlx::query(
        "INSERT INTO network_enrollment_attempts (household_id, occurred_at, outcome) VALUES ($1, $2, 'wrong_scope')",
    )
    .bind(f.hid)
    .bind(Utc::now() - ChronoDuration::days(10))
    .execute(&pool)
    .await
    .unwrap();
    let removed =
        enroll_db::prune_all_attempts(&pool, cfg.cutoff(Utc::now()), cfg.max_per_household)
            .await
            .unwrap();
    assert!(removed >= 1);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_enrollment_attempts WHERE household_id = $1",
    )
    .bind(f.hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(remaining <= cfg.max_per_household);
    let swept = super::prune_enrollment_attempts(&pool).await.unwrap();
    assert!(swept <= remaining as u64, "periodic prune never adds rows");
}
