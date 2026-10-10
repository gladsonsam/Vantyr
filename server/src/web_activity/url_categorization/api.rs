//! URL categorization admin API (UT1 blacklists).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
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

pub async fn get_status(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let set = db::settings::get_settings(&s.db).await?;
    let active_sha: Option<String> = db::lists::active_release_sha(&s.db).await.ok().flatten();
    let category_count: i64 = db::lists::count_categories(&s.db).await.unwrap_or(0);
    let domain_count: i64 = db::lists::count_domain_entries(&s.db).await.unwrap_or(0);
    let url_count: i64 = db::lists::count_url_entries(&s.db).await.unwrap_or(0);
    let job = db::settings::job_status(&s.db).await.ok().flatten();
    Ok(Json(serde_json::json!({
        "settings": {
            "enabled": set.enabled,
            "auto_update": set.auto_update,
            "source_url": set.source_url,
            "last_update_at": set.last_update_at,
            "last_update_error": set.last_update_error,
        },
        "active_release": {
            "sha256": active_sha,
        },
        "counts": {
            "categories": category_count,
            "domains": domain_count,
            "urls": url_count,
        },
        "job": job,
    })))
}

#[derive(Debug, Deserialize)]
pub struct PutSettingsBody {
    enabled: bool,
    auto_update: bool,
    #[serde(default)]
    source_url: String,
}

pub async fn put_settings(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutSettingsBody>,
) -> ApiResult<Json<Value>> {
    let source_url = body.source_url.trim();
    if source_url.is_empty() {
        return Err(ApiError::bad_request("source_url is required"));
    }
    let ip = audit_ip(&headers, addr);
    db::settings::set_settings(&s.db, body.enabled, body.auto_update, source_url).await?;
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "set_url_categorization_settings",
        "ok",
        &serde_json::json!({
            "enabled": body.enabled,
            "auto_update": body.auto_update,
            "source_url": source_url,
        }),
        ip.as_deref(),
    )
    .await;
    get_status(State(s)).await
}

pub async fn post_update_now(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let ip = audit_ip(&headers, addr);
    let set = db::settings::get_settings(&s.db).await?;
    super::engine::spawn_update_job(s.db.clone(), set.source_url.clone());
    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_categorization_update_now",
        "ok",
        &serde_json::json!({ "source_url": set.source_url }),
        ip.as_deref(),
    )
    .await;
    get_status(State(s)).await
}

pub async fn list_categories(State(s): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let cats = db::categories::list_categories(&s.db).await?;
    Ok(Json(serde_json::json!({ "categories": cats })))
}

#[derive(Debug, Deserialize)]
pub struct PutCategoriesBody {
    categories: Vec<PutCategoryRow>,
}

#[derive(Debug, Deserialize)]
pub struct PutCategoryRow {
    key: String,
    enabled: bool,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

pub async fn put_categories(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutCategoriesBody>,
) -> ApiResult<Json<Value>> {
    if body.categories.len() > 512 {
        return Err(ApiError::bad_request("at most 512 categories per request"));
    }
    let ip = audit_ip(&headers, addr);
    let updates: Vec<db::categories::CategoryUpdate<'_>> = body
        .categories
        .iter()
        .filter_map(|c| {
            let key = c.key.trim();
            if key.is_empty() {
                return None;
            }
            let label = c
                .label
                .as_deref()
                .map(str::trim)
                .filter(|label| !label.is_empty());
            Some(db::categories::CategoryUpdate {
                key,
                enabled: c.enabled,
                label,
                description: c.description.as_deref().unwrap_or("").trim(),
            })
        })
        .collect();
    db::categories::set_categories(&s.db, &updates).await?;

    audit::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "set_url_category_enabled",
        "ok",
        &serde_json::json!({ "n": body.categories.len() }),
        ip.as_deref(),
    )
    .await;

    list_categories(State(s)).await
}
