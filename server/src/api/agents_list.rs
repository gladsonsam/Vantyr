//! Agent directory, overview, and icon API.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

#[derive(Deserialize)]
pub struct BulkAgentIdsBody {
    pub agent_ids: Vec<Uuid>,
}

/// Admin: clear the stored per-agent API token so the agent can enroll again.
pub async fn revoke_agent_credentials(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    if let Err(e) = db::revoke_agent_credentials(&s.db, agent_id).await {
        return err500(e);
    }

    s.pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);

    // The stored token is gone, but a live WebSocket keeps streaming until it's torn down.
    // Tell the agent why before dropping it, so it parks in Error instead of
    // reconnect-spinning against a 401. Wait briefly for `ws_agent::run` to
    // clean up, mirroring `delete_agents_bulk`.
    let was_connected = s.agents.lock().contains_key(&agent_id);
    if was_connected {
        let _ = s.try_notify_agent_disconnect(agent_id, "agent_credentials_revoked");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while s.agents.lock().contains_key(&agent_id) {
            if tokio::time::Instant::now() >= deadline {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "credentials revoked but agent did not disconnect in time; retry",
                        "agent_id": agent_id,
                    })),
                )
                    .into_response();
            }
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        }
    }

    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Admin: delete agents (forgets them). Cascades telemetry via FK `ON DELETE CASCADE`.
pub async fn delete_agents_bulk(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<BulkAgentIdsBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    if body.agent_ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "agent_ids must be non-empty" })),
        )
            .into_response();
    }
    if body.agent_ids.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "at most 128 agents per request" })),
        )
            .into_response();
    }

    // Revoke before requesting disconnect: reconnects must not authenticate
    // while the old socket is being torn down.
    for id in &body.agent_ids {
        if let Err(e) = db::revoke_agent_credentials(&s.db, *id).await {
            return err500(e);
        }
    }
    s.pending_enrollment_tokens
        .lock()
        .retain(|_, token| !body.agent_ids.contains(&token.agent_id));

    // Best-effort: tell connected agents they were deleted, then disconnect them.
    // The in-band reason lets the agent park in Error instead of
    // reconnect-spinning against the 401 its old token now gets.
    // This keeps the UX as a single action.
    let mut connected: Vec<Uuid> = {
        let map = s.agents.lock();
        body.agent_ids
            .iter()
            .copied()
            .filter(|id| map.contains_key(id))
            .collect()
    };
    if !connected.is_empty() {
        for id in &connected {
            let _ = s.try_notify_agent_disconnect(*id, "agent_deleted");
        }
        // Wait briefly for cleanup in `ws_agent::run` to remove them from `s.agents`.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let still: Vec<Uuid> = {
                let map = s.agents.lock();
                connected
                    .iter()
                    .copied()
                    .filter(|id| map.contains_key(id))
                    .collect()
            };
            if still.is_empty() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "error": "could not disconnect one or more agents in time; retry",
                        "connected_agent_ids": still
                    })),
                )
                    .into_response();
            }
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        }
        connected.clear();
    }

    let ip = audit_ip(&headers, addr);
    match db::delete_agents_by_ids(&s.db, &body.agent_ids).await {
        Ok(n) => {
            for id in &body.agent_ids {
                s.clear_agent_live(*id);
                s.frames.lock().remove(id);
                s.broadcast(
                    serde_json::json!({ "event": "agent_removed", "agent_id": id }).to_string(),
                );
            }
            // UUID-derived directory only: never trust blob_ref as a deletion path.
            let blob_root = s.screen_history_dir.clone();
            let ids = body.agent_ids.clone();
            let cleanup = tokio::task::spawn_blocking(move || {
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
            Json(serde_json::json!({ "ok": true, "deleted": n })).into_response()
        }
        Err(e) => err500(e),
    }
}
pub async fn me(Extension(user): Extension<auth::AuthUser>) -> Response {
    Json(serde_json::json!({
        "id": user.user_id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "display_icon": user.display_icon,
        "csrf_token": user.csrf_token,
    }))
    .into_response()
}

pub async fn list_agents(State(s): State<Arc<AppState>>) -> Response {
    match db::list_agents(&s.db).await {
        Ok(rows) => Json(serde_json::json!({ "agents": rows })).into_response(),
        Err(e) => err500(e),
    }
}

/// Overview list used by the dashboard sidebar: includes offline agents + last session times.
pub async fn list_agents_overview(State(s): State<Arc<AppState>>) -> Response {
    let agents = match db::list_agents(&s.db).await {
        Ok(rows) => rows,
        Err(e) => return err500(e),
    };

    let online: std::collections::HashMap<uuid::Uuid, chrono::DateTime<chrono::Utc>> = {
        let map = s.agents.lock();
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
    let session_times = match db::agent_last_session_times_batch(&s.db, &agent_ids).await {
        Ok(m) => m,
        Err(e) => return err500(e),
    };

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

    Json(serde_json::json!({ "agents": out })).into_response()
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

pub async fn agent_icon_get(Path(id): Path<Uuid>, State(s): State<Arc<AppState>>) -> Response {
    match db::get_agent_icon(&s.db, id).await {
        Ok(icon) => Json(serde_json::json!({ "icon": icon })).into_response(),
        Err(e) => err500(e),
    }
}

pub async fn agent_icon_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AgentIconBody>,
) -> Response {
    if !user.is_operator() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let icon = match normalize_icon(body.icon) {
        Ok(v) => v,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response()
        }
    };
    let ip = audit_ip(&headers, addr);
    match db::set_agent_icon(&s.db, id, icon.as_deref()).await {
        Ok(()) => {
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
            Json(serde_json::json!({ "icon": icon })).into_response()
        }
        Err(e) => err500(e),
    }
}

use axum::extract::Query;
#[derive(Deserialize)]
pub struct SessionsQuery {
    pub limit: Option<i64>,
}

pub async fn agent_sessions_all(
    State(s): State<Arc<AppState>>,
    Query(q): Query<SessionsQuery>,
) -> Response {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    match sqlx::query(
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
    .await
    {
        Ok(rows) => {
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
            Json(serde_json::json!({ "rows": results })).into_response()
        }
        Err(e) => err500(e.into()),
    }
}

/// Called by the enrollment-token API when an explicit bound_agent_id is supplied.
/// The router may also expose this at POST /agents/:id/replace-installation.
pub async fn replace_agent_installation(
    Path(agent_id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "admin only" })),
        )
            .into_response();
    }
    let (id, plaintext, expires_at) =
        match db::create_agent_replacement_token(&s.db, agent_id).await {
            Ok(Some(token)) => token,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "agent not found" })),
                )
                    .into_response()
            }
            Err(e) => return err500(e),
        };
    s.pending_enrollment_tokens
        .lock()
        .retain(|_, token| token.agent_id != agent_id);
    let _ = s.try_notify_agent_disconnect(agent_id, "agent_credentials_revoked");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while s.agents.lock().contains_key(&agent_id) {
        if tokio::time::Instant::now() >= deadline {
            let _ = db::revoke_agent_enrollment_token(&s.db, id).await;
            return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "credentials revoked but agent did not disconnect in time; retry replacement" }))).into_response();
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
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
    Json(
        serde_json::json!({ "id": id, "enrollment_token": plaintext, "uses": 1,
        "expires_at": expires_at, "bound_agent_id": agent_id }),
    )
    .into_response()
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
