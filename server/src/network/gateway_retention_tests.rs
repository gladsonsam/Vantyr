//! Real-database tests for gateway report retention and lock-order safety.
//!
//! Service-level heartbeat calls take an explicit small retention config so
//! caps are testable without mutating process environment.

use std::net::SocketAddr;
use std::time::Duration;

use axum::middleware::from_fn_with_state;
use axum::Router;
use chrono::Utc;
use futures_util::future::join_all;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::gateway_dto::HeartbeatBody;
use super::gateway_retention::GatewayReportRetention;

async fn insert_user(pool: &PgPool, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1, 'h', 'admin') RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn session(pool: &PgPool, user: Uuid) -> (String, String) {
    let token = format!("session-{}", Uuid::new_v4());
    let hash = crate::auth::secrets::sha256_hex_bytes(token.as_bytes());
    crate::auth::users::db::sessions::dashboard_session_create(
        pool,
        &hash,
        user,
        Utc::now() + chrono::Duration::hours(1),
        None,
        "csrf",
    )
    .await
    .unwrap();
    (token, "csrf".to_string())
}

struct Http {
    base: String,
    client: reqwest::Client,
    token: String,
}

impl Http {
    async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let res = self
            .client
            .post(format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .header("x-csrf-token", "csrf")
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json::<Value>().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let res = self
            .client
            .get(format!("{}{}", self.base, path))
            .header("cookie", format!("session={}", self.token))
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json::<Value>().await.unwrap_or(Value::Null))
    }
}

