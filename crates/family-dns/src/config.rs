//! Validated, bounded configuration for the Vantyr DNS worker.
//!
//! The file is parsed and fully validated before any socket is bound. All
//! addresses are IP literals (no startup name resolution), all collections and
//! strings have hard caps, and a loopback bind is the default. Non-loopback
//! binds require explicit opt-in and are limited to non-public addresses for
//! private lab containers.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::str::FromStr;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use family_policy::{
    Capability, Device, DeviceId, DeviceKind, Effect, HouseholdId, Policy, Rule, RuleMatcher,
    Schedule,
};
use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use serde::{Deserialize, Serialize};
use vantyr_network_subscriptions::config::{
    Limits as SubscriptionLimits, QueryPolicy, SourceMetadata, SubscriptionConfig,
    SubscriptionSource,
};

/// Hard cap on the configuration file itself (bytes).
pub const MAX_CONFIG_BYTES: usize = 64 * 1024;
pub const MAX_UPSTREAMS: usize = 8;
pub const MAX_ZONES: usize = 32;
pub const MAX_RECORDS_PER_ZONE: usize = 512;
/// Bound on operator-configured exact-domain answer overrides.
pub const MAX_REWRITES: usize = MAX_RECORDS_PER_ZONE;
pub const MAX_DEVICES: usize = 256;
pub const MAX_SOURCE_IPS_PER_DEVICE: usize = 16;
/// Bounded CIDR source ranges per device, and across the whole config. These
/// mirror the exact-IP caps so an operator cannot grow the match set without a
/// size-bound config edit.
pub const MAX_SOURCE_RANGES_PER_DEVICE: usize = 16;
pub const MAX_SOURCE_RANGES: usize = 256;
pub const MAX_PROFILES: usize = 64;
pub const MAX_RULES_PER_PROFILE: usize = 512;
pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_NAME_LEN: usize = 255;
pub const MAX_REASON_LEN: usize = 256;
/// Rule ids are server-assigned in the shared policy; this mirrors its cap.
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TIMEZONE_LEN: usize = 64;
/// Bounded PEM string carried inside the one durable bundle (not a path).
pub const MAX_CA_PEM_BYTES: usize = 16 * 1024;
pub const MAX_DOH_PATH_LEN: usize = 256;
pub const MAX_TTL_SECS: u32 = 86_400;
pub const MAX_STALE_SECS: u64 = 30 * 24 * 60 * 60;
pub const DEFAULT_PORT: u16 = 15_353;
pub const HEARTBEAT_TTL_SECS: u64 = 90;
const EVENT_RETENTION_SECS: u64 = 24 * 60 * 60;

// Filter configuration is deliberately only *settings*: source ids/formats and
// bounded regular-file paths, plus an operator-provided service catalog and
// explicitly selected ids. The validated list bytes live in the durable bundle
// as typed material, never in this 64 KiB config. These bounds mirror the
// accepted `vantyr-network-filter` limits.
pub const MAX_FILTER_SOURCES: usize = 32;
pub const MAX_FILTER_PATH_LEN: usize = 512;
pub const MAX_FILTER_FIELD_LEN: usize = 200;
pub const MAX_SELECTED_SERVICES: usize = 64;
pub const MAX_SERVICE_DOMAINS: usize = 512;
pub const MAX_SUBSCRIPTION_SOURCES: usize = 32;
pub const MAX_CACHE_PATH_LEN: usize = 512;
/// Bounds on operator-supplied DoT server certificate/key path strings. The
/// files themselves are read with their own byte bound in `dot::load_server_config`.
pub const MAX_TLS_PATH_LEN: usize = 512;

// Bounded response-cache settings. The entry cap counts cached RESPONSES, not
// bytes: one response may be large, so this is a count bound only and is not a
// memory-size guarantee. The default preserves the previously fixed 4096-entry
// cache exactly; the maximum is deliberately modest (no unbounded admission).
pub const DEFAULT_CACHE_ENTRIES: u64 = 4096;
pub const MAX_CACHE_ENTRIES: u64 = 65_536;
/// Hard bound on operator-supplied bogus-NXDOMAIN answer IPs.
pub const MAX_BOGUS_NXDOMAIN_IPS: usize = 64;

/// Canonicalise only IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4. Native IPv6
/// loopback (`::1`) and deprecated IPv4-compatible addresses (`::a.b.c.d`)
/// stay IPv6 and are never silently reinterpreted as an IPv4 address.
pub fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            if s[..5].iter().all(|&part| part == 0) && s[5] == 0xffff {
                IpAddr::V4(Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                ))
            } else {
                IpAddr::V6(v6)
            }
        }
        v4 => v4,
    }
}

/// Parse an IP literal and return its canonical form.
fn parsed_ip(raw: &str, field: &str) -> Result<IpAddr> {
    let ip = IpAddr::from_str(raw)
        .map_err(|_| anyhow::anyhow!("{field} '{raw}' must be an IP literal"))?;
    Ok(normalize_ip(ip))
}

/// Shape and TTL bounds for one exact-domain rewrite record. Names are
/// absolute so a rewrite can never depend on a resolver search suffix.
fn validate_rewrite_record(record: &RecordSpec) -> Result<()> {
    let name = record.name();
    if name.is_empty() || name.len() > MAX_NAME_LEN || !name.ends_with('.') {
        bail!("rewrite name must be a fully qualified name within {MAX_NAME_LEN} characters");
    }
    hickory_server::proto::rr::Name::from_str(name)
        .map_err(|_| anyhow::anyhow!("invalid rewrite name '{name}'"))?;
    if !(1..=MAX_TTL_SECS).contains(&record.ttl()) {
        bail!("rewrite TTL must be 1..={MAX_TTL_SECS}");
    }
    match record {
        RecordSpec::A { addr, .. } => {
            Ipv4Addr::from_str(addr)
                .map_err(|_| anyhow::anyhow!("invalid rewrite A address '{addr}'"))?;
        }
        RecordSpec::Aaaa { addr, .. } => {
            Ipv6Addr::from_str(addr)
                .map_err(|_| anyhow::anyhow!("invalid rewrite AAAA address '{addr}'"))?;
        }
        RecordSpec::Cname { target, .. } => {
            if target.is_empty() || target.len() > MAX_NAME_LEN || !target.ends_with('.') {
                bail!("rewrite CNAME target must be a fully qualified name within {MAX_NAME_LEN} characters");
            }
            hickory_server::proto::rr::Name::from_str(target)
                .map_err(|_| anyhow::anyhow!("invalid rewrite CNAME target '{target}'"))?;
        }
    }
    Ok(())
}

/// One bounded rule check shared by the safety baseline and device profiles.
fn validate_rule_spec(
    rule: &RuleSpec,
    baseline: bool,
    seen_ids: &mut BTreeSet<String>,
    place: &str,
) -> Result<()> {
    if let Some(id) = &rule.id {
        if id.is_empty()
            || id.len() > MAX_ID_LEN
            || id.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            bail!("rule id in {place} must be 1..={MAX_ID_LEN} non-blank chars");
        }
        if !seen_ids.insert(id.clone()) {
            bail!("rule ids must be unique within a policy");
        }
    }
    if let Some(reason) = &rule.reason {
        if reason.len() > MAX_REASON_LEN || reason.chars().any(char::is_control) {
            bail!("rule reason in {place} is unbounded or contains control chars");
        }
    }
    if let Some(value) = rule.matcher.value() {
        if value.is_empty()
            || value.len() > MAX_NAME_LEN
            || value.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            bail!("rule value in {place} must be 1..={MAX_NAME_LEN} characters");
        }
    }
    if let Some(schedule) = &rule.schedule {
        schedule.validate(place)?;
    }
    if baseline && rule.effect == Effect::Allow {
        bail!("the safety baseline may only contain deny rules");
    }
    Ok(())
}

/// Convert a validated spec to the shared core `Rule`. Explicit ids, reasons
/// and schedules are carried across untouched; locally authored rules get
/// stable generated values. Whole-policy equality with a compiled controller
/// policy depends on preserving these fields exactly.
fn build_rule(spec: &RuleSpec, place: &str, index: usize) -> Rule {
    // Values are carried verbatim: the evaluator already compares names and
    // matchers case-insensitively, and a compiled controller policy must have
    // exactly the same bytes as the policy the controller published.
    let matcher = match &spec.matcher {
        MatchSpec::Exact { value } => RuleMatcher::HostExact(value.clone()),
        MatchSpec::Suffix { value } => RuleMatcher::DomainSuffix(value.clone()),
        MatchSpec::Any => RuleMatcher::Any,
    };
    let schedule = spec.schedule.as_ref().map(|schedule| Schedule {
        weekdays: schedule.weekdays.clone(),
        start_minute: schedule.start_minute,
        end_minute: schedule.end_minute,
        timezone: schedule.timezone.clone(),
    });
    Rule {
        id: spec
            .id
            .clone()
            .unwrap_or_else(|| format!("{place}-{index}")),
        effect: spec.effect,
        matcher,
        schedule,
        reason: spec
            .reason
            .clone()
            .unwrap_or_else(|| format!("{place} rule {index}")),
    }
}

fn default_loopback() -> String {
    "127.0.0.1".to_owned()
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_bind() -> BindConfig {
    BindConfig {
        address: default_loopback(),
        port: default_port(),
        allow_non_loopback: false,
    }
}
fn default_true() -> bool {
    true
}
fn default_cache_entries() -> u64 {
    DEFAULT_CACHE_ENTRIES
}
fn default_personal_computer() -> DeviceKind {
    DeviceKind::PersonalComputer
}
fn default_sinkhole_ttl() -> u32 {
    60
}
fn default_stale_secs() -> u64 {
    24 * 60 * 60
}
fn default_timezone() -> String {
    "UTC".to_owned()
}
fn default_profiles() -> BTreeMap<String, Vec<RuleSpec>> {
    let mut profiles = BTreeMap::new();
    profiles.insert(
        "restricted".to_owned(),
        vec![RuleSpec {
            id: None,
            effect: Effect::Deny,
            matcher: MatchSpec::Suffix {
                value: "example".to_owned(),
            },
            reason: None,
            schedule: None,
        }],
    );
    profiles
}
fn default_device_profile() -> String {
    "restricted".to_owned()
}

/// Explicit listener settings. The default is a high loopback port shared by
/// UDP and TCP; privileged ports are always rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindConfig {
    #[serde(default = "default_loopback")]
    pub address: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub allow_non_loopback: bool,
}

