//! OPTIONAL, bounded real HTTPS inspection for Vantyr Proxy.
//!
//! Default off. When explicitly enabled for named credentials, a CONNECT is
//! terminated downstream with a short-lived leaf signed by the dedicated
//! inspection CA, and relayed to the already validated, already TLS-connected
//! upstream socket. Both directions keep the existing progress/deadline and
//! concurrency bounds. There is no second DNS lookup, no destination widening,
//! and no fallback to an opaque tunnel when inspection fails.

pub mod config;
mod connector;
mod leaf;
mod prepare;
mod relay;

pub use config::{InspectionConfig, InspectionException};

pub(crate) use connector::HandshakeTimeoutConnector;
pub(crate) use leaf::install_crypto_provider;
pub(crate) use prepare::PrepareInspection;
pub(crate) use relay::{InspectRelay, RelayLimits};

use std::collections::BTreeSet;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use rama::extensions::Extension;
use uuid::Uuid;
use vantyr_network_pki::{paths_for, read_secret_file, unlock, CaSigner};

use crate::config::canonical_host;
use crate::Config;

/// Which CONNECT path a request takes. Chosen only after credential, policy,
/// body and egress validation; the choice never changes the destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectionMode {
    Opaque,
    Inspect,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct InspectionModeMarker(pub InspectionMode);

impl Extension for InspectionModeMarker {}

/// One compiled, expiring, client-scoped opaque exception.
#[derive(Clone, Debug)]
pub struct CompiledException {
    pub host: String,
    pub port: u16,
    pub client_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

/// Immutable runtime state. The signer is the only holder of unlocked CA key
/// material and exists in memory only. Dropping it drops the unlocked key.
#[derive(Clone)]
pub struct InspectionRuntime {
    pub(crate) signer: Option<Arc<CaSigner>>,
    pub(crate) enabled_client_ids: BTreeSet<Uuid>,
    pub(crate) exceptions: Vec<CompiledException>,
    pub(crate) leaf_validity_secs: u64,
    pub(crate) handshake_timeout: Duration,
}

impl InspectionRuntime {
    /// Production construction. A disabled config never reads a secret or a
    /// vault. An enabled config fails closed if either cannot be unlocked.
    pub fn from_config(config: &Config) -> Result<Self> {
        let inspection = &config.inspection;
        let (client_ids, destinations) = cross_refs(config);
        inspection.validate(&client_ids, &destinations)?;
        if !inspection.enabled {
            return Ok(Self {
                signer: None,
                enabled_client_ids: BTreeSet::new(),
                exceptions: Vec::new(),
                leaf_validity_secs: inspection.leaf_validity_secs,
                handshake_timeout: Duration::from_secs(inspection.handshake_timeout_secs),
            });
        }

        install_crypto_provider();
        let secret = read_secret_file(Path::new(&inspection.secret_file_path))
            .map_err(|error| anyhow::anyhow!("inspection secret file rejected: {error}"))?;
        // The passphrase is dropped here; only the unlocked signer survives.
        let paths = paths_for(Path::new(&inspection.ca_dir), &inspection.ca_name)
            .map_err(|error| anyhow::anyhow!("inspection CA paths rejected: {error}"))?;
        let signer = unlock(&paths.vault, &secret)
            .map_err(|error| anyhow::anyhow!("inspection CA unlock failed: {error}"))?;
        drop(secret);

        Ok(Self {
            signer: Some(Arc::new(signer)),
            enabled_client_ids: inspection
                .enabled_client_ids
                .iter()
                .map(|id| Uuid::from_str(id).expect("client id validated"))
                .collect(),
            exceptions: inspection
                .exceptions
                .iter()
                .map(|exception| CompiledException {
                    host: canonical_host(&exception.host),
                    port: exception.port,
                    client_id: Uuid::from_str(&exception.client_id).expect("client id validated"),
                    expires_at: DateTime::parse_from_rfc3339(&exception.expires_at)
                        .expect("expires_at validated")
                        .with_timezone(&Utc),
                })
                .collect(),
            leaf_validity_secs: inspection.leaf_validity_secs,
            handshake_timeout: Duration::from_secs(inspection.handshake_timeout_secs),
        })
    }

