//! HTTP plumbing shared by every feature: request extractors, client-IP helpers,
//! pagination parameters, and the cross-cutting middleware stack.

mod client_ip;
mod extractors;
pub mod middleware;
pub mod pagination;
pub mod trusted_proxy;

pub use client_ip::{audit_ip, client_ip_for_audit};
pub use extractors::{AuthUser, RequireAdmin, RequireOperator};
