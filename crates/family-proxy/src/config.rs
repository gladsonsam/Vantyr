//! Validated, bounded configuration for the Vantyr Proxy worker.
//!
//! Everything is parsed and fully validated before a socket is bound. There
//! is no host resolver at startup, no privileged bind by default and no way
//! to mutate a validated value from outside this module. Client credentials
//! are static bootstrap material: the file must be private (mode 0600 on
//! Unix), and credentials are linked to a configured device — never inferred
//! from a source address, and never linked to a person by this worker.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::str::FromStr;

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use family_policy::{
    Capability, Device, DeviceId, DeviceKind, Effect, HouseholdId, Policy, Rule, RuleMatcher,
};
use serde::Deserialize;
use uuid::Uuid;

/// Hard cap on the configuration file itself (bytes).
pub const MAX_CONFIG_BYTES: usize = 64 * 1024;
pub const MAX_CLIENTS: usize = 64;
pub const MAX_DEVICES: usize = 256;
pub const MAX_PROFILES: usize = 64;
pub const MAX_RULES_PER_PROFILE: usize = 512;
pub const MAX_DESTINATIONS: usize = 64;
pub const MAX_LABEL_LEN: usize = 128;
pub const MAX_TOKEN_LEN: usize = 256;
pub const MAX_NAME_LEN: usize = 253;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_TIMEZONE_LEN: usize = 64;
pub const MAX_CONNECTIONS: usize = 4096;
pub const MAX_HEADER_BYTES: usize = 1024 * 1024;
pub const MIN_HEADER_BYTES: usize = 8192;
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TIMEOUT_SECS: u64 = 300;
pub const MAX_TUNNEL_IDLE_SECS: u64 = 3600;

/// Unprivileged, high loopback port. No household deployment is implied.
pub const DEFAULT_BIND_ADDRESS: &str = "127.0.0.1";
pub const DEFAULT_BIND_PORT: u16 = 15_354;
const HEARTBEAT_TTL_SECS: u64 = 90;
const EVENT_RETENTION_SECS: u64 = 24 * 60 * 60;

/// Canonicalise IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4. Native IPv6
/// loopback and deprecated compatible addresses stay IPv6.
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

fn default_bind_address() -> String {
    DEFAULT_BIND_ADDRESS.to_owned()
}
fn default_bind_port() -> u16 {
    DEFAULT_BIND_PORT
}
fn default_true() -> bool {
    true
}
fn default_personal_computer() -> DeviceKind {
    DeviceKind::PersonalComputer
}
fn default_timezone() -> String {
    "UTC".to_owned()
}
fn default_stale_secs() -> u64 {
    24 * 60 * 60
}
fn default_device_profile() -> String {
    "restricted".to_owned()
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
fn default_capabilities() -> BTreeSet<Capability> {
    [Capability::DomainFiltering, Capability::UrlFiltering]
        .into_iter()
        .collect()
}

/// Explicit listener settings. The default is a high loopback port; a
/// non-loopback bind needs an explicit opt-in and is never public.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindConfig {
    #[serde(default = "default_bind_address")]
    pub address: String,
    #[serde(default = "default_bind_port")]
    pub port: u16,
    #[serde(default)]
    pub allow_non_loopback: bool,
}

impl Default for BindConfig {
    fn default() -> Self {
        Self {
            address: default_bind_address(),
            port: default_bind_port(),
            allow_non_loopback: false,
        }
    }
}

impl BindConfig {
    pub fn configured_addr(&self) -> SocketAddr {
        // Validated by Config::validate before any bind.
        SocketAddr::new(
            IpAddr::from_str(&self.address).expect("validated bind address"),
            self.port,
        )
    }
}

/// A domain rule. Exact host and suffix matchers are the only syntax here;
/// there is no external list parser or category feed.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSpec {
    pub effect: Effect,
    #[serde(rename = "match")]
    pub matcher: MatchSpec,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
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

/// A device is selected by the credential that authenticated. Source IPs are
/// deliberately not part of this record: an address is weak association and
/// never identifies a person or a current session.
#[derive(Clone, Debug, Deserialize)]
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
    #[serde(default = "default_capabilities")]
    pub capabilities: BTreeSet<Capability>,
}

