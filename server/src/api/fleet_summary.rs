//! Read-only fleet enrichment; see server/fleet-summary-api.md.
use crate::{db, state::AppState};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::{collections::BTreeSet, sync::Arc};
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

pub async fn fleet_summary(
    Query(q): Query<FleetSummaryQuery>,
    State(s): State<Arc<AppState>>,
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
            Json(serde_json::json!({"agents": agents, "missing": missing})).into_response()
        }
        Err(e) => super::helpers::err500(e),
    }
}

#[cfg(test)]
#[path = "fleet_summary_tests.rs"]
mod tests;
