//! Minimal read-model projection of the official Network API schemas. Unknown
//! fields are retained in `NetworkObservation::raw` so a future executor can
//! preserve unrelated settings exactly instead of rewriting an invented shape.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Error;

/// Official field path for IPv4 DHCP-advertised DNS servers (max 4 entries).
pub const IPV4_DNS_PATH: &str = "ipv4Configuration.dhcpConfiguration.dnsServerIpAddressesOverride";
/// Official field path for IPv6 DNS servers (max 4 entries).
pub const IPV6_DNS_PATH: &str = "ipv6Configuration.dnsServerIpAddressesOverride";

pub fn get_field<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

pub fn set_field(root: &mut Value, path: &str, value: Value) -> Result<(), Error> {
    let segments: Vec<&str> = path.split('.').collect();
    if segments.is_empty() {
        return Err(Error::InvalidPlan("empty field path".into()));
    }
    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        current = current
            .get_mut(segment)
            .ok_or_else(|| Error::InvalidPlan(format!("missing parent object at {path}")))?;
        if !current.is_object() {
            return Err(Error::InvalidPlan(format!("non-object parent at {path}")));
        }
    }
    let object = current
        .as_object_mut()
        .ok_or_else(|| Error::InvalidPlan(format!("non-object target at {path}")))?;
    object.insert(segments[segments.len() - 1].to_owned(), value);
    Ok(())
}

pub fn remove_field(root: &mut Value, path: &str) -> Result<(), Error> {
    let segments: Vec<&str> = path.split('.').collect();
    if segments.is_empty() {
        return Err(Error::InvalidPlan("empty field path".into()));
    }
    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        current = current
            .get_mut(segment)
            .ok_or_else(|| Error::InvalidPlan(format!("missing parent object at {path}")))?;
        if !current.is_object() {
            return Err(Error::InvalidPlan(format!("non-object parent at {path}")));
        }
    }
    let object = current
        .as_object_mut()
        .ok_or_else(|| Error::InvalidPlan(format!("non-object target at {path}")))?;
    object.remove(segments[segments.len() - 1]);
    Ok(())
}

