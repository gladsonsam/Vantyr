//! Certificate custody for the explicit DNS-over-TLS server listener.
//!
//! This module only turns operator-supplied certificate/key *paths* into a
//! maintained rustls `ServerConfig`. It never generates material, never
//! installs a host CA, never installs a custom/insecure verifier and never
//! writes to disk. The listener itself is registered in `server::serve` on the
//! *same* `FilteringHandler` as the plaintext sockets, so decrypted queries
//! receive the identical immutable policy and source-IP device mapping.
//!
//! Scope boundary: certificate/key consistency and current validity are
//! checked here with maintained parsers. Atomic in-process certificate
//! rotation (LST-08) is NOT implemented; changing any listener field is a
//! transport change and is rejected by reload. DoH/DoQ/DNSCrypt/H3 server
//! listeners are out of scope.

use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use anyhow::{bail, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

use crate::config::{Config, DotListenerConfig};

/// Byte bound for each PEM file. Mirrors the existing bounded CA material
/// limit; the read itself stops at one byte over so an oversized file is
/// rejected without allocating it.
const MAX_DOT_PEM_BYTES: usize = 16 * 1024;
const DOT_ALPN: &[u8] = b"dot";

/// Read one bounded PEM file with protected custody:
///   * the path is opened with `O_NOFOLLOW`, so swapping it for a symlink
///     between a path check and the open cannot redirect the read;
///   * regular-file, byte-bound and (for a private key) mode-0600 checks are
///     made on the OPENED DESCRIPTOR (`file.metadata()`), never on a path that
///     an attacker can change before the read;
///   * at most `MAX_DOT_PEM_BYTES`, read with a bound before allocation.
fn read_protected_pem(path: &str, label: &str, private: bool) -> Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(Path::new(path))
        .map_err(|error| anyhow::anyhow!("{label} cannot be opened: {error}"))?;
    let meta = file
        .metadata()
        .map_err(|error| anyhow::anyhow!("{label} cannot be inspected: {error}"))?;
    if !meta.is_file() {
        bail!("{label} must be a regular file, not a symlink or directory");
    }
    if meta.len() as usize > MAX_DOT_PEM_BYTES {
        bail!("{label} exceeds {MAX_DOT_PEM_BYTES} bytes");
    }
    #[cfg(unix)]
    if private {
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o600 {
            bail!("{label} must have mode 0600");
        }
    }
    #[cfg(not(unix))]
    let _ = private;

    let mut bytes = Vec::with_capacity(meta.len() as usize);
    let read = file
        .take(MAX_DOT_PEM_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if read > MAX_DOT_PEM_BYTES {
        bail!("{label} exceeds {MAX_DOT_PEM_BYTES} bytes");
    }
    Ok(bytes)
}

/// Prepare the maintained rustls server config for the ACTUAL selected config
/// exactly once. Callers pass the result through to `serve` rather than
/// reloading from the paths afterwards: a fresh durable start can therefore
/// fail on a bad certificate before it writes any state, and there is no
/// preflight/reload window in which the on-disk material can change between
/// validation and use.
pub(crate) fn prepare_dot_tls(config: &Config) -> Result<Option<Arc<ServerConfig>>> {
    match &config.dot_listener {
        Some(spec) if spec.enabled => Ok(Some(load_server_config(spec)?)),
        _ => Ok(None),
    }
}

/// Build the maintained rustls server config for the DoT listener. Every
/// failure here happens before any socket is registered, so a bad certificate
/// leaves no listener and does not touch persisted state.
pub(crate) fn load_server_config(spec: &DotListenerConfig) -> Result<Arc<ServerConfig>> {
    let cert_pem = read_protected_pem(&spec.cert_path, "DoT certificate", false)?;
    let key_pem = read_protected_pem(&spec.key_path, "DoT private key", true)?;

    let certs = pem::parse_many(cert_pem.as_slice())
        .map_err(|_| anyhow::anyhow!("DoT certificate is not valid PEM"))?;
    if certs.is_empty() {
        bail!("DoT certificate contains no certificate");
    }
    let mut chain = Vec::with_capacity(certs.len());
    for cert in &certs {
        if cert.tag() != "CERTIFICATE" {
            bail!("DoT certificate PEM contains a non-certificate block");
        }
        // Maintained X.509 parser: reject a malformed or currently invalid
        // (not-yet-valid / expired) server certificate without any local
        // certificate arithmetic or a custom time source.
        let (_, parsed) = x509_parser::parse_x509_certificate(cert.contents())
            .map_err(|error| anyhow::anyhow!("DoT certificate is not valid X.509: {error}"))?;
        if !parsed.validity().is_valid() {
            bail!("DoT certificate is not currently valid");
        }
        chain.push(CertificateDer::from(cert.contents().to_vec()));
    }

    let key_blocks = pem::parse_many(key_pem.as_slice())
        .map_err(|_| anyhow::anyhow!("DoT private key is not valid PEM"))?;
    let block = key_blocks
        .iter()
        .find(|candidate| candidate.tag().contains("PRIVATE KEY"))
        .ok_or_else(|| anyhow::anyhow!("DoT private key contains no private key block"))?;
    let key = PrivateKeyDer::try_from(block.contents().to_vec())
        .map_err(|error| anyhow::anyhow!("DoT private key is invalid: {error}"))?;

    // `with_single_cert` uses the maintained rustls key/certificate consistency
    // check; a mismatched pair is rejected here. `with_no_client_auth` is the
    // standard DoT posture (the client verifies this server; the server does
    // not demand a client certificate). No custom or skipping verifier is
    // installed anywhere on either side.
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| anyhow::anyhow!("DoT certificate and key do not match: {error}"))?;
    config.alpn_protocols = vec![DOT_ALPN.to_vec()];
    Ok(Arc::new(config))
}
