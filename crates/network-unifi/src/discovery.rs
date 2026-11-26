//! Read-only discovery over the official versioned Network API. All reads are
//! bounded by configured page size, page count and response byte limits.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    capabilities::{Capabilities, Operation, Support},
    config::ControllerConfig,
    error::Error,
    model::{
        ApplicationInfo, ClientObservation, NetworkObservation, NetworkOverview, Page,
        SiteOverview,
    },
    transport::{Endpoint, RawResponse, Transport},
};

fn interpret_status(status: u16, label: &'static str) -> Result<(), Error> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(Error::AuthDenied),
        404 => Err(Error::Missing),
        405 | 501 => Err(Error::Unsupported(label)),
        429 | 500..=599 => Err(Error::Unavailable(label)),
        _ => Err(Error::Unavailable(label)),
    }
}

fn support_from_error(error: &Error) -> Support {
    match error {
        Error::AuthDenied => Support::AuthDenied,
        Error::Unsupported(_) => Support::Unsupported,
        Error::Unavailable(_) | Error::Transport(_) | Error::LimitExceeded(_) => {
            Support::Unavailable
        }
        _ => Support::Unknown,
    }
}

#[derive(Clone, Copy)]
enum PagedTarget<'a> {
    Sites,
    Networks(&'a str),
    Clients(&'a str),
}

impl PagedTarget<'_> {
    fn label(&self) -> &'static str {
        match self {
            Self::Sites => "sites",
            Self::Networks(_) => "networks",
            Self::Clients(_) => "clients",
        }
    }

    fn endpoint<'b>(&'b self, offset: u64, limit: u32) -> Endpoint<'b> {
        match self {
            Self::Sites => Endpoint::Sites { offset, limit },
            Self::Networks(site) => Endpoint::Networks {
                site,
                offset,
                limit,
            },
            Self::Clients(site) => Endpoint::Clients {
                site,
                offset,
                limit,
            },
        }
    }

}

pub struct Discovery<'a> {
    config: &'a ControllerConfig,
    transport: &'a dyn Transport,
}

impl<'a> Discovery<'a> {
    pub fn new(config: &'a ControllerConfig, transport: &'a dyn Transport) -> Self {
        Self { config, transport }
    }

    async fn fetch_page<T: DeserializeOwned>(
        &self,
        endpoint: Endpoint<'_>,
    ) -> Result<Page<T>, Error> {
        let label = endpoint.label();
        let raw = self.transport.get(endpoint).await?;
        interpret_status(raw.status, label)?;
        if raw.body.len() > self.config.max_body_bytes() {
            return Err(Error::LimitExceeded(label));
        }
        serde_json::from_slice(&raw.body).map_err(|_| Error::Malformed(label))
    }

    async fn collect<T: DeserializeOwned>(
        &self,
        target: PagedTarget<'_>,
    ) -> Result<Vec<T>, Error> {
        let label = target.label();
        let page_size = self.config.max_page_size();
        let max_pages = self.config.max_pages();
        let mut offset: u64 = 0;
        let mut total: u64 = 0;
        let mut collected = Vec::new();

        for _ in 0..max_pages {
            let endpoint = target.endpoint(offset, page_size);
            let page: Page<T> = self.fetch_page(endpoint).await?;
            if page.count < 0
                || page.limit < 0
                || page.offset < 0
                || page.total_count < 0
                || page.offset as u64 != offset
            {
                return Err(Error::NonAdvancingPagination(label));
            }
            total = page.total_count as u64;
            if page.data.is_empty() {
                if total > offset {
                    return Err(Error::NonAdvancingPagination(label));
                }
                return Ok(collected);
            }
            let advanced = page.data.len() as u64;
            collected.extend(page.data);
            offset = offset.saturating_add(advanced);
            if offset >= total {
                return Ok(collected);
            }
        }
        if offset < total {
            return Err(Error::LimitExceeded(label));
        }
        Ok(collected)
    }

    pub async fn info(&self) -> Result<ApplicationInfo, Error> {
        let raw: RawResponse = self.transport.get(Endpoint::Info).await?;
        interpret_status(raw.status, "info")?;
        if raw.body.len() > self.config.max_body_bytes() {
            return Err(Error::LimitExceeded("info"));
        }
        serde_json::from_slice(&raw.body).map_err(|_| Error::Malformed("info"))
    }

    pub async fn list_sites(&self) -> Result<Vec<SiteOverview>, Error> {
        self.collect(PagedTarget::Sites).await
    }

    pub async fn list_networks(&self, site: &str) -> Result<Vec<NetworkOverview>, Error> {
        if !self.config.is_site_allowed(site) {
            return Err(Error::SiteNotAllowed(site.to_owned()));
        }
        self.collect(PagedTarget::Networks(site)).await
    }

    pub async fn list_clients(&self, site: &str) -> Result<Vec<ClientObservation>, Error> {
        if !self.config.is_site_allowed(site) {
            return Err(Error::SiteNotAllowed(site.to_owned()));
        }
        self.collect(PagedTarget::Clients(site)).await
    }

    pub async fn network_detail(
        &self,
        site: &str,
        network: &str,
    ) -> Result<NetworkObservation, Error> {
        if !self.config.is_site_allowed(site) {
            return Err(Error::SiteNotAllowed(site.to_owned()));
        }
        let raw = self
            .transport
            .get(Endpoint::Network { site, network })
            .await?;
        interpret_status(raw.status, "network")?;
        if raw.body.len() > self.config.max_body_bytes() {
            return Err(Error::LimitExceeded("network"));
        }
        let value: Value =
            serde_json::from_slice(&raw.body).map_err(|_| Error::Malformed("network"))?;
        Ok(NetworkObservation::from_raw(value))
    }

    /// Discover version, allowed sites and bounded observations. A failed
    /// per-site read is recorded as a capability status rather than inferred as
    /// success; only `info` is required to proceed.
    pub async fn discover(&self) -> Result<DiscoveryReport, Error> {
        let info = self.info().await?;
        let mut capabilities = Capabilities::from_info(info.application_version);
        let sites = self.list_sites().await?;
        let allowed: Vec<SiteOverview> = sites
            .into_iter()
            .filter(|site| self.config.is_site_allowed(&site.id))
            .collect();

        let mut networks = BTreeMap::new();
        let mut clients = BTreeMap::new();
        for site in &allowed {
            match self.list_networks(&site.id).await {
                Ok(found) => {
                    networks.insert(site.id.clone(), found);
                }
                Err(error) => capabilities.record(Operation::Networks, support_from_error(&error)),
            }
            match self.list_clients(&site.id).await {
                Ok(found) => {
                    clients.insert(site.id.clone(), found);
                }
                Err(error) => capabilities.record(Operation::Clients, support_from_error(&error)),
            }
        }
        Ok(DiscoveryReport {
            capabilities,
            sites: allowed,
            networks,
            clients,
        })
    }
}

#[derive(Clone, Debug)]
pub struct DiscoveryReport {
    pub capabilities: Capabilities,
    pub sites: Vec<SiteOverview>,
    pub networks: BTreeMap<String, Vec<NetworkOverview>>,
    pub clients: BTreeMap<String, Vec<ClientObservation>>,
}