/// A static proxy client. `token` is bootstrap-only secret material; the
/// configuration file must be private. `profile`, when present, is an
/// explicit static profile mapping and never an inferred "adult" selector.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientConfig {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    pub token: String,
    pub device_id: String,
    #[serde(default)]
    pub profile: Option<String>,
}

impl fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientConfig")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("token", &"<redacted>")
            .field("device_id", &self.device_id)
            .field("profile", &self.profile)
            .finish()
    }
}

/// One explicitly approved destination. A `pin` is a narrow loopback
/// exception for local tests or explicitly approved private services; it is
/// not a global "allow private". Without a pin, only a domain may be dialled
/// and every resolved address is checked.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DestinationConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub pin: Option<String>,
}

/// Bounded resource settings. Timeouts and the idle budget bound a tunnel
/// even where a hard byte cap would be awkward for an opaque TLS stream.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitsConfig {
    #[serde(default = "default_max_connections")]
    pub max_connections: usize,
    #[serde(default = "default_max_header_bytes")]
    pub max_header_bytes: usize,
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_request_timeout_secs")]
    pub request_timeout_secs: u64,
    #[serde(default = "default_tunnel_idle_secs")]
    pub tunnel_idle_secs: u64,
}

fn default_max_connections() -> usize {
    128
}
fn default_max_header_bytes() -> usize {
    16 * 1024
}
fn default_max_body_bytes() -> usize {
    1024 * 1024
}
fn default_connect_timeout_ms() -> u64 {
    3000
}
fn default_request_timeout_secs() -> u64 {
    30
}
fn default_tunnel_idle_secs() -> u64 {
    60
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_connections: default_max_connections(),
            max_header_bytes: default_max_header_bytes(),
            max_body_bytes: default_max_body_bytes(),
            connect_timeout_ms: default_connect_timeout_ms(),
            request_timeout_secs: default_request_timeout_secs(),
            tunnel_idle_secs: default_tunnel_idle_secs(),
        }
    }
}

/// Complete, validated worker configuration.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub household_id: String,
    pub policy_revision: u64,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    #[serde(default = "default_stale_secs")]
    pub stale_after_secs: u64,
    #[serde(default)]
    pub bind: BindConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
    #[serde(default)]
    pub clients: Vec<ClientConfig>,
    #[serde(default)]
    pub devices: Vec<DeviceConfig>,
    #[serde(default = "default_profiles")]
    pub profiles: BTreeMap<String, Vec<RuleSpec>>,
    #[serde(default = "default_device_profile")]
    pub default_device_profile: String,
    #[serde(default)]
    pub destinations: Vec<DestinationConfig>,
}

