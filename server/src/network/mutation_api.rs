//! HTTP handlers for bounded household/gateway configuration edits and
//! conservative inventory deletes. All routes inherit session cookie + CSRF
//! middleware from `/api`, require an explicit `network_admin` grant on the
//! household in the URL, and recheck that grant under the mutation's row lock.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Extension, Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::http::{audit_ip, AuthUser};
use crate::state::AppState;

use super::mutation_dto::{DeleteResult, PatchGatewayBody, PatchHouseholdBody};
use super::{api, authz, mutation_service};

pub async fn household_patch(
    Path(hid): Path<Uuid>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<PatchHouseholdBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let body = body
        .map_err(|_| ApiError::bad_request("invalid or unsupported household patch fields"))?
        .0;
    let result = mutation_service::patch_household(&s.db, user.user_id, hid, body).await?;
    if !result.changed_fields.is_empty() {
        api::audit_network(
            &s,
            &user,
            audit_ip(&headers, addr).as_deref(),
            hid,
            "network_household_update",
            json!({ "changed_fields": result.changed_fields.clone() }),
        )
        .await;
    }
    Ok(Json(json!(result)))
}

pub async fn gateway_patch(
    Path((hid, gid)): Path<(Uuid, Uuid)>,
    State(s): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Result<Json<PatchGatewayBody>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    authz::require_network_admin(&s.db, user.user_id, hid).await?;
    let body = body
        .map_err(|_| ApiError::bad_request("invalid or unsupported gateway patch fields"))?
        .0;
    let result = mutation_service::patch_gateway(&s.db, user.user_id, hid, gid, body).await?;
    if !result.changed_fields.is_empty() {
        api::audit_network(
            &s,
            &user,
            audit_ip(&headers, addr).as_deref(),
            hid,
            "network_gateway_update",
            json!({
                "gateway_id": gid,
                "changed_fields": result.changed_fields.clone()
            }),
        )
        .await;
    }
    Ok(Json(json!(result)))
}

macro_rules! delete_handler {
    ($name:ident, $service:ident, $kind:expr, $action:expr, $id_name:expr) => {
        pub async fn $name(
            Path((hid, id)): Path<(Uuid, Uuid)>,
            State(s): State<Arc<AppState>>,
            Extension(user): Extension<AuthUser>,
            headers: HeaderMap,
            ConnectInfo(addr): ConnectInfo<SocketAddr>,
        ) -> ApiResult<Json<Value>> {
            authz::require_network_admin(&s.db, user.user_id, hid).await?;
            mutation_service::$service(&s.db, user.user_id, hid, id).await?;
            api::audit_network(
                &s,
                &user,
                audit_ip(&headers, addr).as_deref(),
                hid,
                $action,
                json!({ $id_name: id }),
            )
            .await;
            Ok(Json(json!(DeleteResult {
                ok: true,
                kind: $kind,
                id,
            })))
        }
    };
}

delete_handler!(
    person_delete,
    delete_person,
    "person",
    "network_person_delete",
    "person_id"
);
delete_handler!(
    device_delete,
    delete_device,
    "device",
    "network_device_delete",
    "device_id"
);
delete_handler!(
    assignment_delete,
    delete_assignment,
    "assignment",
    "network_assignment_delete",
    "assignment_id"
);
delete_handler!(
    connection_delete,
    delete_connection,
    "connection",
    "network_connection_delete",
    "connection_id"
);
