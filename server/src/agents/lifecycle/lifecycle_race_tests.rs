use super::*;
use crate::agent_ws::connection::{register_authenticated_connection, AuthenticatedAgent};
use crate::state::agent_lifecycle::spawn_blocking_ingestion;
use crate::test_support;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use sqlx::PgPool;

#[sqlx::test]
async fn delayed_upgrade_cannot_register_after_revoke_delete_or_replacement(
    db: PgPool,
) -> anyhow::Result<()> {
    for operation in ["revoke", "delete", "replace"] {
        test_support::delete_agents(&db).await?;
        let (state, id, old_hash) = test_support::state(db.clone()).await?;
        let authenticated = AuthenticatedAgent {
            id,
            token_hash: old_hash,
        };
        let lease = state.agents.lifecycle.for_agent(id).read_owned().await;
        let admin = test_support::admin();
        let mutation = async {
            match operation {
                "revoke" => {
                    revoke_agent_credentials(Path(id), State(state.clone()), Extension(admin)).await
                }
                "delete" => {
                    delete_agents_bulk(
                        State(state.clone()),
                        Extension(admin),
                        HeaderMap::new(),
                        ConnectInfo("127.0.0.1:1234".parse().unwrap()),
                        Json(BulkAgentIdsBody {
                            agent_ids: vec![id],
                        }),
                    )
                    .await
                }
                _ => {
                    replace_agent_installation(
                        &state,
                        id,
                        &admin,
                        &HeaderMap::new(),
                        "127.0.0.1:1234".parse().unwrap(),
                    )
                    .await
                }
            }
        };
        let mut mutation = std::pin::pin!(mutation);
        // Queue the real mutation first, then a previously authenticated
        // upgrade. Both are held at the gate, with deterministic ordering.
        assert!(futures_util::poll!(mutation.as_mut()).is_pending());
        let mut delayed = std::pin::pin!(register_authenticated_connection(
            &authenticated,
            "device",
            &state
        ));
        assert!(futures_util::poll!(delayed.as_mut()).is_pending());
        drop(lease);
        let response = mutation.await.into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(delayed.as_mut().await?.is_none());
        if operation == "replace" {
            let bytes = axum::body::to_bytes(response.into_body(), 65536).await?;
            let body: serde_json::Value = serde_json::from_slice(&bytes)?;
            let code = body["enrollment_token"].as_str().unwrap();
            let claim = enrollment_db::claims::create_agent_enrollment_claim(
                &state.db,
                enrollment_db::claims::AgentEnrollmentClaimInput {
                    pairing_code: Some(code),
                    requested_name: "new-host",
                    hostname: None,
                    os: None,
                    agent_version: None,
                    install_id: "replacement",
                    discovered_server: None,
                    client_ip: None,
                },
            )
            .await?
            .map_err(|_| anyhow::anyhow!("replacement claim failed"))?;
            let replacement = state
                .approve_agent_enrollment_claim(claim.claim.id, "test", None, None)
                .await?
                .map_err(|_| anyhow::anyhow!("replacement approval failed"))?;
            assert_eq!(replacement.0, id);
            assert_eq!(replacement.2, "device");
            // Give the device a fresh valid hash before polling the old
            // upgrade: a mere non-null check would let that upgrade through.
            assert_ne!(
                agents_db::get_agent_auth_by_name(&state.db, "device")
                    .await?
                    .unwrap()
                    .1
                    .as_deref(),
                Some(authenticated.token_hash.as_str())
            );
        }
        assert!(
            register_authenticated_connection(&authenticated, "device", &state)
                .await?
                .is_none()
        );
        assert!(state.agents.connections.lock().is_empty());
        assert!(state.agents.cmds.lock().is_empty());
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_sessions")
            .fetch_one(&state.db)
            .await?;
        assert_eq!(sessions, 0, "rejected upgrade must not create a session");
    }
    Ok(())
}

