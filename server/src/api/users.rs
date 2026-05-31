//! Dashboard user accounts (admin).

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

use super::helpers::{audit_ip, err500};
// ─── Dashboard user management (admin-only) ───────────────────────────────────

#[derive(Deserialize)]
pub struct CreateUserBody {
    username: String,
    password: String,
    role: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
}

fn normalize_role(raw: Option<String>) -> Result<String, &'static str> {
    let r = raw.unwrap_or_else(|| "viewer".to_string());
    let t = r.trim().to_lowercase();
    if matches!(t.as_str(), "admin" | "operator" | "viewer") {
        Ok(t)
    } else {
        Err("role must be one of: admin, operator, viewer")
    }
}

pub async fn users_list(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    match db::dashboard_user_list(&s.db).await {
        Ok(rows) => Json(serde_json::json!({ "users": rows })).into_response(),
        Err(e) => err500(e),
    }
}

pub async fn users_create(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateUserBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let role = match normalize_role(body.role) {
        Ok(r) => r,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response()
        }
    };
    if body.username.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "username is required" })),
        )
            .into_response();
    }
    if body.password.len() < 6 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "password must be at least 6 characters" })),
        )
            .into_response();
    }
    let display_name =
        match normalize_profile_display_name(body.display_name.as_deref().unwrap_or("")) {
            Ok(v) => v,
            Err(msg) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": msg })),
                )
                    .into_response()
            }
        };
    let ip = audit_ip(&headers, addr);
    match db::dashboard_user_create(
        &s.db,
        body.username.trim(),
        &body.password,
        &role,
        display_name.as_str(),
    )
    .await
    {
        Ok(new_id) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_create",
                "ok",
                &serde_json::json!({ "user_id": new_id, "username": body.username.trim(), "role": role, "display_name": display_name }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "id": new_id })).into_response()
        }
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct PasswordBody {
    password: String,
}

#[derive(Deserialize)]
pub struct UserProfileBody {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    /// `None` = field omitted (no change). `Some(None)` = JSON null (clear icon). `Some(Some(s))` = set.
    #[serde(default)]
    display_icon: Option<Option<String>>,
}

fn normalize_profile_display_name(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim();
    if t.len() > 200 {
        return Err("display name must be at most 200 characters");
    }
    if t.chars().any(char::is_control) {
        return Err("display name may not contain control characters");
    }
    Ok(t.to_string())
}

fn normalize_profile_username(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("username must not be empty");
    }
    if t.len() > 128 {
        return Err("username must be at most 128 characters");
    }
    if t.chars().any(char::is_control) {
        return Err("username may not contain control characters");
    }
    Ok(t.to_string())
}

fn normalize_profile_display_icon_set(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("icon must not be blank (omit the field or send null to clear)");
    }
    // Stored as `icon:lucide:Name` (PascalCase, matches lucide-react export).
    if let Some(name) = t.strip_prefix("icon:lucide:") {
        if name.is_empty() {
            return Err("Lucide icon name is required");
        }
        if name.len() > 48 {
            return Err("Lucide icon name is too long");
        }
        if !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Lucide icon name must be alphanumeric (PascalCase)");
        }
        return Ok(format!("icon:lucide:{name}"));
    }
    // Client-resized JPEG/PNG/WebP/GIF data URL for a profile photo.
    if t.starts_with("data:image/") {
        const MAX_AVATAR_DATA_URL_BYTES: usize = 240_000;
        if t.len() > MAX_AVATAR_DATA_URL_BYTES {
            return Err("avatar image is too large");
        }
        let head = t.split(',').next().unwrap_or("").to_ascii_lowercase();
        let ok = head.starts_with("data:image/png;base64")
            || head.starts_with("data:image/jpeg;base64")
            || head.starts_with("data:image/jpg;base64")
            || head.starts_with("data:image/webp;base64")
            || head.starts_with("data:image/gif;base64");
        if !ok {
            return Err("avatar must be a PNG, JPEG, WebP, or GIF data URL");
        }
        if t.chars().any(char::is_control) {
            return Err("avatar data URL may not contain control characters");
        }
        return Ok(t.to_string());
    }
    if t.len() > 32 {
        return Err("icon must be at most 32 characters");
    }
    if t.chars().any(char::is_control) {
        return Err("icon may not contain control characters");
    }
    Ok(t.to_string())
}

