//! Query pagination for history and audit endpoints.

use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct PageParams {
    #[serde(default = "default_limit")]
    pub(crate) limit: i64,
    #[serde(default)]
    pub(crate) offset: i64,
}

#[derive(Deserialize)]
pub struct AuditParams {
    pub(crate) agent_id: Option<Uuid>,
    pub(crate) action: Option<String>,
    pub(crate) status: Option<String>,
    #[serde(default = "default_limit")]
    pub(crate) limit: i64,
    #[serde(default)]
    pub(crate) offset: i64,
}

const fn default_limit() -> i64 {
    50
}

pub fn validate_page_params(p: &PageParams) -> Result<(), &'static str> {
    if !(1..=1000).contains(&p.limit) {
        return Err("limit must be between 1 and 1000");
    }
    if p.offset < 0 || p.offset > 100_000 {
        return Err("offset must be between 0 and 100000");
    }
    Ok(())
}

pub fn validate_audit_params(p: &AuditParams) -> Result<(), &'static str> {
    if !(1..=1000).contains(&p.limit) {
        return Err("limit must be between 1 and 1000");
    }
    if p.offset < 0 || p.offset > 100_000 {
        return Err("offset must be between 0 and 100000");
    }
    if let Some(ref s) = p.status {
        if !matches!(s.as_str(), "ok" | "error" | "rejected") {
            return Err("status must be one of: ok, error, rejected");
        }
    }
    Ok(())
}
