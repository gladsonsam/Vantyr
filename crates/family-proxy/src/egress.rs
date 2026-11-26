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
    ProtocolAssignment,
    Benchmarking,
    SpecialPurpose,
    /// A standard translation prefix. The embedded IPv4 address is not
    /// trusted, even when the enclosing IPv6 address looks global.
    TranslationPrefix,
    BroughtForwardPrivate,
    /// Outside the conservative global-unicast IPv6 range (2000::/3).
    Reserved,
    NotApproved,
}

/// Conservative destination classification, independent of DNS behaviour.
///
/// This deliberately fails closed: only global unicast is eligible. It
/// rejects every standard translation prefix, including the well-known
/// `64:ff9b::/32` space (which covers RFC 6052 `/96` and the RFC 8215
/// `64:ff9b:1::/48` local-use prefix), 6to4 and Teredo. Network-specific
/// RFC 6052 prefixes cannot be recognised from the address alone; a network
/// that uses such a translator must pin destinations instead of relying on
/// DNS64. This classifier does not claim to detect arbitrary unknown
/// translators.
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
                return classify_v4(embedded_v4(s[6], s[7]))
                    .map_err(|_| DenyReason::BroughtForwardPrivate);
            }
            // SIIT IPv4-translated ::ffff:0:a.b.c.d/96 (not the mapped form
            // already canonicalised by normalize_ip).
            if s[..4].iter().all(|&part| part == 0) && s[4] == 0xffff && s[5] == 0 {
                return classify_v4(embedded_v4(s[6], s[7]))
                    .map_err(|_| DenyReason::BroughtForwardPrivate);
            }
            // Well-known NAT64 / translation space: 64:ff9b::/32 covers both
            // the RFC 6052 well-known /96 and RFC 8215's 64:ff9b:1::/48.
            if s[0] == 0x0064 && s[1] == 0xff9b {
                return Err(DenyReason::TranslationPrefix);
            }
            // Translation and special-purpose ranges inside 2000::/3.
            if s[0] == 0x2002 {
                return Err(DenyReason::TranslationPrefix); // 6to4 embeds IPv4
            }
            if s[0] == 0x2001 && s[1] == 0x0000 {
                return Err(DenyReason::TranslationPrefix); // Teredo /32
            }
            if s[0] == 0x2001 && (s[1] & 0xfff0) == 0x0010 {
                return Err(DenyReason::SpecialPurpose); // deprecated ORCHID
            }
            if s[0] == 0x2001 && (s[1] & 0xfff0) == 0x0020 {
                return Err(DenyReason::SpecialPurpose); // ORCHIDv2
            }
            if s[0] == 0x2001 && s[1] == 0x0002 {
                return Err(DenyReason::Benchmarking);
            }
            if s[0] == 0x2001 && s[1] == 0x0004 && s[2] == 0x0112 {
                return Err(DenyReason::SpecialPurpose); // AS112
            }
            if s[0] == 0x2001 && s[1] == 0x0db8 {
                return Err(DenyReason::Documentation);
            }
            if s[0] == 0x2620 && s[1] == 0x004f && (s[2] & 0xff00) == 0x8000 {
                return Err(DenyReason::SpecialPurpose); // AS112 direct delegation
            }
            // Only conservative global unicast is eligible. This also closes
            // other translation/reserved spaces outside 2000::/3.
            if (s[0] & 0xe000) != 0x2000 {
                return Err(DenyReason::Reserved);
            }
            Ok(())
        }
    }
}

fn embedded_v4(high: u16, low: u16) -> Ipv4Addr {
    Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
}

