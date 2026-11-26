//! Vault lifecycle: init, unlock, public export, check, recovery and rotation.
//!
//! File layout for one named CA (all created with no-clobber semantics):
//!
//! * `<name>.vault.age` — the only secret file, mode 0600, an age envelope.
//! * `<name>.public.json` — public metadata, world-readable by design.
//! * `<name>.cert.pem` — the public CA certificate.
//!
//! There is no HTTP API and no client-trust provisioning in this layer. A
//! later enrollment step consumes only the public bundle.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::envelope::{
    decrypt_payload, encrypt_payload, VaultPayload, DEFAULT_SCRYPT_LOG_N, MAX_SCRYPT_LOG_N,
    MIN_SCRYPT_LOG_N, PAYLOAD_SCHEMA,
};
use crate::error::{PkiError, Result};
use crate::fsutil::{
    read_bounded_private, read_bounded_public, write_new_atomic, MAX_METADATA_BYTES,
    MAX_SECRET_BYTES, MAX_VAULT_BYTES,
};
use crate::metadata::{CaMetadata, PURPOSE_ID};
use crate::signer::{CaSigner, DEFAULT_CA_VALID_DAYS, MAX_CA_VALID_DAYS};

/// Default CA name. The purpose identifier is separate and fixed.
pub const DEFAULT_CA_NAME: &str = "inspection-ca";
/// Minimum operator passphrase length in bytes.
pub const MIN_SECRET_BYTES: usize = 12;
/// Schema of the machine-readable retirement record.
pub const RETIREMENT_SCHEMA: u32 = 1;
/// Fixed text: this tool never changes device trust stores.
pub const TRUST_REMOVAL_NOTE: &str =
    "Operator action required: removing the retired root from client trust stores is not performed by this tool.";

/// Bounded, validated options for CA creation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultOptions {
    /// age scrypt work factor, validated against the crate bounds.
    pub scrypt_log_n: u8,
    /// CA certificate lifetime in days.
    pub ca_valid_days: u32,
}

impl Default for VaultOptions {
    fn default() -> Self {
        Self {
            scrypt_log_n: DEFAULT_SCRYPT_LOG_N,
            ca_valid_days: DEFAULT_CA_VALID_DAYS,
        }
    }
}

impl VaultOptions {
    pub fn validate(&self) -> Result<()> {
        if !(MIN_SCRYPT_LOG_N..=MAX_SCRYPT_LOG_N).contains(&self.scrypt_log_n) {
            return Err(PkiError::InvalidValidity);
        }
        if self.ca_valid_days == 0 || self.ca_valid_days > MAX_CA_VALID_DAYS {
            return Err(PkiError::InvalidValidity);
        }
        Ok(())
    }
}

/// The three files owned by one named CA.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaPaths {
    pub vault: PathBuf,
    pub metadata: PathBuf,
    pub cert_pem: PathBuf,
}

/// Derive file paths from a directory and a simple CA name. The name is
/// restricted so it can never escape the directory.
pub fn paths_for(dir: &Path, name: &str) -> Result<CaPaths> {
    validate_name(name)?;
    Ok(CaPaths {
        vault: dir.join(format!("{name}.vault.age")),
        metadata: dir.join(format!("{name}.public.json")),
        cert_pem: dir.join(format!("{name}.cert.pem")),
    })
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 64 {
        return Err(PkiError::InvalidName(
            "CA name has an invalid length".into(),
        ));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphanumeric()
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(PkiError::InvalidName(format!(
            "CA name {name:?} has unsupported characters"
        )));
    }
    Ok(())
}

/// Read an operator passphrase from a 0600 regular file. The bytes never go to
/// stdout, a log or a tool result. The returned `SecretString` is zeroized on
/// drop; temporary file-read and UTF-8 conversion buffers are not guaranteed
/// to be zeroized.
pub fn read_secret_file(path: &Path) -> Result<SecretString> {
    let bytes = read_bounded_private(path, MAX_SECRET_BYTES)?;
    let without_newline = match bytes.strip_suffix(b"\n") {
        Some(stripped) => stripped.strip_suffix(b"\r").unwrap_or(stripped),
        None => &bytes,
    };
    if without_newline.is_empty() {
        return Err(PkiError::EmptySecret);
    }
    if without_newline.len() < MIN_SECRET_BYTES {
        return Err(PkiError::WeakSecret {
            bytes: without_newline.len(),
            minimum: MIN_SECRET_BYTES,
        });
    }
    let text = String::from_utf8(without_newline.to_vec())
        .map_err(|_| PkiError::SecretRead("operator secret is not UTF-8".into()))?;
    Ok(SecretString::from(text))
}

