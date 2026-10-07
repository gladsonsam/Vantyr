use super::*;
use crate::agents::modules::db;
use crate::state::{AgentConn, AgentControl, Settings};
use crate::test_support::control::module_report;
use axum::response::IntoResponse;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::sync::Arc;

fn value(report: &ModuleReport) -> serde_json::Value {
    serde_json::to_value(report).unwrap()
}
fn state() -> Arc<AppState> {
    Arc::new(AppState::new(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://fixture:fixture@localhost/fixture")
            .unwrap(),
        Settings {
            allow_remote_script: true,
            ..Settings::for_tests()
        },
        None,
        crate::notify::NotifyHub::new(vec![]),
    ))
}
fn connect(state: &AppState, id: Uuid) -> (Uuid, tokio::sync::mpsc::Receiver<AgentControl>) {
    let conn = Uuid::new_v4();
    let (shutdown, _) = tokio::sync::watch::channel(None);
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    state.agents.connections.lock().insert(
        id,
        AgentConn {
            conn_id: conn,
            connected_at: chrono::Utc::now(),
            session_id: 1,
            shutdown,
            legacy_policy_delivery: false,
        },
    );
    state.agents.cmds.lock().insert(id, tx);
    state.agents.modules.lock().remove(&id);
    (conn, rx)
}
fn install(state: &AppState, id: Uuid, conn: Uuid, report: ModuleReport) {
    state.agents.modules.lock().insert(
        id,
        RuntimeModules {
            conn_id: conn,
            report,
            pending: HashMap::new(),
            sent: HashSet::new(),
            last_sent: HashMap::new(),
        },
    );
}
#[test]
fn schema_requires_complete_unique_known_unsigned_grants() {
    let valid = value(&module_report(u64::MAX, true));
    assert!(ModuleReport::parse(valid.clone()).is_ok());
    for mutate in 0..7 {
        let mut v = valid.clone();
        match mutate {
            0 => {
                v["modules"].as_array_mut().unwrap().pop();
            }
            1 => v["modules"][1] = v["modules"][0].clone(),
            2 => v["modules"][0]["module"] = "unknown".into(),
            3 => v["revision"] = (-1).into(),
            4 => v["schema_version"] = 2.into(),
            5 => v["modules"][0]["authorization_required"] = true.into(),
            _ => v["modules"][0]["available"] = false.into(),
        };
        assert!(ModuleReport::parse(v).is_err(), "case {mutate}");
    }
}
#[test]
fn revisions_cannot_move_back_or_change_permission_without_revision() {
    let old = module_report(5, true);
    let mut new = old.clone();
    new.revision = 6;
    new.modules[0].revision = 4;
    assert!(!new.follows(&old));
    new.modules[0].revision = 5;
    new.modules[0].enabled = false;
    new.modules[0].authorization_required = true;
    assert!(!new.follows(&old));
    new.modules[0].revision = 6;
    assert!(new.follows(&old));
    new.revision = 5;
    assert!(!new.follows(&old));
}
#[tokio::test]
async fn all_command_families_fail_closed_and_queue_generations_cannot_resurrect() {
    let state = state();
    let id = Uuid::new_v4();
    let (conn, mut rx) = connect(&state, id);
    let commands = [
        "start_capture",
        "start_audio",
        "MouseMove",
        "TypeText",
        "Notify",
        "TerminalStart",
        "TerminalInput",
        "RunScript",
        "ListDir",
        "ReadFile",
        "WriteFileChunk",
        "CollectSoftware",
        "RequestInfo",
        "ShutdownHost",
        "set_app_block_rules",
        "set_network_policy",
        "set_internet_block_rules",
        "ListLogSources",
        "ReadLogTail",
    ];
    for kind in commands {
        assert_eq!(
            state
                .agents
                .authorize_agent_command(id, &serde_json::json!({"type":kind}))
                .unwrap_err()
                .code,
            "module_report_required"
        );
    }
    install(&state, id, conn, module_report(1, true));
    for kind in commands {
        let cmd = serde_json::json!({"type":kind});
        assert!(state
            .agents
            .authorize_agent_command(id, &cmd)
            .unwrap()
            .get("__module_generation")
            .is_some());
    }
    for kind in ["enable_module", "set_local_ui_password_hash", "unknown"] {
        assert!(state
            .agents
            .authorize_agent_command(id, &serde_json::json!({"type":kind}))
            .is_err());
    }
    state
        .agents
        .send_agent_command_json(id, &serde_json::json!({"type":"RunScript"}))
        .unwrap();
    let Some(AgentControl::Text(cmd)) = rx.recv().await else {
        panic!()
    };
    let cmd = serde_json::from_str(&cmd).unwrap();
    assert!(state.command_deliverable(id, conn, &cmd));
    install(&state, id, conn, module_report(2, false));
    assert!(!state.command_deliverable(id, conn, &cmd));
    install(&state, id, conn, module_report(3, true));
    assert!(!state.command_deliverable(id, conn, &cmd));
    let (new_conn, _) = connect(&state, id);
    assert!(!state.command_deliverable(id, new_conn, &cmd));
    assert!(!state.agents.module_authorized(id, Module::Scripts));
    install(&state, id, conn, module_report(1, true));
    assert_eq!(
        state
            .agents
            .authorize_agent_command(id, &serde_json::json!({"type":"RunScript"}))
            .unwrap_err()
            .code,
        "module_report_required"
    );
}
#[tokio::test]
async fn legacy_devices_keep_policy_pushes_but_reporting_devices_enforce_grants() {
    let state = state();
    let id = Uuid::new_v4();
    let (conn, mut rx) = connect(&state, id);
    let policies = [
        "set_app_block_rules",
        "set_network_policy",
        "set_internet_block_rules",
    ];
    // A device with a persisted report history never gets the legacy path.
    for kind in policies {
        assert_eq!(
            state
                .agents
                .send_agent_command_json(id, &serde_json::json!({"type":kind}))
                .unwrap_err()
                .code,
            "module_report_required"
        );
    }
    state
        .agents
        .connections
        .lock()
        .get_mut(&id)
        .unwrap()
        .legacy_policy_delivery = true;
    for kind in policies {
        state
            .agents
            .send_agent_command_json(id, &serde_json::json!({"type":kind}))
            .unwrap();
        let Some(AgentControl::Text(cmd)) = rx.recv().await else {
            panic!()
        };
        let cmd: serde_json::Value = serde_json::from_str(&cmd).unwrap();
        assert!(cmd.get("__module_generation").is_none());
        assert!(state.command_deliverable(id, conn, &cmd));
    }
    // Only policy pushes are grandfathered; other modules still need a report.
    for kind in ["RunScript", "start_audio", "ReadFile"] {
        assert_eq!(
            state
                .agents
                .authorize_agent_command(id, &serde_json::json!({"type":kind}))
                .unwrap_err()
                .code,
            "module_report_required"
        );
    }
    // Once the device reports on this connection, its grants are authoritative.
    install(&state, id, conn, module_report(1, false));
    for kind in policies {
        assert_eq!(
            state
                .agents
                .authorize_agent_command(id, &serde_json::json!({"type":kind}))
                .unwrap_err()
                .code,
            "module_not_authorized"
        );
    }
}
async fn fixture(
    db: PgPool,
) -> anyhow::Result<(
    Arc<AppState>,
    Uuid,
    Uuid,
    tokio::sync::mpsc::Receiver<AgentControl>,
)> {
    let (state, id, _) = crate::test_support::state(db).await?;
    let (conn, rx) = connect(&state, id);
    Ok((state, id, conn, rx))
}
#[sqlx::test]
async fn durable_binding_unsigned_revision_and_one_pending_per_module(
    db: PgPool,
) -> anyhow::Result<()> {
    let (s, id, _, _) = fixture(db).await?;
    let command = Uuid::new_v4();
    let req = db::create_module_disable(&s.db, id, Module::Logs, u64::MAX, command)
        .await?
        .unwrap();
    assert_eq!(req.expected_revision, u64::MAX);
    assert_eq!(req.stop_status, "unconfirmed");
    assert!(!req.stopped && !req.persisted && req.pending);
    assert!(
        db::create_module_disable(&s.db, id, Module::Logs, u64::MAX, command)
            .await?
            .is_some()
    );
    assert!(
        db::create_module_disable(&s.db, id, Module::Logs, 1, command)
            .await?
            .is_none()
    );
    assert!(
        db::create_module_disable(&s.db, id, Module::Scripts, u64::MAX, command)
            .await?
            .is_none()
    );
    assert!(
        db::create_module_disable(&s.db, id, Module::Logs, 1, Uuid::new_v4())
            .await?
            .is_none()
    );
    let other: Uuid = sqlx::query_scalar("INSERT INTO agents(name) VALUES('other') RETURNING id")
        .fetch_one(&s.db)
        .await?;
    assert!(
        db::create_module_disable(&s.db, other, Module::Logs, u64::MAX, command)
            .await?
            .is_none()
    );
    db::acknowledge_module_disable(
        &s.db,
        id,
        command,
        "stale",
        Some("revision changed"),
        "unconfirmed",
    )
    .await?;
    let req = db::module_disable_request(&s.db, id, command)
        .await?
        .unwrap();
    assert!(!req.pending && !req.persisted && !req.stopped);
    assert_eq!(req.error.as_deref(), Some("revision changed"));
    assert!(
        db::create_module_disable(&s.db, id, Module::Logs, 2, Uuid::new_v4())
            .await?
            .is_some()
    );
    Ok(())
}
#[sqlx::test]
async fn offline_queue_replays_once_per_connection_and_ack_is_correlated(
    db: PgPool,
) -> anyhow::Result<()> {
    let (s, id, conn, mut rx) = fixture(db).await?;
    let command = Uuid::new_v4();
    db::create_module_disable(&s.db, id, Module::Scripts, 1, command).await?;
    s.test_accept_report(id, conn, value(&module_report(1, true)))
        .await?;
    let first = rx.recv().await.unwrap();
    assert!(matches!(first,AgentControl::Text(ref v) if v.contains(&command.to_string())));
    assert!(!s.agents.module_authorized(id, Module::Scripts));
    s.test_accept_report(id, conn, value(&module_report(1, true)))
        .await?;
    assert!(rx.try_recv().is_err());
    let ack = serde_json::json!({"type":"module_disable_ack","command_id":command,"module":"scripts","ok":true,"status":"disabled","persisted":true,"stopped":false,"stop_status":"local_barrier_timeout","state":module_report(2,false)});
    let mut wrong = ack.clone();
    wrong["module"] = "logs".into();
    assert!(s.test_accept_ack(id, conn, wrong).await.is_err());
    let mut wrong = ack.clone();
    wrong["persisted"] = false.into();
    assert!(s.test_accept_ack(id, conn, wrong).await.is_err());
    let mut wrong = ack.clone();
    wrong["state"] = value(&module_report(1, false));
    assert!(s.test_accept_ack(id, conn, wrong).await.is_err());
    assert!(
        db::module_disable_request(&s.db, id, command)
            .await?
            .unwrap()
            .pending
    );
    let (new_conn, mut rx) = connect(&s, id);
    assert!(!s.agents.module_authorized(id, Module::Scripts));
    assert!(s
        .test_accept_report(id, conn, value(&module_report(3, true)))
        .await
        .is_err());
    assert!(s.test_accept_ack(id, conn, ack.clone()).await.is_err());
    s.test_accept_report(id, new_conn, value(&module_report(1, true)))
        .await?;
    assert!(
        matches!(rx.recv().await,Some(AgentControl::Text(v)) if v.contains(&command.to_string()))
    );
    s.test_accept_ack(id, new_conn, ack).await?;
    let req = db::module_disable_request(&s.db, id, command)
        .await?
        .unwrap();
    assert!(req.persisted && !req.pending && !req.stopped);
    assert_eq!(req.stop_status, "local_barrier_timeout");
    assert_eq!(req.status, "disabled");
    assert_eq!(db::module_report(&s.db, id).await?.unwrap().0.revision, 2);
    assert!(s
        .test_accept_report(id, new_conn, value(&module_report(1, true)))
        .await
        .is_err());
    Ok(())
}

