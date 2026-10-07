//! Windows agent local settings-window password policy.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::RequireAdmin;
use crate::error::{ApiError, ApiResult};
use crate::{db, state::AppState};

// ─── Agent local UI password (Windows settings window) ───────────────────────

#[derive(Deserialize)]
pub struct LocalUiPasswordBody {
    /// Plaintext; `null` or omitted + empty string = no password (open) or clear override.
    #[serde(rename = "password")]
    _password: Option<String>,
}

fn device_owned_setting() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "device_owned_setting",
        "Set the local settings password on the device. Remote password changes are unsupported by device-owned module permissions.",
    )
}

pub async fn local_ui_password_global_get(
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let h = db::get_local_ui_global_hash(&s.db).await?;
    let password_set = db::agent_ui_password_is_set(h.as_deref());
    Ok(Json(serde_json::json!({ "password_set": password_set })))
}

pub async fn local_ui_password_global_put(
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LocalUiPasswordBody>,
) -> ApiError {
    let _ = (s, headers, addr, body);
    device_owned_setting()
}

pub async fn local_ui_password_agent_get(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
) -> ApiResult<Json<Value>> {
    let global = db::get_local_ui_global_hash(&s.db).await?;
    let global_set = db::agent_ui_password_is_set(global.as_deref());

    let ov = db::get_local_ui_override_hash(&s.db, id).await?;
    let override_json = match ov {
        None => serde_json::Value::Null,
        Some(h) => serde_json::json!({ "password_set": db::agent_ui_password_is_set(Some(&h)) }),
    };

    Ok(Json(serde_json::json!({
        "global": { "password_set": global_set },
        "override": override_json,
    })))
}

pub async fn local_ui_password_agent_put(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<LocalUiPasswordBody>,
) -> ApiError {
    let _ = (s, headers, addr, body, id);
    device_owned_setting()
}

pub async fn local_ui_password_agent_delete(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(_user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiError {
    let _ = (s, headers, addr, id);
    device_owned_setting()
}