/// Explicit operator opt-in for a DNS-over-TLS server listener. There is no
/// implicit enablement: a listener exists only when `enabled` is true AND both
/// bounded paths are supplied. The bind is separate from the plaintext UDP/TCP
/// bind (Hickory requires a different port); the same source-IP device mapping
/// and immutable policy apply to decrypted queries. Certificate rotation is
/// deliberately not supported here, so this whole block is transport identity
/// and a reload that changes it is rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DotListenerConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_bind")]
    pub bind: BindConfig,
    pub cert_path: String,
    pub key_path: String,
}

impl Default for BindConfig {
    fn default() -> Self {
        default_bind()
    }
}

impl BindConfig {
    pub fn address(&self) -> IpAddr {
        // Validated in Config::validate before the worker starts.
        IpAddr::from_str(&self.address).expect("validated bind address")
    }

    pub fn configured_addr(&self) -> SocketAddr {
        SocketAddr::new(self.address(), self.port)
    }
}

/// How a denied query is answered. NXDOMAIN is the default: it is a stable,
/// cacheable denial that does not depend on a synthetic address.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum DenyConfig {
    #[default]
    Nxdomain,
    Refused,
    Sinkhole {
        ipv4: Option<String>,
        ipv6: Option<String>,
        #[serde(default = "default_sinkhole_ttl")]
        ttl: u32,
    },
}

impl DenyConfig {
    /// Parsed sinkhole addresses and TTL, after validation.
    pub fn sinkhole(&self) -> Option<(Option<Ipv4Addr>, Option<Ipv6Addr>, u32)> {
        match self {
            Self::Sinkhole { ipv4, ipv6, ttl } => Some((
                ipv4.as_ref()
                    .map(|s| s.parse().expect("validated sinkhole v4")),
                ipv6.as_ref()
                    .map(|s| s.parse().expect("validated sinkhole v6")),
                *ttl,
            )),
            _ => None,
        }
    }
}

/// One authoritative local record. Multiple A/AAAA records for one owner are
/// accumulated into one record set by the catalog builder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecordSpec {
    A {
        name: String,
        ttl: u32,
        addr: String,
    },
    Aaaa {
        name: String,
        ttl: u32,
        addr: String,
    },
    Cname {
        name: String,
        ttl: u32,
        target: String,
    },
}

impl RecordSpec {
    pub fn name(&self) -> &str {
        match self {
            Self::A { name, .. } | Self::Aaaa { name, .. } | Self::Cname { name, .. } => name,
        }
    }
    fn ttl(&self) -> u32 {
        match self {
            Self::A { ttl, .. } | Self::Aaaa { ttl, .. } | Self::Cname { ttl, .. } => *ttl,
        }
    }
}

/// A domain rule. Exact, suffix and `any` matchers are the syntax DNS can
/// enforce today. `id`, `schedule` and an explicit (possibly empty) `reason`
/// let a controller-authored core `Rule` round-trip through this config without
/// being rewritten, so a compiled bundle still equals the whole source policy.
/// There is no external list parser and no category feed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSpec {
    /// When absent, a stable per-profile id is generated for local configs.
    #[serde(default)]
    pub id: Option<String>,
    pub effect: Effect,
    #[serde(rename = "match")]
    pub matcher: MatchSpec,
    /// `None` generates a descriptive reason; `Some("")` is preserved verbatim.
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub schedule: Option<ScheduleSpec>,
}

/// The exact shape of the shared policy's `Schedule`. An invalid timezone is
/// not substituted with a host timezone by the evaluator; it simply makes the
/// window inactive.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleSpec {
    pub weekdays: Vec<u8>,
    pub start_minute: u32,
    pub end_minute: u32,
    pub timezone: String,
}

impl ScheduleSpec {
    fn validate(&self, where_: &str) -> Result<()> {
        if self.weekdays.is_empty() || self.weekdays.len() > 7 {
            bail!("{where_} schedule needs 1..=7 weekdays");
        }
        let mut seen = BTreeSet::new();
        for day in &self.weekdays {
            if *day > 6 || !seen.insert(*day) {
                bail!("{where_} schedule weekdays must be unique 0..=6");
            }
        }
        if self.start_minute > 1440 || self.end_minute > 1440 {
            bail!("{where_} schedule minutes must be 0..=1440");
        }
        if self.timezone.is_empty()
            || self.timezone.len() > MAX_TIMEZONE_LEN
            || self
                .timezone
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
        {
            bail!("{where_} schedule timezone is unbounded or malformed");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MatchSpec {
    Exact {
        value: String,
    },
    Suffix {
        value: String,
    },
    /// Matches every name. Only useful with `Deny` under a deny-by-default
    /// policy; accepted so a core `Any` rule is never silently dropped.
    Any,
}

impl MatchSpec {
    fn value(&self) -> Option<&str> {
        match self {
            Self::Exact { value } | Self::Suffix { value } => Some(value),
            Self::Any => None,
        }
    }
}

/// One verified encrypted upstream. The bootstrap address is a literal IP so
/// no second uncontrolled lookup can redirect the connection; `server_name`
/// is the certificate verification identity (on-wire SNI only for DoH).
/// `ca_pem` is optional bounded PEM material for an explicit local CA.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "scheme", rename_all = "snake_case", deny_unknown_fields)]
pub enum EncryptedUpstreamSpec {
    Dot {
        bootstrap: String,
        #[serde(default)]
        port: Option<u16>,
        server_name: String,
        #[serde(default)]
        ca_pem: Option<String>,
    },
    Doh {
        bootstrap: String,
        #[serde(default)]
        port: Option<u16>,
        server_name: String,
        path: String,
        #[serde(default)]
        ca_pem: Option<String>,
    },
}

impl EncryptedUpstreamSpec {
    pub fn bootstrap(&self) -> &str {
        match self {
            Self::Dot { bootstrap, .. } | Self::Doh { bootstrap, .. } => bootstrap,
        }
    }
    pub fn port(&self) -> u16 {
        match self {
            Self::Dot { port, .. } => port.unwrap_or(853),
            Self::Doh { port, .. } => port.unwrap_or(443),
        }
    }
    pub fn server_name(&self) -> &str {
        match self {
            Self::Dot { server_name, .. } | Self::Doh { server_name, .. } => server_name,
        }
    }
    pub fn ca_pem(&self) -> Option<&str> {
        match self {
            Self::Dot { ca_pem, .. } | Self::Doh { ca_pem, .. } => ca_pem.as_deref(),
        }
    }
    /// Scheme label used in diagnostics (never echoes the bootstrap value).
    pub fn scheme(&self) -> &'static str {
        match self {
            Self::Dot { .. } => "dot",
            Self::Doh { .. } => "doh",
        }
    }
}

/// A device is selected by explicitly configured source IPs or CIDR source
/// ranges. Both are weak association only: they never identify a person or a
/// current session, and no owner or current-user inference is performed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceConfig {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default = "default_personal_computer")]
    pub kind: DeviceKind,
    #[serde(default = "default_true")]
    pub shared: bool,
    pub default_profile: String,
    #[serde(default)]
    pub source_ips: Vec<String>,
    /// Operator-configured CIDR ranges. Kept as validated strings in the one
    /// current config so a bundle round-trip reproduces them exactly.
    #[serde(default)]
    pub source_ranges: Vec<String>,
}

/// Parse one operator CIDR into a canonical, family-checked range. IPv4-mapped
/// IPv6 networks are folded to IPv4 exactly like exact source IPs are, with a
/// 96-bit prefix shift so `::ffff:192.0.2.0/120` is the same range as
/// `192.0.2.0/24`. Native IPv6 and deprecated compatible addresses are never
/// reinterpreted as IPv4; a mapped network whose prefix is shorter than 96
/// spans outside the mapped block and is rejected as a family mismatch.
fn parsed_range(raw: &str) -> Result<IpNet> {
    let (addr, prefix) = raw.split_once('/').ok_or_else(|| {
        anyhow::anyhow!("source range '{raw}' must be an IP CIDR with a prefix length")
    })?;
    let ip = IpAddr::from_str(addr)
        .map_err(|_| anyhow::anyhow!("source range '{raw}' has a non-IP network address"))?;
    let prefix = prefix
        .parse::<u8>()
        .map_err(|_| anyhow::anyhow!("source range '{raw}' has an invalid prefix length"))?;
    let range = match ip {
        IpAddr::V4(v4) => {
            if prefix > 32 {
                bail!("source range '{raw}' has an IPv4 prefix longer than 32");
            }
            IpNet::V4(
                Ipv4Net::new(v4, prefix)
                    .map_err(|_| anyhow::anyhow!("invalid source range '{raw}'"))?,
            )
        }
        IpAddr::V6(v6) => {
            if prefix > 128 {
                bail!("source range '{raw}' has an IPv6 prefix longer than 128");
            }
            if let IpAddr::V4(mapped) = normalize_ip(IpAddr::V6(v6)) {
                if prefix < 96 {
                    bail!("source range '{raw}' maps to IPv4 but its prefix is shorter than 96");
                }
                IpNet::V4(
                    Ipv4Net::new(mapped, prefix - 96)
                        .map_err(|_| anyhow::anyhow!("invalid source range '{raw}'"))?,
                )
            } else {
                IpNet::V6(
                    Ipv6Net::new(v6, prefix)
                        .map_err(|_| anyhow::anyhow!("invalid source range '{raw}'"))?,
                )
            }
        }
    };
    // `ipnet` keeps operator-supplied host bits in its address, so truncate to
    // the network before it is used as a duplicate/conflict key. Matching is
    // unaffected either way (`contains` masks), but the key must be canonical.
    Ok(match range {
        IpNet::V4(net) => IpNet::V4(net.trunc()),
        IpNet::V6(net) => IpNet::V6(net.trunc()),
    })
}

/// Which maintained parser owns an operator-supplied list. Not
/// interchangeable: hosts files carry bare/address-prefixed domains, ABP files
/// carry domain-anchored network rules.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFormatSpec {
    Hosts,
    Abp,
}

