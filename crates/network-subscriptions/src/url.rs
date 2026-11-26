//! Public-URL policy. This is deliberately narrow: HTTPS, no userinfo, no
//! fragment, no query unless explicitly allowed as public, and no HTML viewer
//! pages masquerading as raw lists.

use std::fmt;
use std::net::IpAddr;

use url::{Host, Url};

use crate::config::QueryPolicy;
use crate::error::Error;
use crate::resolve::is_public_global;

const RAW_GITHUB_HOST: &str = "raw.githubusercontent.com";

/// A URL that has passed every static check. Construction is only through
/// [`ValidatedUrl::parse`]; no field is public, so an unvalidated URL cannot
/// reach the transport.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedUrl {
    text: String,
    host: String,
    path: String,
    port: Option<u16>,
}

impl ValidatedUrl {
    pub fn parse(raw: &str, policy: &QueryPolicy, max_header_bytes: usize) -> Result<Self, Error> {
        let url = Url::parse(raw).map_err(|e| Error::InvalidUrl(format!("not a URL: {e}")))?;
        if url.scheme() != "https" {
            return Err(Error::InvalidUrl("only https:// is allowed".into()));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(Error::InvalidUrl(
                "userinfo in a source URL is never allowed".into(),
            ));
        }
        if url.fragment().is_some() {
            return Err(Error::InvalidUrl("URL fragments are not allowed".into()));
        }
        let host = match url.host() {
            Some(Host::Domain(d)) => d.to_ascii_lowercase(),
            Some(Host::Ipv4(ip)) => {
                if !is_public_global(IpAddr::V4(ip)) {
                    return Err(Error::InvalidUrl(
                        "literal IP host is not a public global address".into(),
                    ));
                }
                ip.to_string()
            }
            Some(Host::Ipv6(ip)) => {
                if !is_public_global(IpAddr::V6(ip)) {
                    return Err(Error::InvalidUrl(
                        "literal IP host is not a public global address".into(),
                    ));
                }
                ip.to_string()
            }
            None => return Err(Error::InvalidUrl("URL has no host".into())),
        };

        // github.com serves an HTML viewer at /blob/... . Treating it as a
        // list would "parse" the page into nonsense, so reject it explicitly
        // with a diagnostic instead of pretending.
        if host == "github.com" {
            return Err(Error::InvalidUrl(
                "github.com is an HTML viewer; use a raw.githubusercontent.com file URL".into(),
            ));
        }

        let path = url.path().to_owned();
        if host == RAW_GITHUB_HOST {
            // A raw GitHub file URL is an ordinary HTTPS URL. It has no query
            // and needs owner/repo/ref/path. We do not rewrite URLs: there is
            // no safe guess about a canonical raw form from an arbitrary link.
            let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            if segments.len() < 4 {
                return Err(Error::InvalidUrl(
                    "raw.githubusercontent.com URL must be /owner/repo/ref/path".into(),
                ));
            }
            if url.query().is_some() {
                return Err(Error::InvalidUrl(
                    "raw.githubusercontent.com URLs must not have a query".into(),
                ));
            }
        } else {
            validate_query(url.query(), policy, max_header_bytes)?;
        }

        Ok(Self {
            text: url.to_string(),
            host,
            path,
            port: url.port(),
        })
    }

    /// Full canonical identity, including an explicitly allowed public query.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Diagnostics never echo a query, even an allowed public one.
    pub fn safe_display(&self) -> String {
        let mut out = format!("https://{}", self.host);
        if let Some(port) = self.port {
            out.push_str(&format!(":{port}"));
        }
        out.push_str(&self.path);
        out
    }
}

impl fmt::Display for ValidatedUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.safe_display())
    }
}

fn validate_query(query: Option<&str>, policy: &QueryPolicy, max_header_bytes: usize) -> Result<(), Error> {
    let Some(query) = query else {
        return Ok(());
    };
    if query.is_empty() {
        return Ok(());
    }
    let allowed = match policy {
        QueryPolicy::Reject => {
            return Err(Error::InvalidUrl(
                "query strings are rejected by policy".into(),
            ));
        }
        QueryPolicy::AllowPublic { keys } => keys,
    };
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key.is_empty() || key.len() > max_header_bytes || !allowed.iter().any(|k| k == key) {
            return Err(Error::InvalidUrl(format!(
                "query key '{}' is not in the public allowlist",
                Error::bounded_detail(key, 64)
            )));
        }
        if value.len() > max_header_bytes
            || value.bytes().any(|b| b < 0x20 || b == 0x7f)
        {
            return Err(Error::InvalidUrl(
                "query value is oversized or has control characters".into(),
            ));
        }
    }
    Ok(())
}
