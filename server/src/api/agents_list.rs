//! Agent directory, overview, and icon API.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::{self, RequireOperator};
use crate::error::{ApiError, ApiResult};
use crate::{db, state::AppState};

use super::helpers::audit_ip;

#[derive(Deserialize)]
pub struct BulkAgentIdsBody {
    pub agent_ids: Vec<Uuid>,
}

/// Admin: clear the stored per-agent API token so the agent can enroll again.
pub async fn revoke_agent_credentials(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let _lifecycle = s.agents.lifecycle.for_agent(agent_id).write_owned().await;
    // Invalidate first so cancellation during the DB commit cannot leave the
    // old socket active with a credential that has already been revoked.
    s.invalidate_agent_connection(agent_id, "agent_credentials_revoked")
        .await;
    db::revoke_agent_credentials(&s.db, agent_id).await?;

    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Admin: delete agents (forgets them). Cascades telemetry via FK `ON DELETE CASCADE`.
pub async fn delete_agents_bulk(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<BulkAgentIdsBody>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    if body.agent_ids.is_empty() {
        return Err(ApiError::bad_request("agent_ids must be non-empty"));
    }
    if body.agent_ids.len() > 128 {
        return Err(ApiError::bad_request("at most 128 agents per request"));
    }

    // Acquire in UUID order so overlapping bulk requests cannot deadlock.
    let mut ids = body.agent_ids.clone();
    ids.sort_unstable();
    ids.dedup();
    let mut lifecycle_leases = Vec::with_capacity(ids.len());
    for id in &ids {
        lifecycle_leases.push(Arc::new(
            s.agents.lifecycle.for_agent(*id).write_owned().await,
        ));
    }

    for id in &ids {
        s.invalidate_agent_connection(*id, "agent_deleted").await;
    }

    // Gates prevent reconnect registration while credentials are revoked.
    for id in &body.agent_ids {
        db::revoke_agent_credentials(&s.db, *id).await?;
    }
    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| !body.agent_ids.contains(&token.agent_id));

    let ip = audit_ip(&headers, addr);
    let n = db::delete_agents_by_ids(&s.db, &body.agent_ids).await?;
    for id in &body.agent_ids {
        s.agents.clear_live(*id);
        s.media.frames.lock().remove(id);
        s.broadcast(serde_json::json!({ "event": "agent_removed", "agent_id": id }).to_string());
    }
    // UUID-derived directory only: never trust blob_ref as a deletion path.
    let blob_root = s.settings.screen_history_dir.clone();
    let ids = body.agent_ids.clone();
    let cleanup_leases = lifecycle_leases.clone();
    let cleanup = tokio::task::spawn_blocking(move || {
        // Cancellation must not admit queued ingestion while cleanup runs.
        let _leases = cleanup_leases;
        for id in ids {
            if let Err(e) = remove_agent_screen_blobs(&blob_root, id) {
                tracing::warn!(error = %e, agent_id = %id, "agent removed; screen blob cleanup failed");
            }
        }
    }).await;
    if let Err(e) = cleanup {
        tracing::warn!(error = %e, "screen blob cleanup task failed");
    }
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "agents_delete",
        "ok",
        &serde_json::json!({ "count": n, "agent_ids": body.agent_ids }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true, "deleted": n })))
}
pub async fn me(Extension(user): Extension<auth::AuthUser>) -> Json<Value> {
    Json(serde_json::json!({
        "id": user.user_id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "display_icon": user.display_icon,
        "csrf_token": user.csrf_token,
    }))
}

pub async fn list_agents(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let rows = db::list_agents(&s.db).await?;
    Ok(Json(serde_json::json!({ "agents": rows })))
}

