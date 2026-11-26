//! Bounded ingress writes for Vantyr Proxy.
//!
//! A silent or partial request head is bounded by Rama's HTTP/1
//! `header_read_timeout`; a client that sends a body slowly is bounded by the
//! request-body deadline in `timeout_body`. What neither covers is a client
//! that stops *reading* a response and lets connection writes block forever.
//! This module wraps each accepted socket with a maintained Tokio write
//! timer so a write that makes no progress fails and releases the connection
//! permit. Once a CONNECT tunnel is established the timer is disarmed: the
//! raw tunnel is governed by its own idle budget in the maintained relay.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use rama::extensions::{Extension, Extensions, ExtensionsRef};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{sleep_until, Instant, Sleep};

/// Marker copied through the HTTP connection into a CONNECT request. When
/// set, the ingress write timer is disarmed before the 200 is acknowledged.
#[derive(Clone, Debug)]
pub struct IngressTimeoutOff(pub Arc<AtomicBool>);

impl Extension for IngressTimeoutOff {}

/// An accepted socket whose writes have a progress deadline.
pub struct BoundedIngress {
    inner: rama::tcp::TcpStream,
    bypass: Arc<AtomicBool>,
    write_timeout: Duration,
    write_timer: Pin<Box<Sleep>>,
    write_armed: bool,
}

impl BoundedIngress {
    pub fn wrap(inner: rama::tcp::TcpStream, write_timeout: Duration) -> (Self, Arc<AtomicBool>) {
        let bypass = Arc::new(AtomicBool::new(false));
        (
            Self {
                inner,
                bypass: bypass.clone(),
                write_timeout,
                write_timer: Box::pin(sleep_until(Instant::now())),
                write_armed: false,
            },
            bypass,
        )
    }

    fn poll_write_progress(&mut self, cx: &mut Context<'_>, pending: bool) -> Poll<io::Result<()>> {
        if !pending || self.bypass.load(Ordering::SeqCst) {
            self.write_armed = false;
            return Poll::Ready(Ok(()));
        }
        if !self.write_armed {
            self.write_timer
                .as_mut()
                .reset(Instant::now() + self.write_timeout);
            self.write_armed = true;
        }
        match self.write_timer.as_mut().poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(()) => Poll::Ready(Err(io::Error::from(io::ErrorKind::TimedOut))),
        }
    }
}

impl ExtensionsRef for BoundedIngress {
    fn extensions(&self) -> &Extensions {
        self.inner.extensions()
    }
}

impl AsyncRead for BoundedIngress {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for BoundedIngress {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, buf);
        let pending = matches!(result, Poll::Pending);
        match this.poll_write_progress(cx, pending) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            _ => result,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_flush(cx);
        let pending = matches!(result, Poll::Pending);
        match this.poll_write_progress(cx, pending) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            _ => result,
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_shutdown(cx);
        let pending = matches!(result, Poll::Pending);
        match this.poll_write_progress(cx, pending) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            _ => result,
        }
    }
}
