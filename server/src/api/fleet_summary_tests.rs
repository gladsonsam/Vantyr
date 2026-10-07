use super::*;
use axum::body::to_bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

#[test]
fn validates_and_deduplicates_bounded_ids() {
    let id = Uuid::new_v4();
    assert_eq!(parse_ids(&format!("{id},{id}")).unwrap(), vec![id]);
    for invalid in [
        "".to_owned(),
        "nope".into(),
        format!("{id},"),
        format!(",{id}"),
        "x".repeat(8193),
    ] {
        assert!(parse_ids(&invalid).is_err());
    }
    let ids: Vec<_> = (0..101).map(|_| Uuid::new_v4().to_string()).collect();
    assert_eq!(parse_ids(&ids[..100].join(",")).unwrap().len(), 100);
    assert!(parse_ids(&ids.join(",")).is_err());
}

#[test]
fn sanitizes_nested_config_and_url_credentials() {
    let raw = json!({"hostname":"device", "cpu_brand":{"token":"secret"}, "config":{"api_token":"secret"},
        "api_token":"secret", "config_server_url":"wss://user:secret@example.com/ws/agent?token=secret#secret",
        "capabilities":{"remote_input":"available", "token":"secret"},
        "adapters":[{"name":"eth0", "dns":["1.1.1.1", {"token":"secret"}], "password":"secret"}],
        "drives":[{"mount_point":"/", "config":{"password":"secret"}}]});
    let clean = db::sanitize_fleet_info(&raw).unwrap();
    assert_eq!(clean["config_server_url"], "wss://example.com/ws/agent");
    assert_eq!(clean["capabilities"]["remote_input"], "available");
    assert_eq!(clean["adapters"][0]["dns"], json!(["1.1.1.1"]));
    assert!(!clean.to_string().contains("secret"));
    assert!(db::sanitize_fleet_info(&json!([1])).is_none());
}

#[test]
fn wrong_scalar_types_are_dropped_and_valid_nullable_types_preserved() {
    let malformed = json!({
        "hostname": 123, "config_agent_name": 456, "uptime_secs": "7",
        "cpu_cores": true, "config_ui_password_set": "false", "machine_connection_policy": 1,
        "current_user": null, "config_server_url": 123,
        "os_version": null, "install_path": null, "memory_used_mb": 512.5,
        "capabilities": {"remote_input": true, "screen_capture": 123, "platform": "linux"},
        "monitors": [{"index": "0", "width": "1920", "primary": "true", "name": 42,
            "geometry_available": 1, "x": null, "physical_width": null, "height": 1080}],
        "drives": [{"name": false, "total_gb": "12", "available_gb": 8}],
        "adapters": [{"name": 0, "description": "Ethernet", "mac": false,
            "ips": [12, false, null, "127.0.0.1"], "dns": "1.1.1.1", "gateways": ["192.168.1.1"]}],
        "config": {"token": "secret"}
    });
    let clean = db::sanitize_fleet_info(&malformed).unwrap();
    assert_eq!(
        clean,
        json!({
            "os_version": null, "install_path": null, "memory_used_mb": 512.5,
            "capabilities": {"platform": "linux"},
            "monitors": [{"x": null, "physical_width": null, "height": 1080}],
            "drives": [{"available_gb": 8}],
            "adapters": [{"description": "Ethernet", "ips": ["127.0.0.1"], "gateways": ["192.168.1.1"]}]
        })
    );
    let valid = json!({"hostname": "host", "config_agent_name": "agent", "uptime_secs": 7,
        "config_ui_password_set": false, "monitors": [{"index": 0, "primary": true}]});
    assert_eq!(db::sanitize_fleet_info(&valid), Some(valid));
}