/// Overview list used by the dashboard sidebar: includes offline agents + last session times.
pub async fn list_agents_overview(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let agents = db::list_agents(&s.db).await?;

    let online: std::collections::HashMap<uuid::Uuid, chrono::DateTime<chrono::Utc>> = {
        let map = s.agents.connections.lock();
        map.iter().map(|(id, a)| (*id, a.connected_at)).collect()
    };

    let agent_ids: Vec<Uuid> = agents
        .iter()
        .filter_map(|a| a["id"].as_str().and_then(|s| s.parse().ok()))
        .collect();
    let versions = match db::agent_versions_batch(&s.db, &agent_ids).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "agent_versions_batch failed for overview");
            std::collections::HashMap::new()
        }
    };
    let session_times = db::agent_last_session_times_batch(&s.db, &agent_ids).await?;

    let mut out: Vec<serde_json::Value> = Vec::with_capacity(agents.len());
    for a in agents {
        let id = match a["id"].as_str().and_then(|s| s.parse::<Uuid>().ok()) {
            Some(id) => id,
            None => continue,
        };
        let (last_connected_at, last_disconnected_at) =
            session_times.get(&id).copied().unwrap_or((None, None));
        let connected_at = online.get(&id).copied();
        out.push(serde_json::json!({
            "id": id,
            "name": a["name"],
            "first_seen": a["first_seen"],
            "last_seen": a["last_seen"],
            "icon": a["icon"],
            "agent_version": versions.get(&id).cloned(),
            "online": connected_at.is_some(),
            "connected_at": connected_at,
            "last_connected_at": last_connected_at,
            "last_disconnected_at": last_disconnected_at
        }));
    }

    Ok(Json(serde_json::json!({ "agents": out })))
}

#[derive(Deserialize)]
pub struct AgentIconBody {
    /// Icon key (from the dashboard's icon library); empty or null clears.
    icon: Option<String>,
}

fn normalize_icon(raw: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(s) = raw else {
        return Ok(Some("monitor".to_string()));
    };
    let t = s.trim();
    if t.is_empty() {
        return Ok(Some("monitor".to_string()));
    }
    // Keep it lightweight (intended for a short icon key like "laptop").
    if t.len() > 32 {
        return Err("icon is too long (max 32 characters)");
    }
    // Allow a conservative key charset; frontend enforces the actual allowed list.
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("icon must be alphanumeric (plus '-' or '_')");
    }
    Ok(Some(t.to_string()))
}

pub async fn agent_icon_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let icon = db::get_agent_icon(&s.db, id).await?;
    Ok(Json(serde_json::json!({ "icon": icon })))
}

pub async fn agent_icon_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireOperator(user): RequireOperator,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentIconBody>,
) -> ApiResult<Json<Value>> {
    let icon = normalize_icon(body.icon).map_err(ApiError::bad_request)?;
    let ip = audit_ip(&headers, addr);
    db::set_agent_icon(&s.db, id, icon.as_deref()).await?;
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(id),
        "set_agent_icon",
        "ok",
        &serde_json::json!({ "icon": icon }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "icon": icon })))
}

use axum::extract::Query;
#[derive(Deserialize)]
pub struct SessionsQuery {
    pub limit: Option<i64>,
}

pub async fn agent_sessions_all(
    State(s): State<Arc<AppState>>,
    Query(q): Query<SessionsQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let rows = sqlx::query(
        r"
        SELECT 
            s.id, s.agent_id, s.connected_at, s.disconnected_at,
            a.name as agent_name
        FROM agent_sessions s
        JOIN agents a ON a.id = s.agent_id
        ORDER BY s.connected_at DESC
        LIMIT $1
        ",
    )
    .bind(limit)
    .fetch_all(&s.db)
    .await?;
    let mut results = Vec::new();
    for r in rows {
        use sqlx::Row;
        results.push(serde_json::json!({
            "id": r.try_get::<i64, _>("id").unwrap_or(0),
            "agent_id": r.try_get::<Uuid, _>("agent_id").unwrap_or_default(),
            "agent_name": r.try_get::<String, _>("agent_name").unwrap_or_default(),
            "connected_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("connected_at").unwrap_or_default(),
            "disconnected_at": r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("disconnected_at").unwrap_or_default(),
        }));
    }
    Ok(Json(serde_json::json!({ "rows": results })))
}

/// Called by the enrollment-token API when an explicit bound_agent_id is supplied.
/// The router may also expose this at POST /agents/:id/replace-installation.
pub async fn replace_agent_installation(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let _lifecycle = s.agents.lifecycle.for_agent(agent_id).write_owned().await;
    s.invalidate_agent_connection(agent_id, "agent_credentials_revoked")
        .await;
    let Some((id, plaintext, expires_at)) =
        db::create_agent_replacement_token(&s.db, agent_id).await?
    else {
        return Err(ApiError::not_found("agent not found"));
    };
    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);
    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(agent_id),
        "agent_replacement_code_create",
        "ok",
        &serde_json::json!({ "invite_id": id, "expires_at": expires_at }),
        audit_ip(&headers, addr).as_deref(),
    )
    .await;
    Ok(Json(
        serde_json::json!({ "id": id, "enrollment_token": plaintext, "uses": 1,
        "expires_at": expires_at, "bound_agent_id": agent_id }),
    ))
}