#[sqlx::test]
async fn disable_rest_serializes_with_ingestion_and_queues_offline_idempotently(
    db: PgPool,
) -> anyhow::Result<()> {
    use axum::{
        extract::{ConnectInfo, Extension, Path, State},
        http::{HeaderMap, StatusCode},
        Json,
    };
    let (s, id, conn, _) = fixture(db).await?;
    s.test_accept_report(id, conn, value(&module_report(1, true)))
        .await?;
    s.agents.connections.lock().remove(&id);
    s.agents.modules.lock().remove(&id);
    let gate = s.agents.lifecycle.for_agent(id).read_owned().await;
    let command = Uuid::new_v4();
    let actor = crate::test_support::admin();
    let call = |s: Arc<AppState>, command| {
        let actor = actor.clone();
        async move {
            crate::agents::modules::api::disable_module(
                Path(id),
                State(s),
                Extension(actor),
                HeaderMap::new(),
                ConnectInfo("127.0.0.1:9000".parse().unwrap()),
                Json(crate::agents::modules::api::DisableBody {
                    module: Module::Scripts,
                    expected_revision: 1,
                    command_id: command,
                }),
            )
            .await
            .into_response()
        }
    };
    let mut first = tokio::spawn(call(s.clone(), command));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(30), &mut first)
            .await
            .is_err()
    );
    assert!(db::module_disable_request(&s.db, id, command)
        .await?
        .is_none());
    drop(gate);
    assert_eq!(first.await?.status(), StatusCode::ACCEPTED);
    let req = db::module_disable_request(&s.db, id, command)
        .await?
        .unwrap();
    assert_eq!(req.status, "queued");
    assert!(req.pending && !req.persisted);
    assert_eq!(
        call(s.clone(), command).await.status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(
        call(s.clone(), Uuid::new_v4()).await.status(),
        StatusCode::CONFLICT
    );
    let response =
        crate::agents::modules::api::get_modules(Path(id), State(s.clone()), Extension(actor))
            .await
            .into_response();
    let body = axum::body::to_bytes(response.into_body(), 100000).await?;
    let body: serde_json::Value = serde_json::from_slice(&body)?;
    assert_eq!(body["online"], false);
    assert_eq!(body["authorization_current"], false);
    assert!(body["reported_at"].is_string());
    assert_eq!(body["pending"][0]["command_id"], command.to_string());
    assert_eq!(body["pending"][0]["stop_status"], "unconfirmed");
    Ok(())
}

