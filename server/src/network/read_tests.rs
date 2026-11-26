//! Real-PostgreSQL end-to-end tests for the bounded management read contracts.
//!
//! Each `#[sqlx::test]` gets a fresh migrated database, a real router behind
//! session-cookie + CSRF middleware, and real users/sessions. Reads must never
//! mutate policy state, widen a grant, expose another tenant, or claim anything
//! about applied/enforced state.

use std::net::SocketAddr;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::{Duration as ChronoDuration, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::policy_dto::MAX_POLICY_HISTORY;

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
    let token = format!("read-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("read-csrf-{label}");
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

async fn grant(http: &Http, hid: Uuid, user_id: Uuid, name: &str) {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/grants"),
            json!({ "user_id": user_id, "grant": name }),
        )
        .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

fn policy_body(marker: &str, domain: &str, timezone: &str, stale: u64) -> Value {
    json!({
        "baseline": [{
            "id": marker,
            "effect": "deny",
            "matcher": { "domain_suffix": domain },
            "schedule": null,
            "reason": "safety baseline"
        }],
        "device_profiles": {},
        "person_rules": {},
        "exceptions": [],
        "default_effect": "deny",
        "timezone": timezone,
        "stale_after_secs": stale,
        "event_retention_secs": 86400
    })
}

async fn publish(http: &Http, hid: Uuid, body: Value) -> (u16, Value) {
    let mut body = body;
    if body.get("expected_revision").is_none() {
        body["expected_revision"] = Value::Null;
    }
    http.post(&format!("/api/network/households/{hid}/policies"), body)
        .await
}

async fn create_person(http: &Http, hid: Uuid, name: &str) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/persons"),
            json!({ "display_name": name }),
        )
        .await;
    assert_eq!(status, 200, "person create failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn bind(http: &Http, hid: Uuid, user_id: Uuid, person_id: Uuid) -> Uuid {
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/bindings"),
            json!({ "user_id": user_id, "person_id": person_id }),
        )
        .await;
    assert_eq!(status, 200, "binding failed: {body}");
    Uuid::parse_str(body["binding_id"].as_str().unwrap()).unwrap()
}

// ─── Policy body reads ───────────────────────────────────────────────────────

