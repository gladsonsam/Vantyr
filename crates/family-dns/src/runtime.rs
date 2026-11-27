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
use hickory_resolver::config::{LookupIpStrategy, ResolveHosts, ResolverOpts};
use hickory_resolver::Hosts;
use hickory_server::net::runtime::TokioRuntimeProvider;
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData, CNAME as CnameData, SOA};
use hickory_server::proto::rr::{Name, RData, Record, RecordSet, RecordType, RrKey};
use hickory_server::store::in_memory::InMemoryZoneHandler;
use hickory_server::zone_handler::{AxfrPolicy, Catalog, ZoneType};
use vantyr_network_filter::FilterSnapshot;

use crate::config::{
    forwards_to_self, CacheConfig, Config, DenyConfig, DohListenerConfig, DotListenerConfig,
    RecordSpec,
};
use crate::filter::FilterMaterial;
use crate::management::ManagementState;
use crate::observe::ObservationLog;
use crate::policy::PolicyEvaluator;
use crate::upstream::{CacheControl, EncryptedZoneHandler, PlaintextZoneHandler};

const FORWARD_TIMEOUT_SECS: u64 = 2;
const FORWARD_ATTEMPTS: usize = 1;
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

/// Map validated settings onto the maintained resolver options. Both
/// plaintext and encrypted forwarders receive this exact same value.
pub(crate) fn resolver_options(cache: &CacheConfig) -> ResolverOpts {
    let mut options = ResolverOpts::default();
    options.timeout = Duration::from_secs(FORWARD_TIMEOUT_SECS);
    options.attempts = FORWARD_ATTEMPTS;
    options.cache_size = cache.cache_size();
    options.num_concurrent_reqs = FORWARD_CONCURRENCY;
    options.max_active_requests = MAX_ACTIVE_REQUESTS;
    options.use_hosts_file = if cache.use_hosts_file {
        ResolveHosts::Always
    } else {
        ResolveHosts::Never
    };
    // `ip_strategy` only affects `lookup_ip`; the zone handlers issue
    // record-type lookups. IPv6 answers are therefore shaped explicitly by the
    // handler, not assumed away by this strategy.
    options.ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
    // Keep CNAME records visible so the handler can check every alias target
    // before releasing an answer.
    options.preserve_intermediates = true;
    options.positive_min_ttl = cache
        .positive_min_ttl_secs
        .map(|t| Duration::from_secs(t.into()));
    options.positive_max_ttl = cache
        .positive_max_ttl_secs
        .map(|t| Duration::from_secs(t.into()));
    options.negative_min_ttl = cache
        .negative_min_ttl_secs
        .map(|t| Duration::from_secs(t.into()));
    options.negative_max_ttl = cache
        .negative_max_ttl_secs
        .map(|t| Duration::from_secs(t.into()));
    // No DNSSEC validator, no AD authentication and no per-query DO/ECS hook:
    // those rows stay open rather than bypassing the maintained cache path.
    options
}

/// Build a complete catalog atomically. Construction always goes through a
/// validated config; a failure leaves any running snapshot untouched. Returns
/// the catalog together with the one clear handle shared by both resolver
/// paths. `hosts` is a test seam using Hickory's maintained `Hosts` table.
pub(crate) fn build_catalog(
    config: &Config,
    hosts: Option<Arc<Hosts>>,
) -> Result<(Catalog, CacheControl)> {
    let mut catalog = Catalog::new();
    let mut cache = CacheControl::default();
    for (origin, records) in &config.local_zones {
        let origin = Name::from_str(origin)?;
        let handler = local_zone_handler(&origin, records)?;
        catalog.upsert(origin.into(), vec![Arc::new(handler)]);
    }
    let options = resolver_options(&config.cache);
    let upstreams = config.upstreams();
    if !upstreams.is_empty() {
        let handler = PlaintextZoneHandler::with_hosts(&upstreams, options.clone(), hosts.clone())?;
        cache.register(handler.resolver());
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
    }
    if !config.encrypted_upstreams.is_empty() {
        // Config validation forbids mixing plaintext and encrypted upstreams,
        // so this is an isolated verified route, never a silent fallback.
        let handler =
            EncryptedZoneHandler::with_hosts(&config.encrypted_upstreams, options, hosts)?;
        cache.register(handler.resolver());
        catalog.upsert(Name::root().into(), vec![Arc::new(handler)]);
    }
    Ok((catalog, cache))
}

/// Independent counters/status published with one immutable snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BundleState {
    pub(crate) generation: u64,
    pub(crate) policy_highwater: u64,
    pub(crate) filter_generation: u64,
    /// SHA-256 identity of the applied material, empty when no filter is set.
    pub(crate) filter_identity: String,
}

/// Everything a query needs, built together and never mutated.
pub(crate) struct RuntimeSnapshot {
    pub(crate) revision: u64,
    pub(crate) published_at: DateTime<Utc>,
    pub(crate) config: Config,
    /// The exact whole policy this snapshot enforces, kept beside the
    /// evaluator so a same-revision candidate can be compared byte-for-byte.
    pub(crate) policy: Policy,
    pub(crate) deny: DenyConfig,
    pub(crate) catalog: Arc<Catalog>,
    /// Clear handle for the resolver caches created with this snapshot. A
    /// replacement snapshot builds new resolvers and therefore starts empty.
    pub(crate) cache: CacheControl,
    pub(crate) evaluator: Arc<PolicyEvaluator>,
    /// Immutable compiled filter state. Blocking is applied only after the
    /// household evaluator has allowed the question; a list exception can
    /// never grant an allow against household policy.
    pub(crate) filter: Arc<FilterSnapshot>,
    /// The validated material behind `filter`, reused verbatim by a controller
    /// pull so it cannot restore a startup filter after a local filter change.
    pub(crate) filter_material: Option<FilterMaterial>,
    pub(crate) state: BundleState,
    pub(crate) management: Option<ManagementState>,
}

