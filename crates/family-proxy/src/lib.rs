//! Rama 0.4 compatibility spike for the family network proxy worker.
//!
//! Scope: prove the protocol seams that decide the backend, not a complete
//! filtering proxy. Verified from pinned 0.4.0 source (paths relative to each
//! crate root):
//!   `rama-http-0.4.0/src/layer/upgrade/layer.rs` `UpgradeLayer::new`
//!   `rama-http-0.4.0/src/layer/upgrade/http_proxy_connect/eager.rs`
//!       `EagerHttpProxyConnector::new(connector, relay)` establishes egress
//!       BEFORE the CONNECT 200 is sent; errors become 400/502/504.
//!   `rama-dns-0.4.0/src/client/connector.rs` `DnsConnector::with_resolver`;
//!       IP-literal targets are passed through untouched (so address checks
//!       must also run on the literal path, not only in the resolver).
//!   `rama-net-0.4.0/src/client/connect_request.rs` `ConnectRequest.authority`
//!   `rama-core-0.4.0/src/service/handler.rs` `service_fn`
//!
//! Rama 0.4 has no `RustlsMitmCertIssuer` (only BoringSSL). A small rcgen
//! leaf issuer + rustls termination is future work; this spike keeps the CA
//! custody contract but does NOT claim HTTPS inspection. WebSocket and
//! client-facing HTTP/2 are explicitly out of scope here.

use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use family_policy::{
    evaluate, Action, Assignment, Connection, Decision, Device, EvaluationContext, Policy, Session,
};
use rama::error::{BoxError, BoxErrorExt as _};
use rama::net::client::{
    ConnectRequest, ConnectionError, ConnectionErrorKind, EstablishedClientConnection,
};
use rama::service::service_fn;

/// A gateway-owned inspection CA. The signing key stays inside this value;
/// only the public certificate may be enrolled on clients. Generation is
/// unique per instance — no shared embedded CA. TLS termination is future work.
pub struct InspectionCa {
    issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
    public_cert_pem: String,
}

impl InspectionCa {
    pub fn generate(common_name: &str) -> Result<Self> {
        let key = rcgen::KeyPair::generate()?;
        let mut params = rcgen::CertificateParams::default();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::CrlSign,
        ];
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, common_name.to_owned());
        let cert = params.self_signed(&key)?;
        let public_cert_pem = cert.pem();
        let issuer = rcgen::Issuer::from_ca_cert_pem(&public_cert_pem, key)?;
        Ok(Self {
            issuer,
            public_cert_pem,
        })
    }

    pub fn public_cert_pem(&self) -> &str {
        &self.public_cert_pem
    }

    pub fn issuer(&self) -> &rcgen::Issuer<'static, rcgen::KeyPair> {
        &self.issuer
    }
}

/// The pure-policy seam the proxy worker will consume.
pub trait ProxyPolicy: Send + Sync {
    fn decide(&self, host: &str, path: &str) -> Decision;
}

pub struct StaticProxyPolicy {
    policy: Policy,
    device: Device,
    session: Option<Session>,
    assignments: Vec<Assignment>,
    connections: Vec<Connection>,
    now: DateTime<Utc>,
}

impl StaticProxyPolicy {
    pub fn new(
        policy: Policy,
        device: Device,
        session: Option<Session>,
        assignments: Vec<Assignment>,
        connections: Vec<Connection>,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            policy,
            device,
            session,
            assignments,
            connections,
            now,
        }
    }
}

impl ProxyPolicy for StaticProxyPolicy {
    fn decide(&self, host: &str, path: &str) -> Decision {
        evaluate(
            &self.policy,
            &EvaluationContext {
                now: self.now,
                device: &self.device,
                session: self.session.as_ref(),
                assignments: &self.assignments,
                connections: &self.connections,
                action: Action::HttpRequest {
                    host: host.to_owned(),
                    path: path.to_owned(),
                },
                heartbeat_ttl_secs: 90,
            },
        )
    }
}

/// Destination policy for egress. Enforced on EVERY candidate: Rama's DNS
/// connector deliberately passes IP literals through untouched, so checking
/// only a resolver would let an IP literal bypass the policy.
#[derive(Clone, Debug)]
pub struct DestinationPolicy {
    /// Hostnames that may be dialled, mapped to the one pinned loopback socket
    /// approved for the local proof. No implicit "resolve whatever DNS says".
    pub pinned_hosts: std::collections::BTreeMap<String, SocketAddr>,
}

impl DestinationPolicy {
    pub fn allows_host(&self, host: &str, port: u16) -> bool {
        if IpAddr::from_str(host).is_ok() {
            // Literal path is always denied. Rama's DnsConnector passes IP
            // literals straight to the transport, so there is no resolver here
            // to constrain; only an explicitly enrolled hostname may be dialled.
            return false;
        }
        self.pinned_hosts
            .get(&host.to_ascii_lowercase())
            .is_some_and(|addr| addr.port() == port)
    }

    /// Validate an actual socket candidate, not just the resolver output.
    pub fn allows_socket(&self, candidate: SocketAddr) -> bool {
        if !candidate.ip().is_loopback() {
            return false;
        }
        self.pinned_hosts.values().any(|addr| *addr == candidate)
    }
}

/// Build a validating egress connector for `EagerHttpProxyConnector`. The
/// egress is established before CONNECT is acknowledged; a rejection is a
/// gateway error rather than a silent raw tunnel.
pub fn validating_connect_service(
    policy: DestinationPolicy,
    attempts: Arc<AtomicUsize>,
) -> impl rama::Service<
    ConnectRequest,
    Output = EstablishedClientConnection<
        rama::ServiceInput<tokio::io::DuplexStream>,
        ConnectRequest,
    >,
    Error = ConnectionError,
