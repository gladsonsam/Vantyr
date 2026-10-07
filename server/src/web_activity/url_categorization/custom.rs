//! Admin CRUD for custom URL categories (rollups on top of UT1 keys).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
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

fn validate_custom_key(key: &str) -> bool {
    let k = key.trim();
    if k.is_empty() || k.len() > 64 {
        return false;
    }
    k.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

#[derive(Debug, Deserialize)]
pub struct CreateCustomCategoryBody {
    key: String,
    label_en: String,
    #[serde(default)]
    description_en: String,
    #[serde(default)]
    display_order: i32,
    #[serde(default)]
    hidden: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCustomCategoryBody {
    #[serde(default)]
    label_en: Option<String>,
    #[serde(default)]
    description_en: Option<String>,
    #[serde(default)]
    display_order: Option<i32>,
    #[serde(default)]
    hidden: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct PutMembersBody {
    ut1_keys: Vec<String>,
}

pub async fn list_custom_categories(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let rows = db::custom::list_custom_categories(&s.db).await?;
    Ok(Json(serde_json::json!({ "rows": rows })))
}

pub async fn create_custom_category(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateCustomCategoryBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let key = body.key.trim().to_lowercase();
    if !validate_custom_key(&key) {
        return Err(ApiError::bad_request(
            "invalid key (use lowercase letters, digits, _ or -)",
        ));
    }
    let label_en = body.label_en.trim();
    if label_en.is_empty() || label_en.len() > 128 {
        return Err(ApiError::bad_request(
            "label_en is required (max 128 chars)",
        ));
    }
    let desc = body.description_en.trim();

    let id = db::custom::create_custom_category(
        &s.db,
        &key,
        label_en,
        desc,
        body.display_order,
        body.hidden,
    )
    .await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_custom_category_create",
        "ok",
        &serde_json::json!({ "id": id, "key": key, "label_en": label_en }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "id": id })))
}

pub async fn update_custom_category(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateCustomCategoryBody>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);

    let cur = db::custom::get_custom_category(&s.db, id).await?;
    let Some(cur) = cur else {
        return Err(ApiError::not_found("not found"));
    };

    let key = cur.key;
    let cur_label = cur.label_en;
    let next_label = body
        .label_en
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cur_label.as_str())
        .to_string();
    if next_label.is_empty() || next_label.len() > 128 {
        return Err(ApiError::bad_request(
            "label_en must be non-empty (max 128 chars)",
        ));
    }
    let next_desc = body
        .description_en
        .as_deref()
        .map_or(cur.description_en, |s| s.trim().to_string());
    let next_order = body.display_order.unwrap_or(cur.display_order);
    let next_hidden = body.hidden.unwrap_or(cur.hidden);

    let rows_affected = db::custom::update_custom_category(
        &s.db,
        id,
        &next_label,
        &next_desc,
        next_order,
        next_hidden,
    )
    .await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_custom_category_update",
        "ok",
        &serde_json::json!({ "id": id, "key": key, "rows": rows_affected }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn put_custom_category_members(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutMembersBody>,
) -> ApiResult<Json<Value>> {
    if body.ut1_keys.len() > 4096 {
        return Err(ApiError::bad_request("too many members (max 4096)"));
    }

    let ip = audit_ip(&headers, addr);

    // Ensure category exists.
    let exists = db::custom::custom_category_exists(&s.db, id)
        .await
        .unwrap_or(false);
    if !exists {
        return Err(ApiError::not_found("not found"));
    }

    let mut keys: Vec<String> = body
        .ut1_keys
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty() && k.len() <= 128)
        .collect();
    keys.sort();
    keys.dedup();

    // Validate UT1 keys exist to avoid silent typos.
    if !keys.is_empty() {
        let missing = db::custom::unknown_ut1_keys(&s.db, &keys).await;
        if let Ok(missing) = missing {
            if !missing.is_empty() {
                let miss: Vec<String> = missing.into_iter().filter(|s| !s.is_empty()).collect();
                return Err(ApiError::Custom(
                    (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "error": "unknown UT1 keys in members", "missing": miss })),
                    )
                        .into_response(),
                ));
            }
        }
    }

    db::custom::replace_custom_category_members(&s.db, id, &keys).await?;

    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_custom_category_members_put",
        "ok",
        &serde_json::json!({ "id": id, "count": keys.len() }),
        ip.as_deref(),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true, "count": keys.len() })))
}

pub async fn delete_custom_category(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let rows_affected = db::custom::delete_custom_category(&s.db, id).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_custom_category_delete",
        "ok",
        &serde_json::json!({ "id": id, "rows": rows_affected }),
        ip.as_deref(),
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
