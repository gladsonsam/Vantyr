//! Pure credential mechanics for Vantyr Network gateway workers.
//!
//! This module never touches the database and never logs. A worker credential is
//! a NON-SECRET token id plus a high-entropy secret. Only a SHA-256 digest of the
//! secret is ever stored (via the maintained `crate::auth::secrets` helper); the
//! plaintext exists only in the one-time issuance response. Verification
//! recomputes the digest and compares it in constant time.
//!
//! The bearer shape, audience, command, capability allowlist and heartbeat time
//! window are all bounded here, *before* any database work.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand::Rng;
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// The only audience a gateway worker credential is valid for. A dashboard
/// session, agent socket or remote client never carries this audience.
pub const AUDIENCE: &str = "vantyr-gateway-worker";
/// A bounded heartbeat report: an unverified observation, never an ack.
pub const COMMAND_HEARTBEAT: &str = "heartbeat";
/// Explicit, opt-in scope to retrieve the assigned policy. This command is
/// NEVER added to a credential implicitly; issuance must request it.
pub const COMMAND_READ_POLICY: &str = "read_policy";
/// The complete command allowlist, mirrored by the migration 0077 CHECK.
pub const GATEWAY_COMMAND_ALLOWLIST: &[&str] = &[COMMAND_HEARTBEAT, COMMAND_READ_POLICY];
/// Matches the credential `cardinality(allowed_commands) BETWEEN 1 AND 8` CHECK.
pub const MAX_COMMANDS: usize = 8;

pub const GATEWAY_KINDS: &[&str] = &["dns", "proxy"];
/// Capabilities a worker may report and the server may persist. Unknown strings
/// are rejected rather than stored verbatim (no arbitrary callback/URL payload).
pub const CAPABILITY_ALLOWLIST: &[&str] = &["dns", "proxy", "heartbeat", "config-read"];
pub const MAX_CAPABILITIES: usize = 16;
pub const MAX_CAPABILITY_LEN: usize = 40;
pub const MAX_REVISION_LEN: usize = 64;
pub const MAX_FAILURE_LEN: usize = 200;
/// A reported last-seen time must be this recent and no further than this far
/// in the future (small clock skew) or the report is refused.
pub const MAX_HEARTBEAT_AGE: ChronoDuration = ChronoDuration::minutes(5);
pub const MAX_FUTURE_SKEW: ChronoDuration = ChronoDuration::seconds(60);
/// `<uuid>.<43 base64url chars>` plus the `Bearer ` prefix. 6 + 36 + 1 + 43 = 86.
pub const MAX_BEARER_LEN: usize = 128;
const SECRET_BYTES: usize = 32;
const SECRET_CHARS: usize = 43; // 32 bytes -> 43 URL-safe base64 chars, no padding.
const HASH_LEN: usize = 64;

