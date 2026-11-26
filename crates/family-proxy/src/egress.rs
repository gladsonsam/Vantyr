//! Destination validation and egress dialling for Vantyr Proxy.
//!
//! Every dialled socket is checked. IP literals are checked directly because
//! Rama's DNS connector deliberately passes them through untouched; hostnames
//! are resolved by a maintained resolver inside the same connector operation
//! and only approved, non-private candidates are stamped as connect targets.
//! A `ConnectorTargetStream` is mandatory, so the transport never falls back
//! to an unchecked second lookup. There is no global "allow private" switch:
//! a loopback destination is only reachable through an explicit narrow pin.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use rama::dns::client::resolver::DnsAddressResolver;
use rama::error::{BoxError, BoxErrorExt as _, ErrorExt as _};
use rama::extensions::Extensions;
use rama::futures::stream::{BoxStream, StreamExt as _};
use rama::net::client::{
    AddressCandidates, ConnectRequest, ConnectionError, ConnectionErrorKind, ConnectorService,
    ConnectorTargetStream, EstablishedClientConnection,
};
use rama::tcp::client::service::TcpConnector;
use rama::tcp::TcpStream;

use crate::config::{canonical_host, normalize_ip, Config};

/// Why an address is refused. Used for safe, non-secret diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DenyReason {
    Loopback,
    Private,
    LinkLocal,
    Metadata,
    CarrierNat,
    Unspecified,
    Multicast,
    Documentation,
    BroughtForwardPrivate,
    NotApproved,
}

/// Address classification, independent of any DNS behaviour. NAT64 and
/// IPv4-compatible forms are reduced to the embedded IPv4 address so a mapped
/// private destination cannot slip through as an innocuous-looking IPv6 one.
pub fn classify_ip(ip: IpAddr) -> Result<(), DenyReason> {
    match normalize_ip(ip) {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            if v6.is_unspecified() {
                return Err(DenyReason::Unspecified);
            }
            if v6.is_loopback() {
                return Err(DenyReason::Loopback);
            }
            if v6.is_multicast() {
                return Err(DenyReason::Multicast);
            }
            // Unique local fc00::/7 and link-local fe80::/10.
            if s[0] & 0xfe00 == 0xfc00 {
                return Err(DenyReason::Private);
            }
            if s[0] & 0xffc0 == 0xfe80 {
                return Err(DenyReason::LinkLocal);
            }
            // Deprecated IPv4-compatible ::a.b.c.d.
            if s[..5].iter().all(|&part| part == 0) && s[5] == 0 && (s[6] != 0 || s[7] != 0) {
                return classify_v4(embedded_v4(s[6], s[7]));
            }
            // Well-known NAT64 prefix 64:ff9b::/96.
            if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6].iter().all(|&part| part == 0) {
                return classify_v4(embedded_v4(s[6], s[7]))
                    .map_err(|_| DenyReason::BroughtForwardPrivate);
            }
            Ok(())
        }
    }
}

fn embedded_v4(high: u16, low: u16) -> Ipv4Addr {
    Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
}

