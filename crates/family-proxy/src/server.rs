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
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use family_policy::{evaluate, Action, EvaluationContext, Policy};
use rama::dns::client::resolver::DnsAddressResolver;
use rama::http::client::{HttpClientService, HttpConnectRequestAdapter, HttpConnector};
use rama::http::header;
use rama::http::layer::remove_header::RemoveRequestHeaderLayer;
use rama::http::layer::upgrade::{EagerHttpProxyConnector, UpgradeLayer, UpgradeService};
use rama::http::matcher::MethodMatcher;
use rama::http::server::HttpServer;
use rama::http::BodyLimitLayer;
use rama::http::{Body, Request, Response, StatusCode, Version};
use rama::net::client::{ConnectorService, EstablishedClientConnection};
use rama::net::proxy::{FirstByteTimeoutStart, IoForwardService};
use rama::rt::Executor;
use rama::service::service_fn;
use rama::service::BoxService;
use rama::tcp::server::TcpListener as RamaTcpListener;
use rama::{Layer, Service};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;

use crate::auth::{proxy_authentication_required, AuthError, AuthState};
use crate::config::Config;
use crate::egress::{EgressConnector, EgressPolicy};

type Upgrade = UpgradeService<rama::service::BoxService<Request, Response, Infallible>, Response>;
type Forward = BoxService<Request, Response, rama::error::BoxError>;

/// The request-level service. `Clone` so the HTTP server can serve many
/// connections from the same immutable state.
#[derive(Clone)]
struct ProxyService {
    auth: Arc<AuthState>,
    policy: Arc<Policy>,
    devices: BTreeMap<String, family_policy::Device>,
    upgrade: Upgrade,
    forward: Forward,
    heartbeat_ttl_secs: u64,
}

/// A transport-level concurrency gate. A full proxy drops the connection
/// rather than queueing an unbounded number of pending accepted sockets.
#[derive(Clone)]
struct LimitedService<S> {
    inner: S,
    permits: Arc<Semaphore>,
}

impl<S> Service<rama::tcp::TcpStream> for LimitedService<S>
where
    S: Service<rama::tcp::TcpStream, Output = (), Error = rama::error::BoxError> + Clone,
{
    type Output = ();
    type Error = rama::error::BoxError;

    async fn serve(&self, stream: rama::tcp::TcpStream) -> Result<Self::Output, Self::Error> {
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else {
            tracing::warn!("connection limit reached; dropping accepted connection");
            return Ok(());
        };
        self.inner.serve(stream).await
    }
}

/// Forward a single request over an established, policy-checked connection.
#[derive(Clone)]
struct ForwardClient<C> {
    connector: C,
}

impl<C> ForwardClient<C> {
    fn new(connector: C) -> Self {
        Self { connector }
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
    type Error = rama::error::BoxError;

    async fn serve(&self, request: Request<B>) -> Result<Response, Self::Error> {
        let EstablishedClientConnection { input, conn } = self.connector.connect(request).await?;
        conn.serve(input).await
    }
}

/// A running proxy listener. Dropping it aborts the accept loop; `stop()` is
/// explicit so callers can shut down cleanly.
pub struct ProxyServer {
    bind_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
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
        config.validate()?;
        let limits = config.limits();
        let exec = Executor::default();

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
        let connect = EagerHttpProxyConnector::new(egress.clone(), relay);
        let noop =
            service_fn(|_req: Request| async { Ok::<_, Infallible>(Response::new(Body::empty())) })
                .boxed();
        let upgrade: Upgrade =
            UpgradeLayer::new(exec.clone(), MethodMatcher::CONNECT, connect).into_layer(noop);

        // Ordinary HTTP: dial only through the same egress policy, strip
        // hop-by-hop credentials and forwarding metadata via Rama layers.
        let adapter = HttpConnectRequestAdapter::new(egress);
        let http_connector = HttpConnector::new(adapter, exec.clone());
        let forward: Forward = RemoveRequestHeaderLayer::forwarding_metadata()
            .into_layer(
                RemoveRequestHeaderLayer::hop_by_hop()
                    .into_layer(ForwardClient::new(http_connector)),
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
            forward,
            heartbeat_ttl_secs: Config::heartbeat_ttl_secs(),
        };

        let mut http_server = HttpServer::new_http1(exec.clone());
        http_server.http1_mut().set_max_headers(64);
        http_server
            .http1_mut()
            .try_set_max_buf_size(limits.max_header_bytes)
            .map_err(|error| anyhow::anyhow!("invalid header limit: {error}"))?;
        let http_service = BodyLimitLayer::request_only(limits.max_body_bytes)
            .into_layer(http_server.service(service));
        let limited = LimitedService {
            inner: http_service,
            permits: Arc::new(Semaphore::new(limits.max_connections)),
        };

        let tcp = RamaTcpListener::bind_address(config.bind_addr(), exec.clone())
            .await
            .map_err(|error| anyhow::anyhow!("bind failed: {error}"))?;
        let bind_addr = tcp.local_addr()?;
        let (shutdown, mut changed) = watch::channel(false);
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = changed.changed() => {},
                _ = tcp.serve(limited) => {},
            }
        });
        Ok(Self {
            bind_addr,
            shutdown,
            task,
        })
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }

    pub fn stop(self) {
        let _ = self.shutdown.send(true);
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

        if request.method() == &rama::http::Method::CONNECT {
            return match self.upgrade.serve(request).await {
                Ok(response) => response,
                Err(never) => match never {},
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
            return match self.forward.serve(request).await {
                Ok(response) => response,
                Err(error) => {
                    tracing::warn!(error = ?error, "upstream request failed");
                    status(StatusCode::BAD_GATEWAY, "upstream request failed")
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
