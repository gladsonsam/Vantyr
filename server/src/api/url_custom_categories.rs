//! Admin CRUD for custom URL categories (rollups on top of UT1 keys).

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
use sqlx::Row;

use crate::{auth, db, state::AppState};

use super::helpers::{audit_ip, err500};

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

pub async fn list_custom_categories(State(s): State<Arc<AppState>>) -> Response {
    let cats = sqlx::query(
        r"
        SELECT c.id, c.key, c.label_en, c.description_en, c.display_order, c.hidden, c.updated_at,
               COALESCE(m.member_count, 0)::bigint AS member_count
        FROM url_custom_categories c
        LEFT JOIN (
            SELECT custom_category_id, COUNT(*)::bigint AS member_count
            FROM url_custom_category_members
            GROUP BY custom_category_id
        ) m ON m.custom_category_id = c.id
        ORDER BY c.display_order ASC, c.label_en ASC, c.id ASC
        ",
    )
    .fetch_all(&s.db)
    .await;

    let members = sqlx::query(
        r"
        SELECT m.custom_category_id, m.ut1_key
        FROM url_custom_category_members m
        ORDER BY m.custom_category_id ASC, m.ut1_key ASC
        ",
    )
    .fetch_all(&s.db)
    .await;

    match (cats, members) {
        (Ok(cats), Ok(members)) => {
            let mut by_id: std::collections::HashMap<i64, Vec<String>> =
                std::collections::HashMap::new();
            for r in members {
                let id: i64 = r.try_get("custom_category_id").unwrap_or_default();
                let k: String = r.try_get("ut1_key").unwrap_or_default();
                by_id.entry(id).or_default().push(k);
            }
            let rows: Vec<serde_json::Value> = cats
                .iter()
                .map(|r| {
                    let id: i64 = r.try_get("id").unwrap_or_default();
                    serde_json::json!({
                        "id": id,
                        "key": r.try_get::<String,_>("key").unwrap_or_default(),
                        "label_en": r.try_get::<String,_>("label_en").unwrap_or_default(),
                        "description_en": r.try_get::<String,_>("description_en").unwrap_or_default(),
                        "display_order": r.try_get::<i32,_>("display_order").unwrap_or(0),
                        "hidden": r.try_get::<bool,_>("hidden").unwrap_or(false),
                        "updated_at": r.try_get::<chrono::DateTime<chrono::Utc>,_>("updated_at").unwrap_or_else(|_| chrono::Utc::now()),
                        "member_count": r.try_get::<i64,_>("member_count").unwrap_or(0),
                        "ut1_keys": by_id.get(&id).cloned().unwrap_or_default(),
                    })
                })
                .collect();
            Json(serde_json::json!({ "rows": rows })).into_response()
        }
        (Err(e), _) | (_, Err(e)) => err500(e.into()),
    }
}

pub async fn create_custom_category(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateCustomCategoryBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }

    let ip = audit_ip(&headers, addr);
    let key = body.key.trim().to_lowercase();
    if !validate_custom_key(&key) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid key (use lowercase letters, digits, _ or -)" }))).into_response();
    }
    let label_en = body.label_en.trim();
    if label_en.is_empty() || label_en.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "label_en is required (max 128 chars)" })),
        )
            .into_response();
    }
    let desc = body.description_en.trim();

    let row = sqlx::query(
        r"
        INSERT INTO url_custom_categories (key, label_en, description_en, display_order, hidden, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        RETURNING id
        ",
    )
    .bind(&key)
    .bind(label_en)
    .bind(desc)
    .bind(body.display_order)
    .bind(body.hidden)
    .fetch_one(&s.db)
    .await;

    match row {
        Ok(r) => {
            let id: i64 = r.try_get("id").unwrap_or_default();
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_custom_category_create",
                "ok",
                &serde_json::json!({ "id": id, "key": key, "label_en": label_en }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "id": id })).into_response()
        }
        Err(e) => err500(e.into()),
    }
}

