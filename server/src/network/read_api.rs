//! HTTP handlers for the bounded network management read contracts.
//!
//! All handlers live behind the existing session-cookie + CSRF middleware and
//! use the current OIDC `AuthUser`. Policy reads require an explicit
//! `network_admin` grant on the household in the URL; self-service enrollment
//! discovery requires the caller's own exact `network_enroll` grant AND active
//! binding (enforced by the query). No worker Bearer credential is accepted
//! here, no route writes state, and nothing reports applied/enforced/ack.

use std::sync::Arc;

use axum::extract::{Extension, Path, Query, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::AuthUser;
use crate::state::AppState;

use super::authz;
use super::policy_dto::valid_revision;
use super::read_db;
use super::read_dto::{build_diff, decode_stored, AuditQuery, DiffParams};

fn policy_not_found() -> ApiError {
    ApiError::not_found("policy revision not found in this household")
}

/// `GET /api/network/households/{hid}/policies/current`.
/// The newest SAVED policy revision, decoded from its exact stored bytes.
pub async fn policy_current(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let row = read_db::policy_row(&s.db, hid, None)
        .await?
        .ok_or_else(policy_not_found)?;
    let view = decode_stored(&row)?;
    Ok(Json(json!({ "policy": view })))
}

/// `GET /api/network/households/{hid}/policies/{revision}`.
/// An exact immutable revision in the SAME household; pruned or foreign ids
/// are an honest 404 and malformed bounds are a 400.
pub async fn policy_revision(
    Path((hid, raw_revision)): Path<(Uuid, String)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let revision = raw_revision
        .parse::<u64>()
        .ok()
        .filter(|v| valid_revision(*v))
        .ok_or_else(|| ApiError::bad_request("revision must be a positive integer"))?;
    let row = read_db::policy_row(&s.db, hid, Some(revision as i64))
        .await?
        .ok_or_else(policy_not_found)?;
    let view = decode_stored(&row)?;
    Ok(Json(json!({ "policy": view })))
}

/// `GET /api/network/households/{hid}/policies/diff?from_revision=N&to_revision=M`.
/// Bounded, deterministic semantic diff of two saved revisions. Both sources
/// must exist in this household; a pruned or foreign source is an honest 404.
pub async fn policy_diff(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<DiffParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (from_revision, to_revision) = params.revisions()?;
    let from_row = read_db::policy_row(&s.db, hid, Some(from_revision as i64))
        .await?
        .ok_or_else(policy_not_found)?;
    let to_row = if from_revision == to_revision {
        None
    } else {
        Some(
            read_db::policy_row(&s.db, hid, Some(to_revision as i64))
                .await?
                .ok_or_else(policy_not_found)?,
        )
    };
    let from = decode_stored(&from_row)?;
    let to = match to_row {
        Some(row) => decode_stored(&row)?,
        None => decode_stored(&from_row)?,
    };
    Ok(Json(json!({ "diff": build_diff(&from, &to) })))
}

/// Compatible extension of `GET /api/network/households/{hid}/audit`.
/// The previous `{ "rows": [...] }` shape and ordering are preserved;
/// `total`/`has_more`/`next_offset` are additive and share one snapshot.
pub async fn audit_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(query): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let filters = query.validate()?;
    let page = read_db::audit_page(&s.db, hid, &filters).await?;
    Ok(Json(json!(page)))
}

/// `GET /api/network/enrollment-contexts`.
/// Only the caller's own active principal bindings with an exact
/// `network_enroll` grant are returned. This is self-service discovery, not
/// administrative household discovery and not a runtime network identity.
pub async fn enrollment_contexts(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    validate_page_params(&page).map_err(ApiError::bad_request)?;
    let result =
        read_db::enrollment_contexts_page(&s.db, user.user_id, page.limit, page.offset).await?;
    Ok(Json(json!(result)))
}
