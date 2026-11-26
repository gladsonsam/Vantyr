//! Typed DTOs for Vantyr Network gateways, worker credentials and reports.
//!
//! No response type ever exposes `secret_hash`: issuance shows the plaintext
//! once, every later read is metadata only. Household and gateway ids in
//! requests are checked against the authenticated credential / explicit grant,
//! never trusted as an ownership claim.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use super::gateway_auth;

/// Household-owned DNS or Proxy worker target. `capabilities` and
/// `last_seen_at` are reported/unverified observations, not enforcement state.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Gateway {
    pub id: Uuid,
    pub household_id: Uuid,
    pub kind: String,
    pub label: String,
    pub enabled: bool,
    pub capabilities: Value,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Metadata-only credential view for the browser. Deliberately has no hash or
/// secret field: those never leave the one-time issuance response.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct GatewayCredential {
    pub id: Uuid,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub kind: String,
    pub audience: String,
    pub allowed_commands: Vec<String>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub issued_at: DateTime<Utc>,
    pub rotated_from: Option<Uuid>,
}

/// An append-only heartbeat report. `verified` and `enforced` are always false
/// in storage and are surfaced only so clients cannot mistake a report for an
/// acknowledgement or a policy canary.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct GatewayReport {
    pub id: i64,
    pub household_id: Uuid,
    pub gateway_id: Uuid,
    pub credential_id: Uuid,
    pub reported_at: DateTime<Utc>,
    pub observed_at: DateTime<Utc>,
    pub capabilities: Value,
    pub desired_revision: Option<String>,
    pub applied_revision: Option<String>,
    pub failure: Option<String>,
    pub verified: bool,
    pub enforced: bool,
}

// ─── Requests ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateGatewayBody {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct IssueCredentialBody {
    /// Bounded 1..=720 hours (30 days); defaults to 24.
    #[serde(default)]
    pub expires_in_hours: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatBody {
    /// Explicit audience; must equal `gateway_auth::AUDIENCE`.
    pub audience: String,
    /// Explicit command; must be in the credential's stored allowlist.
    pub command: String,
    /// Claimed ids/kind. All must match the bearer credential's scopes.
    pub gateway_id: Uuid,
    pub household_id: Uuid,
    pub kind: String,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub observed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub desired_revision: Option<String>,
    #[serde(default)]
    pub applied_revision: Option<String>,
    #[serde(default)]
    pub failure: Option<String>,
}

// ─── Normalization ───────────────────────────────────────────────────────────

pub fn normalize_kind(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim().to_ascii_lowercase();
    if gateway_auth::GATEWAY_KINDS.contains(&t.as_str()) {
        Ok(t)
    } else {
        Err("gateway kind must be one of: dns, proxy")
    }
}

pub fn normalize_label(raw: &str) -> Result<String, String> {
    super::dto::normalize_text(raw, "label", 120)
}

const DEFAULT_CREDENTIAL_HOURS: i64 = 24;
const MAX_CREDENTIAL_HOURS: i64 = 720;

pub fn credential_expiry(hours: Option<i64>, now: DateTime<Utc>) -> Result<DateTime<Utc>, ()> {
    let hours = hours.unwrap_or(DEFAULT_CREDENTIAL_HOURS);
    if !(1..=MAX_CREDENTIAL_HOURS).contains(&hours) {
        return Err(());
    }
    let delta = ChronoDuration::hours(hours);
    now.checked_add_signed(delta).ok_or(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_label_and_expiry_are_bounded() {
        assert_eq!(normalize_kind(" DNS ").unwrap(), "dns");
        assert!(normalize_kind("dhcp").is_err());
        assert!(normalize_label("  Core DNS  ").is_ok());
        assert!(normalize_label("").is_err());
        let now = Utc::now();
        assert!(credential_expiry(None, now).unwrap() > now);
        assert!(credential_expiry(Some(721), now).is_err());
        assert!(credential_expiry(Some(0), now).is_err());
    }
}