impl Config {
    /// Read, size-bound and validate a private configuration file. On Unix a
    /// file carrying client tokens must not be group/world readable.
    pub fn load(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)?.permissions().mode();
            if mode & 0o077 != 0 {
                bail!("configuration contains client credentials and must be mode 0600");
            }
        }
        let file = File::open(path)?;
        let mut bytes = Vec::new();
        let read = file
            .take(MAX_CONFIG_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if read > MAX_CONFIG_BYTES {
            bail!("configuration exceeds {MAX_CONFIG_BYTES} bytes");
        }
        Self::parse(&bytes)
    }

    /// Parse and validate an in-memory JSON document.
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
        HouseholdId::from_str(&self.household_id)
            .map_err(|_| anyhow::anyhow!("household_id is not a UUID"))?;
        if self.policy_revision == 0 {
            bail!("policy_revision must be greater than zero");
        }
        if self.timezone.is_empty() || self.timezone.len() > MAX_TIMEZONE_LEN {
            bail!("timezone must be 1..={MAX_TIMEZONE_LEN} characters");
        }
        if !(1..=30 * 24 * 60 * 60).contains(&self.stale_after_secs) {
            bail!("stale_after_secs is out of range");
        }

        let bind_ip = normalize_ip(
            IpAddr::from_str(&self.bind.address)
                .map_err(|_| anyhow::anyhow!("bind address must be an IP literal"))?,
        );
        // Port zero is the OS-assigned port used by in-process tests; an
        // explicitly chosen privileged port is never accepted.
        if self.bind.port != 0 && self.bind.port < 1024 {
            bail!("bind port must be 1024 or higher; privileged ports are not used");
        }
        if !bind_ip.is_loopback() {
            if !self.bind.allow_non_loopback {
                bail!("non-loopback bind requires bind.allow_non_loopback = true");
            }
            if bind_ip.is_unspecified() || is_public_address(bind_ip) {
                bail!("an unspecified or public bind address is never allowed");
            }
        }

        self.validate_limits()?;

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
            bail!("default_device_profile is not defined");
        }

        if self.devices.is_empty() || self.devices.len() > MAX_DEVICES {
            bail!("devices must contain 1..={MAX_DEVICES} entries");
        }
        let mut device_ids = BTreeSet::new();
        for device in &self.devices {
            let id = DeviceId::from_str(&device.id)
                .map_err(|_| anyhow::anyhow!("device id '{}' is not a UUID", device.id))?;
            if !device_ids.insert(id) {
                bail!("duplicate device id {}", device.id);
            }
            if device.default_profile.is_empty()
                || device.default_profile.len() > MAX_LABEL_LEN
                || !self.profiles.contains_key(&device.default_profile)
            {
                bail!("device {} uses an undefined profile", device.id);
            }
            if let Some(label) = &device.label {
                if label.len() > MAX_LABEL_LEN {
                    bail!("device label exceeds {MAX_LABEL_LEN} characters");
                }
            }
        }

        if self.clients.is_empty() || self.clients.len() > MAX_CLIENTS {
            bail!("clients must contain 1..={MAX_CLIENTS} entries");
        }
        let mut client_ids = BTreeSet::new();
        let mut tokens = BTreeSet::new();
        for client in &self.clients {
            let id = Uuid::parse_str(&client.id)
                .map_err(|_| anyhow::anyhow!("client id '{}' is not a UUID", client.id))?;
            if !client_ids.insert(id) {
                bail!("duplicate client id {}", client.id);
            }
            // Static bootstrap tokens are high-entropy secrets. A 1-byte
            // token invites trial-and-error even behind a loopback listener.
            if client.token.len() < 32 || client.token.len() > MAX_TOKEN_LEN {
                bail!("client token must be 32..={MAX_TOKEN_LEN} characters");
            }
            if !tokens.insert(&client.token) {
                bail!("client tokens must be unique");
            }
            if let Some(label) = &client.label {
                if label.len() > MAX_LABEL_LEN {
                    bail!("client label exceeds {MAX_LABEL_LEN} characters");
                }
            }
            let device_id = DeviceId::from_str(&client.device_id)
                .map_err(|_| anyhow::anyhow!("client device id is not a UUID"))?;
            if !device_ids.contains(&device_id) {
                bail!("client {} refers to an undefined device", client.id);
            }
            if let Some(profile) = &client.profile {
                if !self.profiles.contains_key(profile) {
                    bail!("client {} uses an undefined profile", client.id);
                }
            }
        }

        if self.destinations.len() > MAX_DESTINATIONS {
            bail!("at most {MAX_DESTINATIONS} destinations are allowed");
        }
        let mut seen = BTreeSet::new();
        for destination in &self.destinations {
            let host = canonical_host(&destination.host);
            if host.is_empty() || host.len() > MAX_NAME_LEN {
                bail!("destination host must be 1..={MAX_NAME_LEN} characters");
            }
            if destination.port < 1024 {
                bail!("destination port must be 1024 or higher");
            }
            if !seen.insert((host.clone(), destination.port)) {
                bail!("duplicate destination {host}:{}", destination.port);
            }
            match &destination.pin {
                Some(pin) => {
                    let addr = SocketAddr::from_str(pin)
                        .map_err(|_| anyhow::anyhow!("destination pin must be IP:port"))?;
                    if !normalize_ip(addr.ip()).is_loopback() {
                        bail!("a destination pin must be a loopback socket");
                    }
                    if addr.port() != destination.port || addr.port() == 0 {
                        bail!("destination pin port must equal the approved port");
                    }
                    // An IP literal is only ever dialled through an explicit
                    // narrow pin; there is no implicit literal allowlist.
                }
                None => {
                    if IpAddr::from_str(&host).is_ok() {
                        bail!("an IP literal destination requires an explicit loopback pin");
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_limits(&self) -> Result<()> {
        let l = self.limits;
        if l.max_connections == 0 || l.max_connections > MAX_CONNECTIONS {
            bail!("limits.max_connections is out of range");
        }
        if l.max_header_bytes < MIN_HEADER_BYTES || l.max_header_bytes > MAX_HEADER_BYTES {
            bail!("limits.max_header_bytes is out of range");
        }
        if l.max_body_bytes == 0 || l.max_body_bytes > MAX_BODY_BYTES {
            bail!("limits.max_body_bytes is out of range");
        }
        if l.connect_timeout_ms == 0 || l.connect_timeout_ms > MAX_TIMEOUT_SECS * 1000 {
            bail!("limits.connect_timeout_ms is out of range");
        }
        if l.request_timeout_secs == 0 || l.request_timeout_secs > MAX_TIMEOUT_SECS {
            bail!("limits.request_timeout_secs is out of range");
        }
        if l.tunnel_idle_secs == 0 || l.tunnel_idle_secs > MAX_TUNNEL_IDLE_SECS {
            bail!("limits.tunnel_idle_secs is out of range");
        }
        Ok(())
    }

    /// Build the fail-closed policy consumed by the evaluator. There are no
    /// sessions, assignments, person rules or exceptions: a proxy credential
    /// selects a device default, never a person.
    pub fn policy(&self, now: DateTime<Utc>) -> Policy {
        let device_profiles = self
            .profiles
            .iter()
            .map(|(profile, rules)| {
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
                (profile.clone(), built)
            })
            .collect();
        Policy {
            household_id: HouseholdId::from_str(&self.household_id)
                .expect("household_id validated"),
            revision: self.policy_revision,
            baseline: Vec::new(),
            device_profiles,
            person_rules: BTreeMap::new(),
            exceptions: Vec::new(),
            default_effect: Effect::Deny,
            timezone: self.timezone.clone(),
            stale_after_secs: self.stale_after_secs,
            event_retention_secs: EVENT_RETENTION_SECS,
            published_at: now,
        }
    }

    /// Device selected for an authenticated client. An explicit static
    /// `profile` is the only override, and it is config-driven, not inferred.
    pub fn device_for(&self, client: &ClientConfig) -> Device {
        let configured = self
            .devices
            .iter()
            .find(|device| device.id == client.device_id)
            .expect("client device validated");
        let profile = client
            .profile
            .clone()
            .unwrap_or_else(|| configured.default_profile.clone());
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
            default_profile: profile,
            capabilities: configured.capabilities.clone(),
        }
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind.configured_addr()
    }

    pub fn limits(&self) -> LimitsConfig {
        self.limits
    }

    pub fn heartbeat_ttl_secs() -> u64 {
        HEARTBEAT_TTL_SECS
    }
}

/// Lowercase, dot-stripped form used for exact destination approvals.
pub fn canonical_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Conservative public-address check. Private, loopback, link-local,
/// unspecified and documentation ranges are the only private bind addresses
/// accepted in a lab container.
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
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 4,
        "bind": { "address": "127.0.0.1", "port": 15354 },
        "profiles": { "restricted": [
            { "effect": "deny", "match": { "type": "suffix", "value": "blocked.example" }, "reason": "blocked" }
        ]},
        "default_device_profile": "restricted",
        "devices": [{
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "default_profile": "restricted"
        }],
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "vantyr-proxy-bootstrap-token-0001",
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        }],
        "destinations": [{
            "host": "echo.test", "port": 18443, "pin": "127.0.0.1:18443"
        }]
    }"#;

    #[test]
    fn valid_config_builds_fail_closed_policy_and_device_mapping() {
        let config = Config::parse(VALID.as_bytes()).unwrap();
        assert_eq!(
            config.bind_addr(),
            SocketAddr::from_str("127.0.0.1:15354").unwrap()
        );
        let policy = config.policy(Utc::now());
        assert_eq!(policy.revision, 4);
        assert_eq!(policy.default_effect, Effect::Deny);
        assert!(policy.person_rules.is_empty());
        assert!(policy.exceptions.is_empty());
        let client = &config.clients[0];
        let device = config.device_for(client);
        assert_eq!(device.default_profile, "restricted");
        assert_eq!(
            device.id,
            DeviceId::from_str("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").unwrap()
        );
    }

    #[test]
    fn explicit_profile_override_is_the_only_client_selector() {
        let mut value: serde_json::Value = serde_json::from_str(VALID).unwrap();
        value["profiles"]["open"] = serde_json::json!([
            { "effect": "allow", "match": { "type": "suffix", "value": "open.example" } }
        ]);
        value["clients"][0]["profile"] = serde_json::json!("open");
        let config = Config::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            config.device_for(&config.clients[0]).default_profile,
            "open"
        );
        // No source IP path exists in the config at all.
        assert!(!VALID.contains("source_ip"));
    }

    #[test]
    fn rejects_oversize_unknown_and_bad_bounds() {
        let over = format!("{{\"household_id\": \"{}\"}}", "x".repeat(MAX_CONFIG_BYTES));
        assert!(Config::parse(over.as_bytes()).is_err());
        assert!(Config::parse(
            br#"{"household_id":"11111111-2222-3333-4444-555555555555","policy_revision":1,"bogus":true}"#
        )
        .is_err());
        let privileged = VALID.replace("\"port\": 15354", "\"port\": 53");
        assert!(Config::parse(privileged.as_bytes()).is_err());
        let unknown_field = VALID.replace(
            "\"policy_revision\": 4",
            "\"policy_revision\": 4, \"bogus\": true",
        );
        assert!(Config::parse(unknown_field.as_bytes()).is_err());
        let with_limits = VALID.replace(
            "\"clients\":",
            "\"limits\": { \"tunnel_idle_secs\": 0 }, \"clients\":",
        );
        assert!(Config::parse(with_limits.as_bytes()).is_err());
    }

    #[test]
    fn non_loopback_bind_requires_opt_in_and_stays_private() {
        let opted_out = VALID.replace("\"address\": \"127.0.0.1\"", "\"address\": \"10.0.0.5\"");
        assert!(Config::parse(opted_out.as_bytes()).is_err());
        let opted_in = opted_out.replace(
            "\"port\": 15354",
            "\"port\": 15354, \"allow_non_loopback\": true",
        );
        assert!(Config::parse(opted_in.as_bytes()).is_ok());
        let public = VALID
            .replace("\"address\": \"127.0.0.1\"", "\"address\": \"8.8.8.8\"")
            .replace(
                "\"port\": 15354",
                "\"port\": 15354, \"allow_non_loopback\": true",
            );
        assert!(Config::parse(public.as_bytes()).is_err());
    }

    #[test]
    fn mapped_loopback_bind_is_loopback_and_private_pins_are_rejected() {
        let mapped = VALID.replace(
            "\"address\": \"127.0.0.1\"",
            "\"address\": \"::ffff:127.0.0.1\"",
        );
        assert!(Config::parse(mapped.as_bytes()).is_ok());
        let private_pin = VALID.replace("127.0.0.1:18443", "10.0.0.1:18443");
        assert!(Config::parse(private_pin.as_bytes()).is_err());
        let literal_no_pin = VALID.replace(
            "\"host\": \"echo.test\", \"port\": 18443, \"pin\": \"127.0.0.1:18443\"",
            "\"host\": \"169.254.169.254\", \"port\": 18443",
        );
        assert!(Config::parse(literal_no_pin.as_bytes()).is_err());
    }

    #[test]
    fn short_client_tokens_are_rejected() {
        let short = VALID.replace("vantyr-proxy-bootstrap-token-0001", "short");
        assert!(
            Config::parse(short.as_bytes()).is_err(),
            "a 1-byte bootstrap token must not be accepted"
        );
    }

    #[test]
    fn config_file_must_be_private() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = std::env::temp_dir().join(format!(
                "vantyr-proxy-perm-{}-{}.json",
                std::process::id(),
                Uuid::new_v4()
            ));
            std::fs::write(&path, VALID).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(Config::load(&path).is_err(), "0644 config must be rejected");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(Config::load(&path).is_ok(), "0600 config must load");
            std::fs::remove_file(&path).unwrap();
        }
    }
}
