//! Vantyr Network — household inventory and explicit, household-scoped grants.
//!
//! Scope: PostgreSQL inventory (households, persons, shared devices,
//! assignments, connections), explicit agent enrollment and grant management,
//! plus the audited one-time bootstrap. All routes are mounted under `/api` by
//! `app::api_routes()` and therefore inherit the existing session + CSRF
//! middleware. Platform roles never imply a network grant: `authz` is the sole
//! authorization source, and every object id is checked against the household
//! from the URL path.
//!
//! Out of scope (deliberate seams for later slices): session verification
//! APIs, worker/runtime distribution, gateway token endpoints, events ingest,
//! and any DNS/proxy enforcement status derived from these rows.

use std::sync::Arc;

use axum::routing::{get, patch, post};
use axum::Router;

use crate::state::AppState;

mod api;
mod authz;
mod db;
mod dto;
mod service;

#[cfg(test)]
mod tests;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        // One-time, admin-only bootstrap and household provisioning.
        .route("/network/bootstrap", post(api::bootstrap))
        .route(
            "/network/households",
            get(api::households_list).post(api::household_create),
        )
        // Persons.
        .route(
            "/network/households/{hid}/persons",
            get(api::persons_list).post(api::person_create),
        )
        .route(
            "/network/households/{hid}/persons/{pid}",
            patch(api::person_patch),
        )
        // Devices (global inventory, visible per household via assignments).
        .route(
            "/network/households/{hid}/devices",
            get(api::devices_list).post(api::device_create),
        )
        .route(
            "/network/households/{hid}/devices/{did}",
            patch(api::device_patch),
        )
        // Person-to-device assignments.
        .route(
            "/network/households/{hid}/assignments",
            get(api::assignments_list).post(api::assignment_create),
        )
        .route(
            "/network/households/{hid}/assignments/{aid}",
            patch(api::assignment_patch),
        )
        // Connections with separate kind / provenance / capabilities / status.
        .route(
            "/network/households/{hid}/connections",
            get(api::connections_list).post(api::connection_create),
        )
        .route(
            "/network/households/{hid}/connections/{cid}",
            patch(api::connection_patch),
        )
        // Explicit enrollment of an existing agent into a household.
        .route(
            "/network/households/{hid}/agent-enrollments",
            get(api::enrollments_list).post(api::enrollment_create),
        )
        // Household-scoped grants.
        .route(
            "/network/households/{hid}/grants",
            get(api::grants_list).post(api::grant_create),
        )
        .route(
            "/network/households/{hid}/grants/{uid}/{grant}",
            axum::routing::delete(api::grant_delete),
        )
}
