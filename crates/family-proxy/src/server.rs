//! Bounded HTTP/1 forward + CONNECT listener for Vantyr Proxy.
//!
//! Rama owns the HTTP/1 parser, the eager CONNECT upgrade and the upstream
//! HTTP client. Authentication runs before any egress is attempted; policy is
//! evaluated from the accepted core for the authenticated device default.
//! Credentials are stripped by Rama's header layer before an ordinary request
//! reaches the origin. There is no MITM: an established CONNECT is an opaque
//! end-to-end TLS tunnel that the client validates itself.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::fmt;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use family_policy::{evaluate, Action, EvaluationContext, Policy};
use rama::dns::client::resolver::DnsAddressResolver;
use rama::extensions::{ExtensionsRef, Ingress};
use rama::graceful::Shutdown;
use rama::http::client::{HttpClientService, HttpConnectRequestAdapter, HttpConnector};
use rama::http::header;
use rama::http::layer::remove_header::RemoveRequestHeaderLayer;
use rama::http::layer::upgrade::{
    EagerHttpProxyConnector, UpgradeLayer, UpgradeOutput, UpgradeService,
};
use rama::http::matcher::MethodMatcher;
use rama::http::server::HttpServer;
use rama::http::BodyLimitLayer;
use rama::http::{Body, HeaderValue, Request, Response, StatusCode, Version};
use rama::net::client::{ConnectorService, EstablishedClientConnection};
use rama::net::proxy::{FirstByteTimeoutStart, IoForwardService};
use rama::net::ConnectorTargetInputExt as _;
use rama::rt::Executor;
use rama::service::service_fn;
use rama::service::BoxService;
use rama::tcp::server::TcpListener as RamaTcpListener;
use rama::tls::client::TlsClientConfig;
use rama::tls::rustls::client::TlsConnector;
use rama::{Layer, Service};
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinHandle;

use crate::auth::{proxy_authentication_required, AuthError, AuthState};
use crate::bound::{BoundedIngress, IngressTimeoutOff};
use crate::config::Config;
use crate::egress::{EgressConnector, EgressPolicy};
use crate::inspection::{
    HandshakeTimeoutConnector, InspectRelay, InspectionMode, InspectionModeMarker,
    InspectionRuntime, PrepareInspection, RelayLimits,
};
use crate::timeout_body::deadline_body;

type Upgrade = UpgradeService<rama::service::BoxService<Request, Response, Infallible>, Response>;
type Forward = BoxService<Request, Response, ForwardError>;

/// An upstream failure is either a deadline over the whole request/response
/// exchange or another connection/protocol failure.
#[derive(Debug)]
enum ForwardError {
    Deadline,
    Upstream(rama::error::BoxError),
}

impl fmt::Display for ForwardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deadline => write!(f, "upstream request deadline exceeded"),
            Self::Upstream(error) => write!(f, "upstream request failed: {error}"),
        }
    }
}

impl std::error::Error for ForwardError {}

/// The request-level service. `Clone` so the HTTP server can serve many
/// connections from the same immutable state.
#[derive(Clone)]
struct ProxyService {
    auth: Arc<AuthState>,
    policy: Arc<Policy>,
    devices: BTreeMap<String, family_policy::Device>,
    upgrade: Upgrade,
    inspect_upgrade: Option<Upgrade>,
    inspection: InspectionRuntime,
    forward: Forward,
    heartbeat_ttl_secs: u64,
    max_body_bytes: usize,
    body_deadline: Duration,
}

/// A transport-level concurrency gate. A full proxy drops the connection
/// rather than queueing an unbounded number of pending accepted sockets. Each
/// admitted socket also gets bounded read/write progress timers.
#[derive(Clone)]
struct LimitedService<S> {
    inner: S,
    permits: Arc<Semaphore>,
    ingress_write_timeout: Duration,
}

impl<S> Service<rama::tcp::TcpStream> for LimitedService<S>
where
    S: Service<BoundedIngress, Output = (), Error = rama::error::BoxError> + Clone,
{
    type Output = ();
    type Error = rama::error::BoxError;

    async fn serve(&self, stream: rama::tcp::TcpStream) -> Result<Self::Output, Self::Error> {
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            tracing::warn!("connection limit reached; dropping accepted connection");
            return Ok(());
        };
        let (bounded, bypass) = BoundedIngress::wrap(stream, self.ingress_write_timeout);
        bounded
            .extensions()
            .insert(IngressTimeoutOff(bypass.clone()));
        self.inner.serve(bounded).await
    }
}