#[sqlx::test]
async fn negative_acks_are_visible_and_never_claim_persistence_or_physical_stop(
    db: PgPool,
) -> anyhow::Result<()> {
    for status in ["stale", "conflict", "error"] {
        crate::test_support::delete_agents(&db).await?;
        let (s, id, conn, mut rx) = fixture(db.clone()).await?;
        let command = Uuid::new_v4();
        db::create_module_disable(&s.db, id, Module::Logs, 1, command).await?;
        s.test_accept_report(id, conn, value(&module_report(1, true)))
            .await?;
        rx.recv().await.unwrap();
        let mut ack = serde_json::json!({"type":"module_disable_ack","module":"logs","command_id":command,"ok":false,"status":status,"error":"action rejected"});
        if status != "error" {
            ack["state"] = value(&module_report(if status == "stale" { 2 } else { 1 }, true));
        }
        s.test_accept_ack(id, conn, ack).await?;
        let req = db::module_disable_request(&s.db, id, command)
            .await?
            .unwrap();
        assert_eq!(req.status, status);
        assert_eq!(req.error.as_deref(), Some("action rejected"));
        assert!(!req.pending && !req.persisted && !req.stopped);
        assert!(s.agents.module_authorized(id, Module::Logs));
    }
    Ok(())
}