/// One bounded local list source. The path is read once at bootstrap/reload;
/// the validated bytes are then persisted in the bundle. `source_url` is
/// attribution metadata only — it is never dereferenced by this worker.
/// `enabled = false` (or removal from `sources`) explicitly drops the list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterSourceSpec {
    pub id: String,
    pub format: ListFormatSpec,
    pub path: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Exact host or suffix (host plus subdomains) in an operator-provided service.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceDomainSpec {
    Exact { value: String },
    Suffix { value: String },
}

/// A typed service definition. It is a domain set, not an app identity, URL or
/// browser category. `source`/`evidence` are optional operator provenance
/// carried as metadata; no popular-service catalog is bundled or fetched.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSpec {
    pub id: String,
    pub label: String,
    pub version: String,
    pub domains: Vec<ServiceDomainSpec>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
}

/// Operator-provided catalog. Empty by default; only IDs in
/// `FilterConfig::selected_services` are compiled and can block.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceCatalogSpec {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub services: Vec<ServiceSpec>,
}

/// One operator-declared public HTTPS list. The URL is only fetched when the
/// worker opt-in enables the subscription runtime; it is never derived from a
/// local path and never guessed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionSourceSpec {
    pub id: String,
    pub url: String,
    pub format: ListFormatSpec,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub interval_secs: Option<u64>,
    #[serde(default)]
    pub max_stale_secs: Option<u64>,
    pub metadata: SourceMetadata,
}

/// Small subscription settings. Cached bytes stay under `cache_path`, never in
/// this config or in the 64 KiB config file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionSettings {
    pub cache_path: String,
    #[serde(default)]
    pub trusted_ca_pem: Option<String>,
    #[serde(default)]
    pub sources: Vec<SubscriptionSourceSpec>,
}

impl SubscriptionSettings {
    /// Validate the small settings with exactly the same bounds used when they
    /// are embedded in a DNS config. No socket is opened here.
    pub fn validate(&self) -> Result<()> {
        FilterConfig {
            subscriptions: Some(self.clone()),
            ..Default::default()
        }
        .validate("subscriptions")
    }
}

/// Explicit provenance of one compiled list, carried with durable material.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceOrigin {
    #[default]
    Local,
    Subscription,
}

/// Small, validated filter *settings*. No bytes and no fetcher live here.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FilterConfig {
    #[serde(default)]
    pub sources: Vec<FilterSourceSpec>,
    #[serde(default)]
    pub catalog: Option<ServiceCatalogSpec>,
    #[serde(default)]
    pub selected_services: Vec<String>,
    #[serde(default)]
    pub subscriptions: Option<SubscriptionSettings>,
}

impl FilterConfig {
    /// Canonical ids of sources that actually contribute. Disabled sources and
    /// removed sources are absent, so removal is explicit and unambiguous.
    pub fn enabled_source_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .sources
            .iter()
            .filter(|source| source.enabled)
            .map(|source| source.id.clone())
            .chain(
                self.subscriptions
                    .iter()
                    .flat_map(|settings| &settings.sources)
                    .filter(|source| source.enabled)
                    .map(|source| source.id.clone()),
            )
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Maintained parser for one enabled source id.
    pub fn source_format(&self, id: &str) -> Option<ListFormatSpec> {
        self.sources
            .iter()
            .find(|source| source.enabled && source.id == id)
            .map(|source| source.format)
            .or_else(|| {
                self.subscriptions
                    .iter()
                    .flat_map(|settings| &settings.sources)
                    .find(|source| source.enabled && source.id == id)
                    .map(|source| source.format)
            })
    }

    /// Explicit local-vs-subscription provenance for one source id.
    pub fn source_origin(&self, id: &str) -> Option<SourceOrigin> {
        if self
            .sources
            .iter()
            .any(|source| source.enabled && source.id == id)
        {
            return Some(SourceOrigin::Local);
        }
        self.subscriptions
            .iter()
            .flat_map(|settings| &settings.sources)
            .any(|source| source.enabled && source.id == id)
            .then_some(SourceOrigin::Subscription)
    }

    /// Canonical selected service ids (sorted, deduplicated).
    pub fn selected_service_ids(&self) -> Vec<String> {
        let mut ids = self.selected_services.clone();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn validate(&self, place: &str) -> Result<()> {
        if self.sources.len() > MAX_FILTER_SOURCES {
            bail!("{place} has more than {MAX_FILTER_SOURCES} sources");
        }
        let mut seen = BTreeSet::new();
        for source in &self.sources {
            check_filter_field(&source.id, "filter source id", place)?;
            if !seen.insert(source.id.clone()) {
                bail!("{place} has a duplicate source id {}", source.id);
            }
            if source.path.is_empty()
                || source.path.len() > MAX_FILTER_PATH_LEN
                || source.path.chars().any(|c| c.is_control())
            {
                bail!(
                    "{place} source {} path is empty, unbounded or malformed",
                    source.id
                );
            }
            if let Some(url) = &source.source_url {
                check_filter_field(url, "filter source_url", place)?;
            }
        }
        if let Some(subscriptions) = &self.subscriptions {
            if subscriptions.cache_path.is_empty()
                || subscriptions.cache_path.len() > MAX_CACHE_PATH_LEN
                || subscriptions.cache_path.chars().any(char::is_control)
            {
                bail!("{place} subscription cache_path is empty, unbounded or malformed");
            }
            if subscriptions.sources.len() > MAX_SUBSCRIPTION_SOURCES {
                bail!("{place} has more than {MAX_SUBSCRIPTION_SOURCES} subscription sources");
            }
            for source in &subscriptions.sources {
                check_filter_field(&source.id, "subscription id", place)?;
                if !seen.insert(source.id.clone()) {
                    bail!(
                        "{place} source id {} is ambiguous across local and subscription sources",
                        source.id
                    );
                }
                if source.url.is_empty()
                    || source.url.len() > MAX_FILTER_PATH_LEN
                    || source.url.chars().any(char::is_control)
                {
                    bail!(
                        "{place} subscription {} url is unbounded or malformed",
                        source.id
                    );
                }
            }
            // Accepted library validation covers HTTPS-only URLs, no
            // userinfo/query/fragment, metadata and interval bounds. It never
            // opens a socket.
            let library_config = SubscriptionConfig {
                sources: subscriptions
                    .sources
                    .iter()
                    .map(|source| SubscriptionSource {
                        id: source.id.clone(),
                        url: source.url.clone(),
                        enabled: source.enabled,
                        interval_secs: source.interval_secs,
                        max_stale_secs: source.max_stale_secs,
                        metadata: source.metadata.clone(),
                    })
                    .collect(),
                limits: SubscriptionLimits::default(),
                query_policy: QueryPolicy::Reject,
            };
            library_config
                .validate()
                .map_err(|error| anyhow::anyhow!("{place}: {error}"))?;
        }
        if self.selected_services.len() > MAX_SELECTED_SERVICES {
            bail!("{place} selects more than {MAX_SELECTED_SERVICES} services");
        }
        let catalog = match &self.catalog {
            Some(catalog) => catalog,
            None if self.selected_services.is_empty() => return Ok(()),
            None => bail!("{place} selects services without a catalog"),
        };
        check_filter_field(&catalog.version, "catalog version", place)?;
        if catalog.services.len() > MAX_SELECTED_SERVICES {
            bail!("{place} catalog has more than {MAX_SELECTED_SERVICES} services");
        }
        let mut service_ids = BTreeSet::new();
        for service in &catalog.services {
            check_filter_field(&service.id, "service id", place)?;
            if !service_ids.insert(service.id.clone()) {
                bail!("{place} has a duplicate service id {}", service.id);
            }
            check_filter_field(&service.label, "service label", place)?;
            check_filter_field(&service.version, "service version", place)?;
            if let Some(value) = &service.source {
                check_filter_field(value, "service source", place)?;
            }
            if let Some(value) = &service.evidence {
                check_filter_field(value, "service evidence", place)?;
            }
            if service.domains.is_empty() || service.domains.len() > MAX_SERVICE_DOMAINS {
                bail!(
                    "{place} service {} has 0 or more than {MAX_SERVICE_DOMAINS} domains",
                    service.id
                );
            }
            for domain in &service.domains {
                let value = match domain {
                    ServiceDomainSpec::Exact { value } | ServiceDomainSpec::Suffix { value } => {
                        value
                    }
                };
                check_filter_field(value, "service domain", place)?;
                if value.contains('*') {
                    bail!("{place} service {} domain contains a wildcard", service.id);
                }
            }
        }
        for id in &self.selected_services {
            check_filter_field(id, "selected service id", place)?;
            if !service_ids.contains(id) {
                bail!("{place} selects unknown service {id}");
            }
        }
        Ok(())
    }
}

fn check_filter_field(value: &str, what: &str, place: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_FILTER_FIELD_LEN || value.chars().any(char::is_control)
    {
        bail!("{place} {what} is empty, unbounded or malformed");
    }
    Ok(())
}

/// Bounded response-cache and answer-shaping settings. Absent in older
/// bundles/configs; the defaults reproduce the previously fixed behaviour.
/// This configures the maintained Hickory resolver cache only. It does NOT
/// configure a DNSSEC validator, EDNS Client Subnet, optimistic stale serving
/// or any local DNS response wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CacheConfig {
    /// Disable the response cache entirely. `max_entries = 0` has the same
    /// effect through the maintained resolver cache.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Cached RESPONSE count bound (not a byte bound). 0 disables the cache.
    #[serde(default = "default_cache_entries")]
    pub max_entries: u64,
    #[serde(default)]
    pub positive_min_ttl_secs: Option<u32>,
    #[serde(default)]
    pub positive_max_ttl_secs: Option<u32>,
    #[serde(default)]
    pub negative_min_ttl_secs: Option<u32>,
    #[serde(default)]
    pub negative_max_ttl_secs: Option<u32>,
    /// Operator-local opt-in to the system hosts file. OFF by default; the
    /// worker never writes a hosts file.
    #[serde(default)]
    pub use_hosts_file: bool,
    /// Strip A/AAAA answer data (including CNAME glue in the additional
    /// section). HTTPS/SVCB IPv6 hints are NOT covered by this setting.
    #[serde(default)]
    pub disable_ipv6: bool,
    /// An answer containing one of these IPs becomes NXDOMAIN.
    #[serde(default)]
    pub bogus_nxdomain_ips: Vec<String>,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_entries: DEFAULT_CACHE_ENTRIES,
            positive_min_ttl_secs: None,
            positive_max_ttl_secs: None,
            negative_min_ttl_secs: None,
            negative_max_ttl_secs: None,
            use_hosts_file: false,
            disable_ipv6: false,
            bogus_nxdomain_ips: Vec::new(),
        }
    }
}

