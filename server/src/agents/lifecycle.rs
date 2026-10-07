//! Device lifecycle (admin): revoke credentials, issue a replacement-installation code,
//! and delete devices including their Recall blobs. Every path holds the per-device
//! lifecycle write gate so a reconnecting socket cannot race the change.

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

use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::state::AppState;
use chrono::Utc;

use crate::agents::db as agents_db;
use crate::agents::enrollment::db as enrollment_db;
use crate::http::audit_ip;
use crate::platform::audit;

#[derive(Deserialize)]
pub struct BulkAgentIdsBody {
    pub agent_ids: Vec<Uuid>,
}

/// Admin: clear the stored per-agent API token so the agent can enroll again.
pub async fn revoke_agent_credentials(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let _lifecycle = s.agents.lifecycle.for_agent(agent_id).write_owned().await;
    // Invalidate first so cancellation during the DB commit cannot leave the
    // old socket active with a credential that has already been revoked.
    s.invalidate_agent_connection(agent_id, "agent_credentials_revoked")
        .await;
    enrollment_db::invites::revoke_agent_credentials(&s.db, agent_id).await?;

    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Admin: delete agents (forgets them). Cascades telemetry via FK `ON DELETE CASCADE`.
pub async fn delete_agents_bulk(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
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
        enrollment_db::invites::revoke_agent_credentials(&s.db, *id).await?;
    }
    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| !body.agent_ids.contains(&token.agent_id));

    let ip = audit_ip(&headers, addr);
    let n = agents_db::delete_agents_by_ids(&s.db, &body.agent_ids).await?;
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
    audit::insert_audit_log_traced(
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

/// Revoke a device's credential and issue a one-use replacement-installation code bound
/// to its UUID. Called by the enrollment-token API when `bound_agent_id` is supplied.
pub async fn replace_agent_installation(
    s: &Arc<AppState>,
    agent_id: Uuid,
    user: &AuthUser,
    headers: &HeaderMap,
    addr: SocketAddr,
) -> ApiResult<Json<Value>> {
    if !user.is_admin() {
        return Err(ApiError::Forbidden("admin only".into()));
    }
    let _lifecycle = s.agents.lifecycle.for_agent(agent_id).write_owned().await;
    s.invalidate_agent_connection(agent_id, "agent_credentials_revoked")
        .await;
    let Some((id, plaintext, expires_at)) =
        enrollment_db::invites::create_agent_replacement_token(&s.db, agent_id).await?
    else {
        return Err(ApiError::not_found("agent not found"));
    };
    s.agents
        .pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        Some(agent_id),
        "agent_replacement_code_create",
        "ok",
        &serde_json::json!({ "invite_id": id, "expires_at": expires_at }),
        audit_ip(headers, addr).as_deref(),
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

impl AppState {
    /// Caller must hold this device's lifecycle write gate. Detach immediately:
    /// an old socket may still be closing, but cannot ingest or own the new session.
    pub async fn invalidate_agent_connection(&self, agent_id: Uuid, reason: &'static str) {
        let connection = {
            let mut control = self.control.lock();
            let conn_id = self
                .agents
                .connections
                .lock()
                .get(&agent_id)
                .map(|c| c.conn_id);
            if let Some(conn_id) = conn_id {
                let cleanup = control.sessions.revoke_agent(agent_id, conn_id);
                self.deliver_control_cleanup(&mut control, cleanup);
                self.clear_capture_connection_locked(agent_id, conn_id);
            }
            let connection = self.agents.connections.lock().remove(&agent_id);
            self.agents.cmds.lock().remove(&agent_id);
            self.agents.modules.lock().remove(&agent_id);
            connection
        };
        self.agents.clear_live(agent_id);
        self.media.frames.lock().remove(&agent_id);
        if let Some(connection) = connection {
            connection.shutdown.send_replace(Some(reason));
            let disconnected_at = Utc::now();
            if let Err(e) = agents_db::touch_agent(&self.db, agent_id).await {
                tracing::warn!(error = %e, %agent_id, "failed to record lifecycle disconnect");
            }
            if let Err(e) = agents_db::end_agent_session(&self.db, connection.session_id).await {
                tracing::warn!(error = %e, %agent_id, "failed to end invalidated agent session");
            }
            self.broadcast(
                serde_json::json!({
                    "event": "agent_disconnected", "agent_id": agent_id,
                    "disconnected_at": disconnected_at,
                })
                .to_string(),
            );
        }
    }
}

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod lifecycle_race_tests;
