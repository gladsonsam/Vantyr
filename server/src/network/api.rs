//! HTTP handlers. Every household id comes from the URL path and is authorized
//! against the caller's explicit grants before any row is read or written.
//! Sensitive details go only to household-scoped `network_audit`; the globally
//! readable platform audit log gets a generic marker with no ids or keys.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Extension, Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::pagination::{validate_page_params, PageParams};
use crate::http::{audit_ip, AuthUser, RequireAdmin};
use crate::network::{authz, db, dto, mutation_service, service};
use crate::state::AppState;

pub(super) async fn audit_network(
    state: &AppState,
    user: &AuthUser,
    ip: Option<&str>,
    household_id: Uuid,
    action: &str,
    detail: Value,
) {
    if let Err(e) =
        db::insert_network_audit(&state.db, household_id, &user.username, ip, action, &detail).await
    {
        tracing::warn!(error = %e, action, "network audit insert failed");
    }
    // `/api/audit` is readable by every authenticated session: only a generic
    // marker belongs here, never device keys, person/agent ids or scope ids.
    crate::platform::audit::insert_audit_log_traced(
        &state.db,
        user.username.as_str(),
        None,
        "network_action",
        "ok",
        &json!({}),
        ip,
    )
    .await;
}

fn bounds(params: &PageParams) -> ApiResult<(i64, i64)> {
    validate_page_params(params).map_err(ApiError::bad_request)?;
    Ok((params.limit, params.offset))
}

// ─── Bootstrap / households ──────────────────────────────────────────────────

/// One-time, admin-only creation of the single default household and the
/// caller's explicit network_admin grant. No platform role elsewhere implies
/// this grant.
pub async fn bootstrap(
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::BootstrapBody>,
) -> ApiResult<Json<Value>> {
    let name = dto::normalize_text(&body.name, "name", 120).map_err(ApiError::bad_request)?;
    let timezone = dto::normalize_timezone(&body.timezone).map_err(ApiError::bad_request)?;
    let household_id = service::bootstrap_default_household(&s.db, &user, &name, &timezone).await?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        household_id,
        "network_bootstrap",
        json!({ "household_id": household_id, "name": name, "timezone": timezone }),
    )
    .await;
    Ok(Json(json!({ "household_id": household_id })))
}

pub async fn households_list(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_admin_households(&s.db, user.user_id, limit, offset).await?;
    Ok(Json(json!({ "households": rows })))
}

/// Create an additional household plus its creator grant in one transaction.
pub async fn household_create(
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::CreateHouseholdBody>,
) -> ApiResult<Json<Value>> {
    match authz::has_any_admin(&s.db, user.user_id).await {
        Ok(true) => {}
        Ok(false) => return Err(ApiError::forbidden()),
        Err(e) => return Err(ApiError::Internal(e.into())),
    }
    let name = dto::normalize_text(&body.name, "name", 120).map_err(ApiError::bad_request)?;
    let timezone = dto::normalize_timezone(&body.timezone).map_err(ApiError::bad_request)?;
    let household_id = service::create_household(&s.db, &user, &name, &timezone).await?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        household_id,
        "network_household_create",
        json!({ "household_id": household_id, "name": name }),
    )
    .await;
    Ok(Json(json!({ "household_id": household_id })))
}

// ─── Persons ─────────────────────────────────────────────────────────────────

pub async fn persons_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_persons(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "persons": rows })))
}

pub async fn person_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::CreatePersonBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let name = dto::normalize_text(&body.display_name, "display_name", 120)
        .map_err(ApiError::bad_request)?;
    let note =
        dto::normalize_optional_text(&body.note, "note", 1000).map_err(ApiError::bad_request)?;
    // Target validation, clearing the prior default and the insert all happen
    // in one household-locked transaction (see mutation_service).
    let id = mutation_service::create_person(
        &s.db,
        user.user_id,
        hid,
        &name,
        note.as_deref(),
        body.is_default_profile.unwrap_or(false),
    )
    .await?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_person_create",
        json!({ "person_id": id }),
    )
    .await;
    Ok(Json(json!({ "id": id })))
}

