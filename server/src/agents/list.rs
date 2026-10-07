//! Agent directory: list, sidebar overview, icons, and the connection-session log.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Query;
use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::agents::db;
use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, RequireOperator};
use crate::platform::audit;
use crate::state::AppState;

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

    let agent_ids: Vec<Uuid> = agents.iter().map(|a| a.id).collect();
    let versions = match db::agent_versions_batch(&s.db, &agent_ids).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "agent_versions_batch failed for overview");
            std::collections::HashMap::new()
        }
    };
    let session_times = db::agent_last_session_times_batch(&s.db, &agent_ids).await?;

    let overview: Vec<db::AgentOverview> = agents
        .into_iter()
        .map(|a| {
            let id = a.id;
            db::AgentOverview::new(
                a,
                versions.get(&id).cloned(),
                online.get(&id).copied(),
                session_times.get(&id).copied().unwrap_or((None, None)),
            )
        })
        .collect();

    Ok(Json(serde_json::json!({ "agents": overview })))
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
    audit::insert_audit_log_traced(
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

#[derive(Deserialize)]
pub struct SessionsQuery {
    pub limit: Option<i64>,
}

pub async fn agent_sessions_all(
    State(s): State<Arc<AppState>>,
    Query(q): Query<SessionsQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let results = db::list_recent_sessions(&s.db, limit).await?;
    Ok(Json(serde_json::json!({ "rows": results })))
}
