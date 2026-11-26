//! Per-CONNECT short-lived leaf issuance and the SNI-bound TLS server config.
//!
//! This is the only place that turns PKI material into a rustls server config.
//! The leaf's **only** SANs are the exact CONNECT authority (a DNS name or an
//! IP literal); an uninterpreted authority is refused. The SNI guard rejects a
//! ClientHello whose server name is not that same authority — rustls server
//! certificate selection is not client authentication, so relying on the
//! certificate alone would not stop a mismatched SNI from being accepted.

use std::sync::Arc;

use rama::error::{BoxError, BoxErrorExt as _};
use rama::net::address::{Host, HostWithPort};
use rama::tls::rustls::dep::rustls::pki_types::{
    CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer,
};
use rama::tls::rustls::dep::rustls::server::ClientHello;
use rama::tls::rustls::dep::rustls::ServerConfig;
use rama::tls::rustls::server::{DynamicConfigProvider, RustlsServerConfigExt as _};
use rama::tls::server::TlsServerConfig;
use vantyr_network_pki::{CaSigner, IssuedLeaf, LeafRequest};

/// Install the maintained aws-lc-rs provider explicitly. With only the
/// `aws-lc` feature selected rustls would also auto-install it; an explicit
/// call makes the choice auditable and is a no-op when already installed.
pub(crate) fn install_crypto_provider() {
    let _ = rama::tls::rustls::dep::rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// Issue a leaf whose only SAN is the CONNECT authority. `Uninterpreted`
/// authorities are rejected rather than guessed at.
pub(crate) fn issue_leaf(
    signer: &CaSigner,
    target: &HostWithPort,
    validity_secs: u64,
) -> Result<IssuedLeaf, BoxError> {
    let mut request = match &target.host {
        Host::Name(domain) => LeafRequest::new(vec![domain.to_string()], Vec::new()),
        Host::Address(ip) => LeafRequest::new(Vec::new(), vec![*ip]),
        Host::Uninterpreted(_) => {
            return Err(BoxError::from_static_str(
                "inspection: uninterpreted CONNECT authority is not allowed",
            ));
        }
        _ => {
            return Err(BoxError::from_static_str(
                "inspection: unsupported CONNECT authority",
            ));
        }
    };
    request.validity_secs = validity_secs;
    signer
        .issue_server_leaf(request)
        .map_err(|error| BoxError::from(error.to_string()))
}

/// Build an h1-only rustls server config from the issued leaf and bind SNI to
/// the exact CONNECT authority. The dynamic provider is the maintained Rama
/// hook; no TLS handshake code is reimplemented here.
pub(crate) fn server_config(
    leaf: IssuedLeaf,
    target: &HostWithPort,
) -> Result<TlsServerConfig, BoxError> {
    let chain: Vec<CertificateDer<'static>> = leaf
        .chain_der
        .into_iter()
        .map(CertificateDer::from)
        .collect();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf.private_key_der.to_vec()));

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| BoxError::from(format!("inspection leaf rejected: {error}")))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    let guard = Arc::new(SniGuard {
        expected_host: target.host.to_str().to_ascii_lowercase(),
        expected_is_ip: matches!(target.host, Host::Address(_)),
        config: Arc::new(config),
    });
    Ok(TlsServerConfig::new().with_dynamic_config(guard))
}

/// Reject a ClientHello whose SNI is not the CONNECT authority. For an IP
/// authority (where clients normally omit SNI) an absent SNI is allowed, but a
/// present and different one is still refused.
struct SniGuard {
    expected_host: String,
    expected_is_ip: bool,
    config: Arc<ServerConfig>,
}

impl DynamicConfigProvider for SniGuard {
    async fn get_config(&self, hello: ClientHello<'_>) -> Result<Arc<ServerConfig>, BoxError> {
        let expected = self.expected_host.trim_end_matches('.');
        match hello.server_name() {
            Some(name) => {
                if name.trim_end_matches('.').eq_ignore_ascii_case(expected) {
                    Ok(self.config.clone())
                } else {
                    Err(BoxError::from_static_str(
                        "inspection: SNI does not match CONNECT authority",
                    ))
                }
            }
            None if self.expected_is_ip => Ok(self.config.clone()),
            None => Err(BoxError::from_static_str(
                "inspection: missing SNI for a named CONNECT authority",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rama::net::address::{Domain, HostWithPort};

    #[test]
    fn leaf_is_built_from_the_exact_authority_with_a_short_chain() {
        let now = time::OffsetDateTime::now_utc();
        let signer = CaSigner::generate(now, now + time::Duration::days(1)).unwrap();
        let target = HostWithPort::new(Host::Name(Domain::try_from("origin.test").unwrap()), 18443);
        let leaf = issue_leaf(&signer, &target, 60).unwrap();
        assert_eq!(leaf.chain_der.len(), 2);
        assert_eq!(leaf.chain_der[0], leaf.cert_der);
        assert_eq!(leaf.chain_der[1], signer.public_cert_der());
        assert!(!format!("{leaf:?}").contains("BEGIN PRIVATE KEY"));
        assert!(server_config(leaf, &target).is_ok());
    }

    #[test]
    fn ip_authority_is_accepted() {
        let now = time::OffsetDateTime::now_utc();
        let signer = CaSigner::generate(now, now + time::Duration::days(1)).unwrap();
        let target = HostWithPort::new(Host::Address("127.0.0.1".parse().unwrap()), 18443);
        assert!(issue_leaf(&signer, &target, 60).is_ok());
    }
}
