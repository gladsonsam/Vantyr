//! Windows agent local settings-window password policy.

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
use uuid::Uuid;

use crate::{auth, db, state::AppState};

use super::helpers::err500;
// ─── Agent local UI password (Windows settings window) ───────────────────────

#[derive(Deserialize)]
pub struct LocalUiPasswordBody {
    /// Plaintext; `null` or omitted + empty string = no password (open) or clear override.
    #[serde(rename = "password")]
    _password: Option<String>,
}

pub async fn local_ui_password_global_get(State(s): State<Arc<AppState>>) -> Response {
    match db::get_local_ui_global_hash(&s.db).await {
        Ok(h) => {
            let password_set = db::agent_ui_password_is_set(h.as_deref());
            Json(serde_json::json!({ "password_set": password_set })).into_response()
        }
        Err(e) => err500(e),
    }
}

pub async fn local_ui_password_global_put(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LocalUiPasswordBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let _ = (s, headers, addr, body);
    crate::error::api_json_error(StatusCode::CONFLICT,"device_owned_setting","Set the local settings password on the device. Remote password changes are unsupported by device-owned module permissions.")
}

pub async fn local_ui_password_agent_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> Response {
    let global = match db::get_local_ui_global_hash(&s.db).await {
        Ok(h) => h,
        Err(e) => return err500(e),
    };
    let global_set = db::agent_ui_password_is_set(global.as_deref());

    let ov = match db::get_local_ui_override_hash(&s.db, id).await {
        Ok(h) => h,
        Err(e) => return err500(e),
    };
    let override_json = match ov {
        None => serde_json::Value::Null,
        Some(h) => serde_json::json!({ "password_set": db::agent_ui_password_is_set(Some(&h)) }),
    };

    Json(serde_json::json!({
        "global": { "password_set": global_set },
        "override": override_json,
    }))
    .into_response()
}

pub async fn local_ui_password_agent_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LocalUiPasswordBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let _ = (s, headers, addr, body, id);
    crate::error::api_json_error(StatusCode::CONFLICT,"device_owned_setting","Set the local settings password on the device. Remote password changes are unsupported by device-owned module permissions.")
}

pub async fn local_ui_password_agent_delete(
    Path(id): Path<Uuid>,
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
    let _ = (s, headers, addr, id);
    crate::error::api_json_error(StatusCode::CONFLICT,"device_owned_setting","Set the local settings password on the device. Remote password changes are unsupported by device-owned module permissions.")
}
