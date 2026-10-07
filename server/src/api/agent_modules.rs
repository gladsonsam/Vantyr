use crate::agents::db as agents_db;
use crate::error::{ApiError, ApiResult};
use crate::http::audit_ip;
use crate::platform::audit;
use crate::{agent_modules::Module, db, http::AuthUser, state::AppState};
use axum::{
    extract::{ConnectInfo, Extension, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::{net::SocketAddr, sync::Arc};
use uuid::Uuid;

fn operator_required() -> ApiError {
    ApiError::coded(StatusCode::FORBIDDEN, "forbidden", "Operator role required")
}

pub async fn get_modules(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<serde_json::Value>> {
    if !user.is_operator() {
        return Err(operator_required());
    }
    if agents_db::agent_name_by_id(&s.db, id).await?.is_none() {
        return Err(ApiError::Empty(StatusCode::NOT_FOUND));
    }
    let report = db::module_report(&s.db, id).await?;
    let requests = db::module_disable_requests(&s.db, id, false).await?;
    let (online, authorization_current) = {
        let agents = s.agents.connections.lock();
        let runtime = s.agents.modules.lock();
        (
            agents.contains_key(&id),
            agents
                .get(&id)
                .zip(runtime.get(&id))
                .is_some_and(|(connection, runtime)| connection.conn_id == runtime.conn_id),
        )
    };
    Ok(Json(serde_json::json!({
        "state": report.as_ref().map(|report| &report.0),
        "reported_at": report.map(|report| report.1),
        "online": online,
        "authorization_current": authorization_current,
        "pending": requests,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisableBody {
    pub module: Module,
    pub expected_revision: u64,
    pub command_id: Uuid,
}

pub async fn disable_module(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<DisableBody>,
) -> ApiResult<Response> {
    if !user.is_operator() {
        return Err(operator_required());
    }
    // Serialize pending revocation with ingestion, registration and lifecycle mutations.
    let _gate = s.agents.lifecycle.for_agent(id).write_owned().await;
    if agents_db::agent_name_by_id(&s.db, id).await?.is_none() {
        return Err(ApiError::Empty(StatusCode::NOT_FOUND));
    }
    let previous = db::module_disable_request(&s.db, id, body.command_id).await?;
    if previous.is_none() {
        let Some(report) = db::module_report(&s.db, id).await? else {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                "module_report_required",
                "Update the agent and obtain a module report before requesting a disable.",
            ));
        };
        if report.0.get(body.module).revision != body.expected_revision {
            return Err(ApiError::coded(
                StatusCode::CONFLICT,
                "module_revision_conflict",
                "Module revision changed; refresh before requesting disable.",
            ));
        }
    }
    let Some(request) = db::create_module_disable(
        &s.db,
        id,
        body.module,
        body.expected_revision,
        body.command_id,
    )
    .await?
    else {
        return Err(ApiError::coded(StatusCode::CONFLICT,
            "disable_request_conflict", "Command ID was reused with different binding, or this module already has a pending request."));
    };
    if request.pending {
        let conn = {
            let mut control = s.control.lock();
            if matches!(request.module, Module::RemoteInput | Module::LiveScreen) {
                let conn = s.agents.connections.lock().get(&id).map(|c| c.conn_id);
                if let Some(conn) = conn {
                    s.revoke_agent_control_locked(&mut control, id, conn);
                }
            }
            let agents = s.agents.connections.lock();
            let mut runtimes = s.agents.modules.lock();
            if let Some(runtime) = agents.get(&id).and_then(|connection| {
                runtimes
                    .get_mut(&id)
                    .filter(|runtime| runtime.conn_id == connection.conn_id)
            }) {
                // create_module_disable has verified this exact persisted agent/module/revision/ID.
                if previous.is_some() {
                    if let Some(last) = runtime.last_sent.get(&request.command_id) {
                        let remaining = crate::agent_modules::DISABLE_RETRY_COOLDOWN
                            .saturating_sub(last.elapsed());
                        if !remaining.is_zero() {
                            return Err(ApiError::Custom((StatusCode::TOO_MANY_REQUESTS,Json(serde_json::json!({
                                "code":"module_retry_cooldown","error":"Wait before retrying this pending disable request.",
                                "command_id":request.command_id,"retry_after_ms":remaining.as_millis().max(1)
                            }))).into_response()));
                        }
                    }
                    runtime.sent.remove(&request.command_id);
                }
                runtime.pending.insert(request.command_id, request.clone());
                Some(runtime.conn_id)
            } else {
                None
            }
        };
        if let Some(conn) = conn {
            s.replay_module_disables(id, conn).await?;
        }
    }

    audit::insert_audit_log_traced(&s.db, &user.username, Some(id), "module_disable_request", "accepted",
        &serde_json::json!({"command_id":body.command_id,"module":body.module,"expected_revision":body.expected_revision}),
        audit_ip(&headers, addr).as_deref()).await;
    match db::module_disable_request(&s.db, id, body.command_id).await? {
        Some(request) => Ok((StatusCode::ACCEPTED, Json(request)).into_response()),
        None => Err(ApiError::Empty(StatusCode::NOT_FOUND)),
    }
}