pub async fn user_profile_update(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<UserProfileBody>,
) -> Response {
    if user.user_id != id && !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }

    if body.username.is_none() && body.display_icon.is_none() && body.display_name.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Provide username, display_name, and/or display_icon to update" })),
        )
            .into_response();
    }

    let profile_before = match db::dashboard_user_get_profile_bits(&s.db, id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let Some((current_username, _current_icon, current_display_name)) = profile_before else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "user not found" })),
        )
            .into_response();
    };

    let ip = audit_ip(&headers, addr);

    if let Some(raw_username) = body.username {
        let new_name = match normalize_profile_username(&raw_username) {
            Ok(v) => v,
            Err(msg) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": msg })),
                )
                    .into_response();
            }
        };
        if new_name != current_username {
            match db::dashboard_username_taken_by_other(&s.db, &new_name, id).await {
                Ok(true) => {
                    return (
                        StatusCode::CONFLICT,
                        Json(serde_json::json!({ "error": "That username is already taken" })),
                    )
                        .into_response();
                }
                Ok(false) => {}
                Err(e) => return err500(e),
            }
            if let Err(e) = db::dashboard_user_set_username(&s.db, id, &new_name).await {
                return err500(e);
            }
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_set_username",
                "ok",
                &serde_json::json!({ "user_id": id, "new_username": new_name }),
                ip.as_deref(),
            )
            .await;
        }
    }

    if let Some(raw_dn) = body.display_name {
        let new_dn = match normalize_profile_display_name(&raw_dn) {
            Ok(v) => v,
            Err(msg) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": msg })),
                )
                    .into_response();
            }
        };
        if new_dn != current_display_name {
            if let Err(e) = db::dashboard_user_set_display_name(&s.db, id, &new_dn).await {
                return err500(e);
            }
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_set_display_name",
                "ok",
                &serde_json::json!({ "user_id": id }),
                ip.as_deref(),
            )
            .await;
        }
    }

    if let Some(icon_outer) = body.display_icon {
        let icon_val: Option<String> = match icon_outer {
            None => None,
            Some(s) => match normalize_profile_display_icon_set(&s) {
                Ok(v) => Some(v),
                Err(msg) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "error": msg })),
                    )
                        .into_response();
                }
            },
        };
        if let Err(e) = db::dashboard_user_set_display_icon(&s.db, id, icon_val.as_deref()).await {
            return err500(e);
        }
        db::insert_audit_log_traced(
            &s.db,
            user.username.as_str(),
            None,
            "user_set_display_icon",
            "ok",
            &serde_json::json!({ "user_id": id, "cleared": icon_val.is_none() }),
            ip.as_deref(),
        )
        .await;
    }

    let profile_after = match db::dashboard_user_get_profile_bits(&s.db, id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    let Some((username, display_icon, display_name)) = profile_after else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "user not found" })),
        )
            .into_response();
    };

    Json(serde_json::json!({
        "ok": true,
        "id": id,
        "username": username,
        "display_name": display_name,
        "display_icon": display_icon,
    }))
    .into_response()
}

pub async fn user_set_password(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PasswordBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    if body.password.len() < 6 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "password must be at least 6 characters" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    match db::dashboard_user_set_password(&s.db, id, &body.password).await {
        Ok(()) => {
            // Revoke existing sessions so a stolen cookie can't survive a password reset.
            let revoked = db::dashboard_sessions_delete_for_user(&s.db, id)
                .await
                .unwrap_or(0);
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_set_password",
                "ok",
                &serde_json::json!({ "user_id": id, "sessions_revoked": revoked }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct RoleBody {
    role: String,
}

pub async fn user_set_role(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<RoleBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let role = match normalize_role(Some(body.role)) {
        Ok(r) => r,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": msg })),
            )
                .into_response()
        }
    };

    // Safety: do not allow demoting the last remaining admin.
    if role != "admin" {
        let is_target_admin = db::dashboard_user_is_admin(&s.db, id)
            .await
            .unwrap_or(false);
        if is_target_admin {
            let admin_count = db::dashboard_admin_count(&s.db).await.unwrap_or(0);
            if admin_count <= 1 {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "Cannot demote the last admin user" })),
                )
                    .into_response();
            }
        }
    }

    let ip = audit_ip(&headers, addr);
    match db::dashboard_user_set_role(&s.db, id, &role).await {
        Ok(()) => {
            // Force re-login so the new role takes effect immediately on existing sessions.
            let revoked = db::dashboard_sessions_delete_for_user(&s.db, id)
                .await
                .unwrap_or(0);
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_set_role",
                "ok",
                &serde_json::json!({ "user_id": id, "role": role, "sessions_revoked": revoked }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

pub async fn user_delete(
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
    if id == user.user_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "cannot delete your own user" })),
        )
            .into_response();
    }

    // Safety: do not allow deleting the last remaining admin.
    let is_target_admin = db::dashboard_user_is_admin(&s.db, id)
        .await
        .unwrap_or(false);
    if is_target_admin {
        let admin_count = db::dashboard_admin_count(&s.db).await.unwrap_or(0);
        if admin_count <= 1 {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Cannot delete the last admin user" })),
            )
                .into_response();
        }
    }

    let ip = audit_ip(&headers, addr);
    match db::dashboard_user_delete(&s.db, id).await {
        Ok(()) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "user_delete",
                "ok",
                &serde_json::json!({ "user_id": id }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

pub async fn user_identities(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    match db::dashboard_identities_for_user(&s.db, id).await {
        Ok(rows) => Json(serde_json::json!({ "identities": rows })).into_response(),
        Err(e) => err500(e),
    }
}

#[derive(Deserialize)]
pub struct IdentityLinkBody {
    issuer: String,
    subject: String,
}

pub async fn user_identity_link(
    Path(id): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<IdentityLinkBody>,
) -> Response {
    if !user.is_admin() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Forbidden" })),
        )
            .into_response();
    }
    let issuer = body.issuer.trim();
    let subject = body.subject.trim();
    if issuer.is_empty() || subject.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "issuer and subject are required" })),
        )
            .into_response();
    }
    let ip = audit_ip(&headers, addr);
    match db::dashboard_identity_link(&s.db, issuer, subject, id).await {
        Ok(()) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "identity_link",
                "ok",
                &serde_json::json!({ "user_id": id, "issuer": issuer, "subject": subject }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}

pub async fn identity_unlink(
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
    match db::dashboard_identity_unlink(&s.db, id).await {
        Ok(()) => {
            db::insert_audit_log_traced(
                &s.db,
                user.username.as_str(),
                None,
                "identity_unlink",
                "ok",
                &serde_json::json!({ "identity_id": id }),
                ip.as_deref(),
            )
            .await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => err500(e),
    }
}