fn classify_v4(v4: Ipv4Addr) -> Result<(), DenyReason> {
    let [a, b, _, _] = v4.octets();
    if v4.is_unspecified() {
        return Err(DenyReason::Unspecified);
    }
    if v4.is_loopback() {
        return Err(DenyReason::Loopback);
    }
    if v4.is_multicast() || v4.is_broadcast() {
        return Err(DenyReason::Multicast);
    }
    if a == 169 && b == 254 {
        return Err(DenyReason::Metadata);
    }
    if a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) {
        return Err(DenyReason::Private);
    }
    if a == 100 && (64..=127).contains(&b) {
        return Err(DenyReason::CarrierNat);
    }
    if a == 192 && b == 0 {
        return Err(DenyReason::Documentation);
    }
    if a == 0 {
        return Err(DenyReason::Unspecified);
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct Approval {
    port: u16,
    /// Narrow loopback exception. When present it is the only socket dialled.
    pin: Option<SocketAddr>,
}

/// The explicit destination allowlist. This is the single source of truth for
/// both ordinary HTTP forwarding and CONNECT tunnels.
#[derive(Clone, Debug, Default)]
pub struct EgressPolicy {
    approvals: BTreeMap<String, Approval>,
}

impl EgressPolicy {
    /// Build the allowlist from validated configuration only. No implicit
    /// approvals exist: an empty list denies every destination.
    pub fn from_config(config: &Config) -> Self {
        Self::new(config.destinations.iter().map(|destination| {
            let pin = destination
                .pin
                .as_ref()
                .map(|pin| std::net::SocketAddr::from_str(pin).expect("destination pin validated"));
            (destination.host.clone(), destination.port, pin)
        }))
    }

    pub fn new(destinations: impl IntoIterator<Item = (String, u16, Option<SocketAddr>)>) -> Self {
        let approvals = destinations
            .into_iter()
            .map(|(host, port, pin)| {
                // Even when constructed outside config validation, a pin is
                // only ever accepted as an exact loopback socket at the
                // approved port. There is no global private-address bypass.
                let pin = pin.filter(|addr| {
                    normalize_ip(addr.ip()).is_loopback() && addr.port() != 0 && addr.port() == port
                });
                (canonical_host(&host), Approval { port, pin })
            })
            .collect();
        Self { approvals }
    }

    pub(crate) fn approval(&self, host: &str, port: u16) -> Option<&Approval> {
        self.approvals
            .get(&canonical_host(host))
            .filter(|approval| approval.port == port)
    }

    /// Validate an actual socket candidate against an approval. Called for
    /// every resolved address and for literal destinations.
    pub(crate) fn allows_candidate(&self, approval: &Approval, candidate: SocketAddr) -> bool {
        match approval.pin {
            Some(pin) => pin == candidate,
            None => candidate.port() == approval.port && classify_ip(candidate.ip()).is_ok(),
        }
    }

    /// Resolve a literal destination to the one socket that may be dialled.
    /// Literals require an explicit pin; a private literal is never inferred
    /// to be an approved service.
    fn literal_candidate(&self, approval: &Approval, ip: IpAddr, port: u16) -> Option<SocketAddr> {
        let candidate = SocketAddr::new(normalize_ip(ip), port);
        self.allows_candidate(approval, candidate)
            .then_some(candidate)
    }

    /// Filter resolved addresses to the approved socket set. Shared with
    /// tests so a simulated rebinding answer can be asserted as discarded.
    pub(crate) fn filter_resolved(
        &self,
        approval: &Approval,
        resolved: Vec<IpAddr>,
        port: u16,
    ) -> Vec<SocketAddr> {
        resolved
            .into_iter()
            .filter_map(|ip| {
                let candidate = SocketAddr::new(ip, port);
                self.allows_candidate(approval, candidate)
                    .then_some(candidate)
            })
            .collect()
    }
}

/// Compatibility view of a pinned destination register, retained for the
/// existing compatibility spike. The worker itself uses `EgressPolicy`, which
/// additionally validates every actual dialled socket.
#[derive(Clone, Debug)]
pub struct DestinationPolicy {
    pub pinned_hosts: BTreeMap<String, SocketAddr>,
}

impl DestinationPolicy {
    /// Literals always require an explicit pin; only an approved hostname at
    /// the exact approved port passes.
    pub fn allows_host(&self, host: &str, port: u16) -> bool {
        if IpAddr::from_str(host).is_ok() {
            return false;
        }
        self.pinned_hosts
            .get(&canonical_host(host))
            .is_some_and(|addr| addr.port() == port)
    }

    /// Validate an actual socket candidate, not just resolver output.
    pub fn allows_socket(&self, candidate: SocketAddr) -> bool {
        candidate.ip().is_loopback() && self.pinned_hosts.values().any(|addr| *addr == candidate)
    }
}

/// A fixed, validated candidate source. Installing this on the request makes
/// a resolver-aware transport dial exactly the approved sockets; there is no
/// path where the transport performs its own lookup.
#[derive(Clone)]
struct FixedCandidates(Vec<SocketAddr>);

impl AddressCandidates for FixedCandidates {
    fn stream<'a>(
        &'a self,
        _extensions: &'a Extensions,
    ) -> BoxStream<'a, Result<SocketAddr, BoxError>> {
        rama::futures::stream::iter(self.0.iter().copied().map(Ok)).boxed()
    }
}

fn reject(reason: DenyReason) -> ConnectionError {
    ConnectionError::local(
        BoxError::from_static_str("destination denied by Vantyr Proxy policy")
            .context_debug_field("reason", reason),
        ConnectionErrorKind::Rejected,
    )
}

/// A connector that validates the destination and dials only approved socket
/// candidates via Rama's maintained TCP connector.
#[derive(Clone)]
pub struct EgressConnector<R> {
    policy: Arc<EgressPolicy>,
    resolver: R,
    tcp: TcpConnector,
    connect_timeout: Duration,
    max_candidates: usize,
}

impl<R> EgressConnector<R> {
    pub fn new(policy: EgressPolicy, resolver: R, connect_timeout: Duration) -> Self {
        Self {
            policy: Arc::new(policy),
            resolver,
            tcp: TcpConnector::new(),
            connect_timeout,
            max_candidates: 16,
        }
    }

    pub fn policy(&self) -> &EgressPolicy {
        &self.policy
    }
}

impl<R> rama::Service<ConnectRequest> for EgressConnector<R>
where
    R: DnsAddressResolver + Clone + Send + Sync + 'static,
{
    type Output = EstablishedClientConnection<TcpStream, ConnectRequest>;
    type Error = ConnectionError;

    async fn serve(&self, req: ConnectRequest) -> Result<Self::Output, Self::Error> {
        match tokio::time::timeout(self.connect_timeout, self.connect(req)).await {
            Ok(result) => result,
            Err(_) => Err(ConnectionError::transport(
                BoxError::from_static_str("egress timed out"),
                ConnectionErrorKind::Timeout,
            )),
        }
    }
}

