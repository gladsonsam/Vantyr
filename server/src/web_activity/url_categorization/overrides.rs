//! Admin CRUD for URL categorization overrides (persist across UT1 updates).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use super::db;
use crate::error::{ApiError, ApiResult};
use crate::http::RequireAdmin;
use crate::state::AppState;

use crate::http::audit_ip;
use crate::platform::audit;

fn is_lock_timeout(e: &sqlx::Error) -> bool {
    // Postgres lock_timeout typically surfaces as SQLSTATE 55P03 (lock_not_available).
    // statement_timeout is 57014 (query_canceled).
    match e {
        sqlx::Error::Database(db) => db.code().is_some_and(|c| c == "55P03"),
        _ => false,
    }
}

#[derive(Debug, Deserialize)]
pub struct OverridesQuery {
    #[serde(default)]
    q: String,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default = "default_offset")]
    offset: i64,
}

const fn default_limit() -> i64 {
    200
}
const fn default_offset() -> i64 {
    0
}

pub async fn list_overrides(
    State(s): State<Arc<AppState>>,
    Query(q): Query<OverridesQuery>,
) -> ApiResult<Json<Value>> {
    let query = q.q.trim().to_lowercase();
    let limit = q.limit.clamp(1, 500);
    let offset = q.offset.max(0);

    let rows = db::list_overrides(&s.db, &query, limit, offset).await?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

#[derive(Debug, Deserialize)]
pub struct AddOverrideBody {
    kind: String, // "domain" | "url"
    value: String,
    category_key: String,
    #[serde(default)]
    note: String,
}

pub async fn add_override(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AddOverrideBody>,
) -> ApiResult<Json<Value>> {
    let kind = body.kind.trim();
    let value_raw = body.value.trim();
    let key = body.category_key.trim();
    if value_raw.is_empty() || key.is_empty() {
        return Err(ApiError::bad_request("value and category_key are required"));
    }

    let ip = audit_ip(&headers, addr);
    let category_id: Option<i64> = db::category_id_by_key(&s.db, key).await.ok().flatten();
    let Some(category_id) = category_id else {
        return Err(ApiError::bad_request("unknown category_key"));
    };

    let note = body.note.trim().to_string();
    let (target, payload) = if kind == "domain" {
        let domain = super::engine::normalize_hostname(value_raw);
        if domain.is_empty() {
            return Err(ApiError::bad_request("invalid domain"));
        }
        let payload = serde_json::json!({ "ok": true, "kind": "domain", "value": domain });
        (db::OverrideTarget::Domain(domain), payload)
    } else if kind == "url" {
        let url_prefix = if value_raw.to_lowercase().starts_with("http://")
            || value_raw.to_lowercase().starts_with("https://")
        {
            value_raw.to_string()
        } else {
            format!("https://{value_raw}")
        };
        let payload = serde_json::json!({ "ok": true, "kind": "url", "value": url_prefix });
        (db::OverrideTarget::UrlPrefix(url_prefix), payload)
    } else {
        return Err(ApiError::bad_request("kind must be domain or url"));
    };

    match db::upsert_override(&s.db, category_id, &target, &note).await {
        Ok(()) => {}
        Err(db::OverrideWriteError::Insert(e)) if is_lock_timeout(&e) => {
            return Err(ApiError::conflict(
                "Database busy applying overrides; please retry.",
            ));
        }
        Err(db::OverrideWriteError::Insert(e) | db::OverrideWriteError::Tx(e)) => {
            return Err(e.into());
        }
    }
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_category_override_upsert",
        "ok",
        &serde_json::json!({ "kind": kind, "category_key": key, "note": note }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(payload))
}

#[derive(Debug, Deserialize)]
pub struct DeleteOverrideQuery {
    kind: String,
    id: i64,
}

pub async fn delete_override(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<DeleteOverrideQuery>,
) -> ApiResult<Json<Value>> {
    let kind = q.kind.trim();
    let ip = audit_ip(&headers, addr);
    let rows_affected = if kind == "domain" {
        db::delete_domain_override(&s.db, q.id).await?
    } else if kind == "url" {
        db::delete_url_override(&s.db, q.id).await?
    } else {
        return Err(ApiError::bad_request("kind must be domain or url"));
    };
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_category_override_delete",
        "ok",
        &serde_json::json!({ "kind": kind, "id": q.id, "rows": rows_affected }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
