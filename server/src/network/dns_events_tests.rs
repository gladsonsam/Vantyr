//! Real-HTTP / real-PostgreSQL tests for durable DNS events. Each test gets a
//! fresh migrated database, the actual router behind session/CSRF middleware
//! and the cookie-free worker router. No mocked auth, no mocked database.

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
    let token = format!("dns-evt-tok-{label}-{}", Uuid::new_v4());
    let csrf = format!("dns-evt-csrf-{label}");
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
    let api = Router::new().merge(super::routes());
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

    async fn worker(&self, path: &str, bearer: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self
            .client
            .post(format!("{}{}", self.base, path))
            .header("content-type", "application/json")
            .json(&body)
            .timeout(Duration::from_secs(20));
        if let Some(bearer) = bearer {
            req = req.header("authorization", bearer);
        }
        Self::send(req).await
    }

    /// The worker router keeps a 5/s peer governor. Retry only on 429.
    async fn worker_paced(&self, path: &str, bearer: &str, body: Value) -> (u16, Value) {
        for _ in 0..20 {
            let result = self.worker(path, Some(bearer), body.clone()).await;
            if result.0 != 429 {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        self.worker(path, Some(bearer), body).await
    }
}

async fn bootstrap_as(http: &Http, name: &str) -> Uuid {
    let (status, response) = Http::send(
        http.builder(reqwest::Method::POST, "/api/network/bootstrap")
            .header("content-type", "application/json")
            .json(&json!({ "name": name })),
    )
    .await;
    assert_eq!(status, 200, "bootstrap failed: {response}");
    Uuid::parse_str(response["household_id"].as_str().unwrap()).unwrap()
}

async fn create_gateway(http: &Http, hid: Uuid, kind: &str) -> Uuid {
    let (status, body) = Http::send(
        http.builder(
            reqwest::Method::POST,
            &format!("/api/network/households/{hid}/gateways"),
        )
        .header("content-type", "application/json")
        .json(&json!({ "kind": kind, "label": "Worker" })),
    )
    .await;
    assert_eq!(status, 200, "gateway failed: {body}");
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

async fn issue_cred(http: &Http, hid: Uuid, gid: Uuid, commands: Vec<&str>) -> String {
    let (status, body) = Http::send(
        http.builder(
            reqwest::Method::POST,
            &format!("/api/network/households/{hid}/gateways/{gid}/credentials"),
        )
        .header("content-type", "application/json")
        .json(&json!({
            "expires_in_hours": 24,
            "commands": commands.into_iter().map(String::from).collect::<Vec<_>>()
        })),
    )
    .await;
    assert_eq!(status, 200, "credential failed: {body}");
    body["token"].as_str().unwrap().to_string()
}

async fn grant(http: &Http, hid: Uuid, user_id: Uuid, name: &str) {
    let (status, body) = Http::send(
        http.builder(
            reqwest::Method::POST,
            &format!("/api/network/households/{hid}/grants"),
        )
        .header("content-type", "application/json")
        .json(&json!({ "user_id": user_id, "grant": name })),
    )
    .await;
    assert_eq!(status, 200, "grant failed: {body}");
}

async fn device_in_household(pool: &PgPool, hid: Uuid) -> Uuid {
    let person: Uuid = sqlx::query_scalar(
        "INSERT INTO network_persons (household_id, display_name) VALUES ($1, 'Device owner') RETURNING id",
    )
    .bind(hid)
    .fetch_one(pool)
    .await
    .unwrap();
    let device: Uuid = sqlx::query_scalar(
        "INSERT INTO network_devices (household_id, canonical_key, label, device_type) VALUES ($1, $2, 'Test device', 'computer') RETURNING id",
    )
    .bind(hid)
    .bind(format!("dns-evt-device-{}", Uuid::new_v4()).replace('-', ""))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO network_assignments (household_id, person_id, device_id, role) VALUES ($1, $2, $3, 'member')",
    )
    .bind(hid)
    .bind(person)
    .bind(device)
    .execute(pool)
    .await
    .unwrap();
    device
}

fn event(
    id: Uuid,
    name: &str,
    at: chrono::DateTime<Utc>,
    allow: bool,
    reason: &str,
    device: Option<Uuid>,
) -> Value {
    json!({
        "event_id": id,
        "observed_at": at,
        "device_id": device,
        "name": name,
        "query_type": "A",
        "protocol": "udp",
        "allow": allow,
        "reason_code": reason,
        "policy_revision": 1,
        "applied_rule": null,
        "upstream": "default",
        "cache_state": "miss",
        "flags": {"rd": true, "cd": false, "ra": true, "ad": false},
        "filter_blocked": false,
        "filter_source_id": null,
        "filter_source_kind": null,
        "denied_alias_target": null
    })
}

fn batch(batch_id: Uuid, hid: Uuid, gid: Uuid, events: Vec<Value>) -> Value {
    json!({
        "audience": "vantyr-gateway-worker",
        "command": "report_dns_events",
        "household_id": hid,
        "gateway_id": gid,
        "kind": "dns",
        "batch_id": batch_id,
        "events": events
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[sqlx::test]
async fn auth_and_tenant_separation(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let other_hid = Uuid::new_v4();
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let old_cred = issue_cred(&http, hid, gid, vec!["heartbeat"]).await;

    let body = batch(
        Uuid::new_v4(),
        hid,
        gid,
        vec![event(
            Uuid::new_v4(),
            "example.com",
            Utc::now(),
            true,
            "device_default",
            None,
        )],
    );

    // A cookie alone cannot authenticate a worker route.
    let (status, _) = http
        .worker("/worker/network/dns/events", None, body.clone())
        .await;
    assert_eq!(status, 401, "cookie-only worker call must be refused");
    // An old/default credential is not silently widened.
    let (status, _) = http
        .worker_paced("/worker/network/dns/events", &old_cred, body.clone())
        .await;
    assert_eq!(status, 401, "heartbeat-only credential must not ingest");
    // Foreign household / gateway in the body is refused.
    let foreign = batch(
        Uuid::new_v4(),
        other_hid,
        gid,
        vec![event(
            Uuid::new_v4(),
            "example.com",
            Utc::now(),
            true,
            "device_default",
            None,
        )],
    );
    let (status, _) = http
        .worker_paced("/worker/network/dns/events", &cred, foreign)
        .await;
    assert_eq!(status, 401);

    let (status, ingested) = http
        .worker_paced("/worker/network/dns/events", &cred, body.clone())
        .await;
    assert_eq!(status, 200, "ingest failed: {ingested}");
    assert_eq!(ingested["inserted"], 1);

    // A Bearer alone cannot authenticate an admin read route.
    let req = http
        .client
        .get(format!("{base}/api/network/households/{hid}/dns/events"))
        .header("authorization", cred.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(req.status().as_u16(), 401);

    let (status, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(status, 200, "admin read failed: {page}");
    assert_eq!(page["total"], 1);
    let row = &page["rows"][0];
    assert_eq!(row["domain"], "example.com");
    assert_eq!(row["source"], "dns");
    assert_eq!(row["effect"], "allow");
    assert_eq!(row["evidence"], "network_observation");
    assert!(row["person_label"].is_null());
    assert_eq!(page["retention"]["keep_days"], 7);
    assert_eq!(page["retention"]["cap_count"], 5000);
    assert_eq!(page["retention"]["stored_count"], 1);
    assert_eq!(page["unsupported_sources"], json!(["proxy", "agent"]));
    assert!(row.get("person_id").is_none());
    assert!(row.get("verified").is_none());
    assert!(row.get("enforced").is_none());
    assert!(row.get("url").is_none());

    // network_events alone can read; a foreign household cannot be probed.
    let reader = insert_user(&pool, "reader", "viewer").await;
    grant(&http, hid, reader, "network_events").await;
    let (rt, rc) = session_for(&pool, reader, "reader").await;
    let reader_http = Http::new(&base, rt, rc);
    let (status, _) = reader_http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(status, 200);
    let (status, _) = reader_http
        .get(&format!(
            "/api/network/households/{}/dns/events",
            Uuid::new_v4()
        ))
        .await;
    assert_eq!(status, 403);
    // Enroll-only / no grant cannot read.
    let outsider = insert_user(&pool, "outsider", "viewer").await;
    let (ot, oc) = session_for(&pool, outsider, "outsider").await;
    let outsider_http = Http::new(&base, ot, oc);
    let (status, _) = outsider_http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(status, 403);
}

#[sqlx::test]
async fn invalid_batches_are_rejected_without_writes(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let bearer = cred.clone();

    let now = Utc::now();
    let good = event(
        Uuid::new_v4(),
        "example.com",
        now,
        true,
        "device_default",
        None,
    );
    let cases: Vec<Value> = vec![
        {
            let mut e = good.clone();
            e["url"] = json!("https://evil.test");
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["name"] = json!("https://example.com/path?q=1");
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["query_type"] = json!("BOGUS");
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["protocol"] = json!("carrier-pigeon");
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["cache_state"] = json!("maybe");
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["observed_at"] = json!(now + ChronoDuration::hours(1));
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["observed_at"] = json!(now - ChronoDuration::days(31));
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut e = good.clone();
            e["device_id"] = json!(Uuid::new_v4());
            batch(Uuid::new_v4(), hid, gid, vec![e])
        },
        {
            let mut b = batch(Uuid::new_v4(), hid, gid, vec![good.clone()]);
            b["command"] = json!("heartbeat");
            b
        },
        {
            let mut b = batch(Uuid::new_v4(), hid, gid, vec![good.clone()]);
            b["audience"] = json!("dashboard");
            b
        },
        {
            let mut b = batch(Uuid::new_v4(), hid, gid, vec![good.clone()]);
            b["kind"] = json!("proxy");
            b
        },
        batch(Uuid::new_v4(), hid, gid, vec![]),
        batch(
            Uuid::new_v4(),
            hid,
            gid,
            (0..257).map(|_| good.clone()).collect(),
        ),
    ];

    for (i, case) in cases.into_iter().enumerate() {
        let (status, body) = http
            .worker_paced("/worker/network/dns/events", &bearer, case)
            .await;
        assert!(
            status == 400 || status == 401,
            "case {i} should be refused, got {status}: {body}"
        );
    }

    let (status, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(page["total"], 0, "invalid batches must not write rows");
}

#[sqlx::test]
async fn dedup_replay_and_concurrent_batches(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let bearer = cred.clone();
    let now = Utc::now();

    let batch_id = Uuid::new_v4();
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let first = batch(
        batch_id,
        hid,
        gid,
        ids.iter()
            .map(|id| event(*id, "a.example", now, true, "device_default", None))
            .collect(),
    );
    let (status, body) = http
        .worker_paced("/worker/network/dns/events", &bearer, first.clone())
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["inserted"], 3);

    // Exact replay: same outcome, no new rows.
    let (status, replay) = http
        .worker_paced("/worker/network/dns/events", &bearer, first.clone())
        .await;
    assert_eq!(status, 200);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["inserted"], 3);
    assert_eq!(replay["duplicates"], 0);
    let (_, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(page["total"], 3);

    // Same batch id, different bytes: conflict, still no new rows.
    let mut changed = first.clone();
    changed["events"][0]["name"] = json!("changed.example");
    let (status, _) = http
        .worker_paced("/worker/network/dns/events", &bearer, changed)
        .await;
    assert_eq!(status, 409);

    // Overlapping event ids in a new batch are deduplicated by event_id.
    let second = batch(
        Uuid::new_v4(),
        hid,
        gid,
        vec![
            event(ids[0], "a.example", now, true, "device_default", None),
            event(
                Uuid::new_v4(),
                "b.example",
                now,
                false,
                "safety_baseline",
                None,
            ),
        ],
    );
    let (status, body) = http
        .worker_paced("/worker/network/dns/events", &bearer, second)
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["inserted"], 1);
    assert_eq!(body["duplicates"], 1);
    let (_, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(page["total"], 4);

    // Concurrent distinct batches in one household both commit and remain
    // deduplicated (no lost writes, no double count).
    let mut handles = Vec::new();
    for i in 0..4 {
        let b = batch(
            Uuid::new_v4(),
            hid,
            gid,
            (0..5)
                .map(|j| {
                    let id = Uuid::new_v4();
                    event(
                        id,
                        &format!("c{i}-{j}.example"),
                        now,
                        true,
                        "household_default",
                        None,
                    )
                })
                .collect(),
        );
        let base = base.clone();
        let bearer = bearer.clone();
        handles.push(tokio::spawn(async move {
            let client = reqwest::Client::new();
            let response = client
                .post(format!("{base}/worker/network/dns/events"))
                .header("authorization", bearer)
                .header("content-type", "application/json")
                .json(&b)
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .unwrap();
            response.status().as_u16()
        }));
    }
    for handle in handles {
        let status = handle.await.unwrap();
        assert!(status == 200 || status == 429, "unexpected {status}");
    }
    let (_, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events"))
        .await;
    assert_eq!(page["total"], 24);
}

#[sqlx::test]
async fn search_filters_and_pagination(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let bearer = cred.clone();
    let device = device_in_household(&pool, hid).await;
    let now = Utc::now();

    let events = vec![
        event(
            Uuid::new_v4(),
            "alpha.example",
            now,
            true,
            "device_default",
            Some(device),
        ),
        event(
            Uuid::new_v4(),
            "alpha.other",
            now - ChronoDuration::minutes(30),
            false,
            "safety_baseline",
            Some(device),
        ),
        event(
            Uuid::new_v4(),
            "beta.example",
            now,
            true,
            "household_default",
            None,
        ),
        event(
            Uuid::new_v4(),
            "gamma.example",
            now - ChronoDuration::hours(2),
            false,
            "safety_baseline",
            None,
        ),
    ];
    let (status, _) = http
        .worker_paced(
            "/worker/network/dns/events",
            &bearer,
            batch(Uuid::new_v4(), hid, gid, events),
        )
        .await;
    assert_eq!(status, 200);

    let url = |q: &str| format!("/api/network/households/{hid}/dns/events?q={q}");
    // NOTE: query strings below are built explicitly (no generic `q=` helper).
    let (status, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?domain=alpha"
        ))
        .await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["total"], 2);

    let (_, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?reason=safety_baseline"
        ))
        .await;
    assert_eq!(page["total"], 2);

    let (_, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?allow=false"
        ))
        .await;
    assert_eq!(page["total"], 2);

    let (_, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?device_id={device}"
        ))
        .await;
    assert_eq!(page["total"], 2);

    let from = (now - ChronoDuration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (_, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?from={from}"
        ))
        .await;
    assert_eq!(page["total"], 3);

    let (_, page) = http
        .get(&format!("/api/network/households/{hid}/dns/events?limit=2"))
        .await;
    assert_eq!(page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(page["total"], 4);
    assert_eq!(page["has_more"], true);
    assert_eq!(page["next_offset"], 2);

    let (status, _) = http
        .get(&format!("/api/network/households/{hid}/dns/events?limit=0"))
        .await;
    assert_eq!(status, 400);
    let (status, _) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?surprise=1"
        ))
        .await;
    assert_eq!(status, 400);
    let (status, _) = http.get(&url("domain=example.com%2Fpath")).await;
    assert_eq!(status, 400);

    // Explicit source/decision filters; proxy/agent are refused, not silently
    // treated as supported ingestion.
    let (status, page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?source=dns&decision=deny"
        ))
        .await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["total"], 2);
    let (status, _) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?source=proxy"
        ))
        .await;
    assert_eq!(status, 400);
    let (status, _) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?source=dns&offset=1&cursor=abc"
        ))
        .await;
    assert_eq!(status, 400);

    // Keyset cursor walks the same bounded result set without offset.
    let (status, first_page) = http
        .get(&format!("/api/network/households/{hid}/dns/events?limit=2"))
        .await;
    assert_eq!(status, 200);
    let cursor = first_page["next_cursor"].as_str().unwrap().to_string();
    let (status, second_page) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/events?limit=2&cursor={cursor}"
        ))
        .await;
    assert_eq!(status, 200, "{second_page}");
    assert_eq!(second_page["rows"].as_array().unwrap().len(), 2);
    assert_eq!(second_page["has_more"], false);
    assert!(second_page["next"].is_null());
}

