//! Pure mechanics for centrally issued proxy sign-in credentials.
//!
//! This module never touches the database and never logs. A proxy secret is a
//! NEW credential family: 256-bit random, 43 URL-safe characters (inside the
//! worker's 32..=128 shape). Only a SHA-256 digest is ever persisted; the
//! plaintext exists only in the one-time issuance response. [`Secret`] has a
//! redacted `Debug` and no `Display`/serialization so an incidental log cannot
//! leak it.
//!
//! The audience/kind/command vocabulary mirrors `crates/family-proxy` exactly;
//! a gateway Bearer, BYOD grant, dashboard cookie or inspection CA trust never
//! carries it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::Rng;
use uuid::Uuid;

use super::dto;

/// Worker-bound audience for a proxy client credential. Documented here as the
/// server-side mirror of the accepted worker constant; the server stores no
/// audience column because the worker enforces it from its own pinned code.
#[allow(dead_code)]
pub const AUDIENCE: &str = "vantyr-proxy-client";
/// Audience bound into single-use session evidence.
pub const EVIDENCE_AUDIENCE: &str = "vantyr-proxy-session";
/// Worker kind bound into every proxy credential.
pub const KIND: &str = "proxy";
/// The only two commands a proxy credential may carry. Both are opt-in.
pub const COMMAND_PROXY_CONNECT: &str = "proxy_connect";
pub const COMMAND_PROXY_HTTP: &str = "proxy_http";
pub const COMMAND_ALLOWLIST: &[&str] = &[COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP];
pub const MAX_COMMANDS: usize = 8;

/// Bounded lifetime for a proxy credential: 1 hour .. 30 days, matching the
/// worker's retention ceiling. A caller cannot request an unbounded value.
pub const MIN_CREDENTIAL_SECS: i64 = 60 * 60;
pub const MAX_CREDENTIAL_SECS: i64 = 30 * 24 * 60 * 60;
/// Evidence is deliberately short-lived and clamped to the credential and
/// session expiries by the service layer.
pub const MIN_EVIDENCE_SECS: i64 = 30;
pub const MAX_EVIDENCE_SECS: i64 = 5 * 60;
/// Match the accepted worker header/evidence bound.
pub const MAX_EVIDENCE_BYTES: usize = 4096;
pub const MAX_NONCE_CHARS: usize = 64;
pub const MAX_LABEL_LEN: usize = 80;

const SECRET_BYTES: usize = 32;
const SECRET_CHARS: usize = 43; // 32 bytes -> 43 URL-safe base64 chars, no padding.
const HASH_LEN: usize = 64;

/// A one-time plaintext secret. No `Display`, no serialization.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Fresh 256-bit secret from the already-pinned `rand` dependency.
pub fn new_secret() -> Secret {
    let mut raw = [0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut raw);
    let secret = Secret(URL_SAFE_NO_PAD.encode(raw));
    debug_assert_eq!(secret.expose().len(), SECRET_CHARS);
    secret
}

/// A fresh server-generated evidence nonce (never caller-chosen).
pub fn new_nonce() -> String {
    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    let nonce = URL_SAFE_NO_PAD.encode(raw);
    debug_assert!(!nonce.is_empty() && nonce.len() <= MAX_NONCE_CHARS);
    nonce
}

pub fn new_id() -> Uuid {
    Uuid::new_v4()
}

/// The only digest shape persisted. Uses the shared maintained SHA-256 helper.
pub fn hash_secret(secret: &Secret) -> String {
    let hash = crate::auth::secrets::sha256_hex_bytes(secret.expose().as_bytes());
    debug_assert_eq!(hash.len(), HASH_LEN);
    hash
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    crate::auth::secrets::sha256_hex_bytes(bytes)
}

/// Normalize the opt-in scope set. `None` keeps both commands (the staged UI
/// issues a sign-in credential, which must be able to connect and to serve the
/// plain HTTP path). Unknown strings are rejected, never stored.
pub fn normalize_scopes(raw: Option<&[String]>) -> Result<Vec<String>, ()> {
    let Some(items) = raw else {
        return Ok(vec![
            COMMAND_PROXY_CONNECT.to_string(),
            COMMAND_PROXY_HTTP.to_string(),
        ]);
    };
    if items.is_empty() || items.len() > MAX_COMMANDS {
        return Err(());
    }
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let t = item.trim();
        if !COMMAND_ALLOWLIST.contains(&t) {
            return Err(());
        }
        if !out.iter().any(|v| v == t) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

pub fn normalize_label(raw: &str) -> Result<String, ()> {
    dto::normalize_text(raw, "label", MAX_LABEL_LEN).map_err(|_| ())
}

/// Reject a caller-defined expiry that exceeds the server bound. Values are
/// not clamped: an oversized request is refused rather than silently shortened.
pub fn normalize_credential_secs(raw: i64) -> Result<i64, ()> {
    if (MIN_CREDENTIAL_SECS..=MAX_CREDENTIAL_SECS).contains(&raw) {
        Ok(raw)
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_is_high_entropy_hashed_and_debug_redacted() {
        let a = new_secret();
        let b = new_secret();
        assert_ne!(a.expose(), b.expose());
        assert_eq!(a.expose().len(), SECRET_CHARS);
        assert!(a
            .expose()
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        let hash = hash_secret(&a);
        assert_eq!(hash.len(), HASH_LEN);
        assert_ne!(hash, hash_secret(&b));
        assert!(!format!("{a:?}").contains(a.expose()));
    }

    #[test]
    fn nonce_and_digest_are_bounded() {
        let n = new_nonce();
        assert!(!n.is_empty() && n.len() <= MAX_NONCE_CHARS);
        let d = hash_bytes(b"canonical evidence");
        assert_eq!(d.len(), HASH_LEN);
        assert!(d
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    }

    #[test]
    fn scopes_labels_and_expiry_are_bounded() {
        assert_eq!(
            normalize_scopes(None).unwrap(),
            vec![COMMAND_PROXY_CONNECT, COMMAND_PROXY_HTTP]
        );
        assert_eq!(
            normalize_scopes(Some(&["proxy_http".to_string()])).unwrap(),
            vec![COMMAND_PROXY_HTTP]
        );
        assert!(normalize_scopes(Some(&["admin".to_string()])).is_err());
        assert_eq!(normalize_label("  Laptop ").unwrap(), "Laptop");
        assert!(normalize_label("").is_err());
        assert!(normalize_label(&"x".repeat(MAX_LABEL_LEN + 1)).is_err());
        assert_eq!(
            normalize_credential_secs(MIN_CREDENTIAL_SECS),
            Ok(MIN_CREDENTIAL_SECS)
        );
        assert_eq!(
            normalize_credential_secs(MAX_CREDENTIAL_SECS),
            Ok(MAX_CREDENTIAL_SECS)
        );
        assert!(normalize_credential_secs(MIN_CREDENTIAL_SECS - 1).is_err());
        assert!(normalize_credential_secs(MAX_CREDENTIAL_SECS + 1).is_err());
    }
}