/// Shared handle to the current snapshot. The lock is held only for an `Arc`
/// clone, never across I/O or an `.await`.
pub(crate) type SnapshotHandle = Arc<RwLock<Arc<RuntimeSnapshot>>>;

/// Build a full snapshot off the request path. No socket is touched here.
pub(crate) fn build_snapshot(
    config: Config,
    policy: Policy,
    observations: ObservationLog,
    filter: Arc<FilterSnapshot>,
    filter_material: Option<FilterMaterial>,
    state: BundleState,
    management: Option<ManagementState>,
) -> Result<Arc<RuntimeSnapshot>> {
    build_snapshot_with_hosts(
        config,
        policy,
        observations,
        filter,
        filter_material,
        state,
        management,
        None,
    )
}

/// Same as `build_snapshot`, with a maintained `Hosts` table injected for
/// tests. Production always passes `None`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_snapshot_with_hosts(
    config: Config,
    policy: Policy,
    observations: ObservationLog,
    filter: Arc<FilterSnapshot>,
    filter_material: Option<FilterMaterial>,
    state: BundleState,
    management: Option<ManagementState>,
    hosts: Option<Arc<Hosts>>,
) -> Result<Arc<RuntimeSnapshot>> {
    let revision = policy.revision;
    let published_at = policy.published_at;
    let (catalog, cache) = build_catalog(&config, hosts)?;
    let evaluator = Arc::new(PolicyEvaluator::with_policy(
        config.clone(),
        policy.clone(),
        observations,
    ));
    Ok(Arc::new(RuntimeSnapshot {
        revision,
        published_at,
        deny: config.deny.clone(),
        config,
        policy,
        catalog: Arc::new(catalog),
        cache,
        evaluator,
        filter,
        filter_material,
        state,
        management,
    }))
}

/// Transport identity is fixed for the lifetime of a listener. A reload that
/// would move the socket must be rejected instead of silently rebinding.
pub(crate) fn same_transport(a: &Config, b: &Config) -> bool {
    a.bind.address == b.bind.address
        && a.bind.port == b.bind.port
        && a.bind.allow_non_loopback == b.bind.allow_non_loopback
        && same_dot_listener(a.dot_listener.as_ref(), b.dot_listener.as_ref())
        && same_doh_listener(a.doh_listener.as_ref(), b.doh_listener.as_ref())
}

/// The DoT listener block is transport identity. Certificate rotation is not
/// supported, so any change to it (including enable/disable or cert/key paths)
/// is a transport change and must be rejected by reload/controller pull.
fn same_dot_listener(a: Option<&DotListenerConfig>, b: Option<&DotListenerConfig>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.enabled == b.enabled
                && a.bind == b.bind
                && a.cert_path == b.cert_path
                && a.key_path == b.key_path
        }
        _ => false,
    }
}

/// Same transport identity for the DoH listener. Its hostname, path and
/// certificate paths define the accepted wire identity; no field can change on
/// reload. Per-client path identities are not part of this contract.
fn same_doh_listener(a: Option<&DohListenerConfig>, b: Option<&DohListenerConfig>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.enabled == b.enabled
                && a.bind == b.bind
                && a.hostname == b.hostname
                && a.path == b.path
                && a.cert_path == b.cert_path
                && a.key_path == b.key_path
        }
        _ => false,
    }
}

/// Self-loop guard after the OS has assigned an ephemeral port.
pub(crate) fn reject_upstream_self_loop(config: &Config, bound: SocketAddr) -> Result<()> {
    for upstream in config.upstreams() {
        if forwards_to_self(&upstream, &bound) {
            anyhow::bail!("upstream {upstream} points back at the bound listener {bound}");
        }
    }
    for spec in &config.encrypted_upstreams {
        let ip = std::net::IpAddr::from_str(spec.bootstrap())
            .map_err(|_| anyhow::anyhow!("encrypted bootstrap is not an IP literal"))?;
        let candidate = SocketAddr::new(crate::config::normalize_ip(ip), spec.port());
        if forwards_to_self(&candidate, &bound) {
            anyhow::bail!(
                "{} encrypted upstream points back at the bound listener {bound}",
                spec.scheme()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::empty_filter;
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
            empty_filter(),
            None,
            BundleState {
                generation: 1,
                policy_highwater: 1,
                filter_generation: 0,
                filter_identity: String::new(),
            },
            None,
        )
        .unwrap();
        let second = build_snapshot(
            config.clone(),
            config.policy_at(now),
            ObservationLog::default(),
            empty_filter(),
            None,
            BundleState {
                generation: 1,
                policy_highwater: 1,
                filter_generation: 0,
                filter_identity: String::new(),
            },
            None,
        )
        .unwrap();
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.published_at, now);
        assert!(!Arc::ptr_eq(&first, &second));
    }
}