impl CacheConfig {
    /// Effective resolver cache capacity; zero means no cache at all.
    pub fn cache_size(&self) -> u64 {
        if self.enabled {
            self.max_entries
        } else {
            0
        }
    }

    /// Parsed, validated bogus-NXDOMAIN answer addresses.
    pub fn bogus_ips(&self) -> Vec<IpAddr> {
        self.bogus_nxdomain_ips
            .iter()
            .filter_map(|raw| raw.parse::<IpAddr>().ok())
            .collect()
    }

    pub fn validate(&self) -> Result<()> {
        if self.max_entries > MAX_CACHE_ENTRIES {
            bail!("cache.max_entries must be 0..={MAX_CACHE_ENTRIES} (response count, not bytes)");
        }
        for (name, min, max) in [
            (
                "positive TTL",
                self.positive_min_ttl_secs,
                self.positive_max_ttl_secs,
            ),
            (
                "negative TTL",
                self.negative_min_ttl_secs,
                self.negative_max_ttl_secs,
            ),
        ] {
            if min.is_some_and(|ttl| ttl == 0 || ttl > MAX_TTL_SECS)
                || max.is_some_and(|ttl| ttl == 0 || ttl > MAX_TTL_SECS)
            {
                bail!("cache {name} bounds must be 1..={MAX_TTL_SECS} seconds");
            }
            if let (Some(min), Some(max)) = (min, max) {
                if min > max {
                    bail!("cache {name} minimum exceeds its maximum");
                }
            }
        }
        if self.bogus_nxdomain_ips.len() > MAX_BOGUS_NXDOMAIN_IPS {
            bail!("cache.bogus_nxdomain_ips exceeds {MAX_BOGUS_NXDOMAIN_IPS} entries");
        }
        for raw in &self.bogus_nxdomain_ips {
            if raw.len() > MAX_NAME_LEN || raw.parse::<IpAddr>().is_err() {
                bail!("cache.bogus_nxdomain_ips contains an invalid IP literal '{raw}'");
            }
        }
        Ok(())
    }
}

/// YouTube Restricted Mode selection for network-level SafeSearch rewrites.
///
/// Taken from "Control YouTube content available to users"
/// <https://support.google.com/a/answer/6214622>, verified 2026-11-27. This is
/// one current operator setting with three states; there is no schema version
/// or legacy reader. `Off` is the default, so a config that does not mention
/// YouTube keeps every YouTube query on the normal path.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum YouTubeSafeSearch {
    /// No YouTube rewrite. This is the default.
    #[default]
    Off,
    /// CNAME the five documented aliases to `restrictmoderate.youtube.com`.
    Moderate,
    /// CNAME the five documented aliases to `restrict.youtube.com`.
    Strict,
}

/// Global operator opt-in for provider-backed SafeSearch DNS rewrites.
///
/// Nothing is rewritten unless `enabled` is true and the matching provider
/// switch is true. There is no per-client or per-device variant in this
/// contract; one current field is carried in every published snapshot.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SafeSearchConfig {
    /// Master switch. The default (`false`) leaves every query on the normal
    /// catalog/upstream path.
    #[serde(default)]
    pub enabled: bool,
    /// Apply the documented Google Search mapping to
    /// `forcesafesearch.google.com`.
    #[serde(default)]
    pub google: bool,
    /// Apply the documented Bing mapping to `strict.bing.com`.
    #[serde(default)]
    pub bing: bool,
    /// Apply the documented YouTube Restricted Mode mapping to the five exact
    /// aliases. Requires the master switch and a non-`Off` mode; independent
    /// of the Google and Bing switches.
    #[serde(default)]
    pub youtube: YouTubeSafeSearch,
}

/// Complete, validated worker configuration. Deserialized values are kept
/// private to the module's methods after validation so callers cannot bypass
/// validation by mutating a field.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub household_id: String,
    pub policy_revision: u64,
    /// Explicit publication time for a bootstrap/reload policy. When absent,
    /// the worker's clock at bootstrap/reload is used and the resulting value is
    /// persisted in the durable bundle. It is never refreshed on restart.
    #[serde(default)]
    pub policy_published_at: Option<DateTime<Utc>>,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    #[serde(default = "default_stale_secs")]
    pub stale_after_secs: u64,
    /// Bounded event retention, carried verbatim from a controller policy when
    /// one is compiled in. Local configs may omit it for backward compatibility.
    #[serde(default)]
    pub event_retention_secs: Option<u64>,
    #[serde(default)]
    pub bind: BindConfig,
    /// Optional, explicit DoT server listener. Omitted or `enabled = false`
    /// means no encrypted listener is created; nothing enables it implicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dot_listener: Option<DotListenerConfig>,
    #[serde(default)]
    pub deny: DenyConfig,
    #[serde(default)]
    pub upstreams: Vec<String>,
    /// Verified encrypted upstreams, beside (never mixed with) the literal
    /// UDP/TCP `upstreams`.
    #[serde(default)]
    pub encrypted_upstreams: Vec<EncryptedUpstreamSpec>,
    #[serde(default)]
    pub local_zones: BTreeMap<String, Vec<RecordSpec>>,
    /// Exact-owner answer overrides. Unlike `local_zones`, an override does
    /// not make the worker authoritative for an origin: only the configured
    /// owner and query type are answered locally, while every other name keeps
    /// the normal catalog path. An override is applied only after the
    /// household decision has allowed the question.
    #[serde(default)]
    pub rewrites: Vec<RecordSpec>,
    /// Global SafeSearch opt-in. Source-only operator setting; no HTTP,
    /// frontend or per-client delivery exists for it in this contract.
    #[serde(default)]
    pub safe_search: SafeSearchConfig,
    /// Non-overridable deny-only safety rules. Empty for local-only configs.
    #[serde(default)]
    pub baseline: Vec<RuleSpec>,
    #[serde(default = "default_profiles")]
    pub profiles: BTreeMap<String, Vec<RuleSpec>>,
    #[serde(default = "default_device_profile")]
    pub default_device_profile: String,
    #[serde(default)]
    pub devices: Vec<DeviceConfig>,
    /// Bounded filter settings. Absent in older configs; an empty value keeps
    /// the worker exactly as it was before list filtering existed.
    #[serde(default)]
    pub filter: FilterConfig,
    /// Bounded response-cache/answer-shaping settings. Absent in older
    /// bundles; defaults preserve the previous fixed-cache behaviour.
    #[serde(default)]
    pub cache: CacheConfig,
}

impl Config {
    /// Read, size-bound, parse and validate a configuration file. Validation
    /// completes before the caller is allowed to bind any socket.
    pub fn load(path: &Path) -> Result<Self> {
        Self::parse(&read_bounded(path)?)
    }