/// Delete only the known UUID directory under the configured Recall root.
/// Refuse a symlink in its place so cleanup cannot follow an external target.
fn remove_agent_screen_blobs(root: &std::path::Path, agent_id: Uuid) -> std::io::Result<()> {
    let path = root.join(agent_id.to_string());
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(
            "refusing non-directory agent blob path",
        ));
    }
    std::fs::remove_dir_all(path)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn removes_only_the_requested_uuid_directory() {
        let root = std::env::temp_dir().join(format!("vantyr-removal-{}", Uuid::new_v4()));
        let agent = Uuid::new_v4();
        let other = Uuid::new_v4();
        for id in [agent, other] {
            std::fs::create_dir_all(root.join(id.to_string()).join("20261003")).unwrap();
            std::fs::write(
                root.join(id.to_string()).join("20261003/frame.jpg"),
                b"jpeg",
            )
            .unwrap();
        }
        remove_agent_screen_blobs(&root, agent).unwrap();
        remove_agent_screen_blobs(&root, agent).unwrap(); // idempotent
        assert!(!root.join(agent.to_string()).exists());
        assert!(root
            .join(other.to_string())
            .join("20261003/frame.jpg")
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_and_preserves_external_target() {
        let root = std::env::temp_dir().join(format!("vantyr-symlink-{}", Uuid::new_v4()));
        let external = root.join("external");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("keep.jpg"), b"jpeg").unwrap();
        let agent = Uuid::new_v4();
        std::os::unix::fs::symlink(&external, root.join(agent.to_string())).unwrap();
        assert!(remove_agent_screen_blobs(&root, agent).is_err());
        assert!(external.join("keep.jpg").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod lifecycle_race_tests {
    use super::*;
    use crate::state::agent_lifecycle::{spawn_blocking_ingestion, test_support};
    use crate::ws_agent::{register_authenticated_connection, AuthenticatedAgent};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL pointing to PostgreSQL"]
    async fn delayed_upgrade_cannot_register_after_revoke_delete_or_replacement(
    ) -> anyhow::Result<()> {
        for operation in ["revoke", "delete", "replace"] {
            let (state, id, old_hash) = test_support::state().await?;
            let authenticated = AuthenticatedAgent {
                id,
                token_hash: old_hash,
            };
            let lease = state.agents.lifecycle.for_agent(id).read_owned().await;
            let admin = test_support::admin();
            let mutation = async {
                match operation {
                    "revoke" => {
                        revoke_agent_credentials(Path(id), State(state.clone()), Extension(admin))
                            .await
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
                            Path(id),
                            State(state.clone()),
                            Extension(admin),
                            HeaderMap::new(),
                            ConnectInfo("127.0.0.1:1234".parse().unwrap()),
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
                let claim = db::create_agent_enrollment_claim(
                    &state.db,
                    db::AgentEnrollmentClaimInput {
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
                    db::get_agent_auth_by_name(&state.db, "device")
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

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL pointing to PostgreSQL"]
    async fn revoke_invalidates_a_registered_socket_even_with_a_full_command_queue(
    ) -> anyhow::Result<()> {
        let (state, id, hash) = test_support::state().await?;
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
        crate::ws_agent::cleanup_connection(id, connection.conn_id, connection.session_id, &state)
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires TEST_DATABASE_URL pointing to PostgreSQL"]
    async fn deletion_waits_for_a_cancelled_ingestions_blocking_blob_writer() -> anyhow::Result<()>
    {
        let (state, id, hash) = test_support::state().await?;
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

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL pointing to PostgreSQL"]
    async fn reconnect_and_stale_cleanup_preserve_the_new_sessions_sender_and_online_event(
    ) -> anyhow::Result<()> {
        let (state, id, hash) = test_support::state().await?;
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
        crate::ws_agent::cleanup_connection(id, first.conn_id, first.session_id, &state).await;
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
}
