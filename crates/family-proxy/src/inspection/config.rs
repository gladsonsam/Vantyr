//! Validated configuration for the OPTIONAL HTTPS inspection path.
//!
//! Inspection is **off by default**. It never changes where a destination is
//! dialled: the same `EgressConnector` validates the actual socket on both the
//! opaque and the inspected CONNECT path. An exception is only a narrow,
//! expiring permission to *leave the client's TLS opaque* for an already
//! approved, exact `host:port` and an explicitly named credential. It can
//! never widen a destination or bypass policy.
//!
//! Config stores **paths only** — never key material, never a trust-install
//! instruction and never an HTTP API surface. The CA passphrase is read from
//! a private `0600` file into memory at start and is not exposed afterwards.

use std::collections::BTreeSet;
use std::str::FromStr;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;
use vantyr_network_pki::signer::MAX_LEAF_VALID_SECS;
use vantyr_network_pki::DEFAULT_CA_NAME;

use crate::config::{canonical_host, MAX_NAME_LEN, MAX_TIMEOUT_SECS};

/// Opaque exceptions must be renewed explicitly rather than become permanent.
pub const MAX_EXCEPTION_DAYS: i64 = 7;

/// Bound on the length of a configured filesystem path.
pub const MAX_PATH_LEN: usize = 4096;
/// Max certificates whose inspection can be opted out of by exception.
pub const MAX_EXCEPTIONS: usize = 64;
/// Max credentials explicitly allowed to be inspected.
pub const MAX_ENABLED_CLIENT_IDS: usize = 64;
/// Default short leaf lifetime. Bounded well below the PKI hard cap.
pub const DEFAULT_LEAF_VALIDITY_SECS: u64 = 300;
/// Default bound on each TLS handshake (either direction).
pub const DEFAULT_HANDSHAKE_TIMEOUT_SECS: u64 = 10;
/// Bound on the full decrypted session (handshake + request/response).
pub const MAX_SESSION_SECS: u64 = MAX_TIMEOUT_SECS;

fn default_ca_name() -> String {
    DEFAULT_CA_NAME.to_owned()
}
fn default_leaf_validity_secs() -> u64 {
    DEFAULT_LEAF_VALIDITY_SECS
}
fn default_handshake_timeout_secs() -> u64 {
    DEFAULT_HANDSHAKE_TIMEOUT_SECS
}

/// One narrow, expiring, client-scoped permission to keep a CONNECT opaque.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionException {
    /// Exact canonical host. No wildcard, no suffix, no IP range.
    pub host: String,
    /// Exact approved port.
    pub port: u16,
    /// The one credential this exception applies to.
    pub client_id: String,
    /// RFC3339 instant after which the exception no longer applies.
    pub expires_at: String,
}

/// All inspection settings. Every field is validated before a listener binds.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionConfig {
    /// Default `false`. Nothing is inspected unless an operator opts in.
    #[serde(default)]
    pub enabled: bool,
    /// Directory holding the encrypted CA vault. A path, never a key.
    #[serde(default)]
    pub ca_dir: String,
    /// Simple CA name used to derive vault paths.
    #[serde(default = "default_ca_name")]
    pub ca_name: String,
    /// Path to a `0600` passphrase file. A path, never the passphrase.
    #[serde(default)]
    pub secret_file_path: String,
    /// Short, bounded lifetime for each issued server leaf.
    #[serde(default = "default_leaf_validity_secs")]
    pub leaf_validity_secs: u64,
    /// Bound on the downstream and upstream TLS handshakes.
    #[serde(default = "default_handshake_timeout_secs")]
    pub handshake_timeout_secs: u64,
    /// Credential IDs for which inspection is actually enabled.
    #[serde(default)]
    pub enabled_client_ids: Vec<String>,
    /// Narrow expiring opt-outs, scoped to a credential.
    #[serde(default)]
    pub exceptions: Vec<InspectionException>,
}

impl Default for InspectionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            ca_dir: String::new(),
            ca_name: default_ca_name(),
            secret_file_path: String::new(),
            leaf_validity_secs: default_leaf_validity_secs(),
            handshake_timeout_secs: default_handshake_timeout_secs(),
            enabled_client_ids: Vec::new(),
            exceptions: Vec::new(),
        }
    }
}

