//! Audit log: the write API every feature uses to record actions, plus the read endpoint.

use std::sync::Arc;

use axum::{routing::get, Router};

use crate::state::AppState;

mod api;
mod db;

pub use db::{
    insert_audit_log, insert_audit_log_dedup_traced, insert_audit_log_traced, AuditLogDedup,
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/audit", get(api::audit_log))
}
