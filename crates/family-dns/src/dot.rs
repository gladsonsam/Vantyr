//! Protected certificate custody and one-shot TLS preparation for the explicit
//! DNS-over-TLS and DNS-over-HTTPS (HTTP/2) server listeners.
//!
//! This module only turns operator-supplied certificate/key *paths* into a
//! maintained rustls `ServerConfig`. It never generates material, never
//! installs a host CA, never installs a custom/insecure verifier and never
//! writes to disk. Both listeners are registered in `server::serve` on the
//! *same* `FilteringHandler` as the plaintext sockets, so decrypted queries
//! receive the identical immutable policy and source-IP device mapping.
//!
//! Both enabled listeners are prepared ONCE, for the config actually selected
//! (bootstrap or persisted bundle), before any durable state write and before
//! any socket bind. The prepared bundle is passed through to `serve`, so no
//! path is re-read and there is no preflight/reload window in which the on-disk
//! material can change between validation and use.
//!
//! Scope boundary: certificate/key consistency and current validity are
//! checked here with maintained parsers. Atomic in-process certificate
//! rotation (LST-08) is NOT implemented; changing any listener field is a
//! transport change and is rejected by reload. DoQ/DNSCrypt/H3 server
//! listeners and per-client DoH path identities are out of scope.

use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use anyhow::{bail, Result};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

use crate::config::Config;

/// Byte bound for each PEM file. Mirrors the existing bounded CA material
/// limit; the read itself stops at one byte over so an oversized file is
/// rejected without allocating it.
const MAX_TLS_PEM_BYTES: usize = 16 * 1024;

/// The one maintained rustls config per enabled encrypted listener, prepared
/// once for the selected config and consumed by `serve`. Both fields are empty
/// when a listener is disabled, so an omitted block never reads a path.
#[derive(Default)]
pub(crate) struct PreparedTls {
    pub(crate) dot: Option<Arc<ServerConfig>>,
    pub(crate) doh: Option<Arc<ServerConfig>>,
}

impl PreparedTls {
    /// Prepare the maintained rustls configs for the ACTUAL selected config,
    /// exactly once. Callers pass the result through to `serve` rather than
    /// reloading from the paths afterwards: a fresh durable start can fail on
    /// bad certificate before it writes any state, and neither listener can be
    /// partly registered if the other's material is invalid.
    pub(crate) fn prepare(config: &Config) -> Result<Self> {
        let dot = match &config.dot_listener {
            Some(spec) if spec.enabled => Some(load_server_config(
                &spec.cert_path,
                &spec.key_path,
                b"dot",
                "DoT",
            )?),
            _ => None,
        };
        let doh = match &config.doh_listener {
            Some(spec) if spec.enabled => Some(load_server_config(
                &spec.cert_path,
                &spec.key_path,
                b"h2",
                "DoH",
            )?),
            _ => None,
        };
        Ok(Self { dot, doh })
    }
}

/// Read one bounded PEM file with protected custody:
///   * the path is opened with `O_NOFOLLOW`, so swapping it for a symlink
///     between a path check and the open cannot redirect the read;
///   * regular-file, byte-bound and (for a private key) mode-0600 checks are
///     made on the OPENED DESCRIPTOR (`file.metadata()`), never on a path that
///     an attacker can change before the read;
///   * at most `MAX_TLS_PEM_BYTES`, read with a bound before allocation.
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
    if meta.len() as usize > MAX_TLS_PEM_BYTES {
        bail!("{label} exceeds {MAX_TLS_PEM_BYTES} bytes");
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
        .take(MAX_TLS_PEM_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if read > MAX_TLS_PEM_BYTES {
        bail!("{label} exceeds {MAX_TLS_PEM_BYTES} bytes");
    }
    Ok(bytes)
}

/// Build one maintained rustls server config from protected PEM paths. Every
/// failure here happens before any socket is registered, so a bad certificate
/// leaves both listeners absent and does not touch persisted state. `alpn` is
/// the single wire identity of the listener ("dot" or "h2"); `label` is used
/// only in diagnostics.
fn load_server_config(
    cert_path: &str,
    key_path: &str,
    alpn: &[u8],
    label: &str,
) -> Result<Arc<ServerConfig>> {
    let cert_pem = read_protected_pem(cert_path, &format!("{label} certificate"), false)?;
    let key_pem = read_protected_pem(key_path, &format!("{label} private key"), true)?;

    let certs = pem::parse_many(cert_pem.as_slice())
        .map_err(|_| anyhow::anyhow!("{label} certificate is not valid PEM"))?;
    if certs.is_empty() {
        bail!("{label} certificate contains no certificate");
    }
    let mut chain = Vec::with_capacity(certs.len());
    for cert in &certs {
        if cert.tag() != "CERTIFICATE" {
            bail!("{label} certificate PEM contains a non-certificate block");
        }
        // Maintained X.509 parser: reject a malformed or currently invalid
        // (not-yet-valid / expired) server certificate without any local
        // certificate arithmetic or a custom time source.
        let (_, parsed) = x509_parser::parse_x509_certificate(cert.contents())
            .map_err(|error| anyhow::anyhow!("{label} certificate is not valid X.509: {error}"))?;
        if !parsed.validity().is_valid() {
            bail!("{label} certificate is not currently valid");
        }
        chain.push(CertificateDer::from(cert.contents().to_vec()));
    }

    let key_blocks = pem::parse_many(key_pem.as_slice())
        .map_err(|_| anyhow::anyhow!("{label} private key is not valid PEM"))?;
    let block = key_blocks
        .iter()
        .find(|candidate| candidate.tag().contains("PRIVATE KEY"))
        .ok_or_else(|| anyhow::anyhow!("{label} private key contains no private key block"))?;
    let key = PrivateKeyDer::try_from(block.contents().to_vec())
        .map_err(|error| anyhow::anyhow!("{label} private key is invalid: {error}"))?;

    // `with_single_cert` uses the maintained rustls key/certificate consistency
    // check; a mismatched pair is rejected here. `with_no_client_auth` is the
    // standard posture (the client verifies this server; the server does not
    // demand a client certificate). No custom or skipping verifier is installed
    // anywhere on either side.
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|error| anyhow::anyhow!("{label} certificate and key do not match: {error}"))?;
    config.alpn_protocols = vec![alpn.to_vec()];
    Ok(Arc::new(config))
}
