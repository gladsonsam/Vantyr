//! The unlocked inspection CA signer and bounded short-lived leaf issuance.
//!
//! A signer exists only in process memory. Its private key is held as a
//! `SecretString` (zeroized on drop); it is reconstructed into an rcgen key
//! pair only for the duration of a signature and is never written to disk.
//! Leaves are explicitly non-CA, carry `serverAuth` EKU and only validated
//! DNS/IP SANs, and are constrained to outlive neither their requested window
//! nor the CA itself.

use std::fmt;
use std::net::IpAddr;

use base64::Engine;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, PublicKeyData, SerialNumber, PKCS_ECDSA_P256_SHA256,
};
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use zeroize::Zeroizing;

use crate::envelope::VaultPayload;
use crate::error::{PkiError, Result};
use crate::metadata::{sha256_hex, CaMetadata, PURPOSE_ID};
use crate::names::{validate_server_names, MAX_SANS};

/// Default CA lifetime in days.
pub const DEFAULT_CA_VALID_DAYS: u32 = 365;
/// Hard cap on CA lifetime in days (five years).
pub const MAX_CA_VALID_DAYS: u32 = 365 * 5;
/// Default leaf lifetime in seconds (one day).
pub const DEFAULT_LEAF_VALID_SECS: u64 = 24 * 3600;
/// Hard cap on leaf lifetime in seconds (seven days).
pub const MAX_LEAF_VALID_SECS: u64 = 7 * 24 * 3600;
/// Backdating to tolerate modest clock skew between signer and verifier.
pub const MAX_CLOCK_SKEW_SECS: u64 = 300;
/// Cap on DER bytes accepted for a CA certificate from a vault.
pub const MAX_CA_CERT_DER_BYTES: usize = 64 * 1024;

/// An unlocked CA. Deliberately does not implement `Clone` and has a redacting
/// `Debug`; dropping it leaves no key material in files or logs.
pub struct CaSigner {
    key_pem: SecretString,
    ca_params: CertificateParams,
    cert_pem: String,
    cert_der: Vec<u8>,
    serial_hex: String,
    not_before: String,
    not_after: String,
    not_after_dt: OffsetDateTime,
    key_fingerprint: String,
}

impl fmt::Debug for CaSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CaSigner")
            .field("key", &"[redacted]")
            .field("cert_fingerprint_sha256", &sha256_hex(&self.cert_der))
            .field("key_fingerprint_sha256", &self.key_fingerprint)
            .field("not_after", &self.not_after)
            .finish_non_exhaustive()
    }
}

impl CaSigner {
    /// Generate a brand-new, independent CA key and self-signed certificate.
    /// Only an explicit operator `init` call should reach this.
    pub fn generate(now: OffsetDateTime, not_after: OffsetDateTime) -> Result<Self> {
        if not_after <= now {
            return Err(PkiError::InvalidValidity);
        }
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
        let spki = key.subject_public_key_info();
        let digest = Sha256::digest(&spki);
        let key_fingerprint = hex_lower(&digest);

        // Serial is derived from the freshly generated random key; the high
        // bit is cleared so the DER INTEGER stays positive.
        let mut serial = digest[..16].to_vec();
        serial[0] &= 0x7f;
        if serial.iter().all(|byte| *byte == 0) {
            serial[0] = 1;
        }

        let mut params = base_ca_params()?;
        params.serial_number = Some(SerialNumber::from_slice(&serial));
        params.not_before = now - Duration::seconds(MAX_CLOCK_SKEW_SECS as i64);
        params.not_after = not_after;
        let cert = params.self_signed(&key)?;

        let key_pem = SecretString::from(key.serialize_pem());
        let not_before = format_rfc3339(params.not_before)?;
        let not_after_str = format_rfc3339(not_after)?;
        Ok(Self {
            key_pem,
            ca_params: params,
            cert_pem: cert.pem(),
            cert_der: cert.der().as_ref().to_vec(),
            serial_hex: hex_lower(&serial),
            not_before,
            not_after: not_after_str,
            not_after_dt: not_after,
            key_fingerprint,
        })
    }