pub async fn person_patch(
    Path((hid, pid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::PatchPersonBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if body.display_name.is_none() && body.note.is_none() && body.is_default_profile.is_none() {
        return Err(ApiError::bad_request("No fields to update"));
    }
    let name = body
        .display_name
        .as_deref()
        .map(|v| dto::normalize_text(v, "display_name", 120))
        .transpose()
        .map_err(ApiError::bad_request)?;
    let note = dto::normalize_note_patch(&body.note).map_err(ApiError::bad_request)?;
    let note_refs = note.as_ref().map(|n| n.as_deref());
    // A missing/foreign target must leave the current default untouched.
    let updated = mutation_service::patch_person(
        &s.db,
        user.user_id,
        hid,
        pid,
        name.as_deref(),
        note_refs.as_ref().copied(),
        body.is_default_profile,
    )
    .await?;
    if updated.is_none() {
        return Err(ApiError::not_found("person not found in this household"));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_person_update",
        json!({ "person_id": pid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ─── Devices (household-owned) ───────────────────────────────────────────────

pub async fn devices_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_devices(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "devices": rows })))
}

pub async fn device_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::CreateDeviceBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let key = dto::normalize_canonical_key(&body.canonical_key).map_err(ApiError::bad_request)?;
    let label = dto::normalize_text(&body.label, "label", 120).map_err(ApiError::bad_request)?;
    let device_type = dto::normalize_enum(
        &body.device_type,
        dto::DEVICE_TYPES,
        "unknown",
        "device_type",
    )
    .map_err(ApiError::bad_request)?;
    let id = match db::insert_device(
        &s.db,
        hid,
        &key,
        &label,
        &device_type,
        body.shared.unwrap_or(false),
    )
    .await
    {
        Ok(id) => id,
        Err(e) if crate::db::pg_is_unique_violation(&e) => {
            return Err(ApiError::conflict(
                "A device with that canonical_key already exists in this household",
            ))
        }
        Err(e) => return Err(e.into()),
    };
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_device_create",
        json!({ "device_id": id, "canonical_key": key }),
    )
    .await;
    Ok(Json(json!({ "id": id })))
}

pub async fn device_patch(
    Path((hid, did)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::PatchDeviceBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if body.label.is_none() && body.device_type.is_none() && body.shared.is_none() {
        return Err(ApiError::bad_request("No fields to update"));
    }
    let label = body
        .label
        .as_deref()
        .map(|v| dto::normalize_text(v, "label", 120))
        .transpose()
        .map_err(ApiError::bad_request)?;
    let device_type = body
        .device_type
        .as_deref()
        .map(|v| {
            dto::normalize_enum(
                &Some(v.to_string()),
                dto::DEVICE_TYPES,
                "unknown",
                "device_type",
            )
        })
        .transpose()
        .map_err(ApiError::bad_request)?;
    if !db::update_device(
        &s.db,
        hid,
        did,
        label.as_deref(),
        device_type.as_deref(),
        body.shared,
    )
    .await?
    {
        return Err(ApiError::not_found("device not found in this household"));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_device_update",
        json!({ "device_id": did }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ─── Assignments ─────────────────────────────────────────────────────────────

pub async fn assignments_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_assignments(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "assignments": rows })))
}

pub async fn assignment_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::CreateAssignmentBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !db::person_in_household(&s.db, hid, body.person_id).await? {
        return Err(ApiError::not_found("person not found in this household"));
    }
    if !db::device_in_household(&s.db, hid, body.device_id).await? {
        return Err(ApiError::not_found("device not found in this household"));
    }
    if let Some(agent_id) = body.agent_id {
        if !db::agent_enrolled_in_household(&s.db, hid, agent_id).await? {
            return Err(ApiError::bad_request(
                "agent is not enrolled in this household",
            ));
        }
    }
    let role = dto::normalize_enum(&body.role, dto::ASSIGNMENT_ROLES, "member", "role")
        .map_err(ApiError::bad_request)?;
    let note =
        dto::normalize_optional_text(&body.note, "note", 1000).map_err(ApiError::bad_request)?;
    let id = db::insert_assignment(
        &s.db,
        hid,
        body.person_id,
        body.device_id,
        body.agent_id,
        &role,
        body.active.unwrap_or(true),
        note.as_deref(),
    )
    .await
    .map_err(inventory_write_error)?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_assignment_create",
        json!({ "assignment_id": id }),
    )
    .await;
    Ok(Json(json!({ "id": id })))
}