> + Clone {
    service_fn(move |req: ConnectRequest| {
        let host = req.authority.host.to_string();
        let port = req.authority.port;
        let policy = policy.clone();
        let attempts = attempts.clone();
        async move {
            if !policy.allows_host(&host, port) {
                return Err(ConnectionError::local(
                    BoxError::from_static_str("destination denied by network policy"),
                    ConnectionErrorKind::Rejected,
                ));
            }
            attempts.fetch_add(1, Ordering::SeqCst);
            let (client, _server) = tokio::io::duplex(1024);
            Ok(EstablishedClientConnection {
                input: req,
                conn: rama::ServiceInput::new(client),
            })
        }
    })
}

/// Proxy credentials are never forwarded upstream. Hudsucker's
/// `normalize_request` does not strip them, so the Rama worker must.
pub fn strip_proxy_credentials<B>(mut request: rama::http::Request<B>) -> rama::http::Request<B> {
    request.headers_mut().remove("proxy-authorization");
    request.headers_mut().remove("proxy-connection");
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use rama::http::layer::upgrade::{EagerHttpProxyConnector, UpgradeLayer};
    use rama::http::{Body, Request, Response, StatusCode};
    use rama::io::BridgeIo;
    use rama::net::uri::Uri;
    use rama::{Layer, Service};
    use std::collections::BTreeMap;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn pinned() -> DestinationPolicy {
        DestinationPolicy {
            pinned_hosts: BTreeMap::from([(
                "approved.test".to_owned(),
                SocketAddr::from((Ipv4Addr::LOCALHOST, 18443)),
            )]),
        }
    }

    fn connect_request(target: &str) -> Request<()> {
        Request::builder()
            .method("CONNECT")
            .uri(Uri::parse_authority_form(target).unwrap())
            .body(())
            .unwrap()
    }

    #[test]
    fn ip_literals_and_metadata_are_denied_even_though_rama_passes_them_through() {
        let p = pinned();
        assert!(p.allows_host("approved.test", 18443));
        assert!(
            !p.allows_host("approved.test", 443),
            "wrong port must not match"
        );
        for denied in [
            "169.254.169.254",
            "192.168.1.1",
            "10.0.0.1",
            "127.0.0.1",
            "::1",
        ] {
            assert!(!p.allows_host(denied, 80), "{denied} must be denied");
        }
        assert!(!p.allows_socket(SocketAddr::from((Ipv6Addr::LOCALHOST, 18443))));
    }

    #[test]
    fn inspection_ca_is_unique_and_only_public_pem_is_exported() {
        let a = InspectionCa::generate("Vantyr Test A").unwrap();
        let b = InspectionCa::generate("Vantyr Test B").unwrap();
        assert_ne!(a.public_cert_pem(), b.public_cert_pem());
        assert!(!a.public_cert_pem().contains("PRIVATE KEY"));
    }

    #[tokio::test]
    async fn eager_connector_establishes_egress_before_connect_ack() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let connector = validating_connect_service(pinned(), attempts.clone());
        let relay = service_fn(
            |_bridge: BridgeIo<
                rama::http::layer::upgrade::Upgraded,
                rama::ServiceInput<tokio::io::DuplexStream>,
            >| async { Ok::<_, BoxError>(()) },
        );
        let connect = EagerHttpProxyConnector::new(connector, relay);
        let inner = service_fn(|_req: Request| async {
            Ok::<_, std::convert::Infallible>(Response::new(Body::empty()))
        });
        let service =
            UpgradeLayer::new(rama::rt::Executor::default(), true, connect).into_layer(inner);

        let response = service
            .serve(connect_request("approved.test:18443").map(|_| Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "egress must be dialled before ack"
        );
    }

    #[tokio::test]
    async fn denied_and_malformed_connects_never_dial_egress() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let connector = validating_connect_service(pinned(), attempts.clone());
        let relay = service_fn(
            |_bridge: BridgeIo<
                rama::http::layer::upgrade::Upgraded,
                rama::ServiceInput<tokio::io::DuplexStream>,
            >| async { Ok::<_, BoxError>(()) },
        );
        let connect = EagerHttpProxyConnector::new(connector, relay);
        let inner = service_fn(|_req: Request| async {
            Ok::<_, std::convert::Infallible>(Response::new(Body::empty()))
        });
        let service =
            UpgradeLayer::new(rama::rt::Executor::default(), true, connect).into_layer(inner);

        for target in [
            "169.254.169.254:80",
            "127.0.0.1:18443",
            "192.168.1.1:443",
            "approved.test:443",
        ] {
            let response = service
                .serve(connect_request(target).map(|_| Body::empty()))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_GATEWAY,
                "denied target {target}"
            );
        }
        let malformed = Request::builder()
            .method("CONNECT")
            .uri("/")
            .body(Body::empty())
            .unwrap();
        let response = service.serve(malformed).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            0,
            "no egress for denied or malformed targets"
        );
    }

    #[tokio::test]
    async fn proxy_authorization_is_stripped_from_the_upstream_request() {
        let mut request = Request::builder()
            .uri("http://origin.test/path")
            .body(())
            .unwrap();
        request.headers_mut().insert(
            "proxy-authorization",
            rama::http::HeaderValue::from_static("Basic secret"),
        );
        let cleaned = strip_proxy_credentials(request);
        assert!(!cleaned.headers().contains_key("proxy-authorization"));
    }
}
