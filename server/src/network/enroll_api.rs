//! HTTP handlers for authenticated BYOD enrollment.
//!
//! All routes inherit the existing OIDC session cookie + CSRF middleware and
//! read the immutable `AuthUser` from the request extension. Self-service
//! handlers never accept a person id, dashboard user id, household id, device
//! key or assignment claim from the body. Admin handlers require an explicit
//! `network_admin` grant; platform roles alone grant no network rights.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Extension, Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::authz;
use super::enroll_auth;
use super::enroll_db;
use super::enroll_dto;
use super::enroll_service;

fn bounds(params: &PageParams) -> ApiResult<(i64, i64)> {
    validate_page_params(params).map_err(ApiError::bad_request)?;
    Ok((params.limit, params.offset))
}

// ─── Admin: principal bindings ───────────────────────────────────────────────

pub async fn binding_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<enroll_dto::BindingBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let binding_id =
        enroll_service::map_binding(&s.db, hid, user.user_id, body.person_id, body.user_id).await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_principal_binding_set",
        json!({
            "binding_id": binding_id,
            "user_id": body.user_id,
            "person_id": body.person_id,
        }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "binding_id": binding_id })))
}

pub async fn bindings_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = enroll_db::list_bindings(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "bindings": rows })))
}

pub async fn binding_delete(
    Path((hid, bid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !enroll_service::revoke_binding(&s.db, hid, bid).await? {
        return Err(ApiError::not_found("principal binding not found"));
    }
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_principal_binding_revoked",
        json!({ "binding_id": bid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn device_authorization_create(
    Path((hid, bid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<enroll_dto::DeviceAuthorizationBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let enrollment_id =
        enroll_service::authorize_device(&s.db, hid, user.user_id, bid, body.device_id).await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_device_enrollment_authorized",
        json!({ "enrollment_id": enrollment_id, "binding_id": bid, "device_id": body.device_id }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "enrollment_id": enrollment_id })))
}

pub async fn device_authorizations_list(
    Path((hid, bid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = enroll_db::list_device_enrollments(&s.db, hid, bid, limit, offset).await?;
    // Explicit page window and truncation flag: a short page is never silently
    // presented as the complete set of device authorizations.
    Ok(Json(json!({
        "enrollments": rows,
        "limit": limit,
        "offset": offset,
        "returned": rows.len(),
        "truncated": rows.len() as i64 == limit,
    })))
}

// ─── Self: scoped device enrollment ──────────────────────────────────────────

pub async fn own_devices_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let rows = enroll_db::list_own_devices(&s.db, hid, binding.id).await?;
    Ok(Json(json!({ "devices": rows })))
}

pub async fn device_register(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<enroll_dto::RegisterDeviceBody>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let label = enroll_auth::normalize_label(&body.label)
        .map_err(|()| ApiError::bad_request("invalid label"))?;
    let device_type = enroll_auth::normalize_device_type(&body.device_type)
        .map_err(|()| ApiError::bad_request("device_type is not in the BYOD allowlist"))?;
    let device_id = enroll_service::self_register_device(
        &s.db,
        hid,
        user.user_id,
        &label,
        device_type,
        body.shared,
    )
    .await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_byod_device_registered",
        json!({ "device_id": device_id, "binding_id": binding.id, "shared": body.shared }),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "device_id": device_id,
        "status": "enrolled",
        "network_coverage": "unverified",
    })))
}

pub async fn device_enrollment_end(
    Path((hid, did)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    if !enroll_service::end_device_enrollment(&s.db, hid, user.user_id, did).await? {
        return Err(ApiError::not_found(
            "device is not enrolled to this account",
        ));
    }
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_byod_device_ended",
        json!({ "device_id": did, "binding_id": binding.id }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ─── Self: single-use grants and verified sessions ───────────────────────────

pub async fn grant_request(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<enroll_dto::GrantRequest>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let purpose = enroll_auth::normalize_purpose(&body.purpose)
        .map_err(|()| ApiError::bad_request("purpose is not in the enrollment allowlist"))?;
    let ttl = enroll_auth::normalize_grant_secs(body.expires_in_secs)
        .map_err(|()| ApiError::bad_request("expires_in_secs must be between 60 and 600"))?;
    let outcome =
        enroll_service::issue_grant(&s.db, hid, user.user_id, body.device_id, purpose, ttl).await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_enrollment_grant_issued",
        json!({
            "grant_id": outcome.grant_id,
            "binding_id": binding.id,
            "device_id": body.device_id,
            "purpose": purpose,
            "expires_at": outcome.expires_at,
        }),
    )
    .await;
    // The only plaintext secret ever returned. It is a one-time enrollment
    // grant, NOT a proxy credential, worker key or agent token.
    Ok(Json(json!({
        "grant_id": outcome.grant_id,
        "secret": outcome.secret.expose(),
        "household_id": outcome.household_id,
        "device_id": outcome.device_id,
        "purpose": outcome.purpose,
        "expires_at": outcome.expires_at,
        "status": "issued",
        "setup": "pending_setup",
        "network_coverage": "unverified",
        "note": "Scoped receipt only. No proxy credential, client trust material or DNS person identity is delivered by this endpoint.",
    })))
}

pub async fn own_grants_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let rows = enroll_db::list_own_grants(&s.db, hid, binding.id).await?;
    Ok(Json(json!({ "grants": rows })))
}

/// Consume a grant using the authenticated session + CSRF request. The actor is
/// always the `AuthUser`; a body-supplied user/person claim is not consulted.
pub async fn grant_consume(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<enroll_dto::ConsumeGrantBody>,
) -> ApiResult<Json<Value>> {
    let _binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let purpose = enroll_auth::normalize_purpose(&body.purpose)
        .map_err(|()| ApiError::bad_request("purpose is not in the enrollment allowlist"))?;
    let provided = enroll_auth::parse_provided_secret(&body.secret)
        .map_err(|()| ApiError::bad_request("invalid enrollment grant secret"))?;
    let outcome = enroll_service::consume_grant(
        &s.db,
        hid,
        user.user_id,
        body.grant_id,
        provided,
        purpose,
        body.device_id,
    )
    .await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_enrollment_grant_consumed",
        json!({
            "session_id": outcome.session_id,
            "device_id": outcome.device_id,
            "purpose": purpose,
        }),
    )
    .await;
    Ok(Json(json!({
        "session_id": outcome.session_id,
        "household_id": outcome.household_id,
        "device_id": outcome.device_id,
        "purpose": outcome.purpose,
        "verification_method": outcome.verification_method,
        "verified_at": outcome.verified_at,
        "expires_at": outcome.expires_at,
        "status": "verified_session",
        "network_coverage": "unverified_runtime_identity",
        "note": "OIDC/session evidence only. This does not establish that DNS or proxy traffic is routed, inspected or protected for a person on a shared device.",
    })))
}

pub async fn own_sessions_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let rows = enroll_db::list_own_sessions(&s.db, hid, binding.id).await?;
    Ok(Json(json!({ "sessions": rows })))
}

pub async fn session_end(
    Path((hid, sid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let (removed, grants_revoked) =
        enroll_service::end_session(&s.db, hid, user.user_id, sid).await?;
    if !removed {
        return Err(ApiError::not_found("verified session not found"));
    }
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_verified_session_ended",
        json!({
            "session_id": sid,
            "binding_id": binding.id,
            "grants_revoked": grants_revoked,
        }),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "grants_revoked": grants_revoked,
        "scope": "this device and binding only",
    })))
}

pub async fn sessions_end_all(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    let binding = enroll_service::require_enrollment(&s.db, hid, user.user_id).await?;
    let (ended, grants_revoked) =
        enroll_service::end_all_sessions(&s.db, hid, user.user_id).await?;
    super::api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_verified_sessions_logged_out",
        json!({
            "binding_id": binding.id,
            "ended": ended,
            "grants_revoked": grants_revoked,
        }),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "ended": ended,
        "grants_revoked": grants_revoked,
        "scope": "this household and binding only; dashboard session unaffected",
    })))
}
