//! Operator-supplied controller scope. This is the SSRF boundary: request
//! addresses are never accepted from callers. Every request path is built from
//! a fixed endpoint enum plus validated resource IDs under this one authority.
//! Redirects are disabled in the transport, so a different-origin redirect
//! cannot be followed. DNS-rebinding through a hostname is only accepted with
//! an explicit operator opt-in; a literal controller IP is the strict mode.

use std::{fmt, net::IpAddr, time::Duration};

use url::Url;

use crate::{auth::ApiKey, error::Error};

/// Reference version of the official OpenAPI contract used for this adapter.
/// The controller's own `applicationVersion` is reported separately and is
/// never claimed to equal this documentation version.
pub const API_DOC_VERSION: &str = "10.6.109";

/// Local-console base path from the official OpenAPI `servers` entry.
pub const LOCAL_BASE_PATH: &str = "/proxy/network/integration";

const CLOUD_PREFIX: &str = "/v1/connector/consoles/";

fn is_cloud_base_path(path: &str) -> bool {
    if !path.starts_with(CLOUD_PREFIX) || !path.ends_with(LOCAL_BASE_PATH) {
        return false;
    }
    let console = &path[CLOUD_PREFIX.len()..path.len() - LOCAL_BASE_PATH.len()];
    !console.is_empty() && !console.contains('/')
}

/// Resource IDs are interpolated into URL paths. Only a narrow ASCII shape is
/// accepted so no caller can inject a path segment, query or fragment.
pub fn validate_resource_id(id: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > 128 {
        return Err(Error::InvalidConfig(
            "resource id has invalid length".into(),
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::InvalidConfig(
            "resource id contains characters outside [A-Za-z0-9_-]".into(),
        ));
    }
    Ok(())
}

#[derive(Clone)]
pub struct ControllerConfig {
    base_url: String,
    authority: String,
    api_key: ApiKey,
    trusted_ca_pem: Option<String>,
    site_allowlist: Vec<String>,
    request_timeout: Duration,
    max_body_bytes: usize,
    max_page_size: u32,
    max_pages: u32,
    allow_hostname: bool,
}

impl fmt::Debug for ControllerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ControllerConfig")
            .field("base_url", &self.base_url)
            .field("authority", &self.authority)
            .field("api_key", &"[REDACTED]")
            .field("has_trusted_ca", &self.trusted_ca_pem.is_some())
            .field("site_allowlist_len", &self.site_allowlist.len())
            .field("request_timeout", &self.request_timeout)
            .field("max_body_bytes", &self.max_body_bytes)
            .field("max_page_size", &self.max_page_size)
            .field("max_pages", &self.max_pages)
            .field("allow_hostname", &self.allow_hostname)
            .finish()
    }
}

impl ControllerConfig {
    /// Strict local-controller form: the authority is a literal IP address.
    pub fn for_local(
        controller_ip: IpAddr,
        api_key: ApiKey,
        site_allowlist: Vec<String>,
    ) -> Result<Self, Error> {
        for site in &site_allowlist {
            validate_resource_id(site)?;
        }
        if site_allowlist.is_empty() {
            return Err(Error::InvalidConfig("site allowlist is empty".into()));
        }
        let host = match controller_ip {
            IpAddr::V6(ip) => format!("[{}]", ip),
            IpAddr::V4(ip) => ip.to_string(),
        };
        let base_url = format!("https://{}{}", host, LOCAL_BASE_PATH);
        Self::from_base_url(&base_url, api_key, site_allowlist)
    }

    /// Validate an operator-provided local or cloud-connector base URL.
    /// Hostnames are rejected unless the operator opts in explicitly.
    pub fn from_base_url(
        base_url: &str,
        api_key: ApiKey,
        site_allowlist: Vec<String>,
    ) -> Result<Self, Error> {
        Self::build(base_url, api_key, site_allowlist, false)
    }

    /// Explicit hostname-authority form. Only use for an operator-trusted
    /// controller whose DNS name is known not to be attacker-controlled.
    pub fn from_base_url_allow_hostname(
        base_url: &str,
        api_key: ApiKey,
        site_allowlist: Vec<String>,
    ) -> Result<Self, Error> {
        Self::build(base_url, api_key, site_allowlist, true)
    }

