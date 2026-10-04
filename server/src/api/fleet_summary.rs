//! Read-only fleet enrichment; see server/fleet-summary-api.md.
use crate::{auth, db, state::AppState};
use axum::{
    extract::{ConnectInfo, Extension, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::{collections::BTreeSet, net::SocketAddr, sync::Arc};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct FleetSummaryQuery {
    pub ids: String,
}

fn parse_ids(raw: &str) -> Result<Vec<Uuid>, &'static str> {
    if raw.is_empty() || raw.len() > 8192 {
        return Err("ids must contain 1–100 unique UUIDs (maximum 8192 bytes)");
    }
    let mut ids = BTreeSet::new();
    for part in raw.split(',') {
        let id = Uuid::parse_str(part)
            .map_err(|_| "ids must be comma-separated UUIDs without empty entries")?;
        ids.insert(id);
        if ids.len() > 100 {
            return Err("ids supports at most 100 unique UUIDs");
        }
    }
    Ok(ids.into_iter().collect())
}

/// Same read authorization as the per-device info/windows endpoints (any
/// authenticated role). Those reads are audited, so one row covers the batch.
pub async fn fleet_summary(
    Query(q): Query<FleetSummaryQuery>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    connect: Option<ConnectInfo<SocketAddr>>,
) -> Response {
    let ids = match parse_ids(&q.ids) {
        Ok(ids) => ids,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error})),
            )
                .into_response()
        }
    };
    match db::fleet_summary_batch(&s.db, &ids).await {
        Ok(agents) => {
            let missing: Vec<_> = ids.iter().filter(|id| !agents.contains_key(id)).collect();
            let ip = auth::client_ip_for_audit(&headers, connect.map(|c| c.0));
            let detail = serde_json::json!({ "requested": ids.len(), "returned": agents.len() });
            db::insert_audit_log_dedup_traced(
                &s.db,
                db::AuditLogDedup {
                    actor: user.username.as_str(),
                    agent_id: None,
                    action: "view_fleet_summary",
                    status: "ok",
                    detail: &detail,
                    dedup_window_secs: 15,
                    client_ip: ip.as_deref(),
                },
            )
            .await;
            Json(serde_json::json!({"agents": agents, "missing": missing})).into_response()
        }
        Err(e) => super::helpers::err500(e),
    }
}

#[cfg(test)]
#[path = "fleet_summary_tests.rs"]
mod tests;
