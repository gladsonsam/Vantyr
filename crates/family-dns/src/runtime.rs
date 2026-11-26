//! One immutable runtime snapshot per published bundle.
//!
//! A query takes the read lock only long enough to clone an `Arc`; all
//! evaluation, catalog lookup and upstream I/O happen on that frozen snapshot.
//! A reload builds a whole new snapshot off the request path and swaps the
//! `Arc` under a brief write lock. Policy, config, catalog and denial mode are
//! therefore always from the same version.

use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use family_policy::Policy;
use hickory_resolver::config::{LookupIpStrategy, NameServerConfig, ResolveHosts, ResolverOpts};
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData, SOA};
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::store::forwarder::{ForwardConfig, ForwardZoneHandler};
use hickory_server::store::in_memory::InMemoryZoneHandler;
use hickory_server::zone_handler::{AxfrPolicy, Catalog, ZoneType};

use crate::config::{forwards_to_self, Config, DenyConfig, RecordSpec};
use crate::observe::ObservationLog;
use crate::policy::PolicyEvaluator;

const FORWARD_TIMEOUT_SECS: u64 = 2;
const FORWARD_ATTEMPTS: usize = 1;
const FORWARD_CACHE_ENTRIES: u64 = 4096;
const FORWARD_CONCURRENCY: usize = 2;
const MAX_ACTIVE_REQUESTS: usize = 256;

fn local_zone_handler(
    origin: &Name,
    records: &[RecordSpec],
) -> Result<InMemoryZoneHandler<TokioRuntimeProvider>> {
    let mut map: BTreeMap<RrKey, RecordSet> = BTreeMap::new();
    let soa = Record::from_rdata(
        origin.clone(),
        3600,
        RData::SOA(SOA::new(
            origin.clone(),
            Name::from_str("hostmaster.invalid.")?,
            1,
            3600,
            600,
            86_400,
            60,
        )),
    );
    map.insert(
        RrKey::new(origin.clone().into(), RecordType::SOA),
        soa.into(),
    );

    for record in records {
        let name = Name::from_str(record.name())?;
        let (record_type, rdata, ttl) = match record {
            RecordSpec::A { ttl, addr, .. } => (
                RecordType::A,
                RData::A(AData::from(addr.parse::<Ipv4Addr>()?)),
                *ttl,
            ),
            RecordSpec::Aaaa { ttl, addr, .. } => (
                RecordType::AAAA,
                RData::AAAA(AaaaData::from(addr.parse::<Ipv6Addr>()?)),
                *ttl,
            ),
            RecordSpec::Cname { ttl, target, .. } => (
                RecordType::CNAME,
                RData::CNAME(CnameData(Name::from_str(target)?)),
                *ttl,
            ),
        };
        let key = RrKey::new(name.clone().into(), record_type);
        let set = map
            .entry(key)
            .or_insert_with(|| RecordSet::with_ttl(name.clone(), record_type, ttl));
        // Accumulate every address at one owner instead of replacing the
        // previous record set with `map.insert`.
        set.insert(Record::from_rdata(name, ttl, rdata), 0);
        if set.ttl() > ttl {
            set.set_ttl(ttl);
        }
    }

    InMemoryZoneHandler::<TokioRuntimeProvider>::new(
        origin.clone(),
        map,
        ZoneType::Primary,
        AxfrPolicy::Deny,
    )
    .map_err(anyhow::Error::msg)
}