    fn build(
        base_url: &str,
        api_key: ApiKey,
        site_allowlist: Vec<String>,
        allow_hostname: bool,
    ) -> Result<Self, Error> {
        for site in &site_allowlist {
            validate_resource_id(site)?;
        }
        if site_allowlist.is_empty() {
            return Err(Error::InvalidConfig("site allowlist is empty".into()));
        }
        let parsed = Url::parse(base_url)
            .map_err(|_| Error::InvalidConfig("base URL is not a valid absolute URL".into()))?;
        if parsed.scheme() != "https" {
            return Err(Error::InvalidConfig("controller URL must use https".into()));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(Error::InvalidConfig(
                "controller URL must not contain userinfo".into(),
            ));
        }
        if parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(Error::InvalidConfig(
                "controller URL must not contain a query or fragment".into(),
            ));
        }
        let path = parsed.path().trim_end_matches('/');
        if path != LOCAL_BASE_PATH && !is_cloud_base_path(path) {
            return Err(Error::InvalidConfig(
                "controller URL path must be the Network integration base path".into(),
            ));
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| Error::InvalidConfig("controller URL has no host".into()))?;
        if host.is_empty() {
            return Err(Error::InvalidConfig(
                "controller URL has an empty host".into(),
            ));
        }
        if matches!(parsed.host(), Some(url::Host::Domain(_))) && !allow_hostname {
            // A hostname introduces resolver-controlled rebinding risk. Require
            // an explicit operator opt-in before accepting it.
            return Err(Error::InvalidConfig(
                "controller host is a hostname; use a literal IP or the explicit hostname constructor".into(),
            ));
        }
        let authority = match parsed.port() {
            Some(port) => format!("{}:{}", host, port),
            None => host.to_owned(),
        };
        let canonical = format!("https://{}{}", authority, path);
        Ok(Self {
            base_url: canonical,
            authority,
            api_key,
            trusted_ca_pem: None,
            site_allowlist,
            request_timeout: Duration::from_secs(10),
            max_body_bytes: 1 << 20,
            max_page_size: 100,
            max_pages: 100,
            allow_hostname,
        })
    }

    /// Trust one explicit operator-supplied CA in addition to platform roots.
    /// Verification stays on: no "accept invalid certificates" option exists.
    pub fn with_trusted_ca_pem(mut self, pem: impl Into<String>) -> Self {
        self.trusted_ca_pem = Some(pem.into());
        self
    }

    pub fn with_limits(
        mut self,
        request_timeout: Duration,
        max_body_bytes: usize,
        max_page_size: u32,
        max_pages: u32,
    ) -> Result<Self, Error> {
        if max_body_bytes < 1024 || max_page_size == 0 || max_page_size > 200 {
            return Err(Error::InvalidConfig(
                "limits are outside the bounded range".into(),
            ));
        }
        if max_pages == 0 || max_pages > 1000 || request_timeout.is_zero() {
            return Err(Error::InvalidConfig(
                "limits are outside the bounded range".into(),
            ));
        }
        self.request_timeout = request_timeout;
        self.max_body_bytes = max_body_bytes;
        self.max_page_size = max_page_size;
        self.max_pages = max_pages;
        Ok(self)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn authority(&self) -> &str {
        &self.authority
    }

    pub fn api_key(&self) -> &ApiKey {
        &self.api_key
    }

    pub fn trusted_ca_pem(&self) -> Option<&str> {
        self.trusted_ca_pem.as_deref()
    }

    pub fn site_allowlist(&self) -> &[String] {
        &self.site_allowlist
    }

    pub fn request_timeout(&self) -> Duration {
        self.request_timeout
    }

    pub fn max_body_bytes(&self) -> usize {
        self.max_body_bytes
    }

    pub fn max_page_size(&self) -> u32 {
        self.max_page_size
    }

    pub fn max_pages(&self) -> u32 {
        self.max_pages
    }

    pub fn allow_hostname(&self) -> bool {
        self.allow_hostname
    }

    pub fn is_site_allowed(&self, site: &str) -> bool {
        self.site_allowlist.iter().any(|s| s == site)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> ApiKey {
        ApiKey::new("test-key")
    }

    #[test]
    fn rejects_userinfo_query_fragment_http_and_unknown_paths() {
        let site = vec!["11111111-1111-4111-8111-111111111111".to_string()];
        let bad = [
            "http://192.168.1.1/proxy/network/integration",
            "https://user@192.168.1.1/proxy/network/integration",
            "https://192.168.1.1/proxy/network/integration?x=1",
            "https://192.168.1.1/proxy/network/integration#f",
            "https://192.168.1.1/anything",
            "https://localhost/proxy/network/integration",
        ];
        for url in bad {
            assert!(
                ControllerConfig::from_base_url(url, key(), site.clone()).is_err(),
                "accepted bad URL {url}"
            );
        }
    }

    #[test]
    fn accepts_literal_local_and_cloud_connector_bases() {
        let site = vec!["11111111-1111-4111-8111-111111111111".to_string()];
        assert!(ControllerConfig::from_base_url(
            "https://192.168.1.1/proxy/network/integration",
            key(),
            site.clone()
        )
        .is_ok());
        assert!(ControllerConfig::from_base_url_allow_hostname(
            "https://api.ui.com/v1/connector/consoles/abc/proxy/network/integration",
            key(),
            site
        )
        .is_ok());
    }

    #[test]
    fn hostname_requires_explicit_opt_in() {
        let site = vec!["11111111-1111-4111-8111-111111111111".to_string()];
        let url = "https://localhost:8443/proxy/network/integration";
        assert!(ControllerConfig::from_base_url(url, key(), site.clone()).is_err());
        assert!(
            ControllerConfig::from_base_url_allow_hostname(url, key(), site)
                .unwrap()
                .authority()
                .contains("localhost")
        );
    }

    #[test]
    fn resource_ids_cannot_inject_path_characters() {
        assert!(validate_resource_id("11111111-1111-4111-8111-111111111111").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a#b", "a b", "a%2f"] {
            assert!(validate_resource_id(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn page_limit_matches_the_official_contract() {
        let config = ControllerConfig::for_local(
            "127.0.0.1".parse().unwrap(),
            key(),
            vec!["11111111-1111-4111-8111-111111111111".into()],
        )
        .unwrap();
        assert!(config
            .clone()
            .with_limits(Duration::from_secs(5), 1024, 200, 1)
            .is_ok());
        assert!(config
            .with_limits(Duration::from_secs(5), 1024, 201, 1)
            .is_err());
    }

    #[test]
    fn strict_local_controller_supports_ipv4_and_ipv6_literals() {
        for address in ["127.0.0.1", "::1", "fd00::1"] {
            let config = ControllerConfig::for_local(
                address.parse().unwrap(),
                key(),
                vec!["11111111-1111-4111-8111-111111111111".into()],
            )
            .unwrap();
            assert!(!config.allow_hostname());
            assert!(url::Url::parse(config.base_url()).is_ok());
        }
    }
}
