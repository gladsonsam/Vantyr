//! Admin CRUD for URL categorization overrides (persist across UT1 updates).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::Extension;
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sqlx::Row;

use crate::{auth, db, state::AppState, url_categorization};

use super::helpers::{audit_ip, err500};

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
) -> Response {
    let query = q.q.trim().to_lowercase();
    let limit = q.limit.clamp(1, 500);
    let offset = q.offset.max(0);

    let domain_rows = sqlx::query(
        r"
        SELECT o.id, 'domain' AS kind, o.domain AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_domain o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.domain ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(&query)
    .bind(limit)
    .bind(offset)
    .fetch_all(&s.db)
    .await;

    let url_rows = sqlx::query(
        r"
        SELECT o.id, 'url' AS kind, o.url_prefix AS value, c.key AS category_key,
               COALESCE(l.label_en, initcap(replace(replace(c.key, '_', ' '), '-', ' '))) AS category_label, o.note, o.created_at
        FROM url_category_overrides_url o
        JOIN url_categories c ON c.id = o.category_id
        LEFT JOIN url_category_labels l ON l.key = c.key
        WHERE ($1 = '' OR o.url_prefix ILIKE ('%' || $1 || '%') OR c.key ILIKE ('%' || $1 || '%'))
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3
        ",
    )
    .bind(&query)
    .bind(limit)
    .bind(offset)
    .fetch_all(&s.db)
    .await;

    match (domain_rows, url_rows) {
        (Ok(d), Ok(u)) => {
            let mut rows: Vec<serde_json::Value> = Vec::new();
            for r in d.into_iter().chain(u) {
                rows.push(serde_json::json!({
                    "id": r.try_get::<i64,_>("id").unwrap_or_default(),
                    "kind": r.try_get::<String,_>("kind").unwrap_or_else(|_| "domain".into()),
                    "value": r.try_get::<String,_>("value").unwrap_or_default(),
                    "category_key": r.try_get::<String,_>("category_key").unwrap_or_default(),
                    "category_label": r.try_get::<String,_>("category_label").unwrap_or_default(),
                    "note": r.try_get::<String,_>("note").unwrap_or_default(),
                    "created_at": r.try_get::<chrono::DateTime<chrono::Utc>,_>("created_at").unwrap_or_else(|_| chrono::Utc::now()),
                }));
            }
            Json(serde_json::json!({ "rows": rows })).into_response()
        }
        (Err(e), _) | (_, Err(e)) => err500(e.into()),
    }
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
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<AddOverrideBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let kind = body.kind.trim();
    let value_raw = body.value.trim();
    let key = body.category_key.trim();
    if value_raw.is_empty() || key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "value and category_key are required" })),
        )
            .into_response();
    }

    let ip = audit_ip(&headers, addr);
    let category_id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM url_categories WHERE key = $1")
            .bind(key)
            .fetch_optional(&s.db)
            .await
            .ok()
            .flatten();
    let Some(category_id) = category_id else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unknown category_key" })),
        )
            .into_response();
    };

    let note = body.note.trim().to_string();
    // Use a short lock timeout so the UI doesn't hang if another transaction
    // holds locks on the overrides tables (e.g., admin maintenance).
    let mut tx = match s.db.begin().await {
        Ok(v) => v,
        Err(e) => return err500(e.into()),
    };
    if let Err(e) = sqlx::query("SET LOCAL lock_timeout = '1s'")
        .execute(&mut *tx)
        .await
    {
        return err500(e.into());
    }
    if let Err(e) = sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await
    {
        return err500(e.into());
    }

    let res = if kind == "domain" {
        let domain = url_categorization::normalize_hostname(value_raw);
        if domain.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid domain" })),
            )
                .into_response();
        }
        sqlx::query(
            r"INSERT INTO url_category_overrides_domain (category_id, domain, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (domain) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
        )
        .bind(category_id)
        .bind(&domain)
        .bind(&note)
        .execute(&mut *tx)
        .await
        .map(|_| serde_json::json!({ "ok": true, "kind": "domain", "value": domain }))
    } else if kind == "url" {
        let url_prefix = if value_raw.to_lowercase().starts_with("http://")
            || value_raw.to_lowercase().starts_with("https://")
        {
            value_raw.to_string()
        } else {
            format!("https://{value_raw}")
        };
        sqlx::query(
            r"INSERT INTO url_category_overrides_url (category_id, url_prefix, note)
               VALUES ($1,$2,$3)
               ON CONFLICT (url_prefix) DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note
            ",
        )
        .bind(category_id)
        .bind(&url_prefix)
        .bind(&note)
        .execute(&mut *tx)
        .await
        .map(|_| serde_json::json!({ "ok": true, "kind": "url", "value": url_prefix }))
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "kind must be domain or url" })),
        )
            .into_response();
    };

    match res {
        Ok(payload) => {
            if let Err(e) = tx.commit().await {
                return err500(e.into());
            }
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_category_override_upsert",
                "ok",
                &serde_json::json!({ "kind": kind, "category_key": key, "note": note }),
                ip.as_deref(),
            )
            .await;
            Json(payload).into_response()
        }
        Err(e) => {
            let _ = tx.rollback().await;
            if is_lock_timeout(&e) {
                return (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({ "error": "Database busy applying overrides; please retry." })),
                )
                    .into_response();
            }
            err500(e.into())
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteOverrideQuery {
    kind: String,
    id: i64,
}

pub async fn delete_override(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<DeleteOverrideQuery>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let kind = q.kind.trim();
    let ip = audit_ip(&headers, addr);
    let ok = if kind == "domain" {
        sqlx::query("DELETE FROM url_category_overrides_domain WHERE id = $1")
            .bind(q.id)
            .execute(&s.db)
            .await
    } else if kind == "url" {
        sqlx::query("DELETE FROM url_category_overrides_url WHERE id = $1")
            .bind(q.id)
            .execute(&s.db)
            .await
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "kind must be domain or url" })),
        )
            .into_response();
    };
    match ok {
        Ok(r) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "url_category_override_delete",
                "ok",
                &serde_json::json!({ "kind": kind, "id": q.id, "rows": r.rows_affected() }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e.into()),
    }
}