/// Forward a single request over an established, policy-checked connection.
/// The deadline covers connect, response headers and the whole response body.
#[derive(Clone)]
struct ForwardClient<C> {
    connector: C,
    deadline: Duration,
}

impl<C> ForwardClient<C> {
    fn new(connector: C, deadline: Duration) -> Self {
        Self {
            connector,
            deadline,
        }
    }
}

impl<C, B> Service<Request<B>> for ForwardClient<C>
where
    C: ConnectorService<Request<B>, Connection = HttpClientService<B>>,
    B: rama::http::StreamingBody<Data: Send + 'static, Error: Into<rama::error::BoxError>>
        + Unpin
        + Send
        + 'static,
{
    type Output = Response;
    type Error = ForwardError;

    async fn serve(&self, request: Request<B>) -> Result<Response, Self::Error> {
        match tokio::time::timeout(self.deadline, async {
            let EstablishedClientConnection { input, conn } = self
                .connector
                .connect(request)
                .await
                .map_err(|error| ForwardError::Upstream(error.into()))?;
            conn.serve(input).await.map_err(ForwardError::Upstream)
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(ForwardError::Deadline),
        }
    }
}

/// Disarm the ingress socket timers once an eager CONNECT has established its
/// upstream socket. From then on the raw tunnel's own idle budget applies.
#[derive(Clone)]
struct UpgradeBypassGuard<C> {
    inner: C,
}

impl<C> UpgradeBypassGuard<C> {
    fn new(inner: C) -> Self {
        Self { inner }
    }
}

impl<C> Service<Request> for UpgradeBypassGuard<C>
where
    C: Service<Request, Output = UpgradeOutput<Request, Response>, Error = Response> + Clone,
{
    type Output = C::Output;
    type Error = C::Error;

    async fn serve(&self, request: Request) -> Result<Self::Output, Self::Error> {
        let bypass = request
            .extensions()
            .get_ref::<Ingress<rama::extensions::Extensions>>()
            .and_then(|ingress| ingress.0.get_ref::<IngressTimeoutOff>())
            .map(|marker| marker.0.clone());
        let output = self.inner.serve(request).await?;
        if let Some(bypass) = bypass {
            bypass.store(true, Ordering::SeqCst);
        }
        Ok(output)
    }
}

/// A running proxy listener. `stop()` triggers graceful shutdown so active
/// connections and tunnels are closed rather than orphaned when the accept
/// loop ends.
pub struct ProxyServer {
    bind_addr: SocketAddr,
    trigger: Option<oneshot::Sender<()>>,
    shutdown: Option<Shutdown>,
    task: JoinHandle<()>,
}

impl ProxyServer {
    /// Start using Rama's maintained Hickory resolver and system config.
    pub async fn start(config: Config) -> Result<Self> {
        let resolver = rama::dns::client::HickoryDnsResolver::try_new_system()
            .map_err(|error| anyhow::anyhow!("Hickory resolver init failed: {error}"))?;
        Self::start_with(config, resolver).await
    }

    /// Start with an injected resolver (tests use this to prove that a
    /// rebinding or forged answer cannot change the dialled socket).
    pub async fn start_with<R>(config: Config, resolver: R) -> Result<Self>
    where
        R: DnsAddressResolver + Clone + Send + Sync + 'static,
    {
        let inspection = InspectionRuntime::from_config(&config)?;
        Self::start_with_upstream_tls(config, resolver, inspection, None).await
    }

    /// Test-only injection seam: an in-memory inspection signer and explicit
    /// upstream trust anchors for real loopback TLS tests. The binary and the
    /// normal `start`/`start_with` paths never reach this; production always
    /// uses the normal roots and an on-disk encrypted vault.
    #[doc(hidden)]
    pub async fn start_with_test_tls<R>(
        config: Config,
        resolver: R,
        inspection: InspectionRuntime,
        upstream_trust: TlsClientConfig,
    ) -> Result<Self>
    where
        R: DnsAddressResolver + Clone + Send + Sync + 'static,
    {
        Self::start_with_upstream_tls(config, resolver, inspection, Some(upstream_trust)).await
    }

    async fn start_with_upstream_tls<R>(
        config: Config,
        resolver: R,
        inspection: InspectionRuntime,
        upstream_tls: Option<TlsClientConfig>,
    ) -> Result<Self>
    where
        R: DnsAddressResolver + Clone + Send + Sync + 'static,
    {
        config.validate()?;
        let limits = config.limits();
        let (trigger, signal) = oneshot::channel::<()>();
        let shutdown = Shutdown::new(async move {
            let _ = signal.await;
        });
        let exec = Executor::graceful(shutdown.guard());

        let egress = EgressConnector::new(
            EgressPolicy::from_config(&config),
            resolver,
            Duration::from_millis(limits.connect_timeout_ms),
        );

        // CONNECT: establish egress BEFORE the 200, then relay an opaque raw
        // tunnel with idle + first-byte budgets. No TLS is terminated here.
        let relay = IoForwardService::new(exec.clone())
            .with_idle_timeout(Duration::from_secs(limits.tunnel_idle_secs))
            .with_first_byte_timeout(Duration::from_secs(limits.request_timeout_secs))
            .with_first_byte_timeout_start(FirstByteTimeoutStart::ClientFirstByte);
        let connect = UpgradeBypassGuard::new(EagerHttpProxyConnector::new(egress.clone(), relay));
        let noop =
            service_fn(|_req: Request| async { Ok::<_, Infallible>(Response::new(Body::empty())) })
                .boxed();
        let upgrade: Upgrade = UpgradeLayer::new(exec.clone(), MethodMatcher::CONNECT, connect)
            .into_layer(noop.clone());

        // OPTIONAL inspection: same validated egress socket, wrapped in normal
        // upstream TLS with hostname verification before the 200, then a
        // downstream TLS acceptor over the issued short-lived leaf. There is
        // no separate dial and no fallback to the opaque upgrade on failure.
        let inspect_upgrade = match inspection.signer.as_ref() {
            Some(signer) => {
                let upstream_config =
                    upstream_tls.unwrap_or_else(|| TlsClientConfig::new().with_alpn_http_1());
                let tls_egress = HandshakeTimeoutConnector::new(
                    TlsConnector::secure(egress.clone()).with_base_config(upstream_config),
                    inspection.handshake_timeout,
                );
                let session_secs = limits
                    .request_timeout_secs
                    .max(inspection.handshake_timeout.as_secs());
                let inspect_relay = InspectRelay::new(
                    exec.clone(),
                    RelayLimits {
                        header_timeout: Duration::from_secs(limits.request_timeout_secs),
                        body_deadline: Duration::from_secs(limits.request_timeout_secs),
                        max_body_bytes: limits.max_body_bytes,
                        session_timeout: Duration::from_secs(session_secs),
                    },
                );
                let eager = EagerHttpProxyConnector::new(tls_egress, inspect_relay);
                let prepared = UpgradeBypassGuard::new(PrepareInspection::new(
                    eager,
                    signer.clone(),
                    inspection.leaf_validity_secs,
                ));
                let inspected: Upgrade =
                    UpgradeLayer::new(exec.clone(), MethodMatcher::CONNECT, prepared)
                        .into_layer(noop);
                Some(inspected)
            }
            None => None,
        };

        // Ordinary HTTP: dial only through the same egress policy, strip
        // hop-by-hop credentials and forwarding metadata via Rama layers.
        let adapter = HttpConnectRequestAdapter::new(egress);
        let http_connector = HttpConnector::new(adapter, exec.clone());
        let forward: Forward = RemoveRequestHeaderLayer::forwarding_metadata()
            .into_layer(
                RemoveRequestHeaderLayer::hop_by_hop().into_layer(ForwardClient::new(
                    http_connector,
                    Duration::from_secs(limits.request_timeout_secs),
                )),
            )
            .boxed();

        let now = Utc::now();
        let policy = Arc::new(config.policy(now));
        let devices = config
            .clients
            .iter()
            .map(|client| (client.device_id.clone(), config.device_for(client)))
            .collect();
        let service = ProxyService {
            auth: Arc::new(AuthState::new(&config)),
            policy,
            devices,
            upgrade,
            inspect_upgrade,
            inspection,
            forward,
            heartbeat_ttl_secs: Config::heartbeat_ttl_secs(),
            max_body_bytes: limits.max_body_bytes,
            body_deadline: Duration::from_secs(limits.request_timeout_secs),
        };

        let mut http_server = HttpServer::new_http1(exec.clone());
        http_server.http1_mut().set_max_headers(64);
        // A silent or partial request head must not hold the permit forever.
        http_server
            .http1_mut()
            .set_header_read_timeout(Duration::from_secs(limits.request_timeout_secs));
        http_server
            .http1_mut()
            .try_set_max_buf_size(limits.max_header_bytes)
            .map_err(|error| anyhow::anyhow!("invalid header limit: {error}"))?;
        let http_service = BodyLimitLayer::request_only(limits.max_body_bytes)
            .into_layer(http_server.service(service));
        let limited = LimitedService {
            inner: http_service,
            permits: Arc::new(Semaphore::new(limits.max_connections)),
            // A little longer than the upstream deadline so an honest 504 or
            // 502 can still be written before the client socket is failed.
            ingress_write_timeout: Duration::from_secs(limits.request_timeout_secs + 1),
        };

        let tcp = RamaTcpListener::bind_address(config.bind_addr(), exec.clone())
            .await
            .map_err(|error| anyhow::anyhow!("bind failed: {error}"))?;
        let bind_addr = tcp.local_addr()?;
        // `TcpListener::serve` observes the graceful executor's guard and
        // stops accepting when shutdown is triggered.
        let task = tokio::spawn(tcp.serve(limited));
        Ok(Self {
            bind_addr,
            trigger: Some(trigger),
            shutdown: Some(shutdown),
            task,
        })
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }

    /// Trigger shutdown and wait (bounded) for connection tasks and tunnels
    /// to end, so no accepted connection is left running behind the listener.
    pub async fn stop(mut self) {
        if let Some(trigger) = self.trigger.take() {
            let _ = trigger.send(());
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.shutdown_with_limit(Duration::from_secs(2)).await;
        }
        self.task.abort();
    }
}

impl ProxyService {
    async fn handle(&self, request: Request) -> Response {
        // Only HTTP/1 is served. h2/WebSocket are rejected explicitly rather
        // than silently falling through to an unchecked protocol branch.
        if request.version() == Version::HTTP_2 {
            return status(
                StatusCode::HTTP_VERSION_NOT_SUPPORTED,
                "HTTP/2 is not supported by Vantyr Proxy in this milestone",
            );
        }
        if request.headers().contains_key(header::UPGRADE)
            || request
                .headers()
                .get_all(header::CONNECTION)
                .iter()
                .any(|value| {
                    value
                        .to_str()
                        .is_ok_and(|v| v.split(',').any(|t| t.trim() == "upgrade"))
                })
        {
            return status(
                StatusCode::METHOD_NOT_ALLOWED,
                "WebSocket and other HTTP upgrades are not supported in this milestone",
            );
        }

        let client = match self.auth.authenticate(&request) {
            Ok(client) => client.clone(),
            Err(AuthError::Missing | AuthError::Invalid) => return proxy_authentication_required(),
        };
        let Some((host, path)) = target(&request) else {
            return status(StatusCode::BAD_REQUEST, "missing request authority");
        };
        let Some(device) = self.devices.get(&client.device_id) else {
            return status(
                StatusCode::FORBIDDEN,
                "no device is linked to this credential",
            );
        };
        let decision = evaluate(
            &self.policy,
            &EvaluationContext {
                now: Utc::now(),
                device,
                session: None,
                assignments: &[],
                connections: &[],
                action: Action::HttpRequest {
                    host: host.clone(),
                    path,
                },
                heartbeat_ttl_secs: self.heartbeat_ttl_secs,
            },
        );
        if !decision.allow {
            // Reason codes are static policy identifiers, not secrets.
            return status(StatusCode::FORBIDDEN, &decision.reason_code);
        }

        // Enforce the configured body budget before dialling the upstream.
        // `Body::limited` additionally bounds streamed bodies with no declared
        // length, so either shape cannot exceed the limit.
        let declared = request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok());
        if declared.is_some_and(|len| len > self.max_body_bytes) {
            let mut response = status(StatusCode::PAYLOAD_TOO_LARGE, "request body exceeds limit");
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
            return response;
        }

        if request.method().eq(&rama::http::Method::CONNECT) {
            // Choose the path only after credential, policy, body and target
            // validation above. Both paths use the same egress connector, so
            // an exception can never widen the destination.
            let Some(target) = request.connector_target_with_default_port(443) else {
                return status(StatusCode::BAD_REQUEST, "missing CONNECT authority");
            };
            let mode = self.inspection.mode_for(
                &client.id,
                &target.host.to_str(),
                target.port,
                Utc::now(),
            );
            request.extensions().insert(InspectionModeMarker(mode));
            return match mode {
                InspectionMode::Opaque => match self.upgrade.serve(request).await {
                    Ok(response) => response,
                    Err(never) => match never {},
                },
                InspectionMode::Inspect => match self.inspect_upgrade.as_ref() {
                    Some(upgrade) => match upgrade.serve(request).await {
                        Ok(response) => response,
                        Err(never) => match never {},
                    },
                    None => status(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "inspection is not available",
                    ),
                },
            };
        }
        if matches!(
            request.method(),
            &rama::http::Method::GET
                | &rama::http::Method::HEAD
                | &rama::http::Method::POST
                | &rama::http::Method::PUT
                | &rama::http::Method::PATCH
                | &rama::http::Method::DELETE
                | &rama::http::Method::OPTIONS
        ) {
            let (parts, body) = request.into_parts();
            let body = deadline_body(body.limited(self.max_body_bytes), self.body_deadline);
            let request = Request::from_parts(parts, body);
            return match self.forward.serve(request).await {
                // The response body is streamed after `conn.serve` returned;
                // bound that stream too, or a stalled body escapes the
                // request deadline entirely.
                Ok(response) => response.map(|body| deadline_body(body, self.body_deadline)),
                Err(ForwardError::Deadline) => {
                    let mut response = status(
                        StatusCode::GATEWAY_TIMEOUT,
                        "upstream request deadline exceeded",
                    );
                    // Close the client connection so its semaphore permit is
                    // released and the next client can be served immediately.
                    response
                        .headers_mut()
                        .insert(header::CONNECTION, HeaderValue::from_static("close"));
                    response
                }
                Err(ForwardError::Upstream(error)) => {
                    tracing::warn!(error = ?error, "upstream request failed");
                    let mut response = status(StatusCode::BAD_GATEWAY, "upstream request failed");
                    response
                        .headers_mut()
                        .insert(header::CONNECTION, HeaderValue::from_static("close"));
                    response
                }
            };
        }
        status(StatusCode::METHOD_NOT_ALLOWED, "unsupported proxy method")
    }
}