#[sqlx::test]
async fn revoke_invalidates_a_registered_socket_even_with_a_full_command_queue(
    db: PgPool,
) -> anyhow::Result<()> {
    let (state, id, hash) = test_support::state(db).await?;
    let authenticated = AuthenticatedAgent {
        id,
        token_hash: hash,
    };
    let mut connection = register_authenticated_connection(&authenticated, "device", &state)
        .await?
        .unwrap();
    let sender = state.agents.cmds.lock().get(&id).unwrap().clone();
    for _ in 0..crate::state::AGENT_CMD_CHANNEL_CAPACITY {
        sender
            .try_send(crate::state::AgentControl::Text("queued".into()))
            .unwrap();
    }
    assert!(sender.try_send(crate::state::AgentControl::Close).is_err());
    let response = revoke_agent_credentials(
        Path(id),
        State(state.clone()),
        Extension(test_support::admin()),
    )
    .await
    .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    connection.shutdown_rx.changed().await?;
    assert_eq!(
        *connection.shutdown_rx.borrow(),
        Some("agent_credentials_revoked")
    );
    assert!(!state.agents.connections.lock().contains_key(&id));
    assert!(!state.agents.cmds.lock().contains_key(&id));
    let ended: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT disconnected_at FROM agent_sessions WHERE id = $1")
            .bind(connection.session_id)
            .fetch_one(&state.db)
            .await?;
    assert!(ended.is_some());
    // Closing the old task must not change the recorded disconnect time.
    crate::agent_ws::connection::cleanup_connection(
        id,
        connection.conn_id,
        connection.session_id,
        &state,
    )
    .await;
    let after: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT disconnected_at FROM agent_sessions WHERE id = $1")
            .bind(connection.session_id)
            .fetch_one(&state.db)
            .await?;
    assert_eq!(after, ended);
    assert!(
        register_authenticated_connection(&authenticated, "device", &state)
            .await?
            .is_none()
    );
    Ok(())
}

#[sqlx::test]
async fn deletion_waits_for_a_cancelled_ingestions_blocking_blob_writer(
    db: PgPool,
) -> anyhow::Result<()> {
    let (state, id, hash) = test_support::state(db).await?;
    let authenticated = AuthenticatedAgent {
        id,
        token_hash: hash,
    };
    let _connection = register_authenticated_connection(&authenticated, "device", &state)
        .await?
        .unwrap();
    let gate = state.agents.lifecycle.for_agent(id);
    let path = state
        .settings
        .screen_history_dir
        .join(id.to_string())
        .join("20261003/frame.jpg");
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let writer = tokio::spawn(async move {
        let lease = Arc::new(gate.read_owned().await);
        spawn_blocking_ingestion(&lease, move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"jpeg").unwrap();
        })
        .await
        .unwrap();
    });
    started_rx.await?;
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    let mut deletion = std::pin::pin!(delete_agents_bulk(
        State(state.clone()),
        Extension(test_support::admin()),
        HeaderMap::new(),
        ConnectInfo("127.0.0.1:1234".parse().unwrap()),
        Json(BulkAgentIdsBody {
            agent_ids: vec![id]
        })
    ));
    assert!(futures_util::poll!(deletion.as_mut()).is_pending());
    release_tx.send(())?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), deletion)
        .await?
        .into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!state
        .settings
        .screen_history_dir
        .join(id.to_string())
        .exists());
    assert!(state.agents.connections.lock().is_empty());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents")
        .fetch_one(&state.db)
        .await?;
    assert_eq!(count, 0);
    if state.settings.screen_history_dir.exists() {
        std::fs::remove_dir_all(&state.settings.screen_history_dir)?;
    }
    Ok(())
}

#[sqlx::test]
async fn reconnect_and_stale_cleanup_preserve_the_new_sessions_sender_and_online_event(
    db: PgPool,
) -> anyhow::Result<()> {
    let (state, id, hash) = test_support::state(db).await?;
    let authenticated = AuthenticatedAgent {
        id,
        token_hash: hash,
    };
    let mut first = register_authenticated_connection(&authenticated, "device", &state)
        .await?
        .unwrap();
    let mut second = register_authenticated_connection(&authenticated, "device", &state)
        .await?
        .unwrap();
    first.shutdown_rx.changed().await?;
    assert_eq!(*first.shutdown_rx.borrow(), Some(""));
    let mut events = state.tx.subscribe();
    crate::agent_ws::connection::cleanup_connection(id, first.conn_id, first.session_id, &state)
        .await;
    assert_eq!(
        state.agents.connections.lock().get(&id).unwrap().conn_id,
        second.conn_id
    );
    state
        .agents
        .cmds
        .lock()
        .get(&id)
        .unwrap()
        .try_send(crate::state::AgentControl::Text(
            "new-session-command".into(),
        ))?;
    assert!(
        matches!(second.cmd_rx.recv().await, Some(crate::state::AgentControl::Text(value)) if value == "new-session-command")
    );
    assert!(
        events.try_recv().is_err(),
        "stale cleanup must not publish an offline event"
    );
    Ok(())
}
