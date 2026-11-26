//! Vantyr Network — household inventory and explicit, household-scoped grants.
//!
//! Scope: PostgreSQL inventory (households, persons, household-owned devices,
//! assignments, connections), explicit agent enrollment and grant management,
//! the audited one-time bootstrap and a household-scoped audit trail. Routes
//! are mounted under `/api` by `app::api_routes()`, inheriting session + CSRF.
//! Platform roles never imply a network grant: `authz` is the sole source of
//! inventory access, and every object id is checked against the household from
//! the URL path. A canonical key is unique per household, never globally.
//!
//! Connections carry a required household-owned device id; assignment and
//! verified enrollment are optional, so an agentless device can own a DNS
//! connection with no person. Reported status/capabilities are facts, not
//! enforcement. No DHCP server or router management exists here; router DHCP
//! stays outside Vantyr (DNS/Proxy only).
//!
//! In scope now: household-owned DNS/Proxy gateways with one-time scoped worker
//! credentials and a bearer-authenticated heartbeat that records unverified
//! observations only. Reports are retention-bounded (age + count) and never
//! carry enforcement or canary state. Durable, versioned policy rows and an
//! explicit desired assignment are SAVED PROPOSALS; a scoped `read_policy`
//! bearer credential may retrieve its own gateway's assigned policy. Retrieval
//! is not application: there is no applied/enforced flag and no ack endpoint.
//!
//! Out of scope (later slices): real worker apply/ack/canary integration,
//! receipt/verification, session verification APIs, events ingestion, and
//! router lease hints (read-only, never an identity claim).

use std::sync::Arc;

use axum::routing::{delete, get, patch, post};
use axum::Router;

use crate::state::AppState;

mod api;
mod authz;
mod db;
mod dto;
mod enroll_api;
mod enroll_auth;
mod enroll_db;
mod enroll_dto;
mod enroll_retention;
mod enroll_service;
mod gateway_api;
mod gateway_auth;
mod gateway_db;
mod gateway_dto;
mod gateway_retention;
mod gateway_service;
mod policy_api;
mod policy_db;
mod policy_dto;
mod policy_service;
mod read_api;
mod read_db;
mod read_dto;
mod service;

#[cfg(test)]
mod enroll_tests;
#[cfg(test)]
mod gateway_retention_tests;
#[cfg(test)]
mod gateway_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod read_tests;
#[cfg(test)]
mod tests;

// Kept public for the periodic retention task / tests; this slice enforces the
// same bounds on every write, so no core plumbing change is needed yet.
#[allow(unused_imports)]
pub use enroll_retention::{prune_enrollment_attempts, prune_enrollment_records};
pub use gateway_api::worker_routes;
pub use gateway_retention::prune_gateway_reports;

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
        // Household-owned devices.
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
        // Household-scoped audit and grants.
        .route("/network/households/{hid}/audit", get(api::audit_list))
        .route(
            "/network/households/{hid}/grants",
            get(api::grants_list).post(api::grant_create),
        )
        .route(
            "/network/households/{hid}/grants/{uid}/{grant}",
            axum::routing::delete(api::grant_delete),
        )
        // Vantyr Network gateways (DNS/Proxy) and their scoped worker credentials.
        .route(
            "/network/households/{hid}/gateways",
            get(gateway_api::gateways_list).post(gateway_api::gateway_create),
        )
        .route(
            "/network/households/{hid}/gateways/{gid}",
            axum::routing::delete(gateway_api::gateway_revoke),
        )
        .route(
            "/network/households/{hid}/gateways/{gid}/credentials",
            get(gateway_api::credentials_list).post(gateway_api::credential_issue),
        )
        .route(
            "/network/households/{hid}/gateways/{gid}/credentials/{cid}",
            axum::routing::delete(gateway_api::credential_revoke),
        )
        .route(
            "/network/households/{hid}/gateways/{gid}/credentials/{cid}/rotate",
            post(gateway_api::credential_rotate),
        )
        .route(
            "/network/households/{hid}/gateways/{gid}/reports",
            get(gateway_api::reports_list),
        )
        .merge(enroll_routes())
        .merge(policy_routes())
}

/// BYOD enrollment routes inherit session + CSRF from `app::api_routes()`.
/// Bodies are tiny; a small cap keeps hostile payloads out of deserialization.
fn enroll_routes() -> Router<Arc<AppState>> {
    Router::new()
        // Self-service discovery of the CALLER's own enrollment contexts only.
        // Must not become an administrative household-discovery route.
        .route(
            "/network/enrollment-contexts",
            get(read_api::enrollment_contexts),
        )
        // Admin-only: explicit binding of a real dashboard user to a person.
        .route(
            "/network/households/{hid}/bindings",
            get(enroll_api::bindings_list).post(enroll_api::binding_create),
        )
        .route(
            "/network/households/{hid}/bindings/{bid}",
            delete(enroll_api::binding_delete),
        )
        .route(
            "/network/households/{hid}/bindings/{bid}/device-authorizations",
            get(enroll_api::device_authorizations_list)
                .post(enroll_api::device_authorization_create),
        )
        // Self-service: only the caller's own enrollments/grants/sessions.
        .route(
            "/network/households/{hid}/enroll/devices",
            get(enroll_api::own_devices_list).post(enroll_api::device_register),
        )
        .route(
            "/network/households/{hid}/enroll/devices/{did}",
            delete(enroll_api::device_enrollment_end),
        )
        .route(
            "/network/households/{hid}/enroll/grants",
            get(enroll_api::own_grants_list).post(enroll_api::grant_request),
        )
        .route(
            "/network/households/{hid}/enroll/grants/consume",
            post(enroll_api::grant_consume),
        )
        .route(
            "/network/households/{hid}/enroll/sessions",
            get(enroll_api::own_sessions_list).delete(enroll_api::sessions_end_all),
        )
        .route(
            "/network/households/{hid}/enroll/sessions/{sid}",
            delete(enroll_api::session_end),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
}

/// Policy admin routes share a small request-body cap: the stored canonical
/// policy is bounded to 64 KiB, so a larger request is refused before any
/// deserialization or database work. Desired assignment bodies are smaller
/// still and use the same cap.
fn policy_routes() -> Router<Arc<AppState>> {
    Router::new()
        // Durable, versioned policy: publish/list/rollback (saved proposals only).
        .route(
            "/network/households/{hid}/policies",
            get(policy_api::policies_list).post(policy_api::policies_publish),
        )
        // Read contracts. The literal segments are registered before the
        // `{revision}` catch-all so they can never be parsed as a revision.
        .route(
            "/network/households/{hid}/policies/current",
            get(read_api::policy_current),
        )
        .route(
            "/network/households/{hid}/policies/diff",
            get(read_api::policy_diff),
        )
        .route(
            "/network/households/{hid}/policies/{revision}",
            get(read_api::policy_revision),
        )
        .route(
            "/network/households/{hid}/policies/rollback",
            post(policy_api::policies_rollback),
        )
        // Explicit desired assignment: saved/proposed, never applied/enforced.
        .route(
            "/network/households/{hid}/gateways/{gid}/desired-policy",
            get(policy_api::desired_get).put(policy_api::desired_set),
        )
        .layer(axum::extract::DefaultBodyLimit::max(128 * 1024))
}