    /// Parse and validate an in-memory JSON document (used by the binary and
    /// by tests through exactly the same path).
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_CONFIG_BYTES {
            bail!(
                "configuration is {} bytes; limit is {MAX_CONFIG_BYTES}",
                bytes.len()
            );
        }
        let config: Self = serde_json::from_slice(bytes)?;
        config.validate()?;
        Ok(config)
    }

    /// Re-check every bound. Safe to call again after programmatic mutation.
    pub fn validate(&self) -> Result<()> {
        let household = HouseholdId::from_str(&self.household_id)
            .map_err(|_| anyhow::anyhow!("household_id is not a UUID"))?;
        let _ = household;
        if self.policy_revision == 0 {
            bail!("policy_revision must be greater than zero");
        }
        if self
            .policy_published_at
            .is_some_and(|published| published > Utc::now() + chrono::Duration::seconds(60))
        {
            bail!("policy_published_at exceeds the permitted 60-second clock skew");
        }
        if self.timezone.is_empty() || self.timezone.len() > MAX_TIMEZONE_LEN {
            bail!("timezone must be 1..={MAX_TIMEZONE_LEN} characters");
        }
        if !(1..=MAX_STALE_SECS).contains(&self.stale_after_secs) {
            bail!("stale_after_secs must be 1..={MAX_STALE_SECS}");
        }
        self.filter.validate("filter")?;
        self.cache.validate()?;

        // Parse fallibly before any accessor that assumes validation.
        parsed_ip(&self.bind.address, "bind address")?;
        // Classify the canonical address: `::ffff:127.0.0.1` is a loopback
        // bind just like `127.0.0.1`, while native `::1` stays IPv6.
        let bind_ip = normalize_ip(self.bind.address());
        // Port zero asks the OS for an ephemeral (unprivileged) port, which
        // is how the in-process tests bind. An explicitly chosen privileged
        // port is never accepted.
        if self.bind.port != 0 && self.bind.port < 1024 {
            bail!("bind port must be 1024 or higher; privileged ports are not used");
        }
        if !bind_ip.is_loopback() {
            if !self.bind.allow_non_loopback {
                bail!("non-loopback bind requires bind.allow_non_loopback = true");
            }
            if bind_ip.is_unspecified() {
                bail!("an unspecified bind address is never allowed");
            }
            if is_public_address(bind_ip) {
                bail!("a public bind address is never allowed");
            }
        }
        self.validate_dot_listener()?;

        if self.upstreams.len() + self.encrypted_upstreams.len() > MAX_UPSTREAMS {
            bail!("at most {MAX_UPSTREAMS} upstreams are allowed");
        }
        if !self.upstreams.is_empty() && !self.encrypted_upstreams.is_empty() {
            bail!("mixing plaintext and encrypted upstreams is not allowed");
        }
        for spec in &self.encrypted_upstreams {
            let bootstrap = spec.bootstrap();
            if bootstrap.contains("://")
                || bootstrap.contains('@')
                || bootstrap.contains('?')
                || bootstrap.contains('#')
            {
                bail!("encrypted upstream bootstrap must be an IP literal, not a URL");
            }
            let ip = IpAddr::from_str(bootstrap).map_err(|_| {
                anyhow::anyhow!("encrypted upstream bootstrap must be an IP literal")
            })?;
            let port = spec.port();
            if port == 0 {
                bail!("encrypted upstream port must not be zero");
            }
            if self.bind.port != 0
                && forwards_to_self(
                    &SocketAddr::new(normalize_ip(ip), port),
                    &self.bind.configured_addr(),
                )
            {
                bail!("encrypted upstream points back at the listener");
            }
            let name = spec.server_name();
            if name.is_empty()
                || name.len() > MAX_NAME_LEN
                || name.chars().any(|c| c.is_control() || c.is_whitespace())
                || name.contains("://")
                || name.contains('@')
            {
                bail!("encrypted upstream server_name is invalid");
            }
            if let EncryptedUpstreamSpec::Doh { path, .. } = spec {
                if path.is_empty()
                    || path.len() > MAX_DOH_PATH_LEN
                    || !path.starts_with('/')
                    || path.chars().any(|c| c.is_control() || c.is_whitespace())
                    || path.contains('?')
                    || path.contains('#')
                    || path.contains('@')
                {
                    bail!("encrypted upstream DoH path is invalid");
                }
            }
            if let Some(pem) = spec.ca_pem() {
                if pem.len() > MAX_CA_PEM_BYTES || pem.contains('\0') || pem.contains("PRIVATE KEY")
                {
                    bail!("encrypted upstream CA material is invalid or oversized");
                }
            }
        }
        let mut seen_upstreams = BTreeSet::new();
        for raw in &self.upstreams {
            let addr = SocketAddr::from_str(raw)
                .map_err(|_| anyhow::anyhow!("upstream '{raw}' must be an IP:port literal"))?;
            if addr.port() == 0 {
                bail!("upstream port must not be zero");
            }
            let canonical = SocketAddr::new(normalize_ip(addr.ip()), addr.port());
            if !seen_upstreams.insert(canonical) {
                bail!("duplicate upstream {addr}");
            }
            // A configured port lets us reject the self-loop before binding,
            // including the IPv4-mapped/IPv4 direction in either order.
            if self.bind.port != 0 && forwards_to_self(&addr, &self.bind.configured_addr()) {
                bail!("upstream {addr} points back at the listener");
            }
        }

        if self.local_zones.len() > MAX_ZONES {
            bail!("at most {MAX_ZONES} local zones are allowed");
        }
        for (origin, records) in &self.local_zones {
            if origin.len() > MAX_NAME_LEN || !origin.ends_with('.') {
                bail!("zone origin '{origin}' must be a fully qualified name within {MAX_NAME_LEN} characters");
            }
            hickory_server::proto::rr::Name::from_str(origin)
                .map_err(|_| anyhow::anyhow!("invalid zone origin '{origin}'"))?;
            if records.len() > MAX_RECORDS_PER_ZONE {
                bail!("zone {origin} exceeds {MAX_RECORDS_PER_ZONE} records");
            }
            for record in records {
                if record.name().len() > MAX_NAME_LEN {
                    bail!("record name exceeds {MAX_NAME_LEN} characters");
                }
                if !(1..=MAX_TTL_SECS).contains(&record.ttl()) {
                    bail!("record TTL must be 1..={MAX_TTL_SECS}");
                }
                let lower = origin.to_ascii_lowercase();
                let lower_name = record.name().to_ascii_lowercase();
                if lower_name != lower && !lower_name.ends_with(&format!(".{lower}")) {
                    bail!("record {} is outside zone {origin}", record.name());
                }
                hickory_server::proto::rr::Name::from_str(record.name())
                    .map_err(|_| anyhow::anyhow!("invalid record name '{}'", record.name()))?;
                match record {
                    RecordSpec::A { addr, .. } => {
                        Ipv4Addr::from_str(addr)
                            .map_err(|_| anyhow::anyhow!("invalid A address '{addr}'"))?;
                    }
                    RecordSpec::Aaaa { addr, .. } => {
                        Ipv6Addr::from_str(addr)
                            .map_err(|_| anyhow::anyhow!("invalid AAAA address '{addr}'"))?;
                    }
                    RecordSpec::Cname { target, .. } => {
                        if target.len() > MAX_NAME_LEN {
                            bail!("CNAME target exceeds {MAX_NAME_LEN} characters");
                        }
                        hickory_server::proto::rr::Name::from_str(target)
                            .map_err(|_| anyhow::anyhow!("invalid CNAME target '{target}'"))?;
                    }
                }
            }
        }

        if self.rewrites.len() > MAX_REWRITES {
            bail!("at most {MAX_REWRITES} exact rewrites are allowed");
        }
        // One owner is either canonical (CNAME) or carries address data, never
        // both. Duplicate values are rejected so the answer set is deterministic.
        let mut seen_rewrites = BTreeSet::new();
        let mut cname_owners = BTreeSet::new();
        let mut address_owners = BTreeSet::new();
        for record in &self.rewrites {
            validate_rewrite_record(record)?;
            let owner = record.name().to_ascii_lowercase();
            let (kind, value) = match record {
                RecordSpec::A { addr, .. } => ("a", addr.clone()),
                RecordSpec::Aaaa { addr, .. } => ("aaaa", addr.clone()),
                RecordSpec::Cname { target, .. } => ("cname", target.to_ascii_lowercase()),
            };
            if !seen_rewrites.insert((owner.clone(), kind, value)) {
                bail!("duplicate exact rewrite for {owner}");
            }
            if matches!(record, RecordSpec::Cname { .. }) {
                if address_owners.contains(&owner) {
                    bail!("rewrite owner {owner} has both a canonical name and address data");
                }
                cname_owners.insert(owner);
            } else {
                if cname_owners.contains(&owner) {
                    bail!("rewrite owner {owner} has both a canonical name and address data");
                }
                address_owners.insert(owner);
            }
        }

        if let Some(retention) = self.event_retention_secs {
            let max = family_policy::store::MAX_NETWORK_EVENT_RETENTION_SECS;
            if !(1..=max).contains(&retention) {
                bail!("event_retention_secs must be 1..={max}");
            }
        }

        if self.baseline.len() > MAX_RULES_PER_PROFILE {
            bail!("safety baseline exceeds {MAX_RULES_PER_PROFILE} rules");
        }
        let mut seen_ids = BTreeSet::new();
        for rule in &self.baseline {
            validate_rule_spec(rule, true, &mut seen_ids, "baseline")?;
        }

        if self.profiles.is_empty() || self.profiles.len() > MAX_PROFILES {
            bail!("profiles must contain 1..={MAX_PROFILES} entries");
        }
        for (profile, rules) in &self.profiles {
            if profile.is_empty() || profile.len() > MAX_LABEL_LEN {
                bail!("profile name must be 1..={MAX_LABEL_LEN} characters");
            }
            if rules.len() > MAX_RULES_PER_PROFILE {
                bail!("profile {profile} exceeds {MAX_RULES_PER_PROFILE} rules");
            }
            for rule in rules {
                validate_rule_spec(rule, false, &mut seen_ids, profile)?;
            }
        }
        if !self.profiles.contains_key(&self.default_device_profile) {
            bail!(
                "default_device_profile '{}' is not defined",
                self.default_device_profile
            );
        }

        if self.devices.len() > MAX_DEVICES {
            bail!("at most {MAX_DEVICES} devices are allowed");
        }
        let mut device_ids = BTreeSet::new();
        let mut claimed_ips = BTreeSet::new();
        // Canonical range string -> owning device id. Equal-prefix overlaps are
        // necessarily the same canonical network, so rejecting a second owner
        // removes any ambiguous assignment before a query can select it.
        let mut claimed_ranges: BTreeMap<String, String> = BTreeMap::new();
        let mut total_ranges = 0usize;
        for device in &self.devices {
            let id = DeviceId::from_str(&device.id)
                .map_err(|_| anyhow::anyhow!("device id '{}' is not a UUID", device.id))?;
            if !device_ids.insert(id) {
                bail!("duplicate device id {}", device.id);
            }
            if device.source_ips.len() > MAX_SOURCE_IPS_PER_DEVICE {
                bail!(
                    "device {} exceeds {MAX_SOURCE_IPS_PER_DEVICE} source IPs",
                    device.id
                );
            }
            if device.source_ranges.len() > MAX_SOURCE_RANGES_PER_DEVICE {
                bail!(
                    "device {} exceeds {MAX_SOURCE_RANGES_PER_DEVICE} source ranges",
                    device.id
                );
            }
            total_ranges += device.source_ranges.len();
            for raw in &device.source_ranges {
                let range = parsed_range(raw)?;
                if let Some(owner) = claimed_ranges.get(&range.to_string()) {
                    if owner != &device.id {
                        bail!("source range {range} is assigned to more than one device");
                    }
                } else {
                    claimed_ranges.insert(range.to_string(), device.id.clone());
                }
            }
            if let Some(label) = &device.label {
                if label.len() > MAX_LABEL_LEN {
                    bail!("device label exceeds {MAX_LABEL_LEN} characters");
                }
            }
            if !self.profiles.contains_key(&device.default_profile) {
                bail!(
                    "device {} uses undefined profile '{}'",
                    device.id,
                    device.default_profile
                );
            }
            for raw in &device.source_ips {
                let ip = parsed_ip(raw, "source IP")?;
                if !claimed_ips.insert(ip) {
                    bail!("source IP {ip} is assigned to more than one device");
                }
            }
        }
        if total_ranges > MAX_SOURCE_RANGES {
            bail!("at most {MAX_SOURCE_RANGES} source ranges are allowed");
        }

        if let DenyConfig::Sinkhole { ipv4, ipv6, ttl } = &self.deny {
            if ipv4.is_none() && ipv6.is_none() {
                bail!("sinkhole denial needs at least one of ipv4/ipv6");
            }
            if let Some(ip) = ipv4 {
                ip.parse::<Ipv4Addr>()
                    .map_err(|_| anyhow::anyhow!("invalid sinkhole IPv4 '{ip}'"))?;
            }
            if let Some(ip) = ipv6 {
                ip.parse::<Ipv6Addr>()
                    .map_err(|_| anyhow::anyhow!("invalid sinkhole IPv6 '{ip}'"))?;
            }
            if !(1..=MAX_TTL_SECS).contains(ttl) {
                bail!("sinkhole TTL must be 1..={MAX_TTL_SECS}");
            }
        }
        Ok(())
    }

    /// Validate the optional DoT listener block without reading a file or
    /// opening a socket. Public bind, privileged port, path bounds,
    /// distinct-port and self-loop checks all run before any listener exists.
    fn validate_dot_listener(&self) -> Result<()> {
        let Some(dot) = &self.dot_listener else {
            return Ok(());
        };
        for (value, label) in [
            (&dot.cert_path, "DoT cert_path"),
            (&dot.key_path, "DoT key_path"),
        ] {
            if value.is_empty()
                || value.len() > MAX_TLS_PATH_LEN
                || value.chars().any(char::is_control)
            {
                bail!("{label} is empty, unbounded or malformed");
            }
        }
        // A present but disabled block stays inert: no certificate is read and
        // no socket is bound. Enabling is an explicit operator decision.
        if !dot.enabled {
            return Ok(());
        }
        let ip = parsed_ip(&dot.bind.address, "DoT listener address")?;
        let canonical = normalize_ip(ip);
        if dot.bind.port != 0 && dot.bind.port < 1024 {
            bail!("DoT listener port must be 1024 or higher; privileged ports are not used");
        }
        if !canonical.is_loopback() {
            if !dot.bind.allow_non_loopback {
                bail!("non-loopback DoT listener requires dot_listener.bind.allow_non_loopback = true");
            }
            if canonical.is_unspecified() {
                bail!("an unspecified DoT listener address is never allowed");
            }
            if is_public_address(canonical) {
                bail!("a public DoT listener address is never allowed");
            }
        }
        let dot_addr = SocketAddr::new(canonical, dot.bind.port);
        let plain_addr = SocketAddr::new(normalize_ip(self.bind.address()), self.bind.port);
        if dot.bind.port != 0 && dot_addr == plain_addr {
            bail!("DoT listener must use a different port from the plaintext listener");
        }
        // Upstreams may not point back at the encrypted listener either. A
        // zero port defers this to the post-bind guard in `server::serve`.
        if dot.bind.port != 0 {
            for raw in &self.upstreams {
                let addr = SocketAddr::from_str(raw)
                    .map_err(|_| anyhow::anyhow!("upstream '{raw}' must be an IP:port literal"))?;
                if forwards_to_self(&addr, &dot_addr) {
                    bail!("upstream {addr} points back at the DoT listener");
                }
            }
            for spec in &self.encrypted_upstreams {
                let bootstrap = IpAddr::from_str(spec.bootstrap())
                    .map_err(|_| anyhow::anyhow!("encrypted bootstrap is not an IP literal"))?;
                let candidate = SocketAddr::new(normalize_ip(bootstrap), spec.port());
                if forwards_to_self(&candidate, &dot_addr) {
                    bail!(
                        "{} encrypted upstream points back at the DoT listener",
                        spec.scheme()
                    );
                }
            }
        }
        Ok(())
    }

    /// Build the accepted policy value consumed by the policy evaluator.
    /// There are no sessions, assignments, exceptions or person rules here:
    /// DNS never sees a verified identity, so no untrusted field can select a
    /// person-specific profile.
    pub fn policy(&self, now: DateTime<Utc>) -> Policy {
        self.policy_at(now)
    }

    /// Build the policy with an explicit publication time. Durable bundles call
    /// this with the persisted original timestamp so a restart cannot make an
    /// old policy look freshly published.
    pub fn policy_at(&self, published_at: DateTime<Utc>) -> Policy {
        let baseline = self
            .baseline
            .iter()
            .enumerate()
            .map(|(index, rule)| build_rule(rule, "baseline", index))
            .collect();
        let mut device_profiles = BTreeMap::new();
        for (profile, rules) in &self.profiles {
            let built = rules
                .iter()
                .enumerate()
                .map(|(index, rule)| build_rule(rule, profile, index))
                .collect();
            device_profiles.insert(profile.clone(), built);
        }
        Policy {
            household_id: HouseholdId::from_str(&self.household_id)
                .expect("household_id validated"),
            revision: self.policy_revision,
            baseline,
            device_profiles,
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            // Defaults fail closed; only explicit device/profile allow rules
            // can open a name up.
            default_effect: Effect::Deny,
            timezone: self.timezone.clone(),
            stale_after_secs: self.stale_after_secs,
            event_retention_secs: self.event_retention_secs.unwrap_or(EVENT_RETENTION_SECS),
            published_at,
        }
    }

    /// Build the device value for one validated device entry. Both the exact
    /// and the range path use the same construction, so `shared`, kind and
    /// profile behave identically however the source was matched.
    fn device_value(&self, configured: &DeviceConfig) -> Device {
        Device {
            id: DeviceId::from_str(&configured.id).expect("device id validated"),
            household_id: HouseholdId::from_str(&self.household_id)
                .expect("household id validated"),
            label: configured
                .label
                .clone()
                .unwrap_or_else(|| configured.id.clone()),
            kind: configured.kind.clone(),
            shared: configured.shared,
            default_profile: configured.default_profile.clone(),
            capabilities: [Capability::DomainFiltering].into_iter().collect(),
        }
    }

    /// Resolve a source IP to a configured device. Exact IPs are checked
    /// first; otherwise the most specific matching CIDR wins. Unknown sources
    /// get an explicitly restrictive default device; no owner or current-user
    /// inference is performed anywhere in this path.
    pub fn device_for(&self, source: IpAddr) -> (Option<DeviceId>, Device) {
        let source = normalize_ip(source);
        // Exact mapping is authoritative even when a narrower range would
        // select another device.
        for configured in &self.devices {
            for raw in &configured.source_ips {
                if parsed_ip(raw, "source IP").ok() == Some(source) {
                    let device = self.device_value(configured);
                    return (Some(device.id), device);
                }
            }
        }
        // Longest-prefix CIDR match. Validation rejects equal-prefix ranges
        // owned by different devices, so a tie can only repeat the same device.
        let mut best: Option<(&DeviceConfig, u8)> = None;
        for configured in &self.devices {
            for raw in &configured.source_ranges {
                let Some(range) = parsed_range(raw).ok() else {
                    continue;
                };
                if !range.contains(&source) {
                    continue;
                }
                let prefix = range.prefix_len();
                if best.is_none_or(|(_, best_prefix)| prefix > best_prefix) {
                    best = Some((configured, prefix));
                }
            }
        }
        if let Some((configured, _)) = best {
            let device = self.device_value(configured);
            return (Some(device.id), device);
        }
        (
            None,
            Device {
                id: DeviceId::nil(),
                household_id: HouseholdId::from_str(&self.household_id)
                    .expect("household id validated"),
                label: "Unrecognized client".to_owned(),
                kind: DeviceKind::Iot,
                // An unrecognized source is not known to be a shared device;
                // claiming `SharedDevice` would overstate what we observed.
                shared: false,
                default_profile: self.default_device_profile.clone(),
                capabilities: [Capability::DomainFiltering].into_iter().collect(),
            },
        )
    }

    pub fn upstreams(&self) -> Vec<SocketAddr> {
        self.upstreams
            .iter()
            .map(|raw| {
                let addr = SocketAddr::from_str(raw).expect("upstream validated");
                SocketAddr::new(normalize_ip(addr.ip()), addr.port())
            })
            .collect()
    }
}