impl InspectionConfig {
    /// Validate structural bounds and cross-reference client IDs and approved
    /// destinations. `client_ids` and `destinations` come from the already
    /// validated base config, so an exception can never introduce a destination
    /// that policy/egress did not already approve.
    pub fn validate(
        &self,
        client_ids: &BTreeSet<String>,
        destinations: &[(String, u16)],
    ) -> Result<()> {
        if !self.enabled {
            // A disabled feature must have no dormant scopes or exceptions.
            if !self.enabled_client_ids.is_empty() || !self.exceptions.is_empty() {
                bail!("inspection is disabled but scopes or exceptions are configured");
            }
            return Ok(());
        }

        check_path(&self.ca_dir, "inspection.ca_dir")?;
        check_path(&self.secret_file_path, "inspection.secret_file_path")?;
        if self.ca_name.is_empty() || self.ca_name.len() > 64 {
            bail!("inspection.ca_name must be 1..=64 characters");
        }
        if self.leaf_validity_secs == 0 || self.leaf_validity_secs > MAX_LEAF_VALID_SECS {
            bail!("inspection.leaf_validity_secs is out of range");
        }
        if self.handshake_timeout_secs == 0 || self.handshake_timeout_secs > MAX_SESSION_SECS {
            bail!("inspection.handshake_timeout_secs is out of range");
        }

        if self.enabled_client_ids.is_empty()
            || self.enabled_client_ids.len() > MAX_ENABLED_CLIENT_IDS
        {
            bail!(
                "inspection.enabled_client_ids must contain 1..={MAX_ENABLED_CLIENT_IDS} entries"
            );
        }
        let mut seen_clients = BTreeSet::new();
        for id in &self.enabled_client_ids {
            Uuid::from_str(id)
                .map_err(|_| anyhow::anyhow!("inspection client id '{id}' is not a UUID"))?;
            if !client_ids.contains(id) {
                bail!("inspection client id '{id}' is not a configured client");
            }
            if !seen_clients.insert(id) {
                bail!("duplicate inspection client id '{id}'");
            }
        }

        if self.exceptions.len() > MAX_EXCEPTIONS {
            bail!("at most {MAX_EXCEPTIONS} inspection exceptions are allowed");
        }
        let mut seen = BTreeSet::new();
        for exception in &self.exceptions {
            let host = canonical_host(&exception.host);
            if host.is_empty() || host.len() > MAX_NAME_LEN {
                bail!("inspection exception host must be 1..={MAX_NAME_LEN} characters");
            }
            if exception.port == 0 {
                bail!("inspection exception port must be nonzero");
            }
            Uuid::from_str(&exception.client_id)
                .map_err(|_| anyhow::anyhow!("inspection exception client id is not a UUID"))?;
            if !seen_clients.contains(&exception.client_id) {
                bail!("inspection exception client id is not enabled for inspection");
            }
            let expires_at: DateTime<Utc> = DateTime::parse_from_rfc3339(&exception.expires_at)
                .map_err(|_| anyhow::anyhow!("inspection exception expires_at must be RFC3339"))?
                .with_timezone(&Utc);
            if expires_at > Utc::now() + chrono::Duration::days(MAX_EXCEPTION_DAYS) {
                bail!("inspection exception expiry must be within {MAX_EXCEPTION_DAYS} days");
            }
            if !destinations
                .iter()
                .any(|(h, p)| *h == host && *p == exception.port)
            {
                bail!(
                    "inspection exception {host}:{} is not an approved destination",
                    exception.port
                );
            }
            if !seen.insert((exception.client_id.clone(), host, exception.port)) {
                bail!("duplicate inspection exception");
            }
        }
        Ok(())
    }
}

fn check_path(value: &str, label: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_PATH_LEN {
        bail!("{label} must be 1..={MAX_PATH_LEN} characters");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn clients() -> BTreeSet<String> {
        ["22222222-3333-4444-5555-666666666666".to_owned()]
            .into_iter()
            .collect()
    }
    fn destinations() -> Vec<(String, u16)> {
        [("origin.test".to_owned(), 18443)].into_iter().collect()
    }

    #[test]
    fn inspection_is_off_by_default_with_no_scopes() {
        let cfg = InspectionConfig::default();
        assert!(!cfg.enabled);
        assert!(cfg.validate(&clients(), &destinations()).is_ok());
        assert!(cfg.exceptions.is_empty());
        assert!(cfg.enabled_client_ids.is_empty());
    }

    #[test]
    fn disabled_config_cannot_keep_dormant_scopes() {
        let mut cfg = InspectionConfig::default();
        cfg.exceptions.push(InspectionException {
            host: "origin.test".into(),
            port: 18443,
            client_id: "22222222-3333-4444-5555-666666666666".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
        });
        assert!(cfg.validate(&clients(), &destinations()).is_err());
    }

    #[test]
    fn enabled_config_validates_scopes_paths_and_destination_scope() {
        let mut cfg = InspectionConfig {
            enabled: true,
            ca_dir: "/tmp/vantyr-pki".into(),
            secret_file_path: "/tmp/vantyr-pki/secret".into(),
            ..InspectionConfig::default()
        };
        cfg.enabled_client_ids
            .push("22222222-3333-4444-5555-666666666666".into());
        assert!(cfg.validate(&clients(), &destinations()).is_ok());
        cfg.leaf_validity_secs = MAX_LEAF_VALID_SECS + 1;
        assert!(cfg.validate(&clients(), &destinations()).is_err());
        cfg.leaf_validity_secs = DEFAULT_LEAF_VALIDITY_SECS;
        cfg.exceptions.push(InspectionException {
            host: "other.test".into(),
            port: 18443,
            client_id: "22222222-3333-4444-5555-666666666666".into(),
            expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        });
        assert!(
            cfg.validate(&clients(), &destinations()).is_err(),
            "an exception must never name an unapproved destination"
        );
    }

    #[test]
    fn standard_https_exception_is_temporary_and_destination_scoped() {
        let mut cfg = InspectionConfig {
            enabled: true,
            ca_dir: "/tmp/vantyr-pki".into(),
            secret_file_path: "/tmp/vantyr-pki/secret".into(),
            enabled_client_ids: vec!["22222222-3333-4444-5555-666666666666".into()],
            ..InspectionConfig::default()
        };
        cfg.exceptions.push(InspectionException {
            host: "origin.test".into(),
            port: 443,
            client_id: cfg.enabled_client_ids[0].clone(),
            expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        });
        let approved = vec![("origin.test".to_owned(), 443)];
        assert!(cfg.validate(&clients(), &approved).is_ok());
        assert!(cfg.validate(&clients(), &[]).is_err());
        cfg.exceptions[0].expires_at =
            (Utc::now() + chrono::Duration::days(MAX_EXCEPTION_DAYS + 1)).to_rfc3339();
        assert!(cfg.validate(&clients(), &approved).is_err());
        cfg.exceptions[0].expires_at = "2000-01-01T00:00:00Z".into();
        assert!(cfg.validate(&clients(), &approved).is_ok());
    }
}
