//! Agent groups: named sets of agents used as policy and script scopes.

use std::sync::Arc;

use axum::{
    routing::{delete, get, put},
    Router,
};

use crate::state::AppState;

mod api;
pub mod db;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/agents/:id/groups",
            get(api::agent_agent_groups_for_agent_h),
        )
        .route(
            "/agent-groups",
            get(api::agent_groups_list_h).post(api::agent_groups_create_h),
        )
        .route(
            "/agent-groups/:group_id",
            put(api::agent_groups_update_h).delete(api::agent_groups_delete_h),
        )
        .route(
            "/agent-groups/:group_id/members",
            get(api::agent_group_members_list_h).post(api::agent_group_members_add_h),
        )
        .route(
            "/agent-groups/:group_id/members/:agent_id",
            delete(api::agent_group_member_remove_h),
        )
}