pub async fn assignment_patch(
    Path((hid, aid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::PatchAssignmentBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if body.agent_id.is_none()
        && body.role.is_none()
        && body.active.is_none()
        && body.note.is_none()
    {
        return Err(ApiError::bad_request("No fields to update"));
    }
    if let Some(Some(agent_id)) = body.agent_id {
        if !db::agent_enrolled_in_household(&s.db, hid, agent_id).await? {
            return Err(ApiError::bad_request(
                "agent is not enrolled in this household",
            ));
        }
    }
    let role = body
        .role
        .as_deref()
        .map(|v| {
            dto::normalize_enum(
                &Some(v.to_string()),
                dto::ASSIGNMENT_ROLES,
                "member",
                "role",
            )
        })
        .transpose()
        .map_err(ApiError::bad_request)?;
    let note = dto::normalize_note_patch(&body.note).map_err(ApiError::bad_request)?;
    let note_refs = note.as_ref().map(|n| n.as_deref());
    if !db::update_assignment(
        &s.db,
        hid,
        aid,
        body.agent_id,
        role.as_deref(),
        body.active,
        note_refs.as_ref().copied(),
    )
    .await
    .map_err(inventory_write_error)?
    {
        return Err(ApiError::not_found(
            "assignment not found in this household",
        ));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_assignment_update",
        json!({ "assignment_id": aid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

/// Reference checks can race a conservative inventory delete. Never expose
/// PostgreSQL constraint details or turn a removed reference into a 500.
pub(super) fn inventory_write_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|db| db.is_foreign_key_violation())
    {
        ApiError::conflict("an inventory reference changed; reload and try again")
    } else {
        error.into()
    }
}

// ─── Connections ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ConnectionParams {
    kind: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub async fn connections_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(params): Query<ConnectionParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let page = PageParams {
        limit: params.limit.unwrap_or(50),
        offset: params.offset.unwrap_or(0),
    };
    let (limit, offset) = bounds(&page)?;
    let kind = match &params.kind {
        Some(k) => Some(
            dto::normalize_enum(&Some(k.clone()), dto::CONNECTION_KINDS, "agent", "kind")
                .map_err(ApiError::bad_request)?,
        ),
        None => None,
    };
    let rows = db::list_connections(&s.db, hid, kind.as_deref(), limit, offset).await?;
    Ok(Json(json!({ "connections": rows })))
}

pub async fn connection_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::CreateConnectionBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !db::device_in_household(&s.db, hid, body.device_id).await? {
        return Err(ApiError::not_found("device not found in this household"));
    }
    if let Some(assignment_id) = body.assignment_id {
        if !db::assignment_in_household(&s.db, hid, assignment_id).await? {
            return Err(ApiError::not_found(
                "assignment not found in this household",
            ));
        }
    }
    if let Some(agent_id) = body.enrolled_agent_id {
        if !db::agent_enrolled_in_household(&s.db, hid, agent_id).await? {
            return Err(ApiError::bad_request(
                "agent is not enrolled in this household",
            ));
        }
    }
    let kind = dto::normalize_enum(&Some(body.kind), dto::CONNECTION_KINDS, "agent", "kind")
        .map_err(ApiError::bad_request)?;
    let provenance =
        dto::normalize_enum(&body.provenance, dto::PROVENANCES, "manual", "provenance")
            .map_err(ApiError::bad_request)?;
    let status = dto::normalize_enum(&body.status, dto::CONNECTION_STATUSES, "unknown", "status")
        .map_err(ApiError::bad_request)?;
    let capabilities =
        dto::normalize_capabilities(&body.capabilities).map_err(ApiError::bad_request)?;
    let caps_json = Value::Array(capabilities.into_iter().map(Value::String).collect());
    let note =
        dto::normalize_optional_text(&body.note, "note", 1000).map_err(ApiError::bad_request)?;
    let id = db::insert_connection(
        &s.db,
        hid,
        body.device_id,
        body.assignment_id,
        body.enrolled_agent_id,
        &kind,
        &provenance,
        &caps_json,
        &status,
        body.observed_at,
        body.last_seen_at,
        body.revoked_at,
        note.as_deref(),
    )
    .await
    .map_err(inventory_write_error)?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_connection_create",
        json!({ "connection_id": id, "kind": kind }),
    )
    .await;
    Ok(Json(json!({ "id": id })))
}

pub async fn connection_patch(
    Path((hid, cid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::PatchConnectionBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if body.assignment_id.is_none()
        && body.enrolled_agent_id.is_none()
        && body.provenance.is_none()
        && body.capabilities.is_none()
        && body.status.is_none()
        && body.observed_at.is_none()
        && body.last_seen_at.is_none()
        && body.revoked_at.is_none()
        && body.note.is_none()
    {
        return Err(ApiError::bad_request("No fields to update"));
    }
    validate_optional_link(&s, hid, body.assignment_id, true).await?;
    validate_optional_link(&s, hid, body.enrolled_agent_id, false).await?;
    let provenance = body
        .provenance
        .as_deref()
        .map(|v| {
            dto::normalize_enum(
                &Some(v.to_string()),
                dto::PROVENANCES,
                "manual",
                "provenance",
            )
        })
        .transpose()
        .map_err(ApiError::bad_request)?;
    let status = body
        .status
        .as_deref()
        .map(|v| {
            dto::normalize_enum(
                &Some(v.to_string()),
                dto::CONNECTION_STATUSES,
                "unknown",
                "status",
            )
        })
        .transpose()
        .map_err(ApiError::bad_request)?;
    let caps_json = body
        .capabilities
        .as_ref()
        .map(|v| {
            dto::normalize_capabilities(&Some(v.clone()))
                .map(|items| Value::Array(items.into_iter().map(Value::String).collect()))
        })
        .transpose()
        .map_err(ApiError::bad_request)?;
    let note = dto::normalize_note_patch(&body.note).map_err(ApiError::bad_request)?;
    let note_refs = note.as_ref().map(|n| n.as_deref());
    if !db::update_connection(
        &s.db,
        hid,
        cid,
        body.assignment_id,
        body.enrolled_agent_id,
        provenance.as_deref(),
        caps_json.as_ref(),
        status.as_deref(),
        body.observed_at,
        body.last_seen_at,
        body.revoked_at,
        note_refs.as_ref().copied(),
    )
    .await
    .map_err(inventory_write_error)?
    {
        return Err(ApiError::not_found(
            "connection not found in this household",
        ));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_connection_update",
        json!({ "connection_id": cid }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

/// Validate a tri-state optional link before a PATCH. `assignment` selects the
/// in-scope assignment check; otherwise the in-scope enrolled-agent check.
async fn validate_optional_link(
    s: &AppState,
    hid: Uuid,
    value: Option<Option<Uuid>>,
    assignment: bool,
) -> ApiResult<()> {
    let Some(Some(id)) = value else {
        return Ok(());
    };
    let ok = if assignment {
        db::assignment_in_household(&s.db, hid, id).await?
    } else {
        db::agent_enrolled_in_household(&s.db, hid, id).await?
    };
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "linked object is not in this household",
        ))
    }
}

// ─── Explicit agent enrollment ───────────────────────────────────────────────

/// Requires BOTH platform admin approval and an explicit network_admin grant
/// on the target household. The existing fleet is a global admin/operator
/// model, so an operator (even with a household grant) cannot claim an agent;
/// household admins cannot claim arbitrary fleet UUIDs without platform admin.
/// No stronger pre-existing per-agent enrollment proof seam is available in
/// this slice; the link is explicit, audited and one-household-per-agent.
pub async fn enrollment_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    RequireAdmin(user): RequireAdmin,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::EnrollAgentBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    if !db::agent_exists(&s.db, body.agent_id).await? {
        return Err(ApiError::not_found("agent not found"));
    }
    if !db::insert_enrollment(&s.db, hid, body.agent_id, user.user_id).await? {
        return Err(ApiError::conflict(
            "agent is already enrolled in a household",
        ));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_agent_enroll",
        json!({ "agent_id": body.agent_id }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn enrollments_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_enrollments(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "enrollments": rows })))
}

// ─── Household-scoped audit ──────────────────────────────────────────────────

pub async fn audit_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(query): Query<crate::network::read_dto::AuditQuery>,
) -> ApiResult<Json<Value>> {
    // Kept as the mounted symbol for backwards compatibility; the bounded
    // read-contract module owns the filters, count and consistent snapshot.
    crate::network::read_api::audit_list(Path(hid), State(s), Extension(user), Query(query)).await
}

