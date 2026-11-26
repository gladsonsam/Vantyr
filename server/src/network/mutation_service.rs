//! Atomic household/gateway edits, conservative deletes and default-profile
//! selection for the network management UI.
//!
//! Every mutator opens one transaction and locks the household row first. Grant
//! revocation uses the same lock, so the exact `network_admin` grant is
//! re-checked under the lock before any write. Delete mutators additionally
//! lock the target row `FOR UPDATE` and recount references in the same
//! transaction: a concurrent FK insert holds `FOR KEY SHARE` on that parent and
//! cannot slip past the check. No cascade is relied upon and none is widened.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::authz::{self, NetworkGrant};
use super::gateway_db;
use super::gateway_dto;
use super::mutation_db;
use super::mutation_dto::{
    GatewayPatchResult, HouseholdPatchResult, PatchGatewayBody, PatchHouseholdBody,
};
use super::{db, dto};

async fn require_admin_conn(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    household_id: Uuid,
) -> ApiResult<()> {
    let allowed = authz::has_grant_on_conn(conn, user_id, household_id, NetworkGrant::Admin)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden())
    }
}

fn scoped_not_found(what: &'static str) -> ApiError {
    ApiError::not_found(what)
}

/// Household configuration edit. Changing `timezone` is recorded configuration
/// only: no policy row is republished, no gateway assignment changes and no
/// worker enforcement claim is made.
pub async fn patch_household(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    body: PatchHouseholdBody,
) -> ApiResult<HouseholdPatchResult> {
    if body.is_empty() {
        return Err(ApiError::bad_request("no household fields to update"));
    }
    let name = body
        .name
        .as_deref()
        .map(|v| dto::normalize_text(v, "name", 120))
        .transpose()
        .map_err(ApiError::bad_request)?;
    let timezone = body
        .timezone
        .as_deref()
        .map(|v| dto::normalize_timezone(&Some(v.to_string())))
        .transpose()
        .map_err(ApiError::bad_request)?;

    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_conn(&mut tx, user_id, household_id).await?;
    let current = mutation_db::household_on_conn(&mut tx, household_id)
        .await?
        .ok_or_else(|| scoped_not_found("household not found"))?;

    let mut changed_fields = Vec::new();
    if name.as_deref().is_some_and(|v| v != current.name) {
        changed_fields.push("name");
    }
    if timezone.as_deref().is_some_and(|v| v != current.timezone) {
        changed_fields.push("timezone");
    }
    if !changed_fields.is_empty() {
        mutation_db::update_household_on_conn(
            &mut tx,
            household_id,
            name.as_deref(),
            timezone.as_deref(),
        )
        .await?;
    }
    let household = mutation_db::household_on_conn(&mut tx, household_id)
        .await?
        .ok_or_else(|| scoped_not_found("household not found"))?;
    tx.commit().await?;
    Ok(HouseholdPatchResult {
        household,
        changed_fields,
    })
}

/// Gateway label / enabled edit. `enabled` only controls whether existing
/// worker credentials are accepted; it never means applied or protected.
/// Disabling leaves credentials and their scopes untouched. Re-enabling a
/// revoked gateway is refused both here and in the UPDATE predicate.
pub async fn patch_gateway(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    gateway_id: Uuid,
    body: PatchGatewayBody,
) -> ApiResult<GatewayPatchResult> {
    if body.is_empty() {
        return Err(ApiError::bad_request("no gateway fields to update"));
    }
    let label = body
        .label
        .as_deref()
        .map(gateway_dto::normalize_label)
        .transpose()
        .map_err(ApiError::bad_request)?;
    let enabled = body.enabled;

    let mut tx = pool.begin().await?;
    if !gateway_db::lock_household_and_gateway(&mut tx, household_id, gateway_id).await? {
        return Err(scoped_not_found("gateway not found in this household"));
    }
    require_admin_conn(&mut tx, user_id, household_id).await?;
    let current = mutation_db::gateway_on_conn(&mut tx, household_id, gateway_id)
        .await?
        .ok_or_else(|| scoped_not_found("gateway not found in this household"))?;
    if enabled == Some(true) && current.revoked_at.is_some() {
        return Err(ApiError::conflict(
            "a revoked gateway cannot be re-enabled; register a new gateway",
        ));
    }

    let mut changed_fields = Vec::new();
    if label.as_deref().is_some_and(|v| v != current.label) {
        changed_fields.push("label");
    }
    if enabled.is_some_and(|v| v != current.enabled) {
        changed_fields.push("enabled");
    }
    if !changed_fields.is_empty() {
        mutation_db::update_gateway_on_conn(
            &mut tx,
            household_id,
            gateway_id,
            label.as_deref(),
            enabled,
        )
        .await?;
    }
    let gateway = mutation_db::gateway_on_conn(&mut tx, household_id, gateway_id)
        .await?
        .ok_or_else(|| scoped_not_found("gateway not found in this household"))?;
    tx.commit().await?;
    Ok(GatewayPatchResult {
        gateway,
        changed_fields,
    })
}