#[sqlx::test]
async fn stats_counts_are_from_observations_only(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let bearer = cred.clone();
    let device = device_in_household(&pool, hid).await;
    let now = Utc::now();

    let events = vec![
        event(
            Uuid::new_v4(),
            "a.example",
            now,
            true,
            "device_default",
            Some(device),
        ),
        event(
            Uuid::new_v4(),
            "a.example",
            now - ChronoDuration::minutes(10),
            false,
            "safety_baseline",
            Some(device),
        ),
        event(
            Uuid::new_v4(),
            "b.example",
            now - ChronoDuration::minutes(20),
            true,
            "household_default",
            None,
        ),
        event(
            Uuid::new_v4(),
            "c.example",
            now - ChronoDuration::hours(3),
            true,
            "device_default",
            None,
        ),
    ];
    let (status, _) = http
        .worker_paced(
            "/worker/network/dns/events",
            &bearer,
            batch(Uuid::new_v4(), hid, gid, events),
        )
        .await;
    assert_eq!(status, 200);

    let (status, stats) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=24h"
        ))
        .await;
    assert_eq!(status, 200, "{stats}");
    assert_eq!(stats["total_queries"], 4);
    assert_eq!(stats["allowed"], 3);
    assert_eq!(stats["blocked"], 1);
    assert_eq!(stats["observed_only"], true);
    let series_sum: i64 = stats["time_series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["count"].as_i64().unwrap())
        .sum();
    assert_eq!(series_sum, 4, "time series must reconcile with total");
    assert_eq!(stats["time_series"].as_array().unwrap().len(), 24);
    assert_eq!(stats["top_domains"][0]["name"], "a.example");
    assert_eq!(stats["top_domains"][0]["count"], 2);
    assert_eq!(stats["unknown_device_queries"], 2);
    assert_eq!(stats["top_devices"][0]["device_id"], device.to_string());
    assert_eq!(stats["top_devices"][0]["count"], 2);

    assert_eq!(stats["retention_days"], 7);
    assert_eq!(stats["cap_count"], 5000);
    assert_eq!(stats["stored_count"], 4);
    let window_start: chrono::DateTime<Utc> =
        stats["window_start"].as_str().unwrap().parse().unwrap();
    let delta = now - window_start;
    assert!(
        delta >= ChronoDuration::hours(24) - ChronoDuration::seconds(60)
            && delta <= ChronoDuration::hours(24) + ChronoDuration::seconds(60)
    );
    assert_eq!(stats["unsupported_sources"], json!(["proxy", "agent"]));
    assert_eq!(stats["top_blocked"][0]["name"], "a.example");
    assert_eq!(stats["top_blocked"][0]["count"], 1);
    assert_eq!(
        stats["shortened"], true,
        "last observation precedes the window end"
    );

    let (_, hour) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=1h"
        ))
        .await;
    assert_eq!(hour["total_queries"], 3);
    assert_eq!(hour["time_series"].as_array().unwrap().len(), 12);

    let (_, month) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=30d"
        ))
        .await;
    assert_eq!(month["total_queries"], 4);
    assert_eq!(month["time_series"].as_array().unwrap().len(), 30);

    let (_, per_device) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=24h&device_id={device}"
        ))
        .await;
    assert_eq!(per_device["total_queries"], 2);
    assert_eq!(per_device["device_id"], device.to_string());

    let (status, _) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?window=90d"
        ))
        .await;
    assert_eq!(status, 400);
    let (status, _) = http
        .get(&format!(
            "/api/network/households/{hid}/dns/stats?device_id={}",
            Uuid::new_v4()
        ))
        .await;
    assert_eq!(status, 400);
}

