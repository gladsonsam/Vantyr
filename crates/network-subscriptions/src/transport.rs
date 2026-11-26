//! HTTP boundary. Only GET, no auth headers, redirects disabled. The body is
//! read with a bound checked *before* allocation and a deadline covering the
//! whole body (not just the headers).

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::header::{IF_MODIFIED_SINCE, IF_NONE_MATCH};
use reqwest::redirect::Policy;
use reqwest::Client;

use crate::config::Limits;
use crate::error::Error;
use crate::resolve::{AddressLookup, SystemLookup, VettedResolver};
use crate::url::ValidatedUrl;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ConditionalHeaders {
    pub if_none_match: Option<String>,
    pub if_modified_since: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TransportResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub retry_after: Option<String>,
    /// Reported for diagnostics only; never followed.
    pub location: Option<String>,
    pub body: Vec<u8>,
}

#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn get(
        &self,
        url: &ValidatedUrl,
        conditional: ConditionalHeaders,
        max_body_bytes: u64,
    ) -> Result<TransportResponse, Error>;
}

/// Sanitize an untrusted cache/response header: printable ASCII only, bounded
/// length. Anything else is treated as absent rather than forwarded.
pub fn sanitize_header(value: &str, max_bytes: usize) -> Option<String> {
    if value.is_empty() || value.len() > max_bytes {
        return None;
    }
    if value.bytes().any(|b| !(0x20..=0x7e).contains(&b)) {
        return None;
    }
    Some(value.to_owned())
}

pub struct ReqwestTransport {
    client: Client,
    max_header_bytes: usize,
    body_timeout: Duration,
}

impl ReqwestTransport {
    /// Production constructor. The resolver is always the vetted one, so a
    /// private/mapped address never reaches a socket.
    pub fn new(
        limits: &Limits,
        trusted_ca_pem: Option<&str>,
        lookup: Option<Arc<dyn AddressLookup>>,
    ) -> Result<Self, Error> {
        let lookup = lookup.unwrap_or_else(|| Arc::new(SystemLookup));
        let resolver: Arc<dyn reqwest::dns::Resolve> = Arc::new(VettedResolver::new(lookup));
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(limits.connect_timeout())
            .timeout(limits.request_timeout())
            .dns_resolver(resolver);
        if let Some(pem) = trusted_ca_pem {
            let cert = reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|e| Error::InvalidConfig(format!("trusted CA PEM is invalid: {e}")))?;
            // Merges with platform roots; hostname/chain verification stays on.
            builder = builder.tls_certs_merge([cert]);
        }
        let client = builder
            .build()
            .map_err(|e| Error::InvalidConfig(format!("HTTP client could not be built: {e}")))?;
        Ok(Self {
            client,
            max_header_bytes: limits.max_header_bytes,
            body_timeout: limits.request_timeout(),
        })
    }

    /// Injection seam for a prebuilt client (used by the test-only loopback
    /// transport). No verification or SSRF policy is relaxed here; the caller
    /// supplies a client already configured with the intended policy.
    pub fn from_client(client: Client, max_header_bytes: usize, body_timeout: Duration) -> Self {
        Self {
            client,
            max_header_bytes,
            body_timeout,
        }
    }

    fn header(&self, response: &reqwest::Response, name: &str) -> Option<String> {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| sanitize_header(v, self.max_header_bytes))
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn get(
        &self,
        url: &ValidatedUrl,
        conditional: ConditionalHeaders,
        max_body_bytes: u64,
    ) -> Result<TransportResponse, Error> {
        let mut request = self.client.get(url.as_str());
        if let Some(etag) = conditional.if_none_match {
            if let Some(clean) = sanitize_header(&etag, self.max_header_bytes) {
                request = request.header(IF_NONE_MATCH, clean);
            }
        }
        if let Some(since) = conditional.if_modified_since {
            if let Some(clean) = sanitize_header(&since, self.max_header_bytes) {
                request = request.header(IF_MODIFIED_SINCE, clean);
            }
        }
        let mut response = request
            .send()
            .await
            .map_err(|e| Error::Transport(url.safe_display(), e.to_string()))?;

        let status = response.status().as_u16();
        let etag = self.header(&response, "etag");
        let last_modified = self.header(&response, "last-modified");
        let retry_after = self.header(&response, "retry-after");
        let location = self.header(&response, "location");

        // Deadline starts before the body, so a slow chunked body cannot keep
        // the request alive by dribbling bytes after the headers arrived.
        let deadline = Instant::now() + self.body_timeout;
        let mut body = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let chunk = tokio::time::timeout(remaining, response.chunk())
                .await
                .map_err(|_| Error::Transport(url.safe_display(), "body read timed out".into()))?
                .map_err(|e| Error::Transport(url.safe_display(), e.to_string()))?;
            let Some(chunk) = chunk else { break };
            let next = body.len().saturating_add(chunk.len()) as u64;
            if next > max_body_bytes {
                return Err(Error::LimitExceeded(
                    url.safe_display(),
                    "candidate bytes",
                    max_body_bytes,
                ));
            }
            // Checked before allocation/extend.
            body.extend_from_slice(&chunk);
        }
        Ok(TransportResponse {
            status,
            etag,
            last_modified,
            retry_after,
            location,
            body,
        })
    }
}
