//! HTTP handlers for proxy sign-in credentials, sessions and evidence.
//!
//! Admin routes inherit the `/api` session-cookie + CSRF middleware and need an
//! explicit `network_admin` grant on the household in the URL path. Evidence
//! issuance needs the explicit `network_enroll` grant and an active binding.
//! Worker routes are cookie-free, top-level and need a scoped proxy-worker
//! Bearer with the opt-in `introspect_proxy` command. No handler here claims
//! DNS/proxy enforcement, inspection coverage or that a device is routed.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use chrono::Utc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::proxy_dto::{
    CredentialRow, EvidenceBody, IssueBody, RevokeAllBody, SessionRow, WorkerIntrospectBody,
    WorkerSyncBody,
};
use super::{api, authz, proxy_db, proxy_service};

fn bounds(page: &PageParams) -> ApiResult<(i64, i64)> {
    validate_page_params(page).map_err(ApiError::bad_request)?;
    Ok((page.limit, page.offset))
}

fn reject_json(rejection: JsonRejection) -> ApiError {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::status(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body exceeds the bound",
        )
    } else {
        ApiError::bad_request("invalid or unsupported request fields")
    }
}

// ─── Admin: credentials ──────────────────────────────────────────────────────

pub async fn credentials_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows: Vec<CredentialRow> = proxy_db::list_credentials(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "credentials": rows })))
}

pub async fn credential_issue(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<IssueBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let body = body.map_err(reject_json)?.0;
    let outcome =
        proxy_service::issue_credential(&s.db, hid, user.user_id, body, Utc::now()).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_proxy_credential_issue",
        json!({ "credential_id": outcome.credential.id, "device_id": outcome.credential.device_id }),
    )
    .await;
    // The plaintext secret is shown exactly ONCE here. It is never listed,
    // audited, logged or recoverable afterwards.
    Ok(Json(json!({
        "credential": outcome.credential,
        "secret": outcome.secret.expose(),
        "expires_at": outcome.expires_at,
        "network_coverage": "unverified",
        "note": "Sign-in evidence only. Not a gateway token, setup grant or inspection trust.",
    })))
}

pub async fn credential_revoke(
    Path((hid, cid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !proxy_db::credential_in_scope(&s.db, hid, cid).await? {
        return Err(ApiError::not_found(
            "proxy credential not found in this household",
        ));
    }
    if !proxy_service::revoke_one(&s.db, hid, user.user_id, cid, Utc::now()).await? {
        return Err(ApiError::not_found(
            "proxy credential not found in this household",
        ));
    }
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_proxy_credential_revoke",
        json!({ "credential_id": cid }),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "scope": "credential, its sessions and unexpired evidence",
        "live_tunnel_note": "Blocks new requests within the worker sync TTL; an established opaque CONNECT is not retroactively closed.",
    })))
}

pub async fn credentials_revoke_all(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<RevokeAllBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let body = body.map_err(reject_json)?.0;
    let revoked =
        proxy_service::revoke_all_for_person(&s.db, hid, user.user_id, body.person_id, Utc::now())
            .await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_proxy_credentials_revoke_all_for_person",
        json!({ "person_id": body.person_id, "revoked": revoked }),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "revoked": revoked,
        "scope": "all credentials, sessions and unexpired evidence for this person id in this household",
    })))
}

// ─── Admin: sessions and access view ─────────────────────────────────────────

pub async fn sessions_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows: Vec<SessionRow> = proxy_db::list_sessions(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "sessions": rows })))
}

pub async fn session_end(
    Path((hid, sid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !proxy_service::end_session(&s.db, hid, user.user_id, sid, Utc::now()).await? {
        return Err(ApiError::not_found(
            "proxy session not found in this household",
        ));
    }
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_proxy_session_end",
        json!({ "session_id": sid }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "evidence": "invalidated" })))
}

pub async fn access(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let credentials = proxy_db::list_credentials(&s.db, hid, 100, 0).await?;
    let sessions = proxy_db::list_sessions(&s.db, hid, 100, 0).await?;
    let available = proxy_db::any_live_oidc_session(&s.db, hid).await?;
    Ok(Json(json!({
        "credentials": credentials,
        "sessions": sessions,
        "enrollment": if available {
            json!({ "available": true })
        } else {
            json!({ "available": false, "reason": "No active OIDC sign-in is available in this household." })
        },
        "network_coverage": "unverified",
    })))
}

// ─── Self: OIDC-backed evidence issuance ─────────────────────────────────────

pub async fn evidence_issue(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<EvidenceBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(reject_json)?.0;
    let outcome = proxy_service::issue_evidence(&s.db, hid, user.user_id, body, Utc::now()).await?;
    api::audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_proxy_evidence_issue",
        json!({ "expires_at": outcome.expires_at }),
    )
    .await;
    // Canonical JSON is returned once; only its digest is registered. The
    // person is derived from the OIDC-backed session, never from the body.
    let evidence = String::from_utf8(outcome.bytes)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("non-UTF8 evidence")))?;
    Ok(Json(json!({
        "evidence": evidence,
        "expires_at": outcome.expires_at,
        "status": "proxy_sign_in",
        "network_coverage": "unverified",
    })))
}

// ─── Worker: cookie-free scoped routes ───────────────────────────────────────

pub async fn worker_sync(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Json<WorkerSyncBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(reject_json)?.0;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let outcome = proxy_service::worker_sync(&s.db, bearer, body, Utc::now()).await?;
    Ok(Json(json!({
        "credentials": outcome.credentials,
        "assignments": outcome.assignments,
        "synced_at": Utc::now(),
    })))
}

pub async fn worker_introspect(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Json<WorkerIntrospectBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    let body = body.map_err(reject_json)?.0;
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let proof = proxy_service::worker_introspect(&s.db, bearer, body, Utc::now()).await?;
    Ok(Json(json!(proof)))
}

/// Worker router mounted outside `/api`. Rate limited and body-capped before
/// any handler or database work; the cookie/CSRF middleware never applies.
pub fn worker_routes() -> axum::Router<Arc<AppState>> {
    use axum::routing::post;
    use tower_governor::governor::GovernorConfigBuilder;
    use tower_governor::key_extractor::PeerIpKeyExtractor;
    use tower_governor::GovernorLayer;

    let config = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(5)
            .burst_size(20)
            .key_extractor(PeerIpKeyExtractor)
            .finish()
            .expect("static proxy worker rate limit config"),
    );
    axum::Router::new()
        .route("/worker/network/proxy/credentials/sync", post(worker_sync))
        .route(
            "/worker/network/proxy/evidence/introspect",
            post(worker_introspect),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .layer(GovernorLayer::new(config))
}

/// Admin proxy routes merged into the household-scoped `/api` router.
pub fn routes() -> axum::Router<Arc<AppState>> {
    use axum::routing::{delete, get, post};
    axum::Router::new()
        .route(
            "/network/households/{hid}/proxy/credentials",
            get(credentials_list).post(credential_issue),
        )
        .route(
            "/network/households/{hid}/proxy/credentials/revoke-all",
            post(credentials_revoke_all),
        )
        .route(
            "/network/households/{hid}/proxy/credentials/{cid}",
            delete(credential_revoke),
        )
        .route(
            "/network/households/{hid}/proxy/sessions",
            get(sessions_list),
        )
        .route(
            "/network/households/{hid}/proxy/sessions/{sid}",
            delete(session_end),
        )
        .route("/network/households/{hid}/proxy/access", get(access))
        .route(
            "/network/households/{hid}/proxy/evidence",
            post(evidence_issue),
        )
}
