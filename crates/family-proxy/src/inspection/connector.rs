//! Bounded upstream TLS handshake for the inspection path.
//!
//! Rama's `TlsConnector` wraps the shared `EgressConnector`, so the actual
//! socket is still filtered and pinned before any handshake bytes are sent.
//! This thin service adds a progress deadline around that handshake; on
//! timeout the eager CONNECT connector answers 504 before the 200 and no
//! origin HTTP request is ever written.

use std::time::Duration;

use rama::error::{BoxError, BoxErrorExt as _};
use rama::io::Io;
use rama::net::client::{
    ConnectRequest, ConnectionError, ConnectionErrorKind, ConnectorService,
    EstablishedClientConnection,
};
use rama::Service;

#[derive(Clone)]
pub(crate) struct HandshakeTimeoutConnector<C> {
    inner: C,
    timeout: Duration,
}

impl<C> HandshakeTimeoutConnector<C> {
    pub(crate) fn new(inner: C, timeout: Duration) -> Self {
        Self { inner, timeout }
    }
}

impl<C> Service<ConnectRequest> for HandshakeTimeoutConnector<C>
where
    C: ConnectorService<ConnectRequest, Connection: Io + Unpin> + Clone,
{
    type Output = EstablishedClientConnection<C::Connection, ConnectRequest>;
    type Error = ConnectionError;

    async fn serve(&self, request: ConnectRequest) -> Result<Self::Output, Self::Error> {
        match tokio::time::timeout(self.timeout, self.inner.connect(request)).await {
            Ok(result) => result,
            Err(_) => Err(ConnectionError::transport(
                BoxError::from_static_str("upstream TLS handshake timed out"),
                ConnectionErrorKind::Timeout,
            )),
        }
    }
}