/// Read a configuration file with the same fixed 64 KiB bound used by
/// [`Config::parse`]. Callers that reload a file use this directly so an
/// oversized file is rejected before it is ever parsed or applied.
pub fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    // Bound the allocation itself: read at most one byte over the limit,
    // then reject without ever holding the whole oversized file.
    let mut bytes = Vec::new();
    let read = file
        .take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if read > MAX_CONFIG_BYTES {
        bail!("configuration exceeds {MAX_CONFIG_BYTES} bytes");
    }
    Ok(bytes)
}

/// Conservative public-address check that does not depend on unstable
/// standard-library IP helpers: private, loopback, link-local and unspecified
/// ranges are the only addresses a private lab container may bind.
fn is_public_address(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            !(a == 127
                || a == 10
                || a == 0
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 169 && b == 254)
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(v6) => {
            // No implicit `to_ipv4()` here: only explicitly mapped addresses
            // were canonicalised above. Deprecated compatible addresses are
            // treated as ordinary IPv6 and are not allowed as private binds.
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (first & 0xffc0) == 0xfe80) // link-local fe80::/10
        }
    }
}

/// Self-loop guard after canonicalising IPv4-mapped addresses. IPv4 loopback
/// aliases share one namespace; native IPv6 addresses (including `::1`) are
/// compared exactly and never conflated with IPv4.
pub fn forwards_to_self(upstream: &SocketAddr, bound: &SocketAddr) -> bool {
    if upstream.port() != bound.port() {
        return false;
    }
    match (normalize_ip(upstream.ip()), normalize_ip(bound.ip())) {
        (IpAddr::V4(up), IpAddr::V4(local)) => {
            up == local || (up.is_loopback() && local.is_loopback())
        }
        (IpAddr::V6(up), IpAddr::V6(local)) => up == local,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 4,
        "bind": { "address": "127.0.0.1", "port": 15353 },
        "upstreams": ["127.0.0.1:5353"],
        "local_zones": { "lab.example.": [
            { "type": "a", "name": "www.lab.example.", "ttl": 60, "addr": "192.0.2.10" }
        ]},
        "profiles": { "restricted": [
            { "effect": "deny", "match": { "type": "suffix", "value": "blocked.example" }, "reason": "blocked" }
        ]},
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "restricted",
            "source_ips": ["127.0.0.2"]
        }]
    }"#;

    #[test]
    fn valid_config_parses_and_builds_a_fail_closed_policy() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        assert_eq!(config.policy_revision, 4);
        let policy = config.policy(Utc::now());
        assert_eq!(policy.revision, 4);
        assert_eq!(policy.default_effect, Effect::Deny);
        assert!(policy.person_rules.is_empty());
        assert!(policy.exceptions.is_empty());
        let (id, device) = config.device_for("127.0.0.2".parse().unwrap());
        assert_eq!(
            id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(device.default_profile, "restricted");
        let (unknown_id, unknown) = config.device_for("10.9.8.7".parse().unwrap());
        assert!(unknown_id.is_none());
        assert_eq!(unknown.default_profile, "restricted");
        assert!(
            !unknown.shared,
            "unrecognized sources are not claimed as shared"
        );
    }

    #[test]
    fn rejects_oversize_unknown_and_self_looping_config() {
        let over = format!("{{\"household_id\": \"{}\"}}", "x".repeat(MAX_CONFIG_BYTES));
        assert!(Config::parse(over.as_bytes()).is_err());
        assert!(Config::parse(
            br#"{"household_id":"11111111-2222-3333-4444-555555555555","policy_revision":1,"bogus":true}"#
        )
        .is_err());
        let invalid_bind =
            VALID.replace("\"address\": \"127.0.0.1\"", "\"address\": \"not-an-ip\"");
        assert!(Config::parse(invalid_bind.as_bytes()).is_err());
        let self_loop = VALID.replace("127.0.0.1:5353", "127.0.0.1:15353");
        assert!(Config::parse(self_loop.as_bytes()).is_err());
        let alias_loop = VALID.replace("127.0.0.1:5353", "127.0.0.2:15353");
        assert!(Config::parse(alias_loop.as_bytes()).is_err());
    }

    #[test]
    fn non_loopback_bind_requires_explicit_opt_in_and_stays_private() {
        let with_loopback =
            VALID.replace("\"address\": \"127.0.0.1\"", "\"address\": \"10.0.0.5\"");
        assert!(Config::parse(with_loopback.as_bytes()).is_err());
        let opted_in = with_loopback.replace(
            "\"port\": 15353",
            "\"port\": 15353, \"allow_non_loopback\": true",
        );
        assert!(Config::parse(opted_in.as_bytes()).is_ok());
        let public = VALID
            .replace("\"address\": \"127.0.0.1\"", "\"address\": \"8.8.8.8\"")
            .replace(
                "\"port\": 15353",
                "\"port\": 15353, \"allow_non_loopback\": true",
            );
        assert!(Config::parse(public.as_bytes()).is_err());
        let privileged = VALID.replace("\"port\": 15353", "\"port\": 53");
        assert!(Config::parse(privileged.as_bytes()).is_err());
    }

    #[test]
    fn mapped_ipv4_selfloop_is_rejected_in_both_directions() {
        let mapped_bind = VALID
            .replace(
                "\"address\": \"127.0.0.1\"",
                "\"address\": \"::ffff:127.0.0.1\"",
            )
            .replace("127.0.0.1:5353", "127.0.0.1:15353");
        assert!(
            Config::parse(mapped_bind.as_bytes()).is_err(),
            "mapped bind + IPv4 upstream on the same port is a self-loop"
        );
        let mapped_upstream = VALID.replace("127.0.0.1:5353", "[::ffff:127.0.0.1]:15353");
        assert!(
            Config::parse(mapped_upstream.as_bytes()).is_err(),
            "IPv4 bind + mapped upstream on the same port is a self-loop"
        );
        // A mapped loopback bind needs no non-loopback opt-in.
        let mapped_ok = VALID.replace(
            "\"address\": \"127.0.0.1\"",
            "\"address\": \"::ffff:127.0.0.1\"",
        );
        assert!(Config::parse(mapped_ok.as_bytes()).is_ok());
    }

    #[test]
    fn mapped_source_selects_the_configured_ipv4_device() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        let (id, device) = config.device_for("::ffff:127.0.0.2".parse().unwrap());
        assert_eq!(
            id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(device.default_profile, "restricted");
        // The two spellings are one address for duplicate-detection too.
        let duplicate = VALID.replace(
            "\"source_ips\": [\"127.0.0.2\"]",
            "\"source_ips\": [\"127.0.0.2\", \"::ffff:127.0.0.2\"]",
        );
        assert!(Config::parse(duplicate.as_bytes()).is_err());
        assert!(matches!(
            normalize_ip("::1".parse().unwrap()),
            IpAddr::V6(_)
        ));
        assert!(matches!(
            normalize_ip("::127.0.0.1".parse().unwrap()),
            IpAddr::V6(_)
        ));
    }

    fn range_config(devices: &str) -> String {
        format!(
            r#"{{
            "household_id": "11111111-2222-3333-4444-555555555555",
            "policy_revision": 4,
            "bind": {{ "address": "127.0.0.1", "port": 15353 }},
            "upstreams": ["127.0.0.1:5353"],
            "profiles": {{ "restricted": [], "adult": [] }},
            "default_device_profile": "restricted",
            "devices": {devices}
        }}"#
        )
    }

    const RANGE_DEVICES: &str = r#"[
        {"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","default_profile":"adult","shared":false,"source_ips":["127.0.0.20"],"source_ranges":["127.0.0.0/24"]},
        {"id":"bbbbbbbb-cccc-dddd-eeee-ffffffffffff","default_profile":"restricted","source_ranges":["127.0.0.16/28"]}
    ]"#;

    #[test]
    fn source_ranges_use_exact_priority_then_longest_prefix() {
        let config = Config::parse(range_config(RANGE_DEVICES).as_bytes()).unwrap();

        // The /28 is more specific than the /24, but the exact IP on the
        // broader device wins outright.
        let (exact_id, exact) = config.device_for("127.0.0.20".parse().unwrap());
        assert_eq!(
            exact_id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(exact.default_profile, "adult");
        assert!(!exact.shared, "shared must survive the exact path");

        let (specific_id, specific) = config.device_for("127.0.0.21".parse().unwrap());
        assert_eq!(
            specific_id.unwrap().to_string(),
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        );
        assert_eq!(specific.default_profile, "restricted");

        let (broad_id, broad) = config.device_for("127.0.0.40".parse().unwrap());
        assert_eq!(
            broad_id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(broad.default_profile, "adult");
        assert!(!broad.shared, "shared must survive the range path");

        // Mapped sources are canonicalised exactly as exact IPs already are.
        let (mapped_id, mapped) = config.device_for("::ffff:127.0.0.21".parse().unwrap());
        assert_eq!(
            mapped_id.unwrap().to_string(),
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        );
        assert_eq!(mapped.default_profile, "restricted");

        // Outside every range: the restrictive unknown default, never a
        // person inference and never a claim that an unknown client is shared.
        let (unknown_id, unknown) = config.device_for("127.0.1.21".parse().unwrap());
        assert!(unknown_id.is_none());
        assert_eq!(unknown.default_profile, "restricted");
        assert!(!unknown.shared);
    }

    #[test]
    fn mapped_range_is_the_same_range_as_its_ipv4_form() {
        let devices = RANGE_DEVICES.replace("\"127.0.0.0/24\"", "\"::ffff:127.0.0.0/120\"");
        let config = Config::parse(range_config(&devices).as_bytes()).unwrap();
        let (id, _) = config.device_for("127.0.0.40".parse().unwrap());
        assert_eq!(
            id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
    }

    #[test]
    fn native_ipv6_ranges_are_not_folded_to_ipv4() {
        let devices = r#"[{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","default_profile":"adult","source_ranges":["2001:db8::/32"]}]"#;
        let config = Config::parse(range_config(devices).as_bytes()).unwrap();
        let (id, _) = config.device_for("2001:db8::5".parse().unwrap());
        assert_eq!(
            id.unwrap().to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        // Deprecated compatible addresses stay native IPv6, as with exact IPs.
        let (unknown_id, _) = config.device_for("::127.0.0.5".parse().unwrap());
        assert!(unknown_id.is_none());
        let (ipv4_id, _) = config.device_for("127.0.0.5".parse().unwrap());
        assert!(ipv4_id.is_none());
    }

    #[test]
    fn invalid_and_conflicting_source_ranges_are_rejected() {
        for bad in [
            "\"127.0.0.0\"",
            "\"127.0.0.0/33\"",
            "\"2001:db8::/129\"",
            "\"::ffff:192.0.2.0/64\"",
            "\"not-a-network/24\"",
        ] {
            let devices = RANGE_DEVICES.replace("\"127.0.0.0/24\"", bad);
            assert!(
                Config::parse(range_config(&devices).as_bytes()).is_err(),
                "expected rejection for {bad}"
            );
        }

        // Two devices claiming the same canonical range, whether spelled as
        // IPv4 or as IPv4-mapped IPv6, is an ambiguous equal-prefix conflict.
        let equal = RANGE_DEVICES.replace(
            "\"source_ranges\":[\"127.0.0.16/28\"]",
            "\"source_ranges\":[\"127.0.0.16/28\",\"127.0.0.0/24\"]",
        );
        assert!(Config::parse(range_config(&equal).as_bytes()).is_err());
        let mapped_equal = RANGE_DEVICES.replace(
            "\"source_ranges\":[\"127.0.0.16/28\"]",
            "\"source_ranges\":[\"::ffff:127.0.0.0/120\"]",
        );
        assert!(Config::parse(range_config(&mapped_equal).as_bytes()).is_err());
        // Host bits are truncated before the key is compared, so a sloppy
        // spelling cannot slip past the same canonical range.
        let host_bits = RANGE_DEVICES.replace(
            "\"source_ranges\":[\"127.0.0.16/28\"]",
            "\"source_ranges\":[\"127.0.0.5/24\"]",
        );
        assert!(Config::parse(range_config(&host_bits).as_bytes()).is_err());

        let too_many: Vec<String> = (0..MAX_SOURCE_RANGES_PER_DEVICE + 1)
            .map(|i| format!("\"10.0.{i}.0/24\""))
            .collect();
        let per_device = format!(
            r#"[{{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","default_profile":"adult","source_ranges":[{}]}}]"#,
            too_many.join(",")
        );
        assert!(Config::parse(range_config(&per_device).as_bytes()).is_err());

        // The whole-config cap is independent of the per-device cap.
        let mut many_devices = String::from("[");
        for device in 0..(MAX_SOURCE_RANGES / MAX_SOURCE_RANGES_PER_DEVICE + 1) {
            if device > 0 {
                many_devices.push(',');
            }
            let ranges: Vec<String> = (0..MAX_SOURCE_RANGES_PER_DEVICE)
                .map(|range| format!("\"10.{device}.{range}.0/24\""))
                .collect();
            many_devices.push_str(&format!(
                r#"{{"id":"{device:08x}-0000-4000-8000-000000000000","default_profile":"restricted","source_ranges":[{}]}}"#,
                ranges.join(",")
            ));
        }
        many_devices.push(']');
        assert!(Config::parse(range_config(&many_devices).as_bytes()).is_err());
    }

    #[test]
    fn source_ranges_survive_a_config_round_trip_and_revalidation() {
        let config = Config::parse(range_config(RANGE_DEVICES).as_bytes()).unwrap();
        let bytes = serde_json::to_vec(&config).unwrap();
        let reloaded = Config::parse(&bytes).unwrap();
        assert_eq!(reloaded.devices, config.devices);
        let (id, device) = reloaded.device_for("::ffff:127.0.0.21".parse().unwrap());
        assert_eq!(
            id.unwrap().to_string(),
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        );
        assert_eq!(device.default_profile, "restricted");
    }

    #[test]
    fn native_ipv6_loopback_is_not_conflated_with_ipv4() {
        let v6_bind = VALID
            .replace("\"address\": \"127.0.0.1\"", "\"address\": \"::1\"")
            .replace("127.0.0.1:5353", "127.0.0.1:15353");
        assert!(
            Config::parse(v6_bind.as_bytes()).is_ok(),
            "native ::1 and 127.0.0.1 are distinct sockets at the same port"
        );
        let v6_self_loop = v6_bind.replace("127.0.0.1:15353", "[::1]:15353");
        assert!(Config::parse(v6_self_loop.as_bytes()).is_err());
    }

    #[test]
    fn oversized_file_is_rejected_before_parsing_or_binding() {
        let path =
            std::env::temp_dir().join(format!("vantyr-dns-oversize-{}.json", std::process::id()));
        std::fs::write(&path, vec![b'x'; MAX_CONFIG_BYTES + 1]).unwrap();
        assert!(Config::load(&path).is_err());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn filter_settings_are_bounded_and_selected_ids_must_exist() {
        let base = VALID.to_owned();
        let with_filter = base.replace(
            "\"household_id\":",
            r#""filter": {
              "sources": [{"id":"hosts","format":"hosts","path":"/tmp/hosts.txt"}],
              "catalog": {"version":"v1","services":[{"id":"video","label":"Video","version":"1","domains":[{"type":"exact","value":"video.example"}]}]},
              "selected_services": ["video"]
            },
            "household_id":"#,
        );
        let config = Config::parse(with_filter.as_bytes()).unwrap();
        assert_eq!(config.filter.enabled_source_ids(), vec!["hosts".to_owned()]);
        assert_eq!(
            config.filter.selected_service_ids(),
            vec!["video".to_owned()]
        );

        let unknown = with_filter.replace(
            "\"selected_services\": [\"video\"]",
            "\"selected_services\": [\"absent\"]",
        );
        assert!(Config::parse(unknown.as_bytes()).is_err());
        let duplicate = with_filter.replace(
            "\"sources\": [{\"id\":\"hosts\",\"format\":\"hosts\",\"path\":\"/tmp/hosts.txt\"}]",
            "\"sources\": [{\"id\":\"hosts\",\"format\":\"hosts\",\"path\":\"/tmp/hosts.txt\"},{\"id\":\"hosts\",\"format\":\"abp\",\"path\":\"/tmp/ads.txt\"}]",
        );
        assert!(Config::parse(duplicate.as_bytes()).is_err());
        let unbounded = with_filter.replace(
            "\"id\":\"hosts\"",
            &format!("\"id\":\"{}\"", "x".repeat(MAX_FILTER_FIELD_LEN + 1)),
        );
        assert!(Config::parse(unbounded.as_bytes()).is_err());
    }

    #[test]
    fn disabled_sources_are_not_effective() {
        let with_filter = VALID.replace(
            "\"household_id\":",
            r#""filter": {"sources":[{"id":"off","format":"hosts","path":"/tmp/hosts.txt","enabled":false}]},
            "household_id":"#,
        );
        let config = Config::parse(with_filter.as_bytes()).unwrap();
        assert!(config.filter.enabled_source_ids().is_empty());
    }

    fn with_rewrites(rewrites: &str) -> String {
        VALID.replace(
            "\"household_id\":",
            &format!("\"rewrites\": {rewrites},\n        \"household_id\":"),
        )
    }

    #[test]
    fn exact_rewrites_default_empty_and_survive_a_config_round_trip() {
        let plain = Config::parse(VALID.as_bytes()).unwrap();
        assert!(plain.rewrites.is_empty());

        let json = with_rewrites(
            r#"[
            {"type":"a","name":"one.example.","ttl":45,"addr":"192.0.2.40"},
            {"type":"a","name":"one.example.","ttl":45,"addr":"192.0.2.41"},
            {"type":"aaaa","name":"one.example.","ttl":45,"addr":"2001:db8::40"},
            {"type":"cname","name":"alias.example.","ttl":30,"target":"one.example."}
        ]"#,
        );
        let config = Config::parse(json.as_bytes()).unwrap();
        assert_eq!(config.rewrites.len(), 4);
        let bytes = serde_json::to_vec(&config).unwrap();
        let again = Config::parse(&bytes).unwrap();
        assert_eq!(again.rewrites, config.rewrites);
        assert_eq!(serde_json::to_vec(&again).unwrap(), bytes);
    }

    #[test]
    fn exact_rewrites_validate_ttl_names_values_and_canonical_shape() {
        let good = r#"[{"type":"a","name":"one.example.","ttl":1,"addr":"192.0.2.40"}]"#;
        assert!(Config::parse(with_rewrites(good).as_bytes()).is_ok());
        let good_max = good.replace("\"ttl\":1", &format!("\"ttl\":{MAX_TTL_SECS}"));
        assert!(Config::parse(with_rewrites(&good_max).as_bytes()).is_ok());

        let bads: &[&str] = &[
            r#"[{"type":"a","name":"one.example.","ttl":0,"addr":"192.0.2.40"}]"#,
            &format!(
                r#"[{{"type":"a","name":"one.example.","ttl":{},"addr":"192.0.2.40"}}]"#,
                MAX_TTL_SECS + 1
            ),
            r#"[{"type":"a","name":"one.example","ttl":60,"addr":"192.0.2.40"}]"#,
            r#"[{"type":"a","name":"one.example.","ttl":60,"addr":"not-an-ip"}]"#,
            r#"[{"type":"aaaa","name":"one.example.","ttl":60,"addr":"192.0.2.40"}]"#,
            r#"[{"type":"cname","name":"alias.example.","ttl":60,"target":"relative"}]"#,
            r#"[{"type":"cname","name":"alias.example.","ttl":60,"target":"one.example"}]"#,
            r#"[{"type":"cname","name":"alias.example.","ttl":60,"target":"one.example."},{"type":"a","name":"alias.example.","ttl":60,"addr":"192.0.2.40"}]"#,
            r#"[{"type":"a","name":"one.example.","ttl":60,"addr":"192.0.2.40"},{"type":"a","name":"ONE.EXAMPLE.","ttl":60,"addr":"192.0.2.40"}]"#,
        ];
        for bad in bads {
            assert!(
                Config::parse(with_rewrites(bad).as_bytes()).is_err(),
                "invalid rewrite accepted: {bad}"
            );
        }

        let many = format!(
            "[{}]",
            (0..=MAX_REWRITES)
                .map(|i| format!(
                    r#"{{"type":"a","name":"n{i}.example.","ttl":60,"addr":"192.0.2.40"}}"#
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(Config::parse(with_rewrites(&many).as_bytes()).is_err());
    }

    fn with_safe_search(value: &str) -> String {
        VALID.replace(
            "\"household_id\":",
            &format!("\"safe_search\": {value},\n        \"household_id\":"),
        )
    }

    #[test]
    fn safe_search_defaults_off_and_survives_a_config_round_trip() {
        let plain = Config::parse(VALID.as_bytes()).unwrap();
        assert_eq!(
            plain.safe_search,
            SafeSearchConfig {
                enabled: false,
                google: false,
                bing: false,
                youtube: YouTubeSafeSearch::Off,
            }
        );

        let json =
            with_safe_search(r#"{"enabled":true,"google":true,"bing":false,"youtube":"strict"}"#);
        let config = Config::parse(json.as_bytes()).unwrap();
        assert!(config.safe_search.enabled);
        assert!(config.safe_search.google);
        assert!(!config.safe_search.bing);
        assert_eq!(config.safe_search.youtube, YouTubeSafeSearch::Strict);
        let bytes = serde_json::to_vec(&config).unwrap();
        let again = Config::parse(&bytes).unwrap();
        assert_eq!(again.safe_search, config.safe_search);
        assert_eq!(serde_json::to_vec(&again).unwrap(), bytes);
    }

    #[test]
    fn safe_search_rejects_unknown_fields_and_non_boolean_switches() {
        for bad in [
            r#"{"enabled":true,"nope":true}"#,
            r#"{"enabled":"yes"}"#,
            r#"{"google":1}"#,
            r#"{"youtube":"bogus"}"#,
            r#"{"youtube":true}"#,
            r#"{"youtube":"strict","nope":1}"#,
        ] {
            assert!(
                Config::parse(with_safe_search(bad).as_bytes()).is_err(),
                "invalid safe_search accepted: {bad}"
            );
        }
    }
}