/// A fresh 256-bit secret, URL-safe base64 without padding. Issued once.
pub fn new_secret() -> String {
    let mut raw = [0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

pub fn new_token_id() -> Uuid {
    Uuid::new_v4()
}

/// The only hash shape we persist. Uses the shared maintained SHA-256 helper.
pub fn hash_secret(secret: &str) -> String {
    crate::auth::secrets::sha256_hex_bytes(secret.as_bytes())
}

/// Constant-time verification of a presented secret against a stored digest.
/// Both operands have the same fixed width (64 hex bytes), so the comparison
/// does not short-circuit on the first differing byte.
pub fn verify_secret(provided: &str, stored_hash: &str) -> bool {
    let computed = hash_secret(provided);
    let stored = stored_hash.as_bytes();
    // Compare fixed-width bytes; a malformed stored row simply cannot match.
    if stored.len() != HASH_LEN {
        return false;
    }
    computed.as_bytes().ct_eq(stored).into()
}

/// Parse `Authorization: Bearer <token-id>.<secret>` with hard bounds. The
/// secret is returned as a borrowed slice and is never cloned into logs/errors.
pub fn parse_bearer(header: Option<&str>) -> Option<(Uuid, &str)> {
    let raw = header?.trim();
    if raw.is_empty() || raw.len() > MAX_BEARER_LEN {
        return None;
    }
    let value = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let (id, secret) = value.split_once('.')?;
    if id.len() != 36 || secret.is_empty() || secret.len() > SECRET_CHARS {
        return None;
    }
    if !secret
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some((Uuid::parse_str(id).ok()?, secret))
}

/// Test/helper formatter. Kept here so callers never hand-build a bearer string.
pub fn format_bearer(id: Uuid, secret: &str) -> String {
    format!("Bearer {id}.{secret}")
}

/// Validate and normalize worker-reported capabilities against the safe
/// allowlist. Bounded count and length; duplicates are collapsed.
pub fn normalize_capabilities(raw: Option<&[String]>) -> Result<Vec<String>, ()> {
    let Some(items) = raw else {
        return Ok(Vec::new());
    };
    if items.len() > MAX_CAPABILITIES {
        return Err(());
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let t = item.trim();
        if t.is_empty() || t.len() > MAX_CAPABILITY_LEN || t.chars().any(char::is_control) {
            return Err(());
        }
        if !CAPABILITY_ALLOWLIST.contains(&t) {
            return Err(());
        }
        if !out.iter().any(|v| v == t) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

/// Normalize the OPTIONAL command scope requested at credential issuance.
/// `None` keeps the historical heartbeat-only default, so existing heartbeat
/// credentials never gain `read_policy` silently. Every requested command must
/// be on the explicit allowlist; unknown strings are rejected, never stored.
pub fn normalize_commands(raw: Option<&[String]>) -> Result<Vec<String>, ()> {
    let Some(items) = raw else {
        return Ok(vec![COMMAND_HEARTBEAT.to_string()]);
    };
    if items.is_empty() || items.len() > MAX_COMMANDS {
        return Err(());
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let t = item.trim();
        if !GATEWAY_COMMAND_ALLOWLIST.contains(&t) {
            return Err(());
        }
        if !out.iter().any(|v| v == t) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

/// A reported time is accepted only inside `[now - max_age, now + skew]`.
pub fn observed_at_in_window(observed: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    observed <= now + MAX_FUTURE_SKEW && observed >= now - MAX_HEARTBEAT_AGE
}

pub fn bounded_text(value: Option<&str>, max: usize) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(s) if s.is_empty() || s.len() > max || s.chars().any(char::is_control) => Err(()),
        Some(s) => Ok(Some(s.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_high_entropy_bounded_and_hashes_to_64_hex() {
        let a = new_secret();
        let b = new_secret();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        let hash = hash_secret(&a);
        assert_eq!(hash.len(), HASH_LEN);
        assert!(hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert!(verify_secret(&a, &hash));
        assert!(!verify_secret(&b, &hash));
        assert!(!verify_secret(&a, "not-a-hash"));
    }

    #[test]
    fn bearer_is_bounded_and_rejects_malformed_shapes() {
        let id = Uuid::new_v4();
        let secret = new_secret();
        let bearer = format_bearer(id, &secret);
        assert_eq!(parse_bearer(Some(&bearer)), Some((id, secret.as_str())));
        assert_eq!(parse_bearer(Some(&format!("Basic {id}.{secret}"))), None);
        assert_eq!(parse_bearer(Some(&format!("Bearer {id}"))), None);
        assert_eq!(
            parse_bearer(Some(&format!("Bearer not-a-uuid.{secret}"))),
            None
        );
        let too_long = format!("Bearer {id}.{}", "x".repeat(200));
        assert_eq!(parse_bearer(Some(&too_long)), None);
        assert_eq!(parse_bearer(None), None);
    }

    #[test]
    fn capabilities_are_allowlisted_bounded_and_deduplicated() {
        let good = vec!["dns".into(), " dns ".into(), "proxy".into()];
        assert_eq!(
            normalize_capabilities(Some(&good)).unwrap(),
            vec!["dns".to_string(), "proxy".to_string()]
        );
        assert!(normalize_capabilities(Some(&["https://evil".to_string()])).is_err());
        let many: Vec<String> = (0..MAX_CAPABILITIES + 1)
            .map(|i| format!("dns{i}"))
            .collect();
        assert!(normalize_capabilities(Some(&many)).is_err());
    }

    #[test]
    fn command_scope_is_opt_in_and_allowlisted() {
        // Default stays heartbeat-only: no implicit upgrade.
        assert_eq!(
            normalize_commands(None).unwrap(),
            vec![COMMAND_HEARTBEAT.to_string()]
        );
        assert_eq!(
            normalize_commands(Some(&["read_policy".into(), "heartbeat".into()])).unwrap(),
            vec![
                COMMAND_READ_POLICY.to_string(),
                COMMAND_HEARTBEAT.to_string()
            ]
        );
        assert!(normalize_commands(Some(&[])).is_err());
        assert!(normalize_commands(Some(&["agent_token".into()])).is_err());
        assert_eq!(
            normalize_commands(Some(&[
                COMMAND_HEARTBEAT.to_string(),
                COMMAND_HEARTBEAT.to_string()
            ]))
            .unwrap()
            .len(),
            1,
            "duplicates collapse"
        );
        let too_many: Vec<String> = (0..MAX_COMMANDS + 1)
            .map(|i| format!("read_policy{i}"))
            .collect();
        assert!(normalize_commands(Some(&too_many)).is_err());
    }

    #[test]
    fn reported_time_and_text_are_bounded() {
        let now = Utc::now();
        assert!(observed_at_in_window(now, now));
        assert!(observed_at_in_window(now - MAX_HEARTBEAT_AGE, now));
        assert!(!observed_at_in_window(
            now + MAX_FUTURE_SKEW + ChronoDuration::seconds(1),
            now
        ));
        assert!(!observed_at_in_window(
            now - MAX_HEARTBEAT_AGE - ChronoDuration::seconds(1),
            now
        ));
        assert_eq!(bounded_text(Some("ok"), 8).unwrap(), Some("ok".into()));
        assert!(bounded_text(Some(&"x".repeat(9)), 8).is_err());
    }
}