    /// Rebuild a signer from an authenticated, decrypted vault payload.
    pub fn from_payload(payload: &VaultPayload) -> Result<Self> {
        payload.validate()?;
        let key_pem = SecretString::from(payload.ca_key_pem.clone());
        let probe_key = KeyPair::from_pem(key_pem.expose_secret())?;
        let computed = sha256_hex(&probe_key.subject_public_key_info());
        drop(probe_key);
        if computed != payload.key_fingerprint_sha256 {
            return Err(PkiError::MetadataMismatch);
        }
        let cert_der = base64::engine::general_purpose::STANDARD
            .decode(&payload.ca_cert_der_b64)
            .map_err(|_| PkiError::MalformedVault)?;
        if cert_der.is_empty() || cert_der.len() > MAX_CA_CERT_DER_BYTES {
            return Err(PkiError::MalformedVault);
        }
        let not_after_dt = parse_rfc3339(&payload.ca_not_after)?;
        parse_rfc3339(&payload.ca_not_before)?;
        Ok(Self {
            key_pem,
            ca_params: base_ca_params()?,
            cert_pem: payload.ca_cert_pem.clone(),
            cert_der,
            serial_hex: payload.ca_serial_hex.clone(),
            not_before: payload.ca_not_before.clone(),
            not_after: payload.ca_not_after.clone(),
            not_after_dt,
            key_fingerprint: payload.key_fingerprint_sha256.clone(),
        })
    }

    /// Private key PEM, exposed only inside this crate to build the encrypted
    /// envelope. Never used by a public export path.
    pub(crate) fn key_pem_for_envelope(&self) -> &SecretString {
        &self.key_pem
    }

    /// Public CA certificate in PEM form.
    pub fn public_cert_pem(&self) -> &str {
        &self.cert_pem
    }

    /// Public CA certificate in DER form.
    pub fn public_cert_der(&self) -> &[u8] {
        &self.cert_der
    }

    /// SHA-256 of the CA public key's SPKI DER, lower-case hex.
    pub fn key_fingerprint(&self) -> &str {
        &self.key_fingerprint
    }

    /// Build the public metadata derived from this signer.
    pub fn metadata(&self) -> CaMetadata {
        CaMetadata {
            schema: crate::metadata::METADATA_SCHEMA,
            purpose: PURPOSE_ID.into(),
            key_fingerprint_sha256: self.key_fingerprint.clone(),
            cert_fingerprint_sha256: sha256_hex(&self.cert_der),
            serial_hex: self.serial_hex.clone(),
            subject: "O=Vantyr Network, CN=Vantyr Network Inspection CA".into(),
            not_before: self.not_before.clone(),
            not_after: self.not_after.clone(),
            public_cert_pem: self.cert_pem.clone(),
        }
    }

    /// Issue a short-lived server leaf. The returned chain and private key are
    /// kept separate so a later rustls integration can feed them to
    /// `with_single_cert` without any re-parsing by this crate.
    pub fn issue_server_leaf(&self, request: LeafRequest) -> Result<IssuedLeaf> {
        let sans = validate_server_names(&request.dns_names, &request.ip_addresses)?;
        if request.validity_secs == 0 || request.validity_secs > MAX_LEAF_VALID_SECS {
            return Err(PkiError::InvalidValidity);
        }
        let not_before = request.now - Duration::seconds(MAX_CLOCK_SKEW_SECS as i64);
        let not_after = request.now + Duration::seconds(request.validity_secs as i64);
        if not_after > self.not_after_dt {
            return Err(PkiError::InvalidValidity);
        }

        let mut leaf_params = CertificateParams::new(Vec::<String>::new())?;
        leaf_params.subject_alt_names = sans;
        leaf_params.is_ca = IsCa::ExplicitNoCa;
        leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        leaf_params.not_before = not_before;
        leaf_params.not_after = not_after;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "Vantyr Network short-lived server leaf");
        leaf_params.distinguished_name = dn;

        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
        let ca_key = KeyPair::from_pem(self.key_pem.expose_secret())?;
        let issuer = Issuer::from_params(&self.ca_params, ca_key);
        let cert = leaf_params.signed_by(&leaf_key, &issuer)?;
        let cert_der = cert.der().as_ref().to_vec();
        let private_key_pem = SecretString::from(leaf_key.serialize_pem());

