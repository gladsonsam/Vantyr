//! Errors never carry the API key or a response body. Only endpoint labels,
//! status classes and field paths appear here, so `Debug`/`Display` are safe to
//! log.

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum Error {
    #[error("invalid controller configuration: {0}")]
    InvalidConfig(String),

    #[error("site {0} is not in the configured allowlist")]
    SiteNotAllowed(String),

    #[error("operation {0} is unsupported by the documented controller contract")]
    Unsupported(&'static str),

    #[error("operation {0} is unavailable on the controller")]
    Unavailable(&'static str),

    #[error("controller authentication or authorization was denied")]
    AuthDenied,

    #[error("requested controller resource was not found")]
    Missing,

    #[error("response for {0} was malformed")]
    Malformed(&'static str),

    #[error("response for {0} exceeded the configured byte limit")]
    LimitExceeded(&'static str),

    #[error("pagination for {0} did not advance")]
    NonAdvancingPagination(&'static str),

    #[error("transport failure for {0}")]
    Transport(&'static str),

    #[error("invalid plan: {0}")]
    InvalidPlan(String),

    #[error("plan has expired")]
    PlanExpired,

    #[error("plan is stale: controller state changed after it was built")]
    StalePlan,

    #[error("conflict at field {0}: controller state changed after the plan was built")]
    Conflict(String),
}
