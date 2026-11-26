//! SSRF guard. The addresses handed to reqwest are the exact ones we vetted:
//! a custom [`reqwest::dns::Resolve`] returns them directly, so there is no
//! second lookup and no DNS-rebinding TOCTOU. TLS verification still uses the
//! original URL hostname (reqwest verifies SNI/certificate from the URL, not
//! from the resolved IP). Redirects are disabled, so no second host can be
//! introduced mid-fetch.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::error::Error;

/// Maximum number of addresses accepted from one lookup. Bounds work and
/// prevents an attacker from returning thousands of addresses to churn through.
pub const MAX_RESOLVED_ADDRS: usize = 16;

/// True only for a globally routable unicast address. Everything loopback,
/// private, link-local, CGNAT, documentation, multicast, mapped-NAT64 and
/// reserved is rejected.
pub fn is_public_global(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    if a == 0 || a == 127 || a >= 224 {
        return false; // unspecified, loopback, multicast + reserved 224/4
    }
    if a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) {
        return false; // RFC1918
    }
    if a == 169 && b == 254 {
        return false; // link-local
    }
    if a == 100 && (64..=127).contains(&b) {
        return false; // CGNAT / shared address space
    }
    if a == 192 && b == 0 && (c == 2 || c == 0) {
        return false; // documentation + IETF protocol assignments
    }
    if a == 198 && (b == 18 || b == 19) {
        return false; // benchmarking
    }
    if a == 198 && b == 51 && c == 100 {
        return false; // documentation
    }
    if a == 203 && b == 0 && c == 113 {
        return false; // documentation
    }
    if a == 192 && b == 88 && c == 99 {
        return false; // deprecated 6to4 relay anycast
    }
    if a == 240 || a == 255 {
        return false; // reserved
    }
    let _ = d;
    true
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let o = ip.octets();
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    // IPv4-mapped ::ffff:0:0/96: decide by the mapped IPv4 address.
    if o[0..10].iter().all(|b| *b == 0) && o[10] == 0xff && o[11] == 0xff {
        return is_public_v4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    // Only global unicast 2000::/3 is accepted. This rejects ULA (fc00::/7),
    // link-local (fe80::/10), site-local, multicast, NAT64 (64:ff9b::/96),
    // IPv4-compatible and every other special range in one stroke.
    if !(0x20..=0x3f).contains(&o[0]) {
        return false;
    }
    // Documentation 2001:db8::/32, Teredo 2001::/32 and 6to4 2002::/16 are
    // not public list endpoints.
    if o[0] == 0x20 && o[1] == 0x01 && o[2] == 0x0d && o[3] == 0xb8 {
        return false;
    }
    if o[0] == 0x20 && o[1] == 0x01 && o[2] == 0x00 && o[3] == 0x00 {
        return false;
    }
    if o[0] == 0x20 && o[1] == 0x02 {
        return false;
    }
    true
}

/// Reject the whole set if any address is non-public. Returning an empty set
/// is also an error so a lookup failure can never turn into an empty fetch.
pub fn vet_public_addrs(addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, Error> {
    if addrs.is_empty() {
        return Err(Error::Transport(
            "dns".into(),
            "no addresses resolved for host".into(),
        ));
    }
    if addrs.len() > MAX_RESOLVED_ADDRS {
        return Err(Error::Transport(
            "dns".into(),
            "too many addresses resolved for host".into(),
        ));
    }
    let mut out = Vec::with_capacity(addrs.len());
    for addr in addrs {
        if !is_public_global(addr.ip()) {
            return Err(Error::Transport(
                "dns".into(),
                "host resolved to a non-public address".into(),
            ));
        }
        if !out.contains(&addr) {
            out.push(addr);
        }
    }
    Ok(out)
}

/// Injection seam for the lookup step. Production uses [`SystemLookup`]. A
/// test may inject a deterministic lookup; the public-address check is still
/// applied by [`VettedResolver`] afterwards, so a test lookup that returns a
/// private address is rejected exactly like production.
#[async_trait]
pub trait AddressLookup: Send + Sync {
    async fn lookup(&self, host: &str) -> Result<Vec<SocketAddr>, Error>;
}

pub struct SystemLookup;

#[async_trait]
impl AddressLookup for SystemLookup {
    async fn lookup(&self, host: &str) -> Result<Vec<SocketAddr>, Error> {
        let owned = host.to_owned();
        // getaddrinfo is blocking; keep it off the async worker.
        let resolved = tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            (owned.as_str(), 0u16)
                .to_socket_addrs()
                .map(|it| it.take(MAX_RESOLVED_ADDRS + 1).collect::<Vec<_>>())
        })
        .await
        .map_err(|e| Error::Transport("dns".into(), e.to_string()))?
        .map_err(|e| Error::Transport("dns".into(), e.to_string()))?;
        Ok(resolved)
    }
}

/// The resolver given to reqwest. It returns only the vetted addresses; reqwest
/// will never do a second lookup of the hostname.
pub struct VettedResolver {
    lookup: Arc<dyn AddressLookup>,
}

impl VettedResolver {
    pub fn new(lookup: Arc<dyn AddressLookup>) -> Self {
        Self { lookup }
    }
}

impl Resolve for VettedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = self.lookup.clone();
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found = lookup
                .lookup(&host)
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
            let vetted = vet_public_addrs(found)
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;
            let addrs: Addrs = Box::new(vetted.into_iter());
            Ok(addrs)
        })
    }
}