        Ok(IssuedLeaf {
            cert_pem: cert.pem(),
            cert_der: cert_der.clone(),
            chain_der: vec![cert_der, self.cert_der.clone()],
            private_key_pem,
            private_key_der: Zeroizing::new(leaf_key.serialize_der()),
        })
    }
}

/// Parameters that are identical between generation and recovery. Only the
/// distinguished name, key usages and key identifier method are used when
/// signing a leaf, so no CA parameter needs to be inferred from the certificate.
fn base_ca_params() -> Result<CertificateParams> {
    let mut params = CertificateParams::new(Vec::<String>::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.extended_key_usages = Vec::new();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::OrganizationName, "Vantyr Network");
    dn.push(DnType::CommonName, "Vantyr Network Inspection CA");
    params.distinguished_name = dn;
    Ok(params)
}

fn format_rfc3339(value: OffsetDateTime) -> Result<String> {
    value
        .format(&Rfc3339)
        .map_err(|e| PkiError::Serialize(e.to_string()))
}

fn parse_rfc3339(value: &str) -> Result<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| PkiError::MalformedVault)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A validated request for one short-lived server leaf.
#[derive(Clone, Debug)]
pub struct LeafRequest {
    pub dns_names: Vec<String>,
    pub ip_addresses: Vec<IpAddr>,
    /// Requested lifetime in seconds, bounded by [`MAX_LEAF_VALID_SECS`].
    pub validity_secs: u64,
    /// Reference time, supplied explicitly so issuance is deterministic and
    /// testable. Production callers pass `OffsetDateTime::now_utc()`.
    pub now: OffsetDateTime,
}

impl LeafRequest {
    /// A request with the default bounded validity and the current UTC time.
    pub fn new(dns_names: Vec<String>, ip_addresses: Vec<IpAddr>) -> Self {
        Self {
            dns_names,
            ip_addresses,
            validity_secs: DEFAULT_LEAF_VALID_SECS,
            now: OffsetDateTime::now_utc(),
        }
    }

    /// Reject requests with more than the bounded number of names early.
    pub fn name_count(&self) -> usize {
        self.dns_names.len() + self.ip_addresses.len()
    }

    /// Kept for callers that want an early count check before issuance.
    pub fn check_bounds(&self) -> Result<()> {
        if self.name_count() > MAX_SANS {
            return Err(PkiError::TooManyNames {
                count: self.name_count(),
                limit: MAX_SANS,
            });
        }
        Ok(())
    }
}

/// An issued leaf plus material for a future rustls server config. The key is
/// redacted in `Debug` and is never written to disk by this crate.
#[derive(Debug)]
pub struct IssuedLeaf {
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    /// `[leaf, ca]` in DER form, in rustls chain order.
    pub chain_der: Vec<Vec<u8>>,
    pub private_key_pem: SecretString,
    /// PKCS#8 DER for callers that build a rustls `PrivateKeyDer` directly.
    pub private_key_der: Zeroizing<Vec<u8>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaf_is_not_a_ca_and_has_expected_validity() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let signer = CaSigner::generate(now, now + Duration::days(30)).unwrap();
        let leaf = signer
            .issue_server_leaf(LeafRequest {
                dns_names: vec!["proxy.example.test".into()],
                ip_addresses: vec!["10.0.0.1".parse().unwrap()],
                validity_secs: 3600,
                now,
            })
            .unwrap();
        assert_eq!(leaf.chain_der.len(), 2);
        assert_eq!(leaf.chain_der[0], leaf.cert_der);
        assert_eq!(leaf.chain_der[1], signer.public_cert_der());
        assert!(!format!("{:?}", leaf).contains("BEGIN PRIVATE KEY"));
    }

    #[test]
    fn leaf_cannot_outlive_its_ca() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let signer = CaSigner::generate(now, now + Duration::hours(1)).unwrap();
        let result = signer.issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 2 * 3600,
            now,
        });
        assert_eq!(result.err(), Some(PkiError::InvalidValidity));
    }

    #[test]
    fn debug_hides_key_material() {
        let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let signer = CaSigner::generate(now, now + Duration::days(1)).unwrap();
        let rendered = format!("{signer:?}");
        assert!(rendered.contains("[redacted]"));
        assert!(!rendered.contains("BEGIN PRIVATE KEY"));
    }
}
