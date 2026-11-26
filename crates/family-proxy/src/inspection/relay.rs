//! Decrypted HTTP relay for the OPTIONAL inspection path.
//!
//! `TlsAcceptorService` (Rama's maintained rustls acceptor) terminates only the
//! downstream client TLS. The already validated, already TLS-connected
//! upstream socket is handed to `HttpMitmRelay` unchanged — there is no second
//! dial, no second DNS lookup and no fallback to an opaque tunnel if any of
//! this fails. The inner HTTP request is re-checked against the CONNECT
//! authority and stripped of proxy credentials and forwarding metadata before
//! it reaches the origin.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rama::error::{BoxError, BoxErrorExt as _};
use rama::extensions::{Extension, ExtensionsRef};
use rama::http::header::{self, HeaderValue};
use rama::http::layer::remove_header::RemoveRequestHeaderLayer;
use rama::http::layer::upgrade::Upgraded;
use rama::http::proxy::mitm::HttpMitmRelay;
use rama::http::{Body, Request, Response, StatusCode, Version};
use rama::io::BridgeIo;
use rama::layer::ArcLayer;
use rama::net::client::ConnectorTarget;
use rama::rt::Executor;
use rama::tls::rustls::server::TlsAcceptorService;
use rama::tls::server::TlsServerConfig;
use rama::{Layer, Service};

use crate::timeout_body::deadline_body;

/// Extension carrying the per-CONNECT issued TLS config. Inserted into the
/// public `UpgradeOutput.extensions` before the 200 is written, and applied by
/// Rama to `Upgraded` (and therefore to `BridgeIo`) on success.
#[derive(Clone, Debug)]
pub(crate) struct PreparedInspect {
    pub(crate) config: TlsServerConfig,
}

impl Extension for PreparedInspect {}

/// Bounds applied inside the decrypted connection. The outer listener bounds
/// the plaintext CONNECT head and the raw tunnel; these bound the decrypted
/// h1 stream and both TLS directions.
#[derive(Clone, Copy)]
pub(crate) struct RelayLimits {
    pub(crate) header_timeout: Duration,
    pub(crate) body_deadline: Duration,
    pub(crate) max_body_bytes: usize,
    pub(crate) session_timeout: Duration,
}

/// Service registered with `EagerHttpProxyConnector` for the inspected path.
#[derive(Clone)]
pub(crate) struct InspectRelay {
    exec: Executor,
    limits: RelayLimits,
}

impl InspectRelay {
    pub(crate) fn new(exec: Executor, limits: RelayLimits) -> Self {
        Self { exec, limits }
    }
}

impl<Upstream> Service<BridgeIo<Upgraded, Upstream>> for InspectRelay
where
    Upstream: rama::io::Io + Unpin + ExtensionsRef + Send + 'static,
{
    type Output = ();
    type Error = BoxError;

    async fn serve(&self, bridge: BridgeIo<Upgraded, Upstream>) -> Result<(), BoxError> {
        let prepared = bridge
            .extensions()
            .get_ref::<PreparedInspect>()
            .cloned()
            .ok_or_else(|| BoxError::from_static_str("inspection: missing prepared leaf config"))?;
        let target = bridge
            .extensions()
            .get_ref::<ConnectorTarget>()
            .cloned()
            .ok_or_else(|| BoxError::from_static_str("inspection: missing CONNECT authority"))?;
        let expected_host = target.0.host.to_str().to_ascii_lowercase();

        let middleware = InspectLayer {
            expected_host,
            body_deadline: self.limits.body_deadline,
            max_body_bytes: self.limits.max_body_bytes,
        };
        let mut relay = HttpMitmRelay::new(self.exec.clone()).with_http_middleware(middleware);
        relay
            .http1_mut()
            .set_header_read_timeout(self.limits.header_timeout);

        let BridgeIo(ingress, upstream) = bridge;
        let inner = RelayInner {
            relay: Arc::new(relay),
            upstream: Arc::new(Mutex::new(Some(upstream))),
        };
        let acceptor = TlsAcceptorService::new(prepared.config, inner, false);
        match tokio::time::timeout(self.limits.session_timeout, acceptor.serve(ingress)).await {
            Ok(result) => result,
            Err(_) => Err(BoxError::from_static_str(
                "inspection decrypted session timed out",
            )),
        }
    }
}

/// Owns the one pre-established upstream socket and serves decrypted HTTP on
/// the downstream TLS stream through Rama's MITM relay.
#[derive(Clone)]
struct RelayInner<Upstream> {
    relay: Arc<HttpMitmRelay<InspectLayer>>,
    upstream: Arc<Mutex<Option<Upstream>>>,
}