#[sqlx::test]
async fn policy_body_reads_are_authoritative_bounded_and_side_effect_free(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let operator = insert_user(&pool, "operator", "operator").await;
    let events = insert_user(&pool, "events", "viewer").await;
    let (ot, oc) = session_for(&pool, operator, "operator").await;
    let (et, ec) = session_for(&pool, events, "events").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let op = Http::new(&base, ot, oc);
    let ev = Http::new(&base, et, ec);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;

    assert_eq!(
        publish(
            &admin,
            hid,
            policy_body("r1", "a.example", "Australia/Sydney", 3600)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        publish(
            &admin,
            hid,
            policy_body("r2", "b.example", "Australia/Sydney", 7200)
        )
        .await
        .0,
        200
    );
    // Another household's revision 1 exists, but must not be served here.
    assert_eq!(
        publish(
            &admin,
            hid_b,
            policy_body("other", "c.example", "UTC", 3600)
        )
        .await
        .0,
        200
    );

    // Platform role and network_events alone never grant a policy body read.
    assert_eq!(
        op.get(&format!("/api/network/households/{hid}/policies/current"))
            .await
            .0,
        403
    );
    grant(&admin, hid, events, "network_events").await;
    assert_eq!(
        ev.get(&format!("/api/network/households/{hid}/policies/current"))
            .await
            .0,
        403
    );
    // A valid session without CSRF is irrelevant for GET, but a cookie is required.
    let anonymous = admin
        .client
        .get(format!(
            "{base}/api/network/households/{hid}/policies/current"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status().as_u16(), 401);
    // GET reads work with the session cookie alone; CSRF stays scoped to
    // mutating requests exactly as before this slice.
    let cookie_only = admin
        .client
        .get(format!(
            "{base}/api/network/households/{hid}/policies/current"
        ))
        .header("cookie", format!("session={}", admin.token))
        .send()
        .await
        .unwrap();
    assert_eq!(
        cookie_only.status().as_u16(),
        200,
        "GET needs no CSRF token"
    );

    let before_rows = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM network_policies WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let before_audit =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();

    let (status, body) = admin
        .get(&format!("/api/network/households/{hid}/policies/current"))
        .await;
    assert_eq!(status, 200, "current read failed: {body}");
    let current = &body["policy"];
    assert_eq!(current["revision"], 2);
    assert_eq!(current["schema_version"], 1);
    assert_eq!(current["source_kind"], "publish");
    assert_eq!(current["policy"]["baseline"][0]["id"], "r2");
    assert_eq!(current["policy"]["stale_after_secs"], 7200);
    // The row is timestamptz (microseconds) while the body carries the full
    // serde timestamp; they describe the same instant within one microsecond.
    let row_time = chrono::DateTime::parse_from_rfc3339(current["published_at"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    let body_time =
        chrono::DateTime::parse_from_rfc3339(current["policy"]["published_at"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
    assert!((row_time - body_time).num_milliseconds().abs() < 1);

    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT body FROM network_policies WHERE household_id = $1 AND revision = 2",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        current["body_bytes"].as_u64().unwrap() as usize,
        stored.len()
    );
    assert_eq!(
        current["body_sha256"].as_str().unwrap(),
        crate::auth::secrets::sha256_hex_bytes(&stored)
    );
    let typed: vantyr_network_policy::Policy = serde_json::from_slice(&stored).unwrap();
    assert_eq!(typed.household_id, hid);
    assert_eq!(typed.revision, 2);

    let (status, body) = admin
        .get(&format!("/api/network/households/{hid}/policies/1"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["policy"]["revision"], 1);
    assert_eq!(body["policy"]["policy"]["baseline"][0]["id"], "r1");

    let text = serde_json::to_string(&body).unwrap();
    for forbidden in ["applied", "enforced", "token", "secret_hash", "signature"] {
        assert!(
            !text.contains(forbidden),
            "response leaks {forbidden}: {text}"
        );
    }

    // Malformed bounds are 400; missing/pruned/foreign revisions are 404.
    for bad in ["nope", "0", "-1", "9999999999999999999999999"] {
        let (status, _) = admin
            .get(&format!("/api/network/households/{hid}/policies/{bad}"))
            .await;
        assert_eq!(status, 400, "revision {bad} must be a bounded 400");
    }
    assert_eq!(
        admin
            .get(&format!("/api/network/households/{hid}/policies/999"))
            .await
            .0,
        404
    );
    // Revision 1 exists only in the OTHER household.
    assert_eq!(
        admin
            .get(&format!("/api/network/households/{hid_b}/policies/2"))
            .await
            .0,
        404
    );

    let after_rows = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM network_policies WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let after_audit =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before_rows, after_rows, "reads must not publish or assign");
    assert_eq!(before_audit, after_audit, "reads must not write audit rows");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM network_gateway_desired_policy WHERE household_id = $1"
        )
        .bind(hid)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0,
        "reads must not assign a desired policy"
    );

    // Pruned revisions are honestly absent from the read contract.
    for _ in 0..(MAX_POLICY_HISTORY + 3) {
        assert_eq!(
            publish(
                &admin,
                hid_b,
                policy_body("prune", "d.example", "UTC", 3600)
            )
            .await
            .0,
            200
        );
    }
    assert_eq!(
        admin
            .get(&format!("/api/network/households/{hid_b}/policies/1"))
            .await
            .0,
        404,
        "pruned revision is a 404, not a stale body"
    );
    handle.abort();
}

#[sqlx::test]
async fn policy_diff_is_semantic_bounded_and_literal_routes_win(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let events = insert_user(&pool, "events", "viewer").await;
    let (et, ec) = session_for(&pool, events, "events").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let ev = Http::new(&base, et, ec);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    grant(&admin, hid, events, "network_events").await;

    assert_eq!(
        publish(
            &admin,
            hid,
            policy_body("r1", "a.example", "Australia/Sydney", 3600)
        )
        .await
        .0,
        200
    );
    // "current" and "diff" are literal routes, never parsed as a revision.
    assert_eq!(
        admin
            .get(&format!("/api/network/households/{hid}/policies/current"))
            .await
            .0,
        200
    );

    let mut second = policy_body("r1", "changed.example", "UTC", 7200);
    second["baseline"].as_array_mut().unwrap().push(json!({
        "id": "r2",
        "effect": "deny",
        "matcher": { "domain_suffix": "extra.example" },
        "schedule": null,
        "reason": ""
    }));
    assert_eq!(publish(&admin, hid, second).await.0, 200);

    let path = format!("/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=2");
    assert_eq!(ev.get(&path).await.0, 403, "network_events alone is denied");
    let (status, body) = admin.get(&path).await;
    assert_eq!(status, 200, "diff failed: {body}");
    let diff = &body["diff"];
    assert_eq!(diff["content_changed"], true);
    assert_eq!(diff["from"]["revision"], 1);
    assert_eq!(diff["to"]["revision"], 2);
    assert_eq!(diff["counts"]["added_rules"], 1);
    assert_eq!(diff["counts"]["changed_rules"], 1);
    assert_eq!(diff["counts"]["removed_rules"], 0);
    assert!(diff["counts"]["changed_settings"].as_u64().unwrap() >= 2);
    assert_eq!(diff["rules"].as_array().unwrap().len(), 2);
    assert!(diff["settings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["field"] == "timezone"));
    assert_eq!(diff["truncated"], false);
    assert_eq!(diff["omitted_changes"], 0);
    let before = diff["rules"][0]["before"]["matcher"]["domain_suffix"]
        .as_str()
        .unwrap()
        .to_string();
    let after = diff["rules"][0]["after"]["matcher"]["domain_suffix"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(before, "a.example");
    assert_eq!(after, "changed.example");

    let same = format!("/api/network/households/{hid}/policies/diff?from_revision=2&to_revision=2");
    let (_, body) = admin.get(&same).await;
    assert_eq!(body["diff"]["content_changed"], false);
    assert_eq!(body["diff"]["rules"].as_array().unwrap().len(), 0);
    assert_eq!(body["diff"]["settings"].as_array().unwrap().len(), 0);

    // Rollback copies body content into a NEW revision; only provenance changes.
    let (status, body) = admin
        .post(
            &format!("/api/network/households/{hid}/policies/rollback"),
            json!({ "source_revision": 1 }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let rollback =
        format!("/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=3");
    let (status, body) = admin.get(&rollback).await;
    assert_eq!(status, 200);
    assert_eq!(body["diff"]["content_changed"], false, "{body}");
    assert_eq!(body["diff"]["to"]["source_kind"], "rollback");
    assert_eq!(body["diff"]["to"]["rolled_back_from_revision"], 1);
    assert_ne!(
        body["diff"]["from"]["body_sha256"].as_str().unwrap(),
        body["diff"]["to"]["body_sha256"].as_str().unwrap(),
        "rollback changes revision/publication metadata, not body semantics"
    );

    for bad in [
        format!("/api/network/households/{hid}/policies/diff?from_revision=0&to_revision=2"),
        format!("/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=nope"),
        format!("/api/network/households/{hid}/policies/diff?to_revision=2"),
        format!(
            "/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=2&extra=x"
        ),
    ] {
        assert_eq!(admin.get(&bad).await.0, 400, "bad diff params: {bad}");
    }
    assert_eq!(
        admin
            .get(&format!(
                "/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=999"
            ))
            .await
            .0,
        404
    );
    assert_eq!(
        publish(&admin, hid_b, policy_body("b", "b.example", "UTC", 3600))
            .await
            .0,
        200
    );
    assert_eq!(
        admin
            .get(&format!(
                "/api/network/households/{hid}/policies/diff?from_revision=1&to_revision=1&x=1"
            ))
            .await
            .0,
        400,
        "unknown query fields are rejected"
    );
    handle.abort();
}

// ─── Audit filters / paging ──────────────────────────────────────────────────

async fn insert_audit(pool: &PgPool, hid: Uuid, actor: &str, action: &str, second_offset: i64) {
    let ts = Utc.timestamp_opt(1_767_225_600 + second_offset, 0).unwrap();
    sqlx::query(
        "INSERT INTO network_audit (household_id, actor, action, ts, detail) VALUES ($1, $2, $3, $4, '{}'::jsonb)",
    )
    .bind(hid)
    .bind(actor)
    .bind(action)
    .bind(ts)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn audit_filters_count_and_paging_share_one_snapshot(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let other_admin = insert_user(&pool, "other", "admin").await;
    let events = insert_user(&pool, "events", "viewer").await;
    let (ot, oc) = session_for(&pool, other_admin, "other").await;
    let (et, ec) = session_for(&pool, events, "events").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let other = Http::new(&base, ot, oc);
    let ev = Http::new(&base, et, ec);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    // The other admin's grant is on the OTHER household, never on this one.
    grant(&admin, hid_b, other_admin, "network_admin").await;
    grant(&admin, hid, events, "network_events").await;

    for secs in [0, 1, 2, 3, 4] {
        insert_audit(&pool, hid, "alice", "network_policy_publish", secs).await;
    }
    insert_audit(&pool, hid, "bob", "network_grant_set", 10).await;
    insert_audit(&pool, hid_b, "outsider", "network_policy_publish", 20).await;

    let path = format!(
        "/api/network/households/{hid}/audit?action=network_policy_publish&actor=alice\
         &from=2026-01-01T00:00:01Z&to=2026-01-01T00:00:03Z&limit=2&offset=0"
    );
    assert_eq!(other.get(&path).await.0, 403);
    assert_eq!(ev.get(&path).await.0, 403, "network_events alone is denied");

    let before =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (status, body) = admin.get(&path).await;
    assert_eq!(status, 200, "audit read failed: {body}");
    assert_eq!(body["total"], 3);
    assert_eq!(body["rows"].as_array().unwrap().len(), 2);
    assert_eq!(body["has_more"], true);
    assert_eq!(body["next_offset"], 2);
    let rows = body["rows"].as_array().unwrap();
    assert_eq!(rows[0]["actor"], "alice");
    assert_eq!(rows[0]["action"], "network_policy_publish");
    assert!(rows[0]["ts"].as_str().unwrap() > rows[1]["ts"].as_str().unwrap());
    // Stable (ts, id) ordering: later row has a larger id.
    assert!(rows[0]["id"].as_i64().unwrap() > rows[1]["id"].as_i64().unwrap());

    let path2 = format!(
        "/api/network/households/{hid}/audit?action=network_policy_publish&actor=alice\
         &from=2026-01-01T00:00:01Z&to=2026-01-01T00:00:03Z&limit=2&offset=2"
    );
    let (status, body) = admin.get(&path2).await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], 3, "count uses the same predicates");
    assert_eq!(body["rows"].as_array().unwrap().len(), 1);
    assert_eq!(body["has_more"], false);
    assert!(body["next_offset"].is_null());

    // Compatible shape: no filters still returns `rows` with all scoped rows.
    let (status, body) = admin
        .get(&format!("/api/network/households/{hid}/audit"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["total"], before);
    assert_eq!(body["rows"].as_array().unwrap().len(), before as usize);
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("outsider"), "no cross-household audit rows");

    for bad in [
        format!(
            "/api/network/households/{hid}/audit?actor={}",
            "x".repeat(129)
        ),
        format!("/api/network/households/{hid}/audit?actor=bad%0Aname"),
        format!("/api/network/households/{hid}/audit?from=yesterday"),
        format!(
            "/api/network/households/{hid}/audit?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z"
        ),
        format!("/api/network/households/{hid}/audit?limit=0"),
        format!("/api/network/households/{hid}/audit?offset=-1"),
        format!("/api/network/households/{hid}/audit?unknown=x"),
    ] {
        assert_eq!(admin.get(&bad).await.0, 400, "bad audit query: {bad}");
    }
    let after =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM network_audit WHERE household_id = $1")
            .bind(hid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "audit reads must not write");
    handle.abort();
}

// ─── Self-service enrollment contexts ───────────────────────────────────────

#[sqlx::test]
async fn additive_binding_and_own_session_labels_are_scoped_projections(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let user = insert_user(&pool, "labelled-user", "viewer").await;
    sqlx::query("UPDATE dashboard_users SET display_name = 'Full Name' WHERE id = $1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let (ut, uc) = session_for(&pool, user, "labelled-user").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let admin = Http::new(&base, at, ac);
    let user_http = Http::new(&base, ut, uc);
    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    let person = create_person(&admin, hid, "Mapped Person").await;
    let _binding = bind(&admin, hid, user, person).await;
    grant(&admin, hid, user, "network_enroll").await;

    let foreign_person = create_person(&admin, hid_b, "Foreign Person").await;
    let _foreign_binding = bind(&admin, hid_b, user, foreign_person).await;
    grant(&admin, hid_b, user, "network_enroll").await;

    // Admin binding list: additive labels come from scoped joins, never from
    // a global user directory or an inferred person.
    let (status, body) = admin
        .get(&format!("/api/network/households/{hid}/bindings"))
        .await;
    assert_eq!(status, 200);
    let row = &body["bindings"][0];
    assert_eq!(row["dashboard_username"], "labelled-user");
    assert_eq!(row["dashboard_display_name"], "Full Name");
    assert_eq!(row["person_display_name"], "Mapped Person");
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("Foreign Person"), "no cross-household label");

    // Own session row carries only the caller's bound person display name.
    let (status, device_body) = admin
        .post(
            &format!("/api/network/households/{hid}/devices"),
            json!({
                "canonical_key": "byod-label-test",
                "label": "Laptop",
                "device_type": "computer"
            }),
        )
        .await;
    assert_eq!(status, 200, "{device_body}");
    let device = Uuid::parse_str(device_body["id"].as_str().unwrap()).unwrap();
    sqlx::query(
        r"
        INSERT INTO network_verified_sessions
            (household_id, binding_id, device_id, dashboard_user, person_id,
             generation, purpose, verification_method, verified_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, 1, 'proxy_setup', 'oidc_session', NOW(), NOW() + interval '1 hour')
        ",
    )
    .bind(hid)
    .bind(_binding)
    .bind(device)
    .bind(user)
    .bind(person)
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = user_http
        .get(&format!("/api/network/households/{hid}/enroll/sessions"))
        .await;
    assert_eq!(status, 200, "{body}");
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["person_display_name"], "Mapped Person");
    let text = serde_json::to_string(&body).unwrap();
    assert!(!text.contains("Foreign Person"), "no foreign session label");
    handle.abort();
}

#[sqlx::test]
async fn enrollment_contexts_are_caller_only_and_revoke_immediately(pool: PgPool) {
    let (base, handle) = spawn_router(pool.clone()).await;
    let owner = insert_user(&pool, "owner", "admin").await;
    let user = insert_user(&pool, "teen", "viewer").await;
    let other_user = insert_user(&pool, "other-teen", "viewer").await;
    let admin_only = insert_user(&pool, "admin-only", "viewer").await;
    let events = insert_user(&pool, "events", "viewer").await;
    let (ut, uc) = session_for(&pool, user, "teen").await;
    let (ot, oc) = session_for(&pool, other_user, "other-teen").await;
    let (at, ac) = session_for(&pool, owner, "owner").await;
    let (adt, adc) = session_for(&pool, admin_only, "admin-only").await;
    let (et, ec) = session_for(&pool, events, "events").await;
    let admin = Http::new(&base, at, ac);
    let user_http = Http::new(&base, ut, uc);
    let other_http = Http::new(&base, ot, oc);
    let admin_only_http = Http::new(&base, adt, adc);
    let events_http = Http::new(&base, et, ec);

    let hid = bootstrap_as(&admin, "Home").await;
    let hid_b = create_household(&admin, "Other").await;
    let person = create_person(&admin, hid, "Teen Person").await;
    let binding = bind(&admin, hid, user, person).await;
    grant(&admin, hid, user, "network_enroll").await;

    // Another user has the same grant in another household with a different
    // person; neither may appear in the caller's context list.
    let other_person = create_person(&admin, hid_b, "Other Person").await;
    bind(&admin, hid_b, other_user, other_person).await;
    grant(&admin, hid_b, other_user, "network_enroll").await;
    grant(&admin, hid, admin_only, "network_admin").await;
    grant(&admin, hid, events, "network_events").await;

    let (status, body) = user_http.get("/api/network/enrollment-contexts").await;
    assert_eq!(status, 200, "context read failed: {body}");
    assert_eq!(body["total"], 1);
    assert_eq!(body["count"], 1);
    assert_eq!(body["has_more"], false);
    let contexts = body["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(
        contexts[0]["household_id"].as_str().unwrap(),
        hid.to_string()
    );
    assert_eq!(contexts[0]["household_name"], "Home");
    assert_eq!(
        contexts[0]["person_id"].as_str().unwrap(),
        person.to_string()
    );
    assert_eq!(contexts[0]["person_display_name"], "Teen Person");
    assert_eq!(
        contexts[0]["binding_id"].as_str().unwrap(),
        binding.to_string()
    );
    assert_eq!(contexts[0]["generation"], 1);
    let text = serde_json::to_string(&body).unwrap();
    for forbidden in [
        "Other Person",
        "Other",
        "secret",
        "token",
        "password",
        "network_admin",
        "network_grants",
    ] {
        assert!(
            !text.contains(forbidden),
            "context leaks {forbidden}: {text}"
        );
    }
    assert_eq!(
        user_http
            .get(&format!("/api/network/households/{hid}/devices"))
            .await
            .0,
        403,
        "an enroll-only user must not gain household inventory access"
    );
    assert_eq!(
        user_http
            .get(&format!("/api/network/households/{hid}/policies/current"))
            .await
            .0,
        403,
        "an enroll-only user must not gain policy access"
    );

    for http in [&admin_only_http, &events_http] {
        let (status, body) = http.get("/api/network/enrollment-contexts").await;
        assert_eq!(status, 200);
        assert_eq!(body["contexts"].as_array().unwrap().len(), 0);
    }
    let (status, body) = other_http.get("/api/network/enrollment-contexts").await;
    assert_eq!(status, 200);
    assert_eq!(body["contexts"].as_array().unwrap().len(), 1);
    assert_eq!(body["contexts"][0]["household_name"], "Other");
    assert_ne!(
        body["contexts"][0]["person_id"].as_str().unwrap(),
        person.to_string()
    );

    // Revoking either half of the requirement removes the context at once.
    assert_eq!(
        admin
            .delete(&format!(
                "/api/network/households/{hid}/grants/{user}/network_enroll"
            ))
            .await
            .0,
        200
    );
    let (_, body) = user_http.get("/api/network/enrollment-contexts").await;
    assert_eq!(body["contexts"].as_array().unwrap().len(), 0);
    grant(&admin, hid, user, "network_enroll").await;
    assert_eq!(
        admin
            .delete(&format!("/api/network/households/{hid}/bindings/{binding}"))
            .await
            .0,
        200
    );
    let (_, body) = user_http.get("/api/network/enrollment-contexts").await;
    assert_eq!(body["contexts"].as_array().unwrap().len(), 0);

    // Re-mapping bumps the binding generation and exposes only the new person.
    let second_person = create_person(&admin, hid, "Second Person").await;
    let _ = bind(&admin, hid, user, second_person).await;
    let (_, body) = user_http.get("/api/network/enrollment-contexts").await;
    let contexts = body["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0]["person_display_name"], "Second Person");
    // Revoke and re-map each bump the generation; a stale generation cannot
    // be confused with the current binding.
    assert!(contexts[0]["generation"].as_i64().unwrap() >= 2);

    for bad in [
        "/api/network/enrollment-contexts?limit=0",
        "/api/network/enrollment-contexts?offset=-1",
        "/api/network/enrollment-contexts?limit=1001",
    ] {
        assert_eq!(user_http.get(bad).await.0, 400, "bad page params: {bad}");
    }
    handle.abort();
}
