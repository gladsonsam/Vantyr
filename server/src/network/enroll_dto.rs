//! Request bodies and sanitized response rows for BYOD enrollment.
//!
//! Self-service bodies never carry a person id, dashboard user id, household id
//! or canonical device key. Those come from the authenticated session and the
//! URL path only. Admin mapping bodies explicitly name an existing dashboard
//! user and person; both are checked against the database before any write.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ─── Requests ────────────────────────────────────────────────────────────────

/// Admin-only: map an existing network person to an existing dashboard user.
#[derive(Debug, Deserialize)]
pub struct BindingBody {
    pub person_id: Uuid,
    pub user_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct DeviceAuthorizationBody {
    pub device_id: Uuid,
}

/// Self-registration creates a NEW device with a server-generated key. No id,
/// key, MAC, IP or assignment claim is accepted from the caller.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterDeviceBody {
    pub label: String,
    pub device_type: String,
    #[serde(default)]
    pub shared: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantRequest {
    pub device_id: Uuid,
    pub purpose: String,
    pub expires_in_secs: i64,
}

/// The secret is supplied only here, from the one-time issuance response. It is
/// never echoed, listed, audited or stored.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumeGrantBody {
    pub grant_id: Uuid,
    pub secret: String,
    pub purpose: String,
    pub device_id: Uuid,
}

// A diagnostic dump of the request must never reveal the presented secret.
impl std::fmt::Debug for ConsumeGrantBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConsumeGrantBody")
            .field("grant_id", &self.grant_id)
            .field("secret", &"<redacted>")
            .field("purpose", &self.purpose)
            .field("device_id", &self.device_id)
            .finish()
    }
}

// ─── Sanitized rows ──────────────────────────────────────────────────────────

/// Admin-only binding row. The three display fields are additive, read-only
/// projections from scoped joins to the SAME household's person and the
/// dashboard user explicitly named by the admin when the binding was created.
/// They are labels for the UI, never an identity claim and never a directory
/// lookup across households.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BindingRow {
    pub id: Uuid,
    pub dashboard_user: Uuid,
    pub person_id: Uuid,
    pub generation: i64,
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub dashboard_username: String,
    pub dashboard_display_name: String,
    pub person_display_name: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DeviceAuthorizationRow {
    pub id: Uuid,
    pub binding_id: Uuid,
    pub device_id: Uuid,
    pub generation: i64,
    pub status: String,
    pub authorized_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// Deliberately omits `canonical_key`, assignments and inventories: a user may
/// see only the household devices they are explicitly enrolled to use.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OwnDeviceRow {
    pub id: Uuid,
    pub label: String,
    pub device_type: String,
    pub shared: bool,
    pub enrollment_id: Uuid,
    pub enrollment_status: String,
}

/// Metadata only: no secret hash, no person profile payload.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OwnGrantRow {
    pub id: Uuid,
    pub device_id: Uuid,
    pub purpose: String,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// Metadata only. `status` is derived from end/expiry times; no claim about
/// DNS/proxy coverage is made anywhere in this response. `person_display_name`
/// is the label of the person bound to the CALLER's own binding in this
/// household; it is not an inference from a device, IP or network observation.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct OwnSessionRow {
    pub id: Uuid,
    pub device_id: Uuid,
    pub purpose: String,
    pub verification_method: String,
    pub verified_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub person_display_name: String,
}