impl AppState {
    async fn test_accept_report(
        &self,
        id: Uuid,
        conn: Uuid,
        value: serde_json::Value,
    ) -> anyhow::Result<()> {
        let lease = Arc::new(self.agents.lifecycle.for_agent(id).read_owned().await);
        self.accept_module_report(id, conn, value, &lease).await
    }
    async fn test_accept_ack(
        &self,
        id: Uuid,
        conn: Uuid,
        value: serde_json::Value,
    ) -> anyhow::Result<()> {
        let lease = Arc::new(self.agents.lifecycle.for_agent(id).read_owned().await);
        self.accept_module_disable_ack(id, conn, value, &lease)
            .await
    }
}

#[sqlx::test]
async fn explicit_retry_has_cooldown_exact_binding_and_resets_on_reconnect(
    db: PgPool,
) -> anyhow::Result<()> {
    use axum::{
        extract::{ConnectInfo, Extension, Path, State},
        http::{HeaderMap, StatusCode},
        Json,
    };
    let (s, id, conn, mut rx) = fixture(db).await?;
    let command = Uuid::new_v4();
    db::create_module_disable(&s.db, id, Module::Scripts, 1, command).await?;
    s.test_accept_report(id, conn, value(&module_report(1, true)))
        .await?;
    rx.recv().await.unwrap();
    let call = |module| {
        let s = s.clone();
        async move {
            crate::agents::modules::api::disable_module(
                Path(id),
                State(s),
                Extension(crate::test_support::admin()),
                HeaderMap::new(),
                ConnectInfo("127.0.0.1:9000".parse().unwrap()),
                Json(crate::agents::modules::api::DisableBody {
                    module,
                    expected_revision: 1,
                    command_id: command,
                }),
            )
            .await
            .into_response()
        }
    };
    assert_eq!(call(Module::Logs).await.status(), StatusCode::CONFLICT);
    let cooldown = call(Module::Scripts).await;
    assert_eq!(cooldown.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = axum::body::to_bytes(cooldown.into_body(), 10000).await?;
    let body: serde_json::Value = serde_json::from_slice(&body)?;
    assert!(body["retry_after_ms"].as_u64().unwrap() > 0);
    assert_eq!(body["command_id"], command.to_string());
    assert!(rx.try_recv().is_err());
    s.agents
        .modules
        .lock()
        .get_mut(&id)
        .unwrap()
        .last_sent
        .insert(command, std::time::Instant::now() - DISABLE_RETRY_COOLDOWN);
    assert_eq!(call(Module::Scripts).await.status(), StatusCode::ACCEPTED);
    assert!(
        matches!(rx.recv().await,Some(AgentControl::Text(v)) if v.contains(&command.to_string()))
    );
    assert_eq!(
        call(Module::Scripts).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    s.test_accept_report(id, conn, value(&module_report(1, true)))
        .await?;
    assert!(rx.try_recv().is_err());
    let (next, mut rx) = connect(&s, id);
    s.test_accept_report(id, next, value(&module_report(1, true)))
        .await?;
    assert!(
        matches!(rx.recv().await,Some(AgentControl::Text(v)) if v.contains(&command.to_string()))
    );
    Ok(())
}

#[sqlx::test]
async fn report_and_ack_db_waits_retain_lease_until_rotation_can_clear_runtime(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) -> anyhow::Result<()> {
    // A single connection, so holding it suspends the persistence under test.
    let db = pool_options
        .max_connections(1)
        .connect_with(connect_options)
        .await?;
    for ack in [false, true] {
        crate::test_support::delete_agents(&db).await?;
        let (s, id, conn, mut rx) = fixture(db.clone()).await?;
        let command = Uuid::new_v4();
        if ack {
            db::create_module_disable(&s.db, id, Module::Scripts, 1, command).await?;
            s.test_accept_report(id, conn, value(&module_report(1, true)))
                .await?;
            rx.recv().await.unwrap();
        }
        // Occupying this fixture's only DB connection forces persistence to suspend.
        let database_blocker = s.db.acquire().await?;
        let worker_state = s.clone();
        let worker = tokio::spawn(async move {
            if ack {
                worker_state.test_accept_ack(id,conn,serde_json::json!({"type":"module_disable_ack","module":"scripts","command_id":command,"ok":true,"status":"disabled","persisted":true,"stopped":false,"stop_status":"unconfirmed","state":module_report(2,false)})).await
            } else {
                worker_state
                    .test_accept_report(id, conn, value(&module_report(1, true)))
                    .await
            }
        });
        let gate = s.agents.lifecycle.for_agent(id);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if gate.clone().try_write_owned().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await?;
        let rotation_state = s.clone();
        let mut rotation = tokio::spawn(async move {
            let _guard = gate.write_owned().await;
            rotation_state
                .invalidate_agent_connection(id, "agent_credentials_revoked")
                .await;
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut rotation)
                .await
                .is_err()
        );
        drop(database_blocker);
        worker.await??;
        rotation.await?;
        assert!(!s.agents.connections.lock().contains_key(&id));
        assert!(!s.agents.modules.lock().contains_key(&id));
        assert_eq!(
            db::module_report(&s.db, id).await?.unwrap().0.revision,
            if ack { 2 } else { 1 }
        );
        if ack {
            assert_eq!(
                db::module_disable_request(&s.db, id, command)
                    .await?
                    .unwrap()
                    .status,
                "disabled"
            );
        }
        let (_new, _) = connect(&s, id);
        assert_eq!(
            s.agents
                .authorize_agent_command(id, &serde_json::json!({"type":"RunScript"}))
                .unwrap_err()
                .code,
            "module_report_required"
        );
    }
    Ok(())
}

#[test]
fn legacy_reports_synthesize_only_unavailable_clipboard() {
    let modules: Vec<_> = MODULES.iter().filter(|m| **m != Module::Clipboard).map(|m|
        serde_json::json!({"module":m,"available":true,"enabled":true,"revision":1,"authorization_required":false})).collect();
    let legacy = serde_json::json!({"type":"module_states","schema_version":1,"revision":1,"modules":modules});
    let parsed = ModuleReport::parse(legacy.clone()).unwrap();
    let clipboard = parsed.get(Module::Clipboard);
    assert!(!clipboard.available && !clipboard.enabled && clipboard.authorization_required);
    assert_eq!(clipboard.revision, 0);
    assert!(parsed.get(Module::RemoteInput).enabled);
    let mut incomplete = legacy.clone();
    incomplete["modules"].as_array_mut().unwrap().pop();
    assert!(ModuleReport::parse(incomplete).is_err());
    let mut missing_other = serde_json::to_value(&parsed).unwrap();
    missing_other["modules"]
        .as_array_mut()
        .unwrap()
        .retain(|v| v["module"] != "remote_input");
    assert!(ModuleReport::parse(missing_other).is_err());
    let mut duplicate = legacy.clone();
    duplicate["modules"][1] = duplicate["modules"][0].clone();
    assert!(ModuleReport::parse(duplicate).is_err());
    let mut unknown = legacy;
    unknown["modules"][0]["module"] = "unknown_grant".into();
    assert!(ModuleReport::parse(unknown).is_err());
}
