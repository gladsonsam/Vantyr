//! Typed request/response DTOs and input normalization for the network inventory API.
//!
//! Household ids are never taken from request bodies: they come from the URL
//! path, which authz has already checked against the caller's grants.
//! Device keys are unique *within* a household, never globally — a key in
//! household B must not reveal or claim a device in household A.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A present nullable PATCH field is always `Some`: null means clear, while
/// `#[serde(default)]` handles an omitted field as `None` (keep).
fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// ─── Responses (also used as typed sqlx rows) ────────────────────────────────

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Household {
    pub id: Uuid,
    pub name: String,
    pub timezone: String,
    pub is_default: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Person {
    pub id: Uuid,
    pub household_id: Uuid,
    pub display_name: String,
    pub is_default_profile: bool,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// A device belongs to exactly one household. `shared` describes deliberate
/// sharing inside that household, not global ownership.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Device {
    pub id: Uuid,
    pub household_id: Uuid,
    pub canonical_key: String,
    pub label: String,
    pub device_type: String,
    pub shared: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Assignment {
    pub id: Uuid,
    pub household_id: Uuid,
    pub person_id: Uuid,
    pub device_id: Uuid,
    pub agent_id: Option<Uuid>,
    pub active: bool,
    pub role: String,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `status`, `capabilities`, `provenance` and `last_seen_at` are reported,
/// unverified observations. No CRUD write enforces anything on a worker.
/// `assignment_id` and `enrolled_agent_id` are optional: a device may carry a
/// connection with no person, assignment or agent at all.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Connection {
    pub id: Uuid,
    pub household_id: Uuid,
    pub device_id: Uuid,
    pub assignment_id: Option<Uuid>,
    pub enrolled_agent_id: Option<Uuid>,
    pub kind: String,
    pub provenance: String,
    pub capabilities: serde_json::Value,
    pub status: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AgentEnrollment {
    pub household_id: Uuid,
    pub agent_id: Uuid,
    pub enrolled_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Grant {
    pub household_id: Uuid,
    pub user_id: Uuid,
    pub grant_name: String,
    pub granted_at: DateTime<Utc>,
}

/// Household-scoped audit row. Only readable with `network_admin` on that
/// household, unlike the globally readable platform audit log.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct NetworkAudit {
    pub id: i64,
    pub ts: DateTime<Utc>,
    pub household_id: Uuid,
    pub actor: String,
    pub client_ip: Option<String>,
    pub action: String,
    pub status: String,
    pub detail: serde_json::Value,
}

// ─── Requests ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BootstrapBody {
    pub name: String,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateHouseholdBody {
    pub name: String,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePersonBody {
    pub display_name: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub is_default_profile: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct PatchPersonBody {
    #[serde(default)]
    pub display_name: Option<String>,
    /// Omitted = keep; JSON null = clear; string = set.
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub note: Option<Option<String>>,
    #[serde(default)]
    pub is_default_profile: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDeviceBody {
    pub canonical_key: String,
    pub label: String,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub shared: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct PatchDeviceBody {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub shared: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAssignmentBody {
    pub person_id: Uuid,
    pub device_id: Uuid,
    #[serde(default)]
    pub agent_id: Option<Uuid>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchAssignmentBody {
    /// Omitted = keep; JSON null = unlink; UUID = link/replace.
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub agent_id: Option<Option<Uuid>>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub note: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionBody {
    /// Required, household-owned; the connection is about this device.
    pub device_id: Uuid,
    /// Optional verified in-scope assignment (no person is required without it).
    #[serde(default)]
    pub assignment_id: Option<Uuid>,
    /// Optional explicitly enrolled agent identity (never inferred).
    #[serde(default)]
    pub enrolled_agent_id: Option<Uuid>,
    pub kind: String,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub observed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub revoked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchConnectionBody {
    /// Omitted = keep; JSON null = clear; UUID = set (validated in scope).
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub assignment_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub enrolled_agent_id: Option<Option<Uuid>>,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub observed_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub last_seen_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub revoked_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    pub note: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct EnrollAgentBody {
    pub agent_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct GrantBody {
    pub user_id: Uuid,
    pub grant: String,
}

// ─── Normalization ───────────────────────────────────────────────────────────

pub fn normalize_text(raw: &str, field: &str, max: usize) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(format!("{field} must not be blank"));
    }
    if t.chars().any(char::is_control) {
        return Err(format!("{field} may not contain control characters"));
    }
    if t.chars().count() > max {
        return Err(format!("{field} must be at most {max} characters"));
    }
    Ok(t.to_string())
}

pub fn normalize_optional_text(
    raw: &Option<String>,
    field: &str,
    max: usize,
) -> Result<Option<String>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Ok(None),
        Some(s) => normalize_text(s, field, max).map(Some),
    }
}

pub fn normalize_note_patch(
    raw: &Option<Option<String>>,
) -> Result<Option<Option<String>>, String> {
    match raw {
        None => Ok(None),
        Some(None) => Ok(Some(None)),
        Some(Some(s)) => normalize_optional_text(&Some(s.clone()), "note", 1000).map(Some),
    }
}

/// Valid IANA timezone name (chrono-tz catalogue), defaulting to UTC.
pub fn normalize_timezone(raw: &Option<String>) -> Result<String, String> {
    let Some(s) = raw else {
        return Ok("UTC".to_string());
    };
    let t = s.trim();
    if t.is_empty() || t.len() > 64 {
        return Err("timezone must be a 1 to 64 character IANA name".into());
    }
    let parsed: chrono_tz::Tz = t
        .parse()
        .map_err(|_| "timezone must be a valid IANA name")?;
    Ok(parsed.name().to_string())
}

/// Canonical device key: lowercase, strip separator noise, require a short
/// alphanumeric identifier. Uniqueness is enforced per household in SQL.
pub fn normalize_canonical_key(raw: &str) -> Result<String, String> {
    let key: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '_' | '.' | ' '))
        .collect();
    if !(3..=64).contains(&key.len()) {
        return Err("canonical_key must be 3 to 64 characters after normalization".into());
    }
    if !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("canonical_key may only contain letters and digits".into());
    }
    Ok(key)
}

pub fn normalize_enum(
    raw: &Option<String>,
    allowed: &[&str],
    default: &'static str,
    field: &str,
) -> Result<String, String> {
    let Some(s) = raw else {
        return Ok(default.to_string());
    };
    let t = s.trim().to_ascii_lowercase();
    if allowed.contains(&t.as_str()) {
        Ok(t)
    } else {
        Err(format!("{field} must be one of: {}", allowed.join(", ")))
    }
}

pub const DEVICE_TYPES: &[&str] = &[
    "computer", "phone", "tablet", "router", "switch", "ap", "tv", "iot", "other", "unknown",
];
pub const ASSIGNMENT_ROLES: &[&str] = &["owner", "member", "guest", "managed", "unknown"];
pub const CONNECTION_KINDS: &[&str] = &["agent", "dns", "proxy"];
pub const PROVENANCES: &[&str] = &["manual", "agent", "dns", "proxy", "import"];
pub const CONNECTION_STATUSES: &[&str] =
    &["unknown", "active", "inactive", "stale", "error", "revoked"];

pub fn normalize_capabilities(raw: &Option<Vec<String>>) -> Result<Vec<String>, String> {
    let Some(items) = raw else {
        return Ok(Vec::new());
    };
    if items.len() > 32 {
        return Err("capabilities may contain at most 32 entries".into());
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let value = normalize_text(item, "capabilities entry", 80)?;
        if !out.contains(&value) {
            out.push(value);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nullable_patch_distinguishes_omitted_null_and_value() {
        use serde_json::{from_value, json};
        let omitted: PatchConnectionBody = from_value(json!({"status": "active"})).unwrap();
        assert_eq!(omitted.revoked_at, None);
        let clear: PatchConnectionBody = from_value(json!({
            "status": "active", "revoked_at": null, "assignment_id": null,
            "enrolled_agent_id": null, "observed_at": null, "last_seen_at": null, "note": null
        }))
        .unwrap();
        assert_eq!(clear.revoked_at, Some(None));
        assert_eq!(clear.assignment_id, Some(None));
        assert_eq!(clear.enrolled_agent_id, Some(None));
        assert_eq!(clear.observed_at, Some(None));
        assert_eq!(clear.last_seen_at, Some(None));
        assert_eq!(clear.note, Some(None));
        let id = Uuid::new_v4();
        let set: PatchConnectionBody =
            from_value(json!({"assignment_id": id, "revoked_at": "2026-11-26T10:00:00Z"})).unwrap();
        assert_eq!(set.assignment_id, Some(Some(id)));
        assert!(set.revoked_at.flatten().is_some());
        let person: PatchPersonBody = from_value(json!({"note": null})).unwrap();
        assert_eq!(person.note, Some(None));
        let assignment: PatchAssignmentBody =
            from_value(json!({"agent_id": null, "note": null})).unwrap();
        assert_eq!(assignment.agent_id, Some(None));
        assert_eq!(assignment.note, Some(None));
        assert!(from_value::<PatchConnectionBody>(json!({"revoked_at": "not-a-date"})).is_err());
        assert!(from_value::<PatchAssignmentBody>(json!({"agent_id": "not-a-uuid"})).is_err());
    }

    #[test]
    fn canonical_key_is_normalized_and_capped() {
        assert_eq!(
            normalize_canonical_key(" AA-BB:cc_dd.11 ").unwrap(),
            "aabbccdd11"
        );
        assert!(normalize_canonical_key("a!b").is_err());
        assert!(normalize_canonical_key("ab").is_err());
        assert!(normalize_canonical_key(&"a".repeat(65)).is_err());
    }

    #[test]
    fn capabilities_are_capped_and_deduplicated() {
        let vals = vec![" dns ".to_string(), "dns".into(), " proxy ".into()];
        assert_eq!(
            normalize_capabilities(&Some(vals)).unwrap(),
            vec!["dns".to_string(), "proxy".to_string()]
        );
        let too_many: Vec<String> = (0..33).map(|i| format!("c{i}")).collect();
        assert!(normalize_capabilities(&Some(too_many)).is_err());
    }

    #[test]
    fn timezone_must_be_a_known_iana_name() {
        assert_eq!(normalize_timezone(&None).unwrap(), "UTC");
        assert_eq!(
            normalize_timezone(&Some(" Asia/Kuala_Lumpur ".into())).unwrap(),
            "Asia/Kuala_Lumpur"
        );
        assert!(normalize_timezone(&Some("Mars/Olympus".into())).is_err());
    }
}
