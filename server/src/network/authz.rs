//! Household-scoped authorization. This is the *only* source of network access:
//! platform roles (admin / operator / viewer) are deliberately not consulted, so
//! an operator or viewer can never acquire network rights implicitly.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkGrant {
    /// Full inventory CRUD plus grant management within one household.
    Admin,
    /// Reserved for a future, explicitly scoped network-events read endpoint.
    /// It does not authorize inventory reads or writes in this slice.
    Events,
    /// Explicit opt-in for authenticated BYOD enrollment only. It never grants
    /// inventory, policy, grant management or event-reading rights, and it is
    /// never implied by a platform role or by another network grant.
    Enroll,
}

impl NetworkGrant {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "network_admin",
            Self::Events => "network_events",
            Self::Enroll => "network_enroll",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "network_admin" => Some(Self::Admin),
            "network_events" => Some(Self::Events),
            "network_enroll" => Some(Self::Enroll),
            _ => None,
        }
    }
}

/// True only when an explicit grant row exists for this user + household.
pub async fn has_grant(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
    grant: NetworkGrant,
) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r"
        SELECT EXISTS (
            SELECT 1 FROM network_grants
            WHERE user_id = $1 AND household_id = $2 AND grant_name = $3
        )
        ",
    )
    .bind(user_id)
    .bind(household_id)
    .bind(grant.as_str())
    .fetch_one(pool)
    .await
}

/// Whether the caller administers at least one household. Used only to allow
/// creation of an *additional* household, never to widen access to existing ones.
pub async fn has_any_admin(pool: &PgPool, user_id: Uuid) -> sqlx::Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM network_grants WHERE user_id = $1 AND grant_name = 'network_admin')",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
}

/// Guard every household-scoped inventory route. Missing household, missing
/// grant and wrong household all return the same 403 so scopes cannot be probed.
pub async fn require_network_admin(
    pool: &PgPool,
    user_id: Uuid,
    household_id: Uuid,
) -> ApiResult<()> {
    match has_grant(pool, user_id, household_id, NetworkGrant::Admin).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ApiError::forbidden()),
        Err(e) => Err(ApiError::Internal(e.into())),
    }
}
