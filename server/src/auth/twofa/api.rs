//! Per-user 2FA (TOTP) management. Mounted under the authenticated `/api` nest,
//! so `AuthUser` is always present (the user manages their own 2FA).

use std::sync::Arc;

use axum::{extract::State, Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::secrets;
use crate::auth::users::db;
use crate::error::{ApiError, ApiResult};
use crate::http::AuthUser;
use crate::platform::audit;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CodeBody {
    #[serde(default)]
    code: String,
}

pub async fn twofa_status(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let (secret, enabled) = db::totp::dashboard_user_totp_get(&s.db, user.user_id).await?;
    Ok(Json(serde_json::json!({
        "enabled": enabled,
        "pending": secret.is_some() && !enabled,
    })))
}

/// Begin enrollment: generate a fresh secret (stored pending) and return it for
/// the authenticator app. 2FA is not active until `twofa_enable` verifies a code.
pub async fn twofa_setup(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let (secret, uri) = super::generate_secret(&user.username)?;
    db::totp::dashboard_user_totp_set_pending(&s.db, user.user_id, &secret).await?;
    Ok(Json(
        serde_json::json!({ "secret": secret, "otpauth_uri": uri }),
    ))
}

pub async fn twofa_enable(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let (secret, enabled) = db::totp::dashboard_user_totp_get(&s.db, user.user_id).await?;
    if enabled {
        return Err(ApiError::bad_request(
            "Two-factor authentication is already enabled",
        ));
    }
    let Some(secret) = secret else {
        return Err(ApiError::bad_request("Start 2FA setup before enabling"));
    };
    if !super::verify(&secret, body.code.trim()) {
        return Err(ApiError::bad_request("Invalid code"));
    }
    db::totp::dashboard_user_totp_enable(&s.db, user.user_id).await?;
    // Issue recovery codes: stored Argon2-hashed, shown to the user exactly once.
    let codes = super::generate_recovery_codes(10);
    let hashes: Result<Vec<String>, _> = codes
        .iter()
        .map(|c| secrets::hash_dashboard_password(c))
        .collect();
    let hashes = hashes?;
    db::totp::dashboard_recovery_codes_replace(&s.db, user.user_id, &hashes).await?;
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "twofa_enabled",
        "ok",
        &serde_json::json!({}),
        None,
    )
    .await;
    Ok(Json(
        serde_json::json!({ "ok": true, "recovery_codes": codes }),
    ))
}

pub async fn twofa_disable(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<Value>> {
    let (secret, enabled) = db::totp::dashboard_user_totp_get(&s.db, user.user_id).await?;
    if !enabled {
        return Ok(Json(serde_json::json!({ "ok": true })));
    }
    // Require a valid current code (or recovery code) to turn 2FA off.
    let valid = secret
        .as_deref()
        .is_some_and(|sec| super::verify(sec, body.code.trim()))
        || crate::auth::users::service::consume_recovery_code(
            &s.db,
            user.user_id,
            body.code.trim(),
        )
        .await
        .unwrap_or(false);
    if !valid {
        return Err(ApiError::bad_request("Invalid code"));
    }
    db::totp::dashboard_user_totp_disable(&s.db, user.user_id).await?;
    audit::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "twofa_disabled",
        "ok",
        &serde_json::json!({}),
        None,
    )
    .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