/// Create a new CA and its three files. Nothing is overwritten.
pub fn init_ca(
    dir: &Path,
    name: &str,
    secret: &SecretString,
    options: &VaultOptions,
    now: OffsetDateTime,
) -> Result<CaMetadata> {
    options.validate()?;
    let paths = paths_for(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| PkiError::Io {
        op: "create directory",
        detail: e.to_string(),
    })?;
    for path in [&paths.vault, &paths.metadata, &paths.cert_pem] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(PkiError::AlreadyExists);
        }
    }

    let not_after = now + Duration::days(options.ca_valid_days as i64);
    let signer = CaSigner::generate(now, not_after)?;
    let payload = payload_from(&signer)?;
    let ciphertext = encrypt_payload(&payload, secret, options.scrypt_log_n)?;

    // The vault is published first: if a later public write fails, the CA is
    // still recoverable with `export_public` using the same secret.
    write_new_atomic(&paths.vault, &ciphertext, 0o600)?;
    let metadata = signer.metadata();
    metadata.validate()?;
    write_new_atomic(
        &paths.metadata,
        &serde_json::to_vec_pretty(&metadata)?,
        0o644,
    )?;
    write_new_atomic(&paths.cert_pem, signer.public_cert_pem().as_bytes(), 0o644)?;
    Ok(metadata)
}

/// Unlock a vault into process memory. No files are created or modified.
pub fn unlock(vault_path: &Path, secret: &SecretString) -> Result<CaSigner> {
    let ciphertext = read_bounded_private(vault_path, MAX_VAULT_BYTES)?;
    let payload = decrypt_payload(&ciphertext, secret)?;
    CaSigner::from_payload(&payload)
}

/// Export or verify the public bundle. An existing public file is compared,
/// never overwritten, so a mismatch is reported rather than silently repaired.
pub fn export_public(dir: &Path, name: &str, secret: &SecretString) -> Result<CaMetadata> {
    let paths = paths_for(dir, name)?;
    let signer = unlock(&paths.vault, secret)?;
    let metadata = signer.metadata();
    metadata.validate()?;

    write_or_verify(
        &paths.metadata,
        &serde_json::to_vec_pretty(&metadata)?,
        |bytes| {
            let found: CaMetadata = serde_json::from_slice(bytes)?;
            found.validate()?;
            if found == metadata {
                Ok(())
            } else {
                Err(PkiError::MetadataMismatch)
            }
        },
    )?;
    write_or_verify(
        &paths.cert_pem,
        signer.public_cert_pem().as_bytes(),
        |bytes| {
            if bytes == signer.public_cert_pem().as_bytes() {
                Ok(())
            } else {
                Err(PkiError::MetadataMismatch)
            }
        },
    )?;
    Ok(metadata)
}

/// Verify a vault against its public metadata without writing anything.
pub fn check(dir: &Path, name: &str, secret: &SecretString) -> Result<CaMetadata> {
    let paths = paths_for(dir, name)?;
    let signer = unlock(&paths.vault, secret)?;
    let metadata = signer.metadata();
    let bytes = read_bounded_public(&paths.metadata, MAX_METADATA_BYTES)?;
    let found: CaMetadata = serde_json::from_slice(&bytes)?;
    found.validate()?;
    if found != metadata {
        return Err(PkiError::MetadataMismatch);
    }
    let cert = read_bounded_public(&paths.cert_pem, MAX_METADATA_BYTES)?;
    if cert != signer.public_cert_pem().as_bytes() {
        return Err(PkiError::MetadataMismatch);
    }
    Ok(metadata)
}

/// Read public metadata only; no secret is needed and no private data is exposed.
pub fn inspect_metadata(metadata_path: &Path) -> Result<CaMetadata> {
    let bytes = read_bounded_public(metadata_path, MAX_METADATA_BYTES)?;
    let metadata: CaMetadata = serde_json::from_slice(&bytes)?;
    metadata.validate()?;
    Ok(metadata)
}

/// Machine-readable record published when a root is retired. The explicit note
/// makes it clear that device trust stores are untouched by this layer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetirementRecord {
    pub schema: u32,
    pub status: String,
    pub retired_at: String,
    pub old_name: String,
    pub new_name: String,
    pub old_key_fingerprint_sha256: String,
    pub new_key_fingerprint_sha256: String,
    pub client_trust_removal: String,
}