impl<R> EgressConnector<R>
where
    R: DnsAddressResolver + Clone + Send + Sync + 'static,
{
    async fn connect(
        &self,
        req: ConnectRequest,
    ) -> Result<EstablishedClientConnection<TcpStream, ConnectRequest>, ConnectionError> {
        let host = req.authority.host.to_str().to_string();
        let port = req.authority.port;
        let Some(approval) = self.policy.approval(&host, port) else {
            return Err(reject(DenyReason::NotApproved));
        };

        let candidates = if let Some(pin) = approval.pin {
            // Narrow exception: dial exactly the configured loopback socket.
            // No lookup occurs, so a rebinding/forged resolver answer cannot
            // change where the connection goes.
            vec![pin]
        } else if let Ok(ip) = req.authority.host.try_as_ip() {
            // Literal path: Rama would pass this straight through, so the
            // check has to happen here. Only an explicit pin permits a literal.
            match self.policy.literal_candidate(approval, ip, port) {
                Some(addr) => vec![addr],
                None => return Err(reject(DenyReason::NotApproved)),
            }
        } else {
            let Ok(domain) = req.authority.host.clone().try_into_domain() else {
                return Err(reject(DenyReason::NotApproved));
            };
            let mut resolved = Vec::new();
            let mut v4 = std::pin::pin!(self.resolver.lookup_ipv4(domain.clone()));
            while let Some(item) = v4.next().await {
                if let Ok(ip) = item {
                    resolved.push(IpAddr::V4(ip));
                    if resolved.len() >= self.max_candidates {
                        break;
                    }
                }
            }
            if resolved.len() < self.max_candidates {
                let mut v6 = std::pin::pin!(self.resolver.lookup_ipv6(domain));
                while let Some(item) = v6.next().await {
                    if let Ok(ip) = item {
                        resolved.push(IpAddr::V6(ip));
                        if resolved.len() >= self.max_candidates {
                            break;
                        }
                    }
                }
            }
            let approved = self.policy.filter_resolved(approval, resolved, port);
            if approved.is_empty() {
                return Err(reject(DenyReason::NotApproved));
            }
            approved
        };

        // A candidate stream is mandatory: the transport cannot fall back to
        // its own lookup of the authority after this point.
        req.extensions
            .insert(ConnectorTargetStream::new(FixedCandidates(candidates)));
        self.tcp.connect(req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_link_local_metadata_nat64_and_mapped_forms_are_denied() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:169.254.169.254",
            "::ffff:10.1.2.3",
            "::127.0.0.1",
            "64:ff9b::a9fe:a9fe",
        ] {
            assert!(
                classify_ip(ip.parse().unwrap()).is_err(),
                "{ip} must be denied"
            );
        }
        for ip in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                classify_ip(ip.parse().unwrap()).is_ok(),
                "{ip} must be allowed"
            );
        }
    }

    #[test]
    fn pinned_loopback_is_the_only_candidate() {
        let pin = SocketAddr::from(([127, 0, 0, 1], 18443));
        let policy = EgressPolicy::new([("echo.test".into(), 18443, Some(pin))]);
        let approval = policy.approval("ECHO.TEST.", 18443).unwrap();
        assert!(policy.allows_candidate(approval, pin));
        assert!(!policy.allows_candidate(approval, SocketAddr::from(([127, 0, 0, 2], 18443))));
        assert!(!policy.allows_candidate(approval, SocketAddr::from(([127, 0, 0, 1], 18444))));
        assert!(policy.approval("echo.test", 443).is_none());
        assert!(policy.approval("169.254.169.254", 18443).is_none());
    }

    #[test]
    fn simulated_rebinding_answer_keeps_only_the_approved_ip() {
        let approved = Ipv4Addr::new(198, 51, 100, 7);
        let policy = EgressPolicy::new([("public.test".into(), 443, None)]);
        let approval = policy.approval("public.test", 443).unwrap();
        let resolved = vec![
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(approved),
            IpAddr::V6("64:ff9b::a9fe:a9fe".parse().unwrap()),
        ];
        let candidates = policy.filter_resolved(approval, resolved, 443);
        assert_eq!(
            candidates,
            vec![SocketAddr::new(IpAddr::V4(approved), 443)],
            "a private/metadata/NAT64 answer must never become a dial candidate"
        );
    }

    #[test]
    fn literal_without_pin_is_never_dialled() {
        let policy = EgressPolicy::new([("public.test".into(), 443, None)]);
        assert!(policy.approval("169.254.169.254", 80).is_none());
        assert!(policy.approval("[::ffff:10.0.0.1]", 443).is_none());
        let pin = SocketAddr::from(([127, 0, 0, 1], 18443));
        let pinned = EgressPolicy::new([("127.0.0.1".into(), 18443, Some(pin))]);
        let approval = pinned.approval("127.0.0.1", 18443).unwrap();
        assert_eq!(
            pinned.literal_candidate(approval, "127.0.0.1".parse().unwrap(), 18443),
            Some(pin)
        );
    }
}
