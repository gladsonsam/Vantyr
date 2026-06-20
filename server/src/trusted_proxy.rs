//! Trusted reverse-proxy handling for client-IP derivation.
//!
//! `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Proto` are attacker-controllable unless the
//! direct TCP peer is a reverse proxy we operate. Security decisions (login rate limiting and
//! lockout) must only honor those headers when the peer's IP falls inside an operator-configured
//! `TRUSTED_PROXY_CIDRS` allowlist. The default is empty, i.e. trust nobody and key on the peer IP.
//!
//! `auth::client_ip_for_audit` keeps trusting the first forwarded hop for *audit* logging only.

use axum::http::{HeaderMap, Request};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

/// A single IPv4/IPv6 CIDR block (or a bare host address, treated as a /32 or /128).
#[derive(Debug, Clone, Copy)]
pub struct Cidr {
    base: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `"10.0.0.0/8"`, `"203.0.113.4"`, or `"2001:db8::/32"`. Returns `None` if malformed.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        match s.split_once('/') {
            Some((addr_s, prefix_s)) => {
                let base: IpAddr = addr_s.trim().parse().ok()?;
                let prefix: u8 = prefix_s.trim().parse().ok()?;
                let max = if base.is_ipv4() { 32 } else { 128 };
                if prefix > max {
                    return None;
                }
                Some(Self { base, prefix })
            }
            None => {
                let base: IpAddr = s.parse().ok()?;
                let prefix = if base.is_ipv4() { 32 } else { 128 };
                Some(Self { base, prefix })
            }
        }
    }

    /// Whether `ip` falls inside this block. Mismatched address families never match.
    pub fn contains(&self, ip: &IpAddr) -> bool {
        match (self.base, ip) {
            (IpAddr::V4(b), IpAddr::V4(i)) => masked_eq_v4(b, *i, self.prefix),
            (IpAddr::V6(b), IpAddr::V6(i)) => masked_eq_v6(b, *i, self.prefix),
            _ => false,
        }
    }
}

fn masked_eq_v4(a: Ipv4Addr, b: Ipv4Addr, prefix: u8) -> bool {
    let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
    (u32::from(a) & mask) == (u32::from(b) & mask)
}

fn masked_eq_v6(a: Ipv6Addr, b: Ipv6Addr, prefix: u8) -> bool {
    let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
    (u128::from(a) & mask) == (u128::from(b) & mask)
}

/// Operator-configured allowlist of reverse proxies whose forwarding headers we trust.
#[derive(Debug, Clone, Default)]
pub struct TrustedProxies {
    cidrs: Vec<Cidr>,
}

impl TrustedProxies {
    /// Parse a comma/space/newline-separated list. Returns the parsed set plus any unparseable
    /// tokens so the caller can fail fast or warn.
    pub fn parse_list(s: &str) -> (Self, Vec<String>) {
        let mut cidrs = Vec::new();
        let mut invalid = Vec::new();
        for part in s.split([',', ' ', '\n', '\t', '\r']) {
            let p = part.trim();
            if p.is_empty() {
                continue;
            }
            match Cidr::parse(p) {
                Some(c) => cidrs.push(c),
                None => invalid.push(p.to_string()),
            }
        }
        (Self { cidrs }, invalid)
    }

    pub fn is_empty(&self) -> bool {
        self.cidrs.is_empty()
    }

    /// Whether `ip` is one of the trusted reverse proxies.
    pub fn is_trusted(&self, ip: &IpAddr) -> bool {
        self.cidrs.iter().any(|c| c.contains(ip))
    }

    /// Client IP for **security decisions** (rate limit / lockout keys). Only honors the
    /// forwarding headers when the direct `peer` is a trusted proxy; otherwise returns the peer IP.
    pub fn client_ip(&self, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
        if self.is_trusted(&peer.ip()) {
            if let Some(ip) = forwarded_client_ip(headers) {
                return ip;
            }
        }
        peer.ip()
    }
}