async fn spawn(pool: PgPool) -> (String, JoinHandle<()>) {
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
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

/// One household, one active DNS gateway and one credential.
async fn fixture(pool: &PgPool) -> (String, Http, Uuid, Uuid, String, JoinHandle<()>) {
    let (base, handle) = spawn(pool.clone()).await;
    let user = insert_user(pool, "owner").await;
    let (token, _) = session(pool, user).await;
    let http = Http {
        base: base.clone(),
        client: reqwest::Client::new(),
        token,
    };
    let (status, body) = http
        .post("/api/network/bootstrap", json!({ "name": "Home" }))
        .await;
    assert_eq!(status, 200, "{body}");
    let hid = Uuid::parse_str(body["household_id"].as_str().unwrap()).unwrap();
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways"),
            json!({ "kind": "dns", "label": "Core" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let gid = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let (status, body) = http
        .post(
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let bearer = body["token"].as_str().unwrap().to_string();
    (base, http, hid, gid, bearer, handle)
}

fn hb(hid: Uuid, gid: Uuid) -> HeartbeatBody {
    HeartbeatBody {
        audience: super::gateway_auth::AUDIENCE.to_string(),
        command: super::gateway_auth::COMMAND_HEARTBEAT.to_string(),
        gateway_id: gid,
        household_id: hid,
        kind: "dns".to_string(),
        capabilities: Some(vec!["dns".to_string()]),
        observed_at: None,
        desired_revision: None,
        applied_revision: None,
        failure: None,
    }
}

fn caps(cap: i64) -> GatewayReportRetention {
    GatewayReportRetention {
        max_age_days: 7,
        max_per_gateway: cap,
    }
}

async fn heartbeat(
    pool: &PgPool,
    bearer: &str,
    hid: Uuid,
    gid: Uuid,
    cfg: GatewayReportRetention,
) -> ApiResult<i64> {
    super::gateway_service::heartbeat(pool, Some(bearer), hb(hid, gid), Utc::now(), cfg)
        .await
        .map(|o| o.report_id)
}

#[sqlx::test]
async fn expired_reports_are_hidden_on_read_and_pruned_by_sweep(pool: PgPool) {
    let (_, http, hid, gid, bearer, handle) = fixture(&pool).await;
    assert!(heartbeat(&pool, &bearer, hid, gid, caps(10)).await.is_ok());
    sqlx::query("UPDATE network_gateway_reports SET reported_at = NOW() - INTERVAL '8 days'")
        .execute(&pool)
        .await
        .unwrap();
    let (_, body) = http
        .get(&format!(
            "/api/network/households/{hid}/gateways/{gid}/reports"
        ))
        .await;
    assert_eq!(
        body["reports"].as_array().unwrap().len(),
        0,
        "expired hidden"
    );
    let removed = super::prune_gateway_reports(&pool).await.unwrap();
    assert_eq!(removed, 1);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM network_gateway_reports")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    handle.abort();
}

#[sqlx::test]
async fn concurrent_ingest_never_exceeds_the_hard_count_cap(pool: PgPool) {
    let (_, _, hid, gid, bearer, handle) = fixture(&pool).await;
    let tasks: Vec<_> = (0..12)
        .map(|_| {
            let p = pool.clone();
            let b = bearer.clone();
            async move { heartbeat(&p, &b, hid, gid, caps(3)).await }
        })
        .collect();
    let results = tokio::time::timeout(Duration::from_secs(20), join_all(tasks))
        .await
        .expect("concurrent ingest deadlocked");
    assert!(
        results.iter().all(|r| r.is_ok()),
        "unexpected ingest failure: {results:?}"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_gateway_reports WHERE household_id = $1 AND gateway_id = $2",
    )
    .bind(hid)
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count <= 3, "cap breached under concurrency: {count}");
    assert!(count >= 1);
    handle.abort();
}

#[sqlx::test]
async fn concurrent_heartbeat_and_rotate_serialize_without_deadlock(pool: PgPool) {
    let (_, _, hid, gid, bearer, handle) = fixture(&pool).await;
    let (cid, issued_by): (Uuid, Uuid) = sqlx::query_as(
        "SELECT id, issued_by FROM network_gateway_credentials WHERE gateway_id = $1 AND revoked_at IS NULL",
    )
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Every task yields Ok(Some(new_bearer)) only for rotation; heartbeats
    // yield Ok(None). A deadlock would trip the bounded timeout.
    let mut tasks: Vec<JoinHandle<ApiResult<Option<String>>>> = (0..6)
        .map(|_| {
            let p = pool.clone();
            let b = bearer.clone();
            tokio::spawn(async move { heartbeat(&p, &b, hid, gid, caps(10)).await.map(|_| None) })
        })
        .collect();
    let rotate_pool = pool.clone();
    tasks.push(tokio::spawn(async move {
        super::gateway_service::rotate_credential(
            &rotate_pool,
            hid,
            gid,
            cid,
            issued_by,
            Utc::now() + chrono::Duration::hours(1),
        )
        .await
        .map(|(id, secret)| Some(super::gateway_auth::format_bearer(id, &secret)))
    }));
    let results = tokio::time::timeout(Duration::from_secs(20), join_all(tasks))
        .await
        .expect("heartbeat/rotate deadlock");
    // Heartbeats that reach the credential after rotation are legitimately
    // denied; no other failure (in particular no 500) may appear.
    assert!(
        results.iter().all(|r| matches!(
            r,
            Ok(Ok(_))
                | Ok(Err(ApiError::Status(
                    axum::http::StatusCode::UNAUTHORIZED,
                    _
                )))
        )),
        "unexpected error: {results:?}"
    );
    let new_bearer: String = results
        .iter()
        .filter_map(|r| r.as_ref().ok())
        .filter_map(|r| r.as_ref().ok())
        .filter_map(|v| v.clone())
        .next()
        .expect("rotate must mint a replacement");

    assert!(
        heartbeat(&pool, &bearer, hid, gid, caps(10)).await.is_err(),
        "old credential must be denied after rotate"
    );
    assert!(heartbeat(&pool, &new_bearer, hid, gid, caps(10))
        .await
        .is_ok());
    handle.abort();
}

#[sqlx::test]
async fn concurrent_heartbeat_and_revoke_end_with_post_revoke_denial(pool: PgPool) {
    let (_, _, hid, gid, bearer, handle) = fixture(&pool).await;
    let mut tasks: Vec<JoinHandle<ApiResult<i64>>> = (0..6)
        .map(|_| {
            let p = pool.clone();
            let b = bearer.clone();
            tokio::spawn(async move { heartbeat(&p, &b, hid, gid, caps(10)).await })
        })
        .collect();
    let revoke_pool = pool.clone();
    tasks.push(tokio::spawn(async move {
        super::gateway_service::revoke_gateway(&revoke_pool, hid, gid)
            .await
            .map(|_| 0)
    }));
    let results = tokio::time::timeout(Duration::from_secs(20), join_all(tasks))
        .await
        .expect("heartbeat/revoke deadlock");
    // A heartbeat racing a committed revoke is denied (401); neither a 500 nor
    // a hung transaction is acceptable.
    assert!(
        results.iter().all(|r| matches!(
            r,
            Ok(Ok(_))
                | Ok(Err(ApiError::Status(
                    axum::http::StatusCode::UNAUTHORIZED,
                    _
                )))
        )),
        "unexpected error: {results:?}"
    );
    for _ in 0..3 {
        let err = heartbeat(&pool, &bearer, hid, gid, caps(10))
            .await
            .expect_err("revoked gateway must deny heartbeat");
        assert!(matches!(
            err,
            ApiError::Status(axum::http::StatusCode::UNAUTHORIZED, _)
        ));
    }
    handle.abort();
}

#[sqlx::test]
async fn issuing_during_revocation_never_leaves_an_active_credential(pool: PgPool) {
    let (_, _, hid, gid, _, handle) = fixture(&pool).await;
    let issued_by: Uuid = sqlx::query_scalar(
        "SELECT issued_by FROM network_gateway_credentials WHERE gateway_id = $1 LIMIT 1",
    )
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut tasks: Vec<JoinHandle<ApiResult<String>>> = (0..6)
        .map(|_| {
            let p = pool.clone();
            let actor = issued_by;
            tokio::spawn(async move {
                super::gateway_service::issue_credential(
                    &p,
                    hid,
                    gid,
                    actor,
                    Utc::now() + chrono::Duration::hours(1),
                )
                .await
                .map(|(_, secret)| secret)
            })
        })
        .collect();
    let revoke_pool = pool.clone();
    tasks.push(tokio::spawn(async move {
        super::gateway_service::revoke_gateway(&revoke_pool, hid, gid)
            .await
            .map(|_| String::new())
    }));
    let results = tokio::time::timeout(Duration::from_secs(20), join_all(tasks))
        .await
        .expect("issue/revoke deadlock");
    // A task either issued before the gateway was revoked, or was refused with
    // not_found after revocation. No other failure (in particular no 500) is
    // acceptable, and no issued credential may remain active.
    assert!(
        results
            .iter()
            .all(|r| matches!(r, Ok(Ok(_)) | Ok(Err(ApiError::NotFound(_))))),
        "unexpected error: {results:?}"
    );
    let mut issued = 0;
    for result in results.iter().take(6) {
        if let Ok(Ok(secret)) = result {
            issued += 1;
            let hash = crate::auth::secrets::sha256_hex_bytes(secret.as_bytes());
            let id: Uuid = sqlx::query_scalar(
                "SELECT id FROM network_gateway_credentials WHERE secret_hash = $1",
            )
            .bind(hash)
            .fetch_one(&pool)
            .await
            .unwrap();
            let bearer = super::gateway_auth::format_bearer(id, secret);
            assert!(
                heartbeat(&pool, &bearer, hid, gid, caps(10)).await.is_err(),
                "a credential issued before revocation must be revoked with its gateway"
            );
        }
    }
    assert!(
        issued >= 1,
        "at least one credential must be issued before revoke"
    );
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM network_gateway_credentials WHERE gateway_id = $1 AND revoked_at IS NULL",
    )
    .bind(gid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        active, 0,
        "credential issued after revocation is impossible"
    );
    handle.abort();
}