/// Generate a completely independent new CA, publish it under a new name, and
/// write a retirement record for the old root. The old vault and public files
/// are never modified, deleted or re-signed. Client trust is not removed.
pub fn rotate_ca(
    dir: &Path,
    old_name: &str,
    new_name: &str,
    old_secret: &SecretString,
    new_secret: &SecretString,
    options: &VaultOptions,
    now: OffsetDateTime,
) -> Result<(CaMetadata, RetirementRecord)> {
    options.validate()?;
    if old_name == new_name {
        return Err(PkiError::InvalidName(
            "rotation requires a distinct new CA name".into(),
        ));
    }
    let old_paths = paths_for(dir, old_name)?;
    let new_paths = paths_for(dir, new_name)?;
    let retirement_path = dir.join(format!("{old_name}.retired.json"));
    for path in [
        &new_paths.vault,
        &new_paths.metadata,
        &new_paths.cert_pem,
        &retirement_path,
    ] {
        if fs::symlink_metadata(path).is_ok() {
            return Err(PkiError::AlreadyExists);
        }
    }

    let old_signer = unlock(&old_paths.vault, old_secret)?;
    let not_after = now + Duration::days(options.ca_valid_days as i64);
    let new_signer = CaSigner::generate(now, not_after)?;
    let payload = payload_from(&new_signer)?;
    let ciphertext = encrypt_payload(&payload, new_secret, options.scrypt_log_n)?;
    write_new_atomic(&new_paths.vault, &ciphertext, 0o600)?;

    let new_metadata = new_signer.metadata();
    new_metadata.validate()?;
    write_new_atomic(
        &new_paths.metadata,
        &serde_json::to_vec_pretty(&new_metadata)?,
        0o644,
    )?;
    write_new_atomic(
        &new_paths.cert_pem,
        new_signer.public_cert_pem().as_bytes(),
        0o644,
    )?;

    let record = RetirementRecord {
        schema: RETIREMENT_SCHEMA,
        status: "retired".into(),
        retired_at: now
            .format(&Rfc3339)
            .map_err(|e| PkiError::Serialize(e.to_string()))?,
        old_name: old_name.into(),
        new_name: new_name.into(),
        old_key_fingerprint_sha256: old_signer.key_fingerprint().into(),
        new_key_fingerprint_sha256: new_signer.key_fingerprint().into(),
        client_trust_removal: TRUST_REMOVAL_NOTE.into(),
    };
    write_new_atomic(
        &retirement_path,
        &serde_json::to_vec_pretty(&record)?,
        0o644,
    )?;
    Ok((new_metadata, record))
}

/// Read a retirement record.
pub fn inspect_retirement(path: &Path) -> Result<RetirementRecord> {
    let bytes = read_bounded_public(path, MAX_METADATA_BYTES)?;
    let record: RetirementRecord = serde_json::from_slice(&bytes)?;
    if record.schema != RETIREMENT_SCHEMA
        || record.old_key_fingerprint_sha256.len() != 64
        || record.new_key_fingerprint_sha256.len() != 64
    {
        return Err(PkiError::MetadataMismatch);
    }
    Ok(record)
}

fn payload_from(signer: &CaSigner) -> Result<VaultPayload> {
    let metadata = signer.metadata();
    Ok(VaultPayload {
        schema: PAYLOAD_SCHEMA,
        purpose: PURPOSE_ID.into(),
        ca_key_pem: signer.key_pem_for_envelope().expose_secret().to_owned(),
        ca_cert_pem: signer.public_cert_pem().into(),
        ca_cert_der_b64: base64::engine::general_purpose::STANDARD.encode(signer.public_cert_der()),
        ca_serial_hex: metadata.serial_hex,
        ca_not_before: metadata.not_before,
        ca_not_after: metadata.not_after,
        key_fingerprint_sha256: metadata.key_fingerprint_sha256,
    })
}

fn write_or_verify(
    path: &Path,
    bytes: &[u8],
    verify: impl FnOnce(&[u8]) -> Result<()>,
) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(PkiError::SymlinkRejected);
            }
            if !meta.file_type().is_file() {
                return Err(PkiError::NotRegularFile);
            }
            let existing = read_bounded_public(path, MAX_METADATA_BYTES)?;
            verify(&existing)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_new_atomic(path, bytes, 0o644),
        Err(e) => Err(PkiError::Io {
            op: "stat",
            detail: e.to_string(),
        }),
    }
}
