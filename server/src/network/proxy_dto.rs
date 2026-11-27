//! Request bodies and sanitized response rows for proxy sign-in management.
//!
//! Bodies never carry a household id (it comes from the URL path) or an
//! asserted person identity. Every secret is redacted in `Debug` and is never
//! serialized into a row. `personLabel` is a display projection of an
//! explicitly resolved same-household principal; it is never an identity claim.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ─── Requests ────────────────────────────────────────────────────────────────

/// Admin issue body. `device_id` is optional: the server derives it from the
/// active OIDC-backed session when omitted. `scopes` is opt-in and allowlisted.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssueBody {
    pub person_id: Uuid,
    pub device_id: Option<Uuid>,
    pub label: String,
    pub expires_in_hours: i64,
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeAllBody {
    pub person_id: Uuid,
}

/// Evidence request by the signed-in user. The person is **not** supplied: it
/// is derived from the caller's OIDC-backed verified session.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceBody {
    pub credential_id: Uuid,
    pub command: String,
}

/// Worker sync body. The worker can only ask for its own scoped household and
/// gateway; the bearer credential is checked against both.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerSyncBody {
    pub audience: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub command: String,
}

/// Worker introspection body carrying the raw canonical evidence bytes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerIntrospectBody {
    pub audience: String,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub command: String,
    pub evidence: String,
}

// ─── Sanitized rows ──────────────────────────────────────────────────────────

/// Metadata only: no secret, no digest, no person payload. Status is derived
/// from `revoked`/`expires_at` by the UI, never from a stored "protected" badge.
/// Serialized in camelCase to match the staged `ProxyCredentialView`; the
/// database columns stay snake_case (`FromRow` is unaffected by serde rename).
#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRow {
    pub id: Uuid,
    pub label: String,
    pub person_id: Uuid,
    pub person_label: String,
    pub device_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked: bool,
    pub revoked_at: Option<DateTime<Utc>>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: Uuid,
    pub credential_id: Uuid,
    pub device_id: Uuid,
    pub person_id: Uuid,
    pub person_label: String,
    pub started_at: DateTime<Utc>,
    pub last_active_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked: bool,
}

/// Hash-only view sent to an authenticated, scoped proxy worker so it can
/// verify a presented secret locally. This digest is not a client secret and
/// is never returned on an admin route or logged.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WorkerCredentialRow {
    pub id: Uuid,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub secret_hash: String,
    pub binding_generation: i64,
    pub household_kind: String,
    pub scopes: Vec<String>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// Active assignments sent to an authenticated, scoped proxy worker. The
/// worker still filters by person, device and `active` locally; this is not a
/// central policy decision or a "protected" claim.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct WorkerAssignmentRow {
    pub id: Uuid,
    pub person_id: Uuid,
    pub device_id: Uuid,
    pub role: String,
    pub active: bool,
}

/// Bounded proof metadata returned only after the evidence digest was checked
/// and the single-use receipt atomically consumed. No display name, no secret.
#[derive(Debug, Clone, Serialize)]
pub struct EvidenceProof {
    pub valid: bool,
    pub session_id: Uuid,
    pub household_id: Uuid,
    pub credential_id: Uuid,
    pub device_id: Uuid,
    pub person_id: Option<Uuid>,
    pub binding_generation: i64,
    pub household_kind: String,
    pub command: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
