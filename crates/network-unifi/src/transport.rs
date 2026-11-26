//! Transport boundary. The trait exposes only read-only, typed endpoints: no
//! caller can supply an arbitrary URL and there is no POST/PUT/PATCH/DELETE
//! method in this slice. Live writes are deliberately deferred.

use std::fmt;

use async_trait::async_trait;
use reqwest::redirect::Policy;
use url::Url;

use crate::{
    auth::ApiKey,
    config::{validate_resource_id, ControllerConfig},
    error::Error,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint<'a> {
    Info,
    Sites {
        offset: u64,
        limit: u32,
    },
    Networks {
        site: &'a str,
        offset: u64,
        limit: u32,
    },
    Network {
        site: &'a str,
        network: &'a str,
    },
    Clients {
        site: &'a str,
        offset: u64,
        limit: u32,
    },
}

impl Endpoint<'_> {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Sites { .. } => "sites",
            Self::Networks { .. } => "networks",
            Self::Network { .. } => "network",
            Self::Clients { .. } => "clients",
        }
    }

    fn path(&self) -> String {
        match self {
            Self::Info => "/v1/info".to_owned(),
            Self::Sites { .. } => "/v1/sites".to_owned(),
            Self::Networks { site, .. } => format!("/v1/sites/{site}/networks"),
            Self::Network { site, network } => format!("/v1/sites/{site}/networks/{network}"),
            Self::Clients { site, .. } => format!("/v1/sites/{site}/clients"),
        }
    }

    fn paged(&self) -> Option<(u64, u32)> {
        match self {
            Self::Sites { offset, limit }
            | Self::Networks { offset, limit, .. }
            | Self::Clients { offset, limit, .. } => Some((*offset, *limit)),
            Self::Info | Self::Network { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[async_trait]
pub trait Transport: Send + Sync {
    async fn get(&self, endpoint: Endpoint<'_>) -> Result<RawResponse, Error>;
}

pub struct HttpTransport {
    client: reqwest::Client,
    base_url: String,
    api_key: ApiKey,
    max_body_bytes: usize,
    site_allowlist: Vec<String>,
    max_page_size: u32,
}

impl fmt::Debug for HttpTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpTransport")
            .field("base_url", &self.base_url)
            .field("api_key", &"[REDACTED]")
            .field("max_body_bytes", &self.max_body_bytes)
            .finish()
    }
}

impl HttpTransport {
    pub fn new(config: &ControllerConfig) -> Result<Self, Error> {
        let mut builder = reqwest::Client::builder()
            .timeout(config.request_timeout())
            .redirect(Policy::none());
        if let Some(pem) = config.trusted_ca_pem() {
            let cert = reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| Error::InvalidConfig("trusted CA PEM is invalid".into()))?;
            // Merges the operator's CA with platform roots and keeps hostname
            // and chain verification enabled. No danger flags are used.
            builder = builder.tls_certs_merge([cert]);
        }
        let client = builder
            .build()
            .map_err(|_| Error::InvalidConfig("HTTP client could not be built".into()))?;
        Ok(Self {
            client,
            base_url: config.base_url().to_owned(),
            api_key: config.api_key().clone(),
            max_body_bytes: config.max_body_bytes(),
            site_allowlist: config.site_allowlist().to_vec(),
            max_page_size: config.max_page_size(),
        })
    }

    fn url_for(&self, endpoint: &Endpoint<'_>) -> Result<Url, Error> {
        let mut url = Url::parse(&format!("{}{}", self.base_url, endpoint.path()))
            .map_err(|_| Error::InvalidConfig("request URL could not be built".into()))?;
        if let Some((offset, limit)) = endpoint.paged() {
            url.query_pairs_mut()
                .append_pair("offset", &offset.to_string())
                .append_pair("limit", &limit.to_string());
        }
        Ok(url)
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn get(&self, endpoint: Endpoint<'_>) -> Result<RawResponse, Error> {
        let site = match &endpoint {
            Endpoint::Networks { site, .. }
            | Endpoint::Network { site, .. }
            | Endpoint::Clients { site, .. } => Some(*site),
            Endpoint::Info | Endpoint::Sites { .. } => None,
        };
        if let Some(site) = site {
            validate_resource_id(site)?;
            if !self.site_allowlist.iter().any(|allowed| allowed == site) {
                return Err(Error::SiteNotAllowed(site.to_owned()));
            }
        }
        if endpoint
            .paged()
            .is_some_and(|(_, limit)| limit == 0 || limit > self.max_page_size)
        {
            return Err(Error::LimitExceeded(endpoint.label()));
        }
        match &endpoint {
            Endpoint::Networks { site, .. } | Endpoint::Clients { site, .. } => {
                validate_resource_id(site)?
            }
            Endpoint::Network { site, network } => {
                validate_resource_id(site)?;
                validate_resource_id(network)?;
            }
            _ => {}
        }
        let url = self.url_for(&endpoint)?;
        let label = endpoint.label();
        let mut response = self
            .client
            .get(url)
            .header("x-api-key", self.api_key.expose())
            .send()
            .await
            .map_err(|_| Error::Transport(label))?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::Transport(label))?
        {
            if body.len().saturating_add(chunk.len()) > self.max_body_bytes {
                return Err(Error::LimitExceeded(label));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(RawResponse { status, body })
    }
}
