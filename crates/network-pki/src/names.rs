//! Validation of server identities that may be placed in a leaf certificate.
//!
//! Only DNS names and IP addresses are supported. Wildcards are rejected: the
//! CAs issued here are for bounded, explicitly named proxy targets, and a
//! wildcard would make a short-lived leaf cover an unbounded set of hosts.
//! Nothing here parses TLS or X.509; it validates plain strings and `IpAddr`s
//! before handing them to rcgen as SANs.

use std::collections::BTreeSet;
use std::net::IpAddr;

use rcgen::SanType;

use crate::error::{PkiError, Result};

/// Hard cap on names in one leaf request.
pub const MAX_SANS: usize = 16;
/// Longest DNS name accepted (RFC 1035 presentation form).
pub const MAX_DNS_LEN: usize = 253;
/// Longest single DNS label.
pub const MAX_LABEL_LEN: usize = 63;
/// Cap on the total public input bytes for one request.
pub const MAX_NAME_INPUT_BYTES: usize = 4096;

/// Convert validated names to rcgen SANs, rejecting duplicates and anything
/// outside the supported DNS/IP set.
pub fn validate_server_names(
    dns_names: &[String],
    ip_addresses: &[IpAddr],
) -> Result<Vec<SanType>> {
    let count = dns_names.len() + ip_addresses.len();
    if count == 0 {
        return Err(PkiError::InvalidName(
            "at least one DNS name or IP address is required".into(),
        ));
    }
    if count > MAX_SANS {
        return Err(PkiError::TooManyNames {
            count,
            limit: MAX_SANS,
        });
    }
    let input_bytes = dns_names.iter().map(|n| n.len()).sum::<usize>() + ip_addresses.len() * 16;
    if input_bytes > MAX_NAME_INPUT_BYTES {
        return Err(PkiError::InvalidName("name input is too large".into()));
    }

    let mut seen = BTreeSet::new();
    let mut sans = Vec::with_capacity(count);

    for name in dns_names {
        validate_dns_name(name)?;
        if !seen.insert(format!("dns:{name}")) {
            return Err(PkiError::InvalidName(format!(
                "duplicate DNS name {name:?}"
            )));
        }
        sans.push(SanType::DnsName(name.clone().try_into().map_err(|_| {
            PkiError::InvalidName("name is not valid IA5".into())
        })?));
    }
    for ip in ip_addresses {
        if !seen.insert(format!("ip:{ip}")) {
            return Err(PkiError::InvalidName(format!("duplicate IP address {ip}")));
        }
        sans.push(SanType::IpAddress(*ip));
    }
    Ok(sans)
}

/// Validate an ASCII DNS name for use as a SAN. IDNs must already be punycode.
fn validate_dns_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(PkiError::InvalidName("empty DNS name".into()));
    }
    if name.len() > MAX_DNS_LEN {
        return Err(PkiError::InvalidName("DNS name is too long".into()));
    }
    if name.contains('*') {
        return Err(PkiError::InvalidName(format!(
            "wildcard DNS name {name:?} is not supported"
        )));
    }
    if !name.is_ascii() {
        return Err(PkiError::InvalidName(format!(
            "DNS name {name:?} must be ASCII (use punycode)"
        )));
    }
    if name.starts_with('.') || name.ends_with('.') {
        return Err(PkiError::InvalidName(format!(
            "DNS name {name:?} has an empty label"
        )));
    }
    for label in name.split('.') {
        if label.is_empty() || label.len() > MAX_LABEL_LEN {
            return Err(PkiError::InvalidName(format!(
                "DNS name {name:?} has an invalid label"
            )));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(PkiError::InvalidName(format!(
                "DNS name {name:?} label starts or ends with '-'"
            )));
        }
        if !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(PkiError::InvalidName(format!(
                "DNS name {name:?} contains an unsupported character"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_dns_and_ip() {
        let sans = validate_server_names(
            &["proxy.example.test".into(), "a-b.local".into()],
            &["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()],
        )
        .unwrap();
        assert_eq!(sans.len(), 4);
    }

    #[test]
    fn rejects_wildcards_and_malformed_names() {
        for bad in [
            "*.example.test",
            "",
            "-bad.example",
            "bad-.example",
            "bad..example",
            ".example",
            "example.",
            "under_score.example",
            "café.example",
        ] {
            assert!(
                validate_server_names(&[bad.into()], &[]).is_err(),
                "accepted bad name {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_duplicates_and_too_many_names() {
        assert!(validate_server_names(&["a.example".into(), "a.example".into()], &[]).is_err());
        let many: Vec<String> = (0..MAX_SANS + 1).map(|i| format!("h{i}.example")).collect();
        assert_eq!(
            validate_server_names(&many, &[]),
            Err(PkiError::TooManyNames {
                count: MAX_SANS + 1,
                limit: MAX_SANS,
            })
        );
    }

    #[test]
    fn requires_at_least_one_name() {
        assert!(validate_server_names(&[], &[]).is_err());
    }
}