fn classify_v4(v4: Ipv4Addr) -> Result<(), DenyReason> {
    let [a, b, c, _] = v4.octets();
    if v4.is_unspecified() || a == 0 {
        return Err(DenyReason::Unspecified);
    }
    if v4.is_loopback() {
        return Err(DenyReason::Loopback);
    }
    if v4.is_multicast() || v4.is_broadcast() {
        return Err(DenyReason::Multicast);
    }
    // 240.0.0.0/4 is reserved (future use), including 255.255.255.255.
    if a >= 240 {
        return Err(DenyReason::Reserved);
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
        return Err(DenyReason::ProtocolAssignment);
    }
    if a == 192 && b == 88 && c == 99 {
        return Err(DenyReason::SpecialPurpose);
    }
    if a == 198 && (b == 18 || b == 19) {
        return Err(DenyReason::Benchmarking);
    }
    if a == 198 && b == 51 && c == 100 {
        return Err(DenyReason::Documentation);
    }
    if a == 203 && b == 0 && c == 113 {
        return Err(DenyReason::Documentation);
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
        let candidates = self
            .validated_candidates(&req.authority.host, req.authority.port)
            .await?;
        // A candidate stream is mandatory: the transport cannot fall back to
        // its own lookup of the authority after this point.
        req.extensions
            .insert(ConnectorTargetStream::new(FixedCandidates(candidates)));
        self.tcp.connect(req).await
    }

    /// Resolve and validate the approved candidate sockets. Kept as a single
    /// seam so tests can assert the non-pinned DNS path filters every answer
    /// and consults the resolver only once, without faking the transport.
    pub(crate) async fn validated_candidates(
        &self,
        host: &rama::net::address::Host,
        port: u16,
    ) -> Result<Vec<SocketAddr>, ConnectionError> {
        let Some(approval) = self.policy.approval(&host.to_str(), port) else {
            return Err(reject(DenyReason::NotApproved));
        };
        if let Some(pin) = approval.pin {
            // Narrow exception: dial exactly the configured loopback socket.
            // No lookup occurs, so a rebinding/forged resolver answer cannot
            // change where the connection goes.
            return Ok(vec![pin]);
        }
        if let Ok(ip) = host.try_as_ip() {
            // Literal path: Rama would pass this straight through, so the
            // check has to happen here. Only an explicit pin permits a literal.
            return self
                .policy
                .literal_candidate(approval, ip, port)
                .map(|addr| vec![addr])
                .ok_or_else(|| reject(DenyReason::NotApproved));
        }
        let Ok(domain) = host.clone().try_into_domain() else {
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
        Ok(approved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rama::dns::client::resolver::DnsAddressResolver;
    use rama::futures::stream;
    use rama::net::address::{Domain, Host};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Resolver used to exercise the non-pinned path. It answers once with a
    /// mixture of private, special and global addresses and counts lookups so
    /// a second, uncontrolled lookup would be visible.
    #[derive(Clone, Debug)]
    struct FakeResolver {
        calls: Arc<AtomicUsize>,
        v4: Vec<Ipv4Addr>,
        v6: Vec<std::net::Ipv6Addr>,
    }

    impl DnsAddressResolver for FakeResolver {
        type Error = BoxError;

        fn lookup_ipv4(
            &self,
            _domain: Domain,
        ) -> impl stream::Stream<Item = Result<Ipv4Addr, Self::Error>> + Send + '_ {
            self.calls.fetch_add(1, Ordering::SeqCst);
            stream::iter(self.v4.iter().copied().map(Ok))
        }

        fn lookup_ipv6(
            &self,
            _domain: Domain,
        ) -> impl stream::Stream<Item = Result<std::net::Ipv6Addr, Self::Error>> + Send + '_
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            stream::iter(self.v6.iter().copied().map(Ok))
        }
    }

    #[tokio::test]
    async fn non_pinned_dns_path_filters_every_answer_and_looks_up_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = FakeResolver {
            calls: calls.clone(),
            v4: vec![
                Ipv4Addr::new(169, 254, 169, 254),
                Ipv4Addr::new(10, 0, 0, 1),
                Ipv4Addr::new(93, 184, 216, 34),
            ],
            v6: vec![
                // RFC 8215 local-use NAT64 embedding the metadata address.
                "64:ff9b:1:a9fe:a9fe::".parse().unwrap(),
                // 6to4 embedding a private IPv4 address.
                "2002:0a00:0001::".parse().unwrap(),
                "2606:4700:4700::1111".parse().unwrap(),
            ],
        };
        let connector = EgressConnector::new(
            EgressPolicy::new([("public.test".into(), 443, None)]),
            resolver,
            Duration::from_secs(2),
        );
        let host = Host::Name(Domain::try_from("public.test").unwrap());
        let candidates = connector
            .validated_candidates(&host, 443)
            .await
            .expect("a global candidate remains");
        assert_eq!(
            candidates,
            vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)), 443),
                SocketAddr::new("2606:4700:4700::1111".parse::<IpAddr>().unwrap(), 443),
            ],
            "private, metadata and translation answers must never be dial candidates"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "one A and one AAAA stream inside the connector, no additional lookups"
        );
    }

    #[tokio::test]
    async fn non_pinned_dns_path_fails_closed_when_all_answers_are_private() {
        let calls = Arc::new(AtomicUsize::new(0));
        let resolver = FakeResolver {
            calls: calls.clone(),
            v4: vec![Ipv4Addr::new(192, 168, 1, 1), Ipv4Addr::LOCALHOST],
            v6: vec!["64:ff9b:1:a9fe:a9fe::".parse().unwrap()],
        };
        let connector = EgressConnector::new(
            EgressPolicy::new([("blocked.test".into(), 443, None)]),
            resolver,
            Duration::from_secs(2),
        );
        let host = Host::Name(Domain::try_from("blocked.test").unwrap());
        assert!(connector.validated_candidates(&host, 443).await.is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "one A and one AAAA stream, no additional lookups"
        );
    }

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
            "64:ff9b:1:a9fe:a9fe::", // RFC 8215 local-use /48
            "64:ff9b:1::1",
            "2002:0a00:0001::",   // 6to4 embedding 10.0.0.1
            "2001:0:a9fe:a9fe::", // Teredo
            "2001:db8::1",
            "240.0.0.1", // reserved 240/4
            "255.255.255.255",
            "198.18.0.1",
            "192.0.0.9",
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
        let approved = Ipv4Addr::new(93, 184, 216, 34);
        let policy = EgressPolicy::new([("public.test".into(), 443, None)]);
        let approval = policy.approval("public.test", 443).unwrap();
        let resolved = vec![
            IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(approved),
            IpAddr::V6("64:ff9b::a9fe:a9fe".parse().unwrap()),
            IpAddr::V6("64:ff9b:1:a9fe:a9fe::".parse().unwrap()),
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