#[sqlx::test]
async fn retention_prunes_idle_households_by_age_and_count(pool: PgPool) {
    let (base, _task) = spawn_router(pool.clone()).await;
    let admin = insert_user(&pool, "admin", "admin").await;
    let (token, csrf) = session_for(&pool, admin, "admin").await;
    let http = Http::new(&base, token, csrf);
    let hid = bootstrap_as(&http, "Home").await;
    let gid = create_gateway(&http, hid, "dns").await;
    let cred = issue_cred(&http, hid, gid, vec!["report_dns_events"]).await;
    let bearer = cred.clone();
    let now = Utc::now();

    // Direct SQL insert models genuinely old rows that ingestion would refuse.
    for i in 0..6 {
        let at = if i < 3 {
            now - ChronoDuration::days(40)
        } else {
            now - ChronoDuration::minutes(i)
        };
        sqlx::query(
            r"INSERT INTO network_dns_events
              (household_id, gateway_id, event_id, observed_at, name, query_type,
               protocol, allow, reason_code, cache_state)
              VALUES ($1, $2, $3, $4, 'old.example', 'A', 'udp', true, 'device_default', 'miss')",
        )
        .bind(hid)
        .bind(gid)
        .bind(Uuid::new_v4())
        .bind(at)
        .execute(&pool)
        .await
        .unwrap();
    }

    // The production retention helper (called at startup and each tick)
    // prunes the idle household's expired rows even with no further ingest.
    let removed = crate::network::prune_dns_events(&pool).await.unwrap();
    assert_eq!(removed, 3);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM network_dns_events WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 3);

    // Count cap is enforced by the same sweep with a bounded cap argument.
    let capped = super::dns_events_db::prune_all_events(&pool, now - ChronoDuration::days(30), 1)
        .await
        .unwrap();
    assert_eq!(capped, 2);
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM network_dns_events WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 1);

    // A further live ingest still works after pruning and its receipt table
    // remains bounded by the production sweep.
    let (status, body) = http
        .worker_paced(
            "/worker/network/dns/events",
            &bearer,
            batch(
                Uuid::new_v4(),
                hid,
                gid,
                vec![event(
                    Uuid::new_v4(),
                    "live.example",
                    now,
                    true,
                    "device_default",
                    None,
                )],
            ),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let batches: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::bigint FROM network_dns_event_batches WHERE household_id = $1",
    )
    .bind(hid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(batches, 1);
}