    /// Test-only injection seam. Deliberately bypasses on-disk vault/secret
    /// access so real loopback tests can use an in-memory CA. This is never
    /// called by the binary, `start_with`, or any production path.
    #[doc(hidden)]
    pub fn from_signer_test_seam(signer: CaSigner, config: &Config) -> Result<Self> {
        let inspection = &config.inspection;
        if !inspection.enabled {
            bail!("test seam requires inspection to be enabled");
        }
        let (client_ids, destinations) = cross_refs(config);
        inspection.validate(&client_ids, &destinations)?;
        install_crypto_provider();
        Ok(Self {
            signer: Some(Arc::new(signer)),
            enabled_client_ids: inspection
                .enabled_client_ids
                .iter()
                .map(|id| Uuid::from_str(id).expect("client id validated"))
                .collect(),
            exceptions: inspection
                .exceptions
                .iter()
                .map(|exception| CompiledException {
                    host: canonical_host(&exception.host),
                    port: exception.port,
                    client_id: Uuid::from_str(&exception.client_id).expect("client id validated"),
                    expires_at: DateTime::parse_from_rfc3339(&exception.expires_at)
                        .expect("expires_at validated")
                        .with_timezone(&Utc),
                })
                .collect(),
            leaf_validity_secs: inspection.leaf_validity_secs,
            handshake_timeout: Duration::from_secs(inspection.handshake_timeout_secs),
        })
    }

    /// Select the opaque path only for credentials that are not inspected, or
    /// for a not-expired, client-scoped, exact host:port exception. An expired
    /// exception goes back to inspection, and no branch changes the destination.
    pub(crate) fn mode_for(
        &self,
        client_id: &Uuid,
        host: &str,
        port: u16,
        now: DateTime<Utc>,
    ) -> InspectionMode {
        if self.signer.is_none() || !self.enabled_client_ids.contains(client_id) {
            return InspectionMode::Opaque;
        }
        let host = canonical_host(host);
        let excepted = self.exceptions.iter().any(|exception| {
            exception.client_id == *client_id
                && exception.host == host
                && exception.port == port
                && exception.expires_at > now
        });
        if excepted {
            InspectionMode::Opaque
        } else {
            InspectionMode::Inspect
        }
    }
}

fn cross_refs(config: &Config) -> (BTreeSet<String>, Vec<(String, u16)>) {
    let client_ids = config.clients.iter().map(|c| c.id.clone()).collect();
    let destinations = config
        .destinations
        .iter()
        .map(|d| (canonical_host(&d.host), d.port))
        .collect();
    (client_ids, destinations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(exceptions: Vec<CompiledException>) -> InspectionRuntime {
        InspectionRuntime {
            signer: None,
            enabled_client_ids: [Uuid::parse_str("22222222-3333-4444-5555-666666666666").unwrap()]
                .into_iter()
                .collect(),
            exceptions,
            leaf_validity_secs: 300,
            handshake_timeout: Duration::from_secs(10),
        }
    }

    #[test]
    fn mode_is_opaque_without_a_signer_or_scope() {
        let id = Uuid::parse_str("22222222-3333-4444-5555-666666666666").unwrap();
        assert_eq!(
            runtime(Vec::new()).mode_for(&id, "origin.test", 18443, Utc::now()),
            InspectionMode::Opaque
        );
    }

    #[test]
    fn exceptions_are_client_scoped_exact_and_expiring() {
        let id = Uuid::parse_str("22222222-3333-4444-5555-666666666666").unwrap();
        let other = Uuid::parse_str("33333333-3333-4444-5555-666666666666").unwrap();
        let now = Utc::now();
        let mut rt = runtime(vec![CompiledException {
            host: "origin.test".into(),
            port: 18443,
            client_id: id,
            expires_at: now + Duration::from_secs(60),
        }]);
        rt.signer = Some(Arc::new(
            CaSigner::generate(
                time::OffsetDateTime::now_utc(),
                time::OffsetDateTime::now_utc() + time::Duration::days(1),
            )
            .unwrap(),
        ));
        assert_eq!(
            rt.mode_for(&id, "origin.test", 18443, now),
            InspectionMode::Opaque
        );
        assert_eq!(
            rt.mode_for(&other, "origin.test", 18443, now),
            InspectionMode::Opaque,
            "a non-enabled credential is always opaque"
        );
        assert_eq!(
            rt.mode_for(&id, "origin.test", 18444, now),
            InspectionMode::Inspect,
            "a different port cannot use the exception"
        );
        assert_eq!(
            rt.mode_for(&id, "origin.test", 18443, now + Duration::from_secs(61)),
            InspectionMode::Inspect,
            "expired exception returns to inspection"
        );
    }
}