fn forwarder_handler(upstreams: &[SocketAddr]) -> Result<ForwardZoneHandler<TokioRuntimeProvider>> {
    let mut servers = Vec::with_capacity(upstreams.len());
    for upstream in upstreams {
        let mut server = NameServerConfig::udp_and_tcp(upstream.ip());
        for connection in &mut server.connections {
            connection.port = upstream.port();
        }
        servers.push(server);
    }
    let mut options = ResolverOpts::default();
    options.timeout = Duration::from_secs(FORWARD_TIMEOUT_SECS);
    options.attempts = FORWARD_ATTEMPTS;
    options.cache_size = FORWARD_CACHE_ENTRIES;
    options.num_concurrent_reqs = FORWARD_CONCURRENCY;
    options.max_active_requests = MAX_ACTIVE_REQUESTS;
    options.use_hosts_file = ResolveHosts::Never;
    options.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
    // Keep CNAME records visible so the handler can check every alias target
    // before releasing an answer.
    options.preserve_intermediates = true;
    let config = ForwardConfig {
        name_servers: servers,
        options: Some(options),
    };
    ForwardZoneHandler::builder_tokio(config)
        .with_origin(Name::root())
        .build()
        .map_err(anyhow::Error::msg)
}

/// Build a complete catalog atomically. Construction always goes through a
/// validated config; a failure leaves any running snapshot untouched.
pub(crate) fn build_catalog(config: &Config) -> Result<Catalog> {
    let mut catalog = Catalog::new();
    for (origin, records) in &config.local_zones {
        let origin = Name::from_str(origin)?;
        let handler = local_zone_handler(&origin, records)?;
        catalog.upsert(origin.into(), vec![Arc::new(handler)]);
    }
    let upstreams = config.upstreams();
    if !upstreams.is_empty() {
        let handler = forwarder_handler(&upstreams)?;
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
    }
    Ok(catalog)
}

/// Everything a query needs, built together and never mutated.
pub(crate) struct RuntimeSnapshot {
    pub(crate) revision: u64,
    pub(crate) published_at: DateTime<Utc>,
    pub(crate) config: Config,
    pub(crate) deny: DenyConfig,
    pub(crate) catalog: Arc<Catalog>,
    pub(crate) evaluator: Arc<PolicyEvaluator>,
}

/// Shared handle to the current snapshot. The lock is held only for an `Arc`
/// clone, never across I/O or an `.await`.
pub(crate) type SnapshotHandle = Arc<RwLock<Arc<RuntimeSnapshot>>>;

/// Build a full snapshot off the request path. No socket is touched here.
pub(crate) fn build_snapshot(
    config: Config,
    policy: Policy,
    observations: ObservationLog,
) -> Result<Arc<RuntimeSnapshot>> {
    let revision = policy.revision;
    let published_at = policy.published_at;
    let catalog = Arc::new(build_catalog(&config)?);
    let evaluator = Arc::new(PolicyEvaluator::with_policy(
        config.clone(),
        policy,
        observations,
    ));
    Ok(Arc::new(RuntimeSnapshot {
        revision,
        published_at,
        deny: config.deny.clone(),
        config,
        catalog,
        evaluator,
    }))
}

/// Transport identity is fixed for the lifetime of a listener. A reload that
/// would move the socket must be rejected instead of silently rebinding.
pub(crate) fn same_transport(a: &Config, b: &Config) -> bool {
    a.bind.address == b.bind.address
        && a.bind.port == b.bind.port
        && a.bind.allow_non_loopback == b.bind.allow_non_loopback
}

/// Self-loop guard after the OS has assigned an ephemeral port.
pub(crate) fn reject_upstream_self_loop(config: &Config, bound: SocketAddr) -> Result<()> {
    for upstream in config.upstreams() {
        if forwards_to_self(&upstream, &bound) {
            anyhow::bail!("upstream {upstream} points back at the bound listener {bound}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn snapshot_versions_stay_separate() {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let config = Config::parse(
            br#"{
                "household_id": "11111111-2222-3333-4444-555555555555",
                "policy_revision": 1,
                "profiles": {"restricted": [
                    {"effect": "deny", "match": {"type": "suffix", "value": "example"}}
                ]},
                "default_device_profile": "restricted"
            }"#,
        )
        .unwrap();
        let first = build_snapshot(
            config.clone(),
            config.policy_at(now),
            ObservationLog::default(),
        )
        .unwrap();
        let second = build_snapshot(
            config.clone(),
            config.policy_at(now),
            ObservationLog::default(),
        )
        .unwrap();
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.published_at, now);
        assert!(!Arc::ptr_eq(&first, &second));
    }
}
