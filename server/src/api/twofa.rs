//! Per-user 2FA (TOTP) management. Mounted under the authenticated `/api` nest,
//! so `AuthUser` is always present (the user manages their own 2FA).

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;

use crate::{auth, db, state::AppState};

use super::helpers::err500;

#[derive(Deserialize)]
pub struct CodeBody {
    #[serde(default)]
    code: String,
}

fn bad(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": msg })),
    )
        .into_response()
}

pub async fn twofa_status(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    match db::dashboard_user_totp_get(&s.db, user.user_id).await {
        Ok((secret, enabled)) => Json(serde_json::json!({
            "enabled": enabled,
            "pending": secret.is_some() && !enabled,
        }))
        .into_response(),
        Err(e) => err500(e),
    }
}

/// Begin enrollment: generate a fresh secret (stored pending) and return it for
/// the authenticator app. 2FA is not active until `twofa_enable` verifies a code.
pub async fn twofa_setup(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
) -> Response {
    let (secret, uri) = match crate::twofa::generate_secret(&user.username) {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    if let Err(e) = db::dashboard_user_totp_set_pending(&s.db, user.user_id, &secret).await {
        return err500(e);
    }
    Json(serde_json::json!({ "secret": secret, "otpauth_uri": uri })).into_response()
}

pub async fn twofa_enable(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    Json(body): Json<CodeBody>,
) -> Response {
    let (secret, enabled) = match db::dashboard_user_totp_get(&s.db, user.user_id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    if enabled {
        return bad("Two-factor authentication is already enabled");
    }
    let Some(secret) = secret else {
        return bad("Start 2FA setup before enabling");
    };
    if !crate::twofa::verify(&secret, body.code.trim()) {
        return bad("Invalid code");
    }
    if let Err(e) = db::dashboard_user_totp_enable(&s.db, user.user_id).await {
        return err500(e);
    }
    // Issue recovery codes: stored Argon2-hashed, shown to the user exactly once.
    let codes = crate::twofa::generate_recovery_codes(10);
    let hashes: Result<Vec<String>, _> =
        codes.iter().map(|c| db::hash_dashboard_password(c)).collect();
    let hashes = match hashes {
        Ok(h) => h,
        Err(e) => return err500(e),
    };
    if let Err(e) = db::dashboard_recovery_codes_replace(&s.db, user.user_id, &hashes).await {
        return err500(e);
    }
    db::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "twofa_enabled",
        "ok",
        &serde_json::json!({}),
        None,
    )
    .await;
    Json(serde_json::json!({ "ok": true, "recovery_codes": codes })).into_response()
}

pub async fn twofa_disable(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<auth::AuthUser>,
    Json(body): Json<CodeBody>,
) -> Response {
    let (secret, enabled) = match db::dashboard_user_totp_get(&s.db, user.user_id).await {
        Ok(v) => v,
        Err(e) => return err500(e),
    };
    if !enabled {
        return Json(serde_json::json!({ "ok": true })).into_response();
    }
    // Require a valid current code (or recovery code) to turn 2FA off.
    let valid = secret
        .as_deref()
        .is_some_and(|sec| crate::twofa::verify(sec, body.code.trim()))
        || db::dashboard_recovery_code_consume(&s.db, user.user_id, body.code.trim())
            .await
            .unwrap_or(false);
    if !valid {
        return bad("Invalid code");
    }
    if let Err(e) = db::dashboard_user_totp_disable(&s.db, user.user_id).await {
        return err500(e);
    }
    db::insert_audit_log_traced(
        &s.db,
        &user.username,
        None,
        "twofa_disabled",
        "ok",
        &serde_json::json!({}),
        None,
    )
    .await;
    Json(serde_json::json!({ "ok": true })).into_response()
}