impl Service<Request> for ProxyService {
    type Output = Response;
    type Error = Infallible;

    async fn serve(&self, request: Request) -> Result<Response, Infallible> {
        Ok(self.handle(request).await)
    }
}

fn target(request: &Request) -> Option<(String, String)> {
    let host = request
        .uri()
        .host()
        .map(|host| host.to_string())
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(|value| {
                    value
                        .rsplit_once('@')
                        .map(|(_, tail)| tail)
                        .unwrap_or(value)
                        .split(':')
                        .next()
                        .unwrap_or(value)
                        .to_owned()
                })
        })?;
    let path = request
        .uri()
        .path()
        .map(|path| path.to_string())
        .unwrap_or_else(|| "/".to_owned());
    Some((host, path))
}

fn status(code: StatusCode, message: &str) -> Response {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = code;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_uses_authority_then_host_header() {
        let absolute = Request::builder()
            .uri("http://example.test/a/b?q=1")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            target(&absolute).unwrap(),
            ("example.test".to_owned(), "/a/b".to_owned())
        );
        let authority = Request::builder()
            .uri(rama::net::uri::Uri::parse_authority_form("example.test:443").unwrap())
            .body(Body::empty())
            .unwrap();
        assert_eq!(target(&authority).unwrap().0, "example.test");
        let origin = Request::builder()
            .uri("/x")
            .header(header::HOST, "example.test:8080")
            .body(Body::empty())
            .unwrap();
        assert_eq!(target(&origin).unwrap().0, "example.test");
    }
}
