//! URL categorization admin API (UT1 blacklists).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sqlx::Row;

use crate::{auth, db, state::AppState, url_categorization};

use super::helpers::{audit_ip, err500};

pub async fn get_status(State(s): State<Arc<AppState>>) -> Response {
    match url_categorization::get_settings(&s.db).await {
        Ok(set) => {
            let active_sha: Option<String> = sqlx::query_scalar(
                "SELECT sha256 FROM url_categorization_release WHERE active = true ORDER BY id DESC LIMIT 1",
            )
            .fetch_optional(&s.db)
            .await
            .ok()
            .flatten();
            let category_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_categories")
                    .fetch_one(&s.db)
                    .await
                    .unwrap_or(0);
            let domain_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_category_domain_entries")
                    .fetch_one(&s.db)
                    .await
                    .unwrap_or(0);
            let url_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*)::bigint FROM url_category_url_entries")
                    .fetch_one(&s.db)
                    .await
                    .unwrap_or(0);
            let job = sqlx::query(
                "SELECT state, started_at, updated_at, bytes_total, bytes_done, message FROM url_categorization_job WHERE id = 1",
            )
            .fetch_optional(&s.db)
            .await
            .ok()
            .flatten()
            .map(|r| {
                let state: String = r.try_get("state").unwrap_or_else(|_| "idle".to_string());
                let started_at: Option<chrono::DateTime<chrono::Utc>> =
                    r.try_get("started_at").ok().flatten();
                let updated_at: chrono::DateTime<chrono::Utc> = r
                    .try_get("updated_at")
                    .unwrap_or_else(|_| chrono::Utc::now());
                let bytes_total: Option<i64> = r.try_get("bytes_total").ok().flatten();
                let bytes_done: i64 = r.try_get("bytes_done").unwrap_or(0);
                let message: Option<String> = r.try_get("message").ok().flatten();
                serde_json::json!({
                    "state": state,
                    "started_at": started_at,
                    "updated_at": updated_at,
                    "bytes_total": bytes_total,
                    "bytes_done": bytes_done,
                    "message": message,
                })
            });
            Json(serde_json::json!({
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
            }))
            .into_response()
        }
        Err(e) => err500(e),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutSettingsBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let source_url = body.source_url.trim();
    if source_url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "source_url is required" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    match url_categorization::set_settings(&s.db, body.enabled, body.auto_update, source_url).await
    {
        Ok(()) => {
            db::insert_audit_log_traced(
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
        Err(e) => err500(e),
    }
}

pub async fn post_update_now(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    let set = match url_categorization::get_settings(&s.db).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    url_categorization::spawn_update_job(s.db.clone(), set.source_url.clone());
    db::insert_audit_log_traced(
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

pub async fn list_categories(State(s): State<Arc<AppState>>) -> Response {
    let rows = sqlx::query(
        r"
        SELECT c.key,
               c.enabled,
               COALESCE(l.description_en, c.description, '') AS description,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS label
        FROM url_categories c
        LEFT JOIN url_category_labels l ON l.key = c.key
        ORDER BY c.key ASC
        ",
    )
    .fetch_all(&s.db)
    .await;
    match rows {
        Ok(rows) => {
            let cats: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    let key: String = r.try_get("key").unwrap_or_default();
                    let enabled: bool = r.try_get("enabled").unwrap_or(true);
                    let desc: String = r.try_get("description").unwrap_or_default();
                    let label: String = r.try_get("label").unwrap_or_else(|_| key.clone());
                    serde_json::json!({ "key": key, "label": label, "enabled": enabled, "description": desc })
                })
                .collect();
            Json(serde_json::json!({ "categories": cats })).into_response()
        }
        Err(e) => err500(e.into()),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutCategoriesBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if body.categories.len() > 512 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "at most 512 categories per request" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    let mut tx = match s.db.begin().await {
        Ok(t) => t,
        Err(e) => return err500(e.into()),
    };
    for c in &body.categories {
        let k = c.key.trim();
        if k.is_empty() {
            continue;
        }
        if let Err(e) = sqlx::query("UPDATE url_categories SET enabled = $1 WHERE key = $2")
            .bind(c.enabled)
            .bind(k)
            .execute(&mut *tx)
            .await
        {
            return err500(e.into());
        }
        if let Some(ref label_raw) = c.label {
            let label = label_raw.trim();
            if !label.is_empty() {
                let desc = c.description.as_deref().unwrap_or("").trim().to_string();
                if let Err(e) = sqlx::query(
                    r"
                    INSERT INTO url_category_labels (key, label_en, description_en, updated_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (key) DO UPDATE
                        SET label_en = EXCLUDED.label_en,
                            description_en = EXCLUDED.description_en,
                            updated_at = NOW()
                    ",
                )
                .bind(k)
                .bind(label)
                .bind(&desc)
                .execute(&mut *tx)
                .await
                {
                    return err500(e.into());
                }
            }
        }
    }
    if let Err(e) = tx.commit().await {
        return err500(e.into());
    }

    db::insert_audit_log_traced(
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
