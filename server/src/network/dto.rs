//! Typed request/response DTOs and input normalization for the network inventory API.
//!
//! Everything the client sends is trimmed, length-capped and validated here before
//! it reaches SQL. Household ids are *never* taken from request bodies: they come
//! from the URL path, which authz has already checked against the caller's grants.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ─── Responses (also used as typed sqlx rows) ────────────────────────────────

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Household {
    pub id: Uuid,
    pub name: String,
    pub is_default: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Person {
    pub id: Uuid,
    pub household_id: Uuid,
    pub display_name: String,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Device {
    pub id: Uuid,
    pub canonical_key: String,
    pub label: String,
    pub device_type: String,
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
    pub role: String,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Connection {
    pub id: Uuid,
    pub household_id: Uuid,
    pub assignment_id: Uuid,
    pub kind: String,
    pub provenance: String,
    pub capabilities: serde_json::Value,
    pub status: String,
    pub observed_at: Option<DateTime<Utc>>,
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

// ─── Requests ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BootstrapBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateHouseholdBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct CreatePersonBody {
    pub display_name: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchPersonBody {
    #[serde(default)]
    pub display_name: Option<String>,
    /// Omitted = keep; JSON null = clear; string = set.
    #[serde(default)]
    pub note: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDeviceBody {
    pub canonical_key: String,
    pub label: String,
    #[serde(default)]
    pub device_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchDeviceBody {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub device_type: Option<String>,
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
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchAssignmentBody {
    /// Omitted = keep; JSON null = unlink; UUID = link/replace.
    #[serde(default)]
    pub agent_id: Option<Option<Uuid>>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub note: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConnectionBody {
    pub assignment_id: Uuid,
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
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PatchConnectionBody {
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    /// Omitted = keep; JSON null = clear; timestamp = set.
    #[serde(default)]
    pub observed_at: Option<Option<DateTime<Utc>>>,
    #[serde(default)]
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

/// Canonical device key: lowercase, strip separator noise, require a short
/// alphanumeric identifier. Normalizing here makes duplicate detection reliable
/// without storing a raw, user-supplied identifier verbatim.
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
pub const CONNECTION_STATUSES: &[&str] = &["unknown", "active", "inactive", "stale", "error"];

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
}