macro_rules! delete_mutator {
    ($name:ident, $locker:ident, $refs:expr, $deleter:ident, $missing:expr) => {
        pub async fn $name(
            pool: &PgPool,
            user_id: Uuid,
            household_id: Uuid,
            id: Uuid,
        ) -> ApiResult<()> {
            let mut tx = pool.begin().await?;
            db::lock_household(&mut tx, household_id).await?;
            require_admin_conn(&mut tx, user_id, household_id).await?;
            if !mutation_db::$locker(&mut tx, household_id, id).await? {
                return Err(scoped_not_found($missing));
            }
            let refs = $refs(&mut tx, household_id, id).await?;
            if let Some(reason) = refs.reason() {
                return Err(ApiError::conflict(reason));
            }
            mutation_db::$deleter(&mut tx, household_id, id).await?;
            tx.commit().await?;
            Ok(())
        }
    };
}

delete_mutator!(
    delete_person,
    person_for_delete_on_conn,
    mutation_db::person_refs_on_conn,
    delete_person_on_conn,
    "person not found in this household"
);
delete_mutator!(
    delete_device,
    device_for_delete_on_conn,
    mutation_db::device_refs_on_conn,
    delete_device_on_conn,
    "device not found in this household"
);

pub async fn delete_assignment(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    assignment_id: Uuid,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_conn(&mut tx, user_id, household_id).await?;
    if !mutation_db::assignment_for_delete_on_conn(&mut tx, household_id, assignment_id).await? {
        return Err(scoped_not_found("assignment not found in this household"));
    }
    let connections =
        mutation_db::assignment_refs_on_conn(&mut tx, household_id, assignment_id).await?;
    if connections > 0 {
        return Err(ApiError::conflict(
            "assignment has connections; remove them first",
        ));
    }
    mutation_db::delete_assignment_on_conn(&mut tx, household_id, assignment_id).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn delete_connection(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    connection_id: Uuid,
) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_conn(&mut tx, user_id, household_id).await?;
    let status =
        mutation_db::connection_status_on_conn(&mut tx, household_id, connection_id).await?;
    let Some(status) = status else {
        return Err(scoped_not_found("connection not found in this household"));
    };
    if status == "active" {
        return Err(ApiError::conflict(
            "connection is active; record it inactive or revoked first",
        ));
    }
    mutation_db::delete_connection_on_conn(&mut tx, household_id, connection_id).await?;
    tx.commit().await?;
    Ok(())
}

/// Create a person and, when requested, make it the sole default in one locked
/// transaction. A missing target can no longer clear an existing default.
pub async fn create_person(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    display_name: &str,
    note: Option<&str>,
    is_default_profile: bool,
) -> ApiResult<Uuid> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_conn(&mut tx, user_id, household_id).await?;
    let person_id =
        mutation_db::insert_person_on_conn(&mut tx, household_id, display_name, note).await?;
    if is_default_profile {
        mutation_db::clear_default_profile_on_conn(&mut tx, household_id, person_id).await?;
        mutation_db::set_default_profile_on_conn(&mut tx, household_id, person_id, true).await?;
    }
    tx.commit().await?;
    Ok(person_id)
}

/// Apply a person PATCH atomically. Returns `None` when the target is absent or
/// foreign; in that case no default is touched and the handler maps it to 404.
pub async fn patch_person(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    person_id: Uuid,
    display_name: Option<&str>,
    note: Option<Option<&str>>,
    is_default_profile: Option<bool>,
) -> ApiResult<Option<dto::Person>> {
    let mut tx = pool.begin().await?;
    db::lock_household(&mut tx, household_id).await?;
    require_admin_conn(&mut tx, user_id, household_id).await?;
    if !mutation_db::person_for_update_on_conn(&mut tx, household_id, person_id).await? {
        return Ok(None);
    }
    match is_default_profile {
        Some(true) => {
            mutation_db::clear_default_profile_on_conn(&mut tx, household_id, person_id).await?;
            mutation_db::set_default_profile_on_conn(&mut tx, household_id, person_id, true)
                .await?;
        }
        Some(false) => {
            mutation_db::set_default_profile_on_conn(&mut tx, household_id, person_id, false)
                .await?;
        }
        None => {}
    }
    if display_name.is_some() || note.is_some() {
        mutation_db::update_person_on_conn(&mut tx, household_id, person_id, display_name, note)
            .await?;
    }
    let person = mutation_db::person_on_conn(&mut tx, household_id, person_id).await?;
    tx.commit().await?;
    Ok(person)
}