impl<Upstream> Service<rama::tls::rustls::server::TlsStream<Upgraded>> for RelayInner<Upstream>
where
    Upstream: rama::io::Io + Unpin + ExtensionsRef + Send + 'static,
{
    type Output = ();
    type Error = BoxError;

    async fn serve(
        &self,
        decrypted: rama::tls::rustls::server::TlsStream<Upgraded>,
    ) -> Result<(), BoxError> {
        let upstream = self
            .upstream
            .lock()
            .map_err(|_| BoxError::from_static_str("inspection: upstream slot poisoned"))?
            .take()
            .ok_or_else(|| BoxError::from_static_str("inspection: upstream already consumed"))?;
        self.relay.serve(BridgeIo(decrypted, upstream)).await
    }
}

/// Middleware applied to the decrypted upstream client. It is the only place
/// that sees the inner request, so it re-asserts the authority and removes
/// everything the outer proxy already strips for plain HTTP forwarding.
#[derive(Clone)]
struct InspectLayer {
    expected_host: String,
    body_deadline: Duration,
    max_body_bytes: usize,
}

type WrappedClient<S> = std::sync::Arc<
    rama::http::layer::remove_header::RemoveRequestHeader<
        rama::http::layer::remove_header::RemoveRequestHeader<S>,
    >,
>;

impl<S> Layer<S> for InspectLayer {
    type Service = InspectService<WrappedClient<S>>;

    fn layer(&self, inner: S) -> Self::Service {
        // ArcLayer is Rama's maintained way to make the per-connection client
        // service clonable (HttpClientService itself is not Clone).
        let inner: WrappedClient<S> = ArcLayer::new().into_layer(
            RemoveRequestHeaderLayer::hop_by_hop()
                .into_layer(RemoveRequestHeaderLayer::forwarding_metadata().into_layer(inner)),
        );
        InspectService {
            inner,
            expected_host: self.expected_host.clone(),
            body_deadline: self.body_deadline,
            max_body_bytes: self.max_body_bytes,
        }
    }
}

#[derive(Clone)]
struct InspectService<S> {
    inner: S,
    expected_host: String,
    body_deadline: Duration,
    max_body_bytes: usize,
}

impl<S> Service<Request> for InspectService<S>
where
    S: Service<Request, Output = Response> + Clone,
    S::Error: Into<BoxError>,
{
    type Output = Response;
    type Error = BoxError;

    async fn serve(&self, mut request: Request) -> Result<Response, BoxError> {
        if request.version() == Version::HTTP_2 {
            return Ok(status(
                StatusCode::HTTP_VERSION_NOT_SUPPORTED,
                "HTTP/2 is not supported by Vantyr inspection",
            ));
        }
        if request.headers().contains_key(header::UPGRADE)
            || request
                .headers()
                .get_all(header::CONNECTION)
                .iter()
                .any(|value| {
                    value.to_str().is_ok_and(|v| {
                        v.split(',')
                            .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
                    })
                })
        {
            return Ok(status(
                StatusCode::METHOD_NOT_ALLOWED,
                "WebSocket and other upgrades are not supported by Vantyr inspection",
            ));
        }

        // The inner authority cannot escape the CONNECT authority. This is
        // checked after the egress socket was already pinned to that authority,
        // so a hostile Host can never reroute the upstream connection.
        let host = request
            .uri()
            .host()
            .map(|host| host.to_string())
            .or_else(|| {
                request
                    .headers()
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        if !host
            .trim_end_matches('.')
            .eq_ignore_ascii_case(self.expected_host.trim_end_matches('.'))
        {
            return Ok(status(
                StatusCode::FORBIDDEN,
                "inner request authority does not match the CONNECT authority",
            ));
        }

        // Hop-by-hop and forwarding layers removed the metadata; remove the
        // proxy credential explicitly as well so there is no reliance on a
        // single layer's header list.
        request.headers_mut().remove(header::PROXY_AUTHORIZATION);
        request.headers_mut().insert(
            header::HOST,
            HeaderValue::from_str(&self.expected_host)
                .map_err(|error| BoxError::from(format!("invalid pinned Host: {error}")))?,
        );

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
            return Ok(response);
        }

        let (parts, body) = request.into_parts();
        let body = deadline_body(body.limited(self.max_body_bytes), self.body_deadline);
        let request = Request::from_parts(parts, body);
        let response = self.inner.serve(request).await.map_err(Into::into)?;
        Ok(response.map(|body| deadline_body(body, self.body_deadline)))
    }
}

fn status(code: StatusCode, message: &str) -> Response {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = code;
    response
}
