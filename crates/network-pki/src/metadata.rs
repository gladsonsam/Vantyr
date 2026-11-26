//! Public, export-only metadata for the inspection CA.
//!
//! This structure is safe to write to a world-readable file, print in a CLI or
//! send to an enrollment flow later: it contains no key material. The private
//! key lives only inside the age-encrypted vault and in process memory while a
//! signer is unlocked.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{PkiError, Result};

/// Explicit, separate purpose for this CA. It is not a user identity CA, not a
/// Wi-Fi/RADIUS server CA and not a client-trust provisioning artefact.
pub const PURPOSE_ID: &str = "vantyr-network-inspection-ca/v1";
/// Bumped only with an explicit, implemented migration.
pub const METADATA_SCHEMA: u32 = 1;

/// SHA-256 over DER bytes, lower-case hex. A standard digest of public data,
/// not a custom crypto construction.
pub fn sha256_hex(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Public description of one inspection root. No secret fields by construction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaMetadata {
    pub schema: u32,
    /// Fixed purpose identifier; see [`PURPOSE_ID`].
    pub purpose: String,
    /// SHA-256 of the CA public key's SubjectPublicKeyInfo DER.
    pub key_fingerprint_sha256: String,
    /// SHA-256 of the CA certificate DER.
    pub cert_fingerprint_sha256: String,
    /// Certificate serial number, lower-case hex.
    pub serial_hex: String,
    /// Issuer/subject distinguished name in RFC 4514-like display form.
    pub subject: String,
    /// RFC 3339 UTC validity bounds of the CA certificate.
    pub not_before: String,
    pub not_after: String,
    /// Public CA certificate in PEM form.
    pub public_cert_pem: String,
}

impl CaMetadata {
    /// Reject malformed or unsafe metadata before it is trusted for comparison.
    pub fn validate(&self) -> Result<()> {
        if self.schema != METADATA_SCHEMA {
            return Err(PkiError::SchemaMismatch {
                found: self.schema,
                expected: METADATA_SCHEMA,
            });
        }
        if self.purpose != PURPOSE_ID {
            return Err(PkiError::PurposeMismatch);
        }
        if !is_hex_256(&self.key_fingerprint_sha256) || !is_hex_256(&self.cert_fingerprint_sha256) {
            return Err(PkiError::MetadataMismatch);
        }
        if self.serial_hex.is_empty()
            || self.subject.is_empty()
            || self.not_before.is_empty()
            || self.not_after.is_empty()
        {
            return Err(PkiError::MetadataMismatch);
        }
        if !self.public_cert_pem.contains("BEGIN CERTIFICATE")
            || self
                .public_cert_pem
                .to_ascii_lowercase()
                .contains("private key")
        {
            return Err(PkiError::MetadataMismatch);
        }
        Ok(())
    }
}

fn is_hex_256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_sha256_vector() {
        // SHA-256("abc") from FIPS 180-4.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn metadata_rejects_secrets_and_wrong_purpose() {
        let mut meta = CaMetadata {
            schema: METADATA_SCHEMA,
            purpose: PURPOSE_ID.into(),
            key_fingerprint_sha256: "a".repeat(64),
            cert_fingerprint_sha256: "b".repeat(64),
            serial_hex: "01".into(),
            subject: "CN=test".into(),
            not_before: "2026-01-01T00:00:00Z".into(),
            not_after: "2027-01-01T00:00:00Z".into(),
            public_cert_pem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"
                .into(),
        };
        meta.validate().unwrap();
        meta.purpose = "other".into();
        assert_eq!(meta.validate(), Err(PkiError::PurposeMismatch));
    }
}
