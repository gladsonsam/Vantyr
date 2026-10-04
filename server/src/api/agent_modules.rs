use super::helpers::{audit_ip, err500};
use crate::{agent_modules::Module, auth::AuthUser, db, state::AppState};
use axum::{
    extract::{ConnectInfo, Extension, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::{net::SocketAddr, sync::Arc};
use uuid::Uuid;

pub async fn get_modules(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Response {
    if !user.is_operator() {
        return crate::error::api_json_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Operator role required",
        );
    }
    match db::agent_name_by_id(&s.db, id).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    }
    let report = match db::module_report(&s.db, id).await {
        Ok(report) => report,
        Err(e) => return err500(e),
    };
    let requests = match db::module_disable_requests(&s.db, id, false).await {
        Ok(requests) => requests,
        Err(e) => return err500(e),
    };
    let (online, authorization_current) = {
        let agents = s.agents.lock();
        let runtime = s.agent_modules.lock();
        (
            agents.contains_key(&id),
            agents
                .get(&id)
                .zip(runtime.get(&id))
                .is_some_and(|(connection, runtime)| connection.conn_id == runtime.conn_id),
        )
    };
    Json(serde_json::json!({
        "state": report.as_ref().map(|report| &report.0),
        "reported_at": report.map(|report| report.1),
        "online": online,
        "authorization_current": authorization_current,
        "pending": requests,
    }))
    .into_response()
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
) -> Response {
    if !user.is_operator() {
        return crate::error::api_json_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Operator role required",
        );
    }
    // Serialize pending revocation with ingestion, registration and lifecycle mutations.
    let _gate = s.agent_lifecycle.for_agent(id).write_owned().await;
    match db::agent_name_by_id(&s.db, id).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err500(e),
    }
    let previous = match db::module_disable_request(&s.db, id, body.command_id).await {
        Ok(request) => request,
        Err(e) => return err500(e),
    };
    if previous.is_none() {
        let report = match db::module_report(&s.db, id).await {
            Ok(Some(report)) => report.0,
            Ok(None) => {
                return crate::error::api_json_error(
                    StatusCode::CONFLICT,
                    "module_report_required",
                    "Update the agent and obtain a module report before requesting a disable.",
                )
            }
            Err(e) => return err500(e),
        };
        if report.get(body.module).revision != body.expected_revision {
            return crate::error::api_json_error(
                StatusCode::CONFLICT,
                "module_revision_conflict",
                "Module revision changed; refresh before requesting disable.",
            );
        }
    }
    let request = match db::create_module_disable(&s.db, id, body.module, body.expected_revision, body.command_id).await {
        Ok(Some(request)) => request,
        Ok(None) => return crate::error::api_json_error(StatusCode::CONFLICT,
            "disable_request_conflict", "Command ID was reused with different binding, or this module already has a pending request."),
        Err(e) => return err500(e),
    };
    if request.pending {
        let conn = {
            let mut control = s.control.lock();
            if matches!(request.module, Module::RemoteInput | Module::LiveScreen) {
                let conn = s.agents.lock().get(&id).map(|c| c.conn_id);
                if let Some(conn) = conn {
                    s.revoke_agent_control_locked(&mut control, id, conn);
                }
            }
            let agents = s.agents.lock();
            let mut runtimes = s.agent_modules.lock();
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
                            return (StatusCode::TOO_MANY_REQUESTS,Json(serde_json::json!({
                                "code":"module_retry_cooldown","error":"Wait before retrying this pending disable request.",
                                "command_id":request.command_id,"retry_after_ms":remaining.as_millis().max(1)
                            }))).into_response();
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
            if let Err(e) = s.replay_module_disables(id, conn).await {
                return err500(e);
            }
        }
    }

    db::insert_audit_log_traced(&s.db, &user.username, Some(id), "module_disable_request", "accepted",
        &serde_json::json!({"command_id":body.command_id,"module":body.module,"expected_revision":body.expected_revision}),
        audit_ip(&headers, addr).as_deref()).await;
    match db::module_disable_request(&s.db, id, body.command_id).await {
        Ok(Some(request)) => (StatusCode::ACCEPTED, Json(request)).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err500(e),
    }
}
