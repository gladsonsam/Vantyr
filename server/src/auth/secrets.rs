//! Secret handling: constant-time comparison, SHA-256 token digests, and Argon2
//! password hashing.

use anyhow::Result;
use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Compare two secret strings in a way that does not leak the expected value via timing
/// on the comparison step. Values are compared via SHA-256 digests (fixed width).
#[must_use]
pub fn ct_compare_secret(provided: &str, expected: &str) -> bool {
    let a = Sha256::digest(provided.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    // Avoid raw string equality checks; compare fixed-width digests in constant time.
    a.ct_eq(&b).into()
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn hash_dashboard_password(plain: &str) -> Result<String> {
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(plain.as_bytes())
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify_dashboard_password(hash: &str, plain: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(plain.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_stored_phc_password_compatibility() {
        // Published Argon2 PHC test vector, also accepted by the previous 0.5 API.
        let stored = "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        assert!(verify_dashboard_password(stored, "password"));
        assert!(!verify_dashboard_password(stored, "wrong"));
        assert!(!verify_dashboard_password("malformed", "password"));
    }

    #[test]
    fn generates_distinct_salted_hashes_and_preserves_sha256_encoding() {
        let first = hash_dashboard_password("new password").unwrap();
        let second = hash_dashboard_password("new password").unwrap();
        assert_ne!(first, second);
        assert!(verify_dashboard_password(&first, "new password"));
        assert_eq!(
            sha256_hex_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