pub async fn update_custom_category(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateCustomCategoryBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);

    let cur = sqlx::query("SELECT id, key, label_en, description_en, display_order, hidden FROM url_custom_categories WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.db)
        .await;
    let cur = match cur {
        Ok(c) => c,
        Err(e) => return err500(e.into()),
    };
    let Some(cur) = cur else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )
            .into_response();
    };

    let key: String = cur.try_get("key").unwrap_or_default();
    let cur_label: String = cur.try_get("label_en").unwrap_or_default();
    let next_label = body
        .label_en
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cur_label.as_str())
        .to_string();
    if next_label.is_empty() || next_label.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "label_en must be non-empty (max 128 chars)" })),
        )
            .into_response();
    }
    let next_desc = body.description_en.as_deref().map_or_else(
        || {
            cur.try_get::<String, _>("description_en")
                .unwrap_or_default()
        },
        |s| s.trim().to_string(),
    );
    let next_order = body
        .display_order
        .unwrap_or_else(|| cur.try_get::<i32, _>("display_order").unwrap_or(0));
    let next_hidden = body
        .hidden
        .unwrap_or_else(|| cur.try_get::<bool, _>("hidden").unwrap_or(false));

    let ok = sqlx::query(
        r"
        UPDATE url_custom_categories
        SET label_en = $2,
            description_en = $3,
            display_order = $4,
            hidden = $5,
            updated_at = NOW()
        WHERE id = $1
        ",
    )
    .bind(id)
    .bind(&next_label)
    .bind(&next_desc)
    .bind(next_order)
    .bind(next_hidden)
    .execute(&s.db)
    .await;

    match ok {
        Ok(r) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_custom_category_update",
                "ok",
                &serde_json::json!({ "id": id, "key": key, "rows": r.rows_affected() }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e.into()),
    }
}

pub async fn put_custom_category_members(
    Path(id): Path<i64>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PutMembersBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if body.ut1_keys.len() > 4096 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "too many members (max 4096)" })),
        )
            .into_response();
    }

    let ip = audit_ip(&headers, addr);

    // Ensure category exists.
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM url_custom_categories WHERE id = $1")
            .bind(id)
            .fetch_optional(&s.db)
            .await
            .ok()
            .flatten();
    if exists.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )
            .into_response();
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
        let missing = sqlx::query(
            r"
            SELECT k AS missing
            FROM UNNEST($1::text[]) AS k
            WHERE NOT EXISTS (SELECT 1 FROM url_categories c WHERE c.key = k)
            LIMIT 25
            ",
        )
        .bind(&keys)
        .fetch_all(&s.db)
        .await;
        if let Ok(missing) = missing {
            if !missing.is_empty() {
                let miss: Vec<String> = missing
                    .iter()
                    .map(|r| r.try_get::<String, _>("missing").unwrap_or_default())
                    .filter(|s| !s.is_empty())
                    .collect();
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "unknown UT1 keys in members", "missing": miss })),
                )
                    .into_response();
            }
        }
    }

    let mut tx = match s.db.begin().await {
        Ok(v) => v,
        Err(e) => return err500(e.into()),
    };
    if let Err(e) =
        sqlx::query("DELETE FROM url_custom_category_members WHERE custom_category_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
    {
        let _ = tx.rollback().await;
        return err500(e.into());
    }
    for k in &keys {
        if let Err(e) = sqlx::query(
            "INSERT INTO url_custom_category_members (custom_category_id, ut1_key) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(id)
        .bind(k)
        .execute(&mut *tx)
        .await
        {
            let _ = tx.rollback().await;
            return err500(e.into());
        }
    }
    if let Err(e) = tx.commit().await {
        return err500(e.into());
    }

    db::insert_audit_log_traced(
        &s.db,
        user.username.as_str(),
        None,
        "url_custom_category_members_put",
        "ok",
        &serde_json::json!({ "id": id, "count": keys.len() }),
        ip.as_deref(),
    )
    .await;

    Json(serde_json::json!({ "ok": true, "count": keys.len() })).into_response()
}

pub async fn delete_custom_category(
    Path(id): Path<i64>,
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
    let ok = sqlx::query("DELETE FROM url_custom_categories WHERE id = $1")
        .bind(id)
        .execute(&s.db)
        .await;
    match ok {
        Ok(r) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_custom_category_delete",
                "ok",
                &serde_json::json!({ "id": id, "rows": r.rows_affected() }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e.into()),
    }
}