// ─── Grants ──────────────────────────────────────────────────────────────────

pub async fn grants_list(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Query(page): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let (limit, offset) = bounds(&page)?;
    let rows = db::list_grants(&s.db, hid, limit, offset).await?;
    Ok(Json(json!({ "grants": rows })))
}

pub async fn grant_create(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<dto::GrantBody>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let Some(grant) = authz::NetworkGrant::parse(&body.grant) else {
        return Err(ApiError::bad_request(
            "grant must be network_admin, network_events or network_enroll",
        ));
    };
    if !db::dashboard_user_exists(&s.db, body.user_id).await? {
        return Err(ApiError::not_found("dashboard user not found"));
    }
    let created = db::insert_grant(&s.db, hid, body.user_id, grant, user.user_id).await?;
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_grant_set",
        json!({ "user_id": body.user_id, "grant": grant.as_str(), "created": created }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "created": created })))
}

pub async fn grant_delete(
    Path((hid, uid, grant_name)): Path<(Uuid, Uuid, String)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let Some(grant) = authz::NetworkGrant::parse(&grant_name) else {
        return Err(ApiError::bad_request(
            "grant must be network_admin, network_events or network_enroll",
        ));
    };
    if !service::revoke_grant(&s.db, hid, uid, grant).await? {
        return Err(ApiError::not_found("grant not found"));
    }
    audit_network(
        &s,
        &user,
        audit_ip(&headers, addr).as_deref(),
        hid,
        "network_grant_revoke",
        json!({ "user_id": uid, "grant": grant.as_str() }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}