/// Leftmost (client-closest) IP from `X-Forwarded-For`, then `X-Real-IP`.
fn forwarded_client_ip(headers: &HeaderMap) -> Option<IpAddr> {
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(ip) = v.split(',').find_map(|s| s.trim().parse::<IpAddr>().ok()) {
            return Some(ip);
        }
    }
    if let Some(v) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if let Ok(ip) = v.trim().parse::<IpAddr>() {
            return Some(ip);
        }
    }
    None
}

/// `tower_governor` key extractor that mirrors [`TrustedProxies::client_ip`] so per-IP rate
/// limiting can't be sidestepped by spoofing `X-Forwarded-For` from an untrusted peer.
#[derive(Clone)]
pub struct TrustedIpKeyExtractor(pub Arc<TrustedProxies>);

impl tower_governor::key_extractor::KeyExtractor for TrustedIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(
        &self,
        req: &Request<T>,
    ) -> Result<Self::Key, tower_governor::errors::GovernorError> {
        let peer = req
            .extensions()
            .get::<axum::extract::ConnectInfo<SocketAddr>>()
            .map(|c| c.0)
            .ok_or(tower_governor::errors::GovernorError::UnableToExtractKey)?;
        Ok(self.0.client_ip(req.headers(), peer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdrs(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    fn peer(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_contains_v4() {
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains(&"10.1.2.3".parse().unwrap()));
        assert!(!c.contains(&"11.0.0.1".parse().unwrap()));
        let host = Cidr::parse("203.0.113.4").unwrap();
        assert!(host.contains(&"203.0.113.4".parse().unwrap()));
        assert!(!host.contains(&"203.0.113.5".parse().unwrap()));
    }

    #[test]
    fn cidr_contains_v6() {
        let c = Cidr::parse("2001:db8::/32").unwrap();
        assert!(c.contains(&"2001:db8::1".parse().unwrap()));
        assert!(!c.contains(&"2001:db9::1".parse().unwrap()));
    }

    #[test]
    fn cidr_rejects_bad_input() {
        assert!(Cidr::parse("not-an-ip").is_none());
        assert!(Cidr::parse("10.0.0.0/99").is_none());
        assert!(Cidr::parse("").is_none());
    }

    #[test]
    fn parse_list_collects_invalid() {
        let (tp, invalid) = TrustedProxies::parse_list("10.0.0.0/8, garbage, 192.168.1.1");
        assert_eq!(invalid, vec!["garbage".to_string()]);
        assert!(tp.is_trusted(&"10.5.5.5".parse().unwrap()));
        assert!(tp.is_trusted(&"192.168.1.1".parse().unwrap()));
        assert!(!tp.is_trusted(&"8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn untrusted_peer_ignores_forwarded_header() {
        let tp = TrustedProxies::default();
        let h = hdrs(&[("x-forwarded-for", "1.2.3.4")]);
        // Default (empty) allowlist trusts nobody → must key on the peer, not the spoofed header.
        assert_eq!(
            tp.client_ip(&h, peer("203.0.113.9:5555")),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn trusted_peer_honors_forwarded_header() {
        let (tp, _) = TrustedProxies::parse_list("203.0.113.0/24");
        let h = hdrs(&[("x-forwarded-for", "1.2.3.4, 203.0.113.9")]);
        assert_eq!(
            tp.client_ip(&h, peer("203.0.113.9:5555")),
            "1.2.3.4".parse::<IpAddr>().unwrap()
        );
        // Falls back to peer when the trusted proxy sends no forwarding header.
        let empty = HeaderMap::new();
        assert_eq!(
            tp.client_ip(&empty, peer("203.0.113.9:5555")),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn trusted_peer_falls_back_on_garbage_forwarded() {
        let (tp, _) = TrustedProxies::parse_list("10.0.0.0/8");
        let h = hdrs(&[("x-real-ip", "5.6.7.8")]);
        assert_eq!(
            tp.client_ip(&h, peer("10.0.0.5:1111")),
            "5.6.7.8".parse::<IpAddr>().unwrap()
        );
    }
}
