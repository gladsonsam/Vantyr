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
};
use serde::{Deserialize, Serialize};

/// Hard cap on the configuration file itself (bytes).
pub const MAX_CONFIG_BYTES: usize = 64 * 1024;
pub const MAX_UPSTREAMS: usize = 8;
pub const MAX_ZONES: usize = 32;
pub const MAX_RECORDS_PER_ZONE: usize = 512;
pub const MAX_DEVICES: usize = 256;
pub const MAX_SOURCE_IPS_PER_DEVICE: usize = 16;
pub const MAX_PROFILES: usize = 64;
pub const MAX_RULES_PER_PROFILE: usize = 512;
pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_NAME_LEN: usize = 255;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_TIMEZONE_LEN: usize = 64;
pub const MAX_TTL_SECS: u32 = 86_400;
pub const MAX_STALE_SECS: u64 = 30 * 24 * 60 * 60;
pub const DEFAULT_PORT: u16 = 15_353;
pub const HEARTBEAT_TTL_SECS: u64 = 90;
const EVENT_RETENTION_SECS: u64 = 24 * 60 * 60;

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
            effect: Effect::Deny,
            matcher: MatchSpec::Suffix {
                value: "example".to_owned(),
            },
            reason: None,
        }],
    );
    profiles
}
fn default_device_profile() -> String {
    "restricted".to_owned()
}

/// Explicit listener settings. The default is a high loopback port shared by
/// UDP and TCP; privileged ports are always rejected.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindConfig {
    #[serde(default = "default_loopback")]
    pub address: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub allow_non_loopback: bool,
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
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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
#[derive(Clone, Debug, Deserialize, Serialize)]
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

/// A domain rule. Exact and suffix matchers are the only syntax in this slice:
/// there is no external list parser and no category feed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSpec {
    pub effect: Effect,
    #[serde(rename = "match")]
    pub matcher: MatchSpec,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum MatchSpec {
    Exact { value: String },
    Suffix { value: String },
}

impl MatchSpec {
    fn value(&self) -> &str {
        match self {
            Self::Exact { value } | Self::Suffix { value } => value,
        }
    }
}

/// A device is selected by an explicitly configured source IP. IPs are weak
/// association only: they never identify a person or a current session.
#[derive(Clone, Debug, Deserialize, Serialize)]
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
    #[serde(default)]
    pub bind: BindConfig,
    #[serde(default)]
    pub deny: DenyConfig,
    #[serde(default)]
    pub upstreams: Vec<String>,
    #[serde(default)]
    pub local_zones: BTreeMap<String, Vec<RecordSpec>>,
    #[serde(default = "default_profiles")]
    pub profiles: BTreeMap<String, Vec<RuleSpec>>,
    #[serde(default = "default_device_profile")]
    pub default_device_profile: String,
    #[serde(default)]
    pub devices: Vec<DeviceConfig>,
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
        if self.timezone.is_empty() || self.timezone.len() > MAX_TIMEZONE_LEN {
            bail!("timezone must be 1..={MAX_TIMEZONE_LEN} characters");
        }
        if !(1..=MAX_STALE_SECS).contains(&self.stale_after_secs) {
            bail!("stale_after_secs must be 1..={MAX_STALE_SECS}");
        }

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

        if self.upstreams.len() > MAX_UPSTREAMS {
            bail!("at most {MAX_UPSTREAMS} upstreams are allowed");
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
                let value = rule.matcher.value();
                if value.is_empty() || value.len() > MAX_NAME_LEN {
                    bail!("rule value must be 1..={MAX_NAME_LEN} characters");
                }
                if let Some(reason) = &rule.reason {
                    if reason.len() > MAX_REASON_LEN {
                        bail!("rule reason exceeds {MAX_REASON_LEN} characters");
                    }
                }
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
        let mut device_profiles = BTreeMap::new();
        for (profile, rules) in &self.profiles {
            let built = rules
                .iter()
                .enumerate()
                .map(|(index, rule)| {
                    let matcher = match &rule.matcher {
                        MatchSpec::Exact { value } => {
                            RuleMatcher::HostExact(value.to_ascii_lowercase())
                        }
                        MatchSpec::Suffix { value } => {
                            RuleMatcher::DomainSuffix(value.to_ascii_lowercase())
                        }
                    };
                    Rule {
                        id: format!("{profile}-{index}"),
                        effect: rule.effect,
                        matcher,
                        schedule: None,
                        reason: rule
                            .reason
                            .clone()
                            .unwrap_or_else(|| format!("{profile} rule {index}")),
                    }
                })
                .collect();
            device_profiles.insert(profile.clone(), built);
        }
        Policy {
            household_id: HouseholdId::from_str(&self.household_id)
                .expect("household_id validated"),
            revision: self.policy_revision,
            baseline: Vec::new(),
            device_profiles,
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            // Defaults fail closed; only explicit device/profile allow rules
            // can open a name up.
            default_effect: Effect::Deny,
            timezone: self.timezone.clone(),
            stale_after_secs: self.stale_after_secs,
            event_retention_secs: EVENT_RETENTION_SECS,
            published_at,
        }
    }

    /// Resolve a source IP to a configured device. Unknown sources get an
    /// explicitly restrictive default device; no owner or current-user
    /// inference is performed anywhere in this path.
    pub fn device_for(&self, source: IpAddr) -> (Option<DeviceId>, Device) {
        let source = normalize_ip(source);
        for configured in &self.devices {
            for raw in &configured.source_ips {
                if parsed_ip(raw, "source IP").ok() == Some(source) {
                    let device = Device {
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
                    };
                    return (Some(device.id), device);
                }
            }
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
}
