//! Encrypted custody of the CA private key using the `age` file format.
//!
//! The vault is a standard age binary envelope produced by the maintained
//! upstream `age` crate with its native scrypt passphrase recipient. There is
//! no custom AES envelope, no homemade KDF and no key derivation logic here.
//! The work factor is an explicit bounded parameter and is stored by age in
//! the standard recipient stanza, so decryption never needs a side-channel.

use secrecy::SecretString;
use serde::{Deserialize, Serialize};

use crate::error::{PkiError, Result};
use crate::fsutil::MAX_PAYLOAD_BYTES;
use crate::metadata::PURPOSE_ID;

/// Version of the JSON payload *inside* the age envelope.
pub const PAYLOAD_SCHEMA: u32 = 1;
/// Lower bound used by this crate for the scrypt work factor.
pub const MIN_SCRYPT_LOG_N: u8 = 14;
/// Default operator work factor; age's own default targets roughly one second.
pub const DEFAULT_SCRYPT_LOG_N: u8 = 18;
/// Upper bound accepted during decryption. Bounds CPU and memory that a
/// malicious vault file can make us spend.
pub const MAX_SCRYPT_LOG_N: u8 = 20;

/// Plaintext inside the age envelope. `Debug` is implemented by hand so the
/// private key can never appear in a log or panic message.
#[derive(Serialize, Deserialize)]
pub struct VaultPayload {
    pub schema: u32,
    pub purpose: String,
    pub ca_key_pem: String,
    pub ca_cert_pem: String,
    pub ca_cert_der_b64: String,
    pub ca_serial_hex: String,
    pub ca_not_before: String,
    pub ca_not_after: String,
    pub key_fingerprint_sha256: String,
}

impl std::fmt::Debug for VaultPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VaultPayload")
            .field("schema", &self.schema)
            .field("purpose", &self.purpose)
            .field("ca_key_pem", &"[redacted]")
            .field("ca_cert_pem", &self.ca_cert_pem)
            .field("ca_cert_der_b64", &"[public certificate DER]")
            .field("ca_serial_hex", &self.ca_serial_hex)
            .field("ca_not_before", &self.ca_not_before)
            .field("ca_not_after", &self.ca_not_after)
            .field("key_fingerprint_sha256", &self.key_fingerprint_sha256)
            .finish()
    }
}

impl VaultPayload {
    /// Reject foreign or malformed payloads before any key is used.
    pub fn validate(&self) -> Result<()> {
        if self.schema != PAYLOAD_SCHEMA {
            return Err(PkiError::SchemaMismatch {
                found: self.schema,
                expected: PAYLOAD_SCHEMA,
            });
        }
        if self.purpose != PURPOSE_ID {
            return Err(PkiError::PurposeMismatch);
        }
        if self.ca_key_pem.is_empty()
            || !self.ca_key_pem.contains("PRIVATE KEY")
            || self.ca_cert_pem.is_empty()
            || self.ca_cert_der_b64.is_empty()
            || self.ca_serial_hex.is_empty()
            || self.ca_not_before.is_empty()
            || self.ca_not_after.is_empty()
            || self.key_fingerprint_sha256.len() != 64
        {
            return Err(PkiError::MalformedVault);
        }
        Ok(())
    }
}

/// Encrypt a validated payload to an operator passphrase.
pub fn encrypt_payload(
    payload: &VaultPayload,
    secret: &SecretString,
    log_n: u8,
) -> Result<Vec<u8>> {
    if !(MIN_SCRYPT_LOG_N..=MAX_SCRYPT_LOG_N).contains(&log_n) {
        return Err(PkiError::InvalidValidity);
    }
    payload.validate()?;
    let plaintext = serde_json::to_vec(payload)?;
    let mut recipient = age::scrypt::Recipient::new(secret.clone());
    recipient.set_work_factor(log_n);
    age::encrypt(&recipient, &plaintext).map_err(|_| PkiError::Io {
        op: "encrypt vault",
        detail: "age encryption failed".into(),
    })
}

/// Decrypt and validate a payload. A wrong passphrase, truncated ciphertext or
/// tampered stanza all produce the same generic fail-closed error.
pub fn decrypt_payload(ciphertext: &[u8], secret: &SecretString) -> Result<VaultPayload> {
    let mut identity = age::scrypt::Identity::new(secret.clone());
    identity.set_max_work_factor(MAX_SCRYPT_LOG_N);
    let plaintext: Vec<u8> =
        age::decrypt(&identity, ciphertext).map_err(|_| PkiError::DecryptFailed)?;
    if plaintext.len() > MAX_PAYLOAD_BYTES {
        return Err(PkiError::TooLarge {
            what: "vault payload",
            bytes: plaintext.len() as u64,
            limit: MAX_PAYLOAD_BYTES as u64,
        });
    }
    let payload: VaultPayload =
        serde_json::from_slice(&plaintext).map_err(|_| PkiError::MalformedVault)?;
    payload.validate()?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> VaultPayload {
        VaultPayload {
            schema: PAYLOAD_SCHEMA,
            purpose: PURPOSE_ID.into(),
            ca_key_pem: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n".into(),
            ca_cert_pem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n".into(),
            ca_cert_der_b64: "AA==".into(),
            ca_serial_hex: "01".into(),
            ca_not_before: "2026-01-01T00:00:00Z".into(),
            ca_not_after: "2027-01-01T00:00:00Z".into(),
            key_fingerprint_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn round_trip_and_wrong_secret() {
        let secret = SecretString::from("a long enough operator passphrase 12345".to_owned());
        let encrypted = encrypt_payload(&payload(), &secret, MIN_SCRYPT_LOG_N).unwrap();
        assert!(encrypted.starts_with(b"age-encryption.org/"));
        let decrypted = decrypt_payload(&encrypted, &secret).unwrap();
        assert_eq!(decrypted.ca_cert_pem, payload().ca_cert_pem);

        let wrong = SecretString::from("a different operator passphrase 123456".to_owned());
        assert_eq!(
            decrypt_payload(&encrypted, &wrong).err(),
            Some(PkiError::DecryptFailed)
        );
        assert_eq!(
            decrypt_payload(&encrypted[..encrypted.len() / 2], &secret).err(),
            Some(PkiError::DecryptFailed)
        );
    }

    #[test]
    fn debug_never_shows_the_key() {
        let rendered = format!("{:?}", payload());
        assert!(rendered.contains("[redacted]"));
        assert!(!rendered.contains("BEGIN PRIVATE KEY"));
    }
}