async fn fixture() -> Arc<AppState> {
    let (s, _, _) = crate::state::agent_lifecycle::test_support::state()
        .await
        .unwrap();
    sqlx::raw_sql(r"
        CREATE TEMP TABLE agent_info (agent_id UUID PRIMARY KEY, info JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
        CREATE TEMP TABLE window_events (id BIGSERIAL PRIMARY KEY, agent_id UUID NOT NULL, app TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', ts TIMESTAMPTZ NOT NULL);
        CREATE INDEX idx_window_events_agent_ts ON window_events (agent_id, ts DESC);
        CREATE TEMP TABLE agent_group_members (group_id UUID, agent_id UUID, PRIMARY KEY (group_id, agent_id));
        CREATE INDEX ON agent_group_members (agent_id);
        CREATE TEMP TABLE app_block_rules (id SERIAL PRIMARY KEY, name TEXT NOT NULL DEFAULT '', exe_pattern TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT TRUE);
        CREATE TEMP TABLE app_block_rule_scopes (rule_id INT, scope_kind TEXT, agent_id UUID, group_id UUID);
        CREATE INDEX ON app_block_rule_scopes (rule_id);
        CREATE TEMP TABLE app_block_rule_schedules (rule_id INT);
        CREATE TEMP TABLE internet_block_rules (id BIGSERIAL PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE);
        CREATE TEMP TABLE internet_block_rule_scopes (rule_id BIGINT, scope_kind TEXT, agent_id UUID, group_id UUID);
        CREATE INDEX ON internet_block_rule_scopes (rule_id);
        CREATE TEMP TABLE internet_block_rule_schedules (rule_id BIGINT);
        CREATE INDEX ON internet_block_rule_schedules (rule_id);
    ").execute(&s.db).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../migrations/0070_fleet_latest_window.sql"
    ))
    .execute(&s.db)
    .await
    .unwrap();
    s
}

async fn add_agent(s: &AppState, name: &str) -> Uuid {
    sqlx::query_scalar("INSERT INTO agents (name) VALUES ($1) RETURNING id")
        .bind(name)
        .fetch_one(&s.db)
        .await
        .unwrap()
}

async fn body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn get(s: Arc<AppState>, ids: &[Uuid]) -> (StatusCode, Value) {
    body(
        fleet_summary(
            Query(FleetSummaryQuery {
                ids: ids
                    .iter()
                    .map(Uuid::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            }),
            State(s),
            Extension(crate::state::agent_lifecycle::test_support::admin()),
            HeaderMap::new(),
            None,
        )
        .await
        .into_response(),
    )
    .await
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; isolated PostgreSQL temporary tables"]
async fn handler_multiple_devices_missing_and_deterministic_latest_window() {
    let s = fixture().await;
    let a = add_agent(&s, "a").await;
    let b = add_agent(&s, "b").await;
    let unrelated = add_agent(&s, "unrequested").await;
    let missing = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_info VALUES ($1, $2, '2026-01-01T00:00:00Z')")
        .bind(a)
        .bind(json!({"hostname":123, "config_agent_name":456, "uptime_secs":"7", "config_ui_password_set":"false", "api_token":"secret", "monitors":[{"index":"0","primary":"true"}]}))
        .execute(&s.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO window_events(agent_id,app,title,ts) VALUES ($1,'older','old','2026-01-01'),($1,'first-tie','first','2026-01-02'),($1,'last-tie','last','2026-01-02'),($2,'private','unrequested','2026-01-03')")
        .bind(a).bind(unrelated).execute(&s.db).await.unwrap();
    let (status, result) = get(s.clone(), &[b, a, missing, a]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["agents"].as_object().unwrap().len(), 2);
    assert_eq!(result["missing"], json!([missing]));
    let ra = &result["agents"][a.to_string()];
    assert_eq!(ra["last_window"]["app"], "last-tie");
    assert_eq!(ra["last_window"]["title"], "last");
    assert_eq!(ra["last_window"]["reported_at"], "2026-01-02T00:00:00Z");
    assert_eq!(ra["info_reported_at"], "2026-01-01T00:00:00Z");
    for key in [
        "hostname",
        "config_agent_name",
        "uptime_secs",
        "config_ui_password_set",
    ] {
        assert!(ra["info"].get(key).is_none());
    }
    assert_eq!(ra["info"]["monitors"], json!([{}]));
    assert!(ra["info"].get("api_token").is_none());
    let rb = &result["agents"][b.to_string()];
    assert!(
        rb["info"].is_null() && rb["info_reported_at"].is_null() && rb["last_window"].is_null()
    );
    assert_eq!(rb["internet_blocked"], false);
    assert_eq!(rb["app_block_enabled_count"], 0);
    assert!(result["agents"].get(unrelated.to_string()).is_none());
    let audit_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&s.db)
        .await
        .unwrap();
    assert_eq!(audit_count, 0);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; isolated PostgreSQL temporary tables"]
async fn policy_overlap_disabled_schedules_and_source_priority() {
    let s = fixture().await;
    let a = add_agent(&s, "a").await;
    let b = add_agent(&s, "b").await;
    let c = add_agent(&s, "c").await;
    let group = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_group_members VALUES ($1,$2),($1,$3)")
        .bind(group)
        .bind(a)
        .bind(b)
        .execute(&s.db)
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO app_block_rule_schedules VALUES (5); INSERT INTO app_block_rules(id, enabled) VALUES (1,true),(2,true),(3,true),(4,false),(5,true); INSERT INTO app_block_rule_scopes(rule_id,scope_kind) VALUES (1,'all'),(4,'all'); INSERT INTO internet_block_rules(id,enabled) VALUES (1,true),(2,true),(3,true),(4,false),(5,true); INSERT INTO internet_block_rule_scopes(rule_id,scope_kind) VALUES (4,'all'),(5,'all'); INSERT INTO internet_block_rule_schedules VALUES (5);").execute(&s.db).await.unwrap();
    sqlx::query("INSERT INTO app_block_rule_scopes(rule_id,scope_kind,agent_id,group_id) VALUES (1,'agent',$1,NULL),(1,'group',NULL,$2),(2,'group',NULL,$2),(3,'agent',$1,NULL),(5,'agent',$3,NULL)")
        .bind(a).bind(group).bind(c).execute(&s.db).await.unwrap();
    sqlx::query(
        "INSERT INTO internet_block_rule_scopes VALUES (1,'agent',$1,NULL),(2,'group',NULL,$2)",
    )
    .bind(a)
    .bind(group)
    .execute(&s.db)
    .await
    .unwrap();
    let (_, r) = get(s.clone(), &[a, b, c]).await;
    assert_eq!(r["agents"][a.to_string()]["app_block_enabled_count"], 3);
    assert_eq!(r["agents"][b.to_string()]["app_block_enabled_count"], 2);
    assert_eq!(r["agents"][c.to_string()]["app_block_enabled_count"], 2);
    assert_eq!(r["agents"][a.to_string()]["internet_block_source"], "group");
    assert_eq!(r["agents"][b.to_string()]["internet_block_source"], "group");
    assert_eq!(r["agents"][c.to_string()]["internet_blocked"], false); // scheduled-only is not always-on
    sqlx::raw_sql("INSERT INTO internet_block_rule_scopes(rule_id,scope_kind) VALUES (3,'all')")
        .execute(&s.db)
        .await
        .unwrap();
    let (_, r) = get(s.clone(), &[a, b, c]).await;
    for id in [a, b, c] {
        assert_eq!(r["agents"][id.to_string()]["internet_block_source"], "all");
    }
    sqlx::raw_sql("DELETE FROM internet_block_rule_scopes WHERE rule_id IN (2,3)")
        .execute(&s.db)
        .await
        .unwrap();
    let (_, r) = get(s.clone(), &[a, b, c]).await;
    assert_eq!(r["agents"][a.to_string()]["internet_block_source"], "agent");
    assert_eq!(r["agents"][b.to_string()]["internet_blocked"], false);
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; isolated PostgreSQL temporary tables"]
async fn handler_errors_do_not_fabricate_healthy_results() {
    let s = fixture().await;
    let a = add_agent(&s, "a").await;
    sqlx::raw_sql(
        "ALTER TABLE pg_temp.internet_block_rule_schedules RENAME COLUMN rule_id TO unavailable",
    )
    .execute(&s.db)
    .await
    .unwrap();
    let (status, result) = get(s.clone(), &[a]).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(result.get("agents").is_none());
    let (status, _) = body(
        fleet_summary(
            Query(FleetSummaryQuery { ids: "bad".into() }),
            State(s),
            Extension(crate::state::agent_lifecycle::test_support::admin()),
            HeaderMap::new(),
            None,
        )
        .await
        .into_response(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST); // validation happens before database access
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; isolated PostgreSQL temporary tables"]
async fn latest_window_plan_uses_bounded_index_probes() {
    use sqlx::Row;
    let s = fixture().await;
    let a = add_agent(&s, "a").await;
    let other = add_agent(&s, "other").await;
    sqlx::query("INSERT INTO window_events(agent_id,ts) SELECT $1,'2026-01-01'::timestamptz FROM generate_series(1,20000) UNION ALL SELECT $2,'2026-01-01'::timestamptz FROM generate_series(1,20000)")
        .bind(a).bind(other).execute(&s.db).await.unwrap();
    sqlx::raw_sql("ANALYZE window_events")
        .execute(&s.db)
        .await
        .unwrap();
    let plan = sqlx::query(&format!(
        "EXPLAIN (ANALYZE, BUFFERS) {}",
        db::FLEET_SUMMARY_SQL
    ))
    .bind(vec![a])
    .fetch_all(&s.db)
    .await
    .unwrap();
    let plan = plan
        .iter()
        .map(|r| r.get::<String, _>(0))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(plan.contains("idx_window_events_agent_ts_id"), "{plan}");
    assert!(!plan.contains("Seq Scan on window_events"), "{plan}");
    assert!(plan.contains("Limit  ("), "{plan}");
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; isolated PostgreSQL temporary tables"]
async fn authenticated_route_preserves_read_roles_and_validation() {
    let s = fixture().await;
    let a = add_agent(&s, "a").await;
    sqlx::raw_sql(r"
        CREATE TEMP TABLE dashboard_users(id UUID PRIMARY KEY, username TEXT, role TEXT, display_name TEXT, display_icon TEXT);
        CREATE TEMP TABLE dashboard_sessions(user_id UUID, token_sha256_hex TEXT, expires_at TIMESTAMPTZ, csrf_token TEXT, last_seen_at TIMESTAMPTZ);
    ").execute(&s.db).await.unwrap();
    for role in ["admin", "operator", "viewer"] {
        let user = Uuid::new_v4();
        sqlx::query("INSERT INTO dashboard_users VALUES ($1,$2,$2,$2,NULL)")
            .bind(user)
            .bind(role)
            .execute(&s.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO dashboard_sessions VALUES ($1,$2,NOW()+INTERVAL '1 hour','csrf',NOW())",
        )
        .bind(user)
        .bind(db::sha256_hex_bytes(role.as_bytes()))
        .execute(&s.db)
        .await
        .unwrap();
    }
    let app = crate::app::api_routes()
        .route_layer(axum::middleware::from_fn_with_state(
            s.clone(),
            crate::auth::require_auth,
        ))
        .with_state(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();
    let url = format!("{base}/agents/fleet-summary?ids={a}");
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    for role in ["admin", "operator", "viewer"] {
        let response = client
            .get(&url)
            .header("Cookie", format!("session={role}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert!(body["agents"].get(a.to_string()).is_some());
    }
    let mut hundred = vec![a];
    hundred.extend((0..99).map(|_| Uuid::new_v4()));
    let query = hundred
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let response = client
        .get(format!("{base}/agents/fleet-summary?ids={query},{a}"))
        .header("Cookie", "session=viewer")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["agents"].as_object().unwrap().len(), 1);
    assert_eq!(body["missing"].as_array().unwrap().len(), 99);
    for suffix in ["", "?ids=invalid", "?ids=", "?ids=,", "?ids=%20"] {
        let response = client
            .get(format!("{base}/agents/fleet-summary{suffix}"))
            .header("Cookie", "session=viewer")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let too_many = (0..101)
        .map(|_| Uuid::new_v4().to_string())
        .collect::<Vec<_>>()
        .join(",");
    assert_eq!(
        client
            .get(format!("{base}/agents/fleet-summary?ids={too_many}"))
            .header("Cookie", "session=viewer")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .post(&url)
            .header("Cookie", "session=admin")
            .header("x-csrf-token", "csrf")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    task.abort();
}
