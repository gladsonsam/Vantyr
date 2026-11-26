//! Idle deadline wrapper for streamed HTTP bodies.
//!
//! Rama's HTTP client returns a `Response` as soon as the response head is
//! parsed; the body is streamed afterwards. A deadline around the service
//! call therefore cannot bound a body that stalls after the head. This
//! wrapper applies a progress deadline to every body frame, preserving
//! streaming and backpressure: any frame that makes no progress within the
//! budget fails the body, which closes the connection instead of pretending
//! a post-head status can still be sent.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use rama::bytes::Bytes;
use rama::error::BoxError;
use rama::error::BoxErrorExt as _;
use rama::http::body::{Frame, SizeHint, StreamingBody};
use rama::http::Body;
use tokio::time::{sleep_until, Instant, Sleep};

/// Body that fails if no frame arrives within `deadline`.
pub struct DeadlineBody {
    inner: Body,
    deadline: Duration,
    timer: Pin<Box<Sleep>>,
    armed: bool,
}

impl DeadlineBody {
    pub fn new(inner: Body, deadline: Duration) -> Self {
        Self {
            inner,
            deadline,
            timer: Box::pin(sleep_until(Instant::now() + deadline)),
            armed: false,
        }
    }
}

impl StreamingBody for DeadlineBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();
        if !this.armed {
            this.timer.as_mut().reset(Instant::now() + this.deadline);
            this.armed = true;
        }
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Pending => match this.timer.as_mut().poll(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(()) => Poll::Ready(Some(Err(BoxError::from_static_str(
                    "body stream deadline exceeded",
                )))),
            },
            Poll::Ready(frame) => {
                // Progress re-arms the deadline for the next frame, so a
                // slow-but-progressing stream is not cut off arbitrarily.
                this.armed = false;
                Poll::Ready(frame)
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Wrap a body with its progress deadline while keeping Rama's `Body` type.
pub fn deadline_body(body: Body, deadline: Duration) -> Body {
    Body::new(DeadlineBody::new(body, deadline))
}