fn as_string_list(value: &Value) -> Option<Vec<String>> {
    let array = value.as_array()?;
    let mut out = Vec::with_capacity(array.len());
    for item in array {
        out.push(item.as_str()?.to_owned());
    }
    Some(out)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationInfo {
    pub application_version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteOverview {
    pub id: String,
    pub internal_reference: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub count: i64,
    pub data: Vec<T>,
    pub limit: i64,
    pub offset: i64,
    pub total_count: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Management {
    Gateway,
    Switch,
    Unmanaged,
    Unknown(String),
}

impl Management {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "GATEWAY" => Self::Gateway,
            "SWITCH" => Self::Switch,
            "UNMANAGED" => Self::Unmanaged,
            other => Self::Unknown(other.to_owned()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOverview {
    pub id: String,
    pub name: String,
    pub management: String,
    pub vlan_id: u16,
    pub enabled: bool,
    #[serde(rename = "default", default)]
    pub default_network: bool,
    #[serde(default)]
    pub zone_id: Option<String>,
}

impl NetworkOverview {
    pub fn management_kind(&self) -> Management {
        Management::parse(&self.management)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DnsView {
    pub has_ipv4_dhcp: bool,
    pub dhcp_mode: Option<String>,
    pub ipv4_dns_path: Option<&'static str>,
    pub ipv4_dns_overrides: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ipv6View {
    pub configured: bool,
    pub ipv6_dns_path: Option<&'static str>,
    pub dns_overrides: Option<Vec<String>>,
    pub router_advertisement: bool,
    pub slaac_enabled: bool,
    pub dhcpv6_configured: bool,
    pub interface_type: Option<String>,
    pub shape_known: bool,
}

/// A bounded typed projection plus the exact raw network document. Resource
/// IDs, IPs and MACs are weak network observations, not authenticated person
/// identity.
#[derive(Clone, Debug, PartialEq)]
pub struct NetworkObservation {
    pub id: String,
    pub name: String,
    pub management: Management,
    pub vlan_id: u16,
    pub enabled: bool,
    pub dns: DnsView,
    pub ipv6: Ipv6View,
    pub raw: Value,
}

impl NetworkObservation {
    pub fn from_raw(raw: Value) -> Self {
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let management = Management::parse(
            raw.get("management").and_then(Value::as_str).unwrap_or(""),
        );
        let vlan_id = raw
            .get("vlanId")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u16::MAX as u64) as u16;
        let enabled = raw
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mode = get_field(&raw, "ipv4Configuration.dhcpConfiguration.mode")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let has_dhcp = get_field(&raw, "ipv4Configuration.dhcpConfiguration").is_some();
        let server_mode = mode.as_deref() == Some("SERVER");
        let dns = DnsView {
            has_ipv4_dhcp: has_dhcp,
            dhcp_mode: mode,
            // The override is optional in the schema, so it can be set even
            // when absent today. Only SERVER mode advertises it to clients.
            ipv4_dns_path: if server_mode {
                Some(IPV4_DNS_PATH)
            } else {
                None
            },
            ipv4_dns_overrides: get_field(&raw, IPV4_DNS_PATH).and_then(as_string_list),
        };

        let configured = raw.get("ipv6Configuration").is_some();
        let interface_type = get_field(&raw, "ipv6Configuration.interfaceType")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let shape_known = !configured
            || matches!(interface_type.as_deref(), Some("STATIC" | "PREFIX_DELEGATION"));
        let assignment = get_field(&raw, "ipv6Configuration.clientAddressAssignment");
        let ipv6 = Ipv6View {
            configured,
            ipv6_dns_path: if configured {
                Some(IPV6_DNS_PATH)
            } else {
                None
            },
            dns_overrides: get_field(&raw, IPV6_DNS_PATH).and_then(as_string_list),
            router_advertisement: get_field(&raw, "ipv6Configuration.routerAdvertisement").is_some(),
            slaac_enabled: assignment
                .and_then(|v| v.get("slaacEnabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            dhcpv6_configured: assignment
                .and_then(|v| v.get("dhcpConfiguration"))
                .is_some(),
            interface_type,
            shape_known,
        };

        Self {
            id,
            name,
            management,
            vlan_id,
            enabled,
            dns,
            ipv6,
            raw,
        }
    }
}

/// Overview client fields only. `mac_address` is populated only if a detail
/// response supplies it; an IP/MAC association is never a verified person.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientObservation {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub client_type: String,
    #[serde(default)]
    pub ip_address: Option<String>,
    #[serde(default)]
    pub connected_at: Option<String>,
    #[serde(default)]
    pub mac_address: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeforeValue {
    Absent,
    Present(Value),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_preserves_unknown_fields() {
        let raw = serde_json::json!({
            "id": "n1",
            "name": "Home",
            "management": "GATEWAY",
            "vlanId": 20,
            "enabled": true,
            "customFutureField": {"keep": 7},
            "ipv4Configuration": {"dhcpConfiguration": {
                "mode": "SERVER",
                "dnsServerIpAddressesOverride": ["10.0.0.10"]
            }},
            "ipv6Configuration": {
                "interfaceType": "PREFIX_DELEGATION",
                "routerAdvertisement": {"priority": "MEDIUM"},
                "clientAddressAssignment": {"slaacEnabled": true},
                "dnsServerIpAddressesOverride": ["fd00::10"]
            }
        });
        let observation = NetworkObservation::from_raw(raw);
        assert_eq!(observation.management, Management::Gateway);
        assert_eq!(observation.vlan_id, 20);
        assert_eq!(
            observation.dns.ipv4_dns_overrides,
            Some(vec!["10.0.0.10".to_owned()])
        );
        assert!(observation.ipv6.router_advertisement);
        assert!(observation.ipv6.slaac_enabled);
        assert!(observation.ipv6.shape_known);
        assert_eq!(observation.raw["customFutureField"]["keep"], 7);
    }

    #[test]
    fn path_helpers_do_not_invent_parent_objects() {
        let mut raw = serde_json::json!({"a": {"b": 1}});
        assert_eq!(get_field(&raw, "a.b"), Some(&Value::from(1)));
        assert!(set_field(&mut raw, "a.b", Value::from(2)).is_ok());
        assert_eq!(get_field(&raw, "a.b"), Some(&Value::from(2)));
        assert!(set_field(&mut raw, "x.y", Value::from(3)).is_err());
        assert!(remove_field(&mut raw, "a.b").is_ok());
        assert!(get_field(&raw, "a.b").is_none());
    }
}
