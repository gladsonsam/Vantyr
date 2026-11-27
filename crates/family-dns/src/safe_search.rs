//! Provider-backed SafeSearch mappings, taken from official provider support
//! documentation and verified on 2026-11-27.
//!
//! Google, "Lock SafeSearch for accounts, devices & networks you manage":
//! <https://support.google.com/websearch/answer/186669> states, for a managed
//! network, "Set the DNS entry for www.google.com (and any other Google country
//! or region domains that your users may use) to be a CNAME for
//! forcesafesearch.google.com." The IP printed in its hosts-file example is
//! explicitly an example to be discovered by pinging the VIP, so no address is
//! stored here.
//!
//! Microsoft, "Blocking explicit content with SafeSearch":
//! <https://support.microsoft.com/en-us/topic/blocking-adult-content-with-safesearch-or-blocking-chat-946059ed-992b-46a0-944a-28e8fb8f1814>
//! states, "Set the DNS entry for www.bing.com to be a CNAME for strict.bing.com"
//! and "Similarly, set edgeservices.bing.com to be the CNAME for strict.bing.com
//! to force SafeSearch in the Edge sidebar." It also says to "use a CNAME rather
//! than the strict.bing.com IP as the CNAME will continue to work even if the IP
//! for strict.bing.com changes."
//!
//! Both targets are hostnames. The configured upstream resolves them through
//! the maintained Hickory resolver, so no provider IP, provider HTTP fetch,
//! second DNS engine or custom crypto is needed here. Only names named by the
//! two documents are selected; the mapping never invents a provider.

use hickory_server::proto::rr::{Name, RecordType};

use crate::config::SafeSearchConfig;

/// Official Google SafeSearch VIP hostname (not an address).
pub(crate) const GOOGLE_TARGET: &str = "forcesafesearch.google.com.";
/// Official Bing strict SafeSearch hostname (not an address).
pub(crate) const BING_TARGET: &str = "strict.bing.com.";

/// Only domains named in the two official documents are selected.
const GOOGLE_DOMAINS: &[&str] = &[
    "www.google.com.",
    // The Google document gives this region domain as its example of an
    // additional country/region domain to include.
    "www.google.co.uk.",
];
const BING_DOMAINS: &[&str] = &[
    "www.bing.com.",
    // The Microsoft document names this domain for the Edge sidebar.
    "edgeservices.bing.com.",
];

/// True for a canonical provider target. Such a name is never itself
/// rewritten, which is the recursion/loop guard for this slice.
pub(crate) fn is_target(name: &Name) -> bool {
    let lower = name.to_string().to_ascii_lowercase();
    lower == GOOGLE_TARGET || lower == BING_TARGET
}

/// Select one official target for an allowed question. Both the master switch
/// and the provider switch must be on; the default is no selection at all.
/// Only types this slice can answer completely are selected: a type answered
/// with a bare CNAME would send the client back to the same worker forever.
pub(crate) fn target_for(
    config: &SafeSearchConfig,
    qname: &Name,
    qtype: RecordType,
) -> Option<&'static str> {
    if !config.enabled || is_target(qname) {
        return None;
    }
    if !matches!(
        qtype,
        RecordType::A | RecordType::AAAA | RecordType::CNAME | RecordType::ANY
    ) {
        return None;
    }
    let owner = qname.to_string().to_ascii_lowercase();
    if config.google && GOOGLE_DOMAINS.contains(&owner.as_str()) {
        return Some(GOOGLE_TARGET);
    }
    if config.bing && BING_DOMAINS.contains(&owner.as_str()) {
        return Some(BING_TARGET);
    }
    None
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn name(value: &str) -> Name {
        Name::from_str(value).unwrap()
    }

    #[test]
    fn default_config_selects_nothing() {
        let config = SafeSearchConfig::default();
        assert!(target_for(&config, &name("www.google.com."), RecordType::A).is_none());
        assert!(target_for(&config, &name("www.bing.com."), RecordType::A).is_none());
    }

    #[test]
    fn each_provider_uses_only_its_documented_target() {
        let google = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: false,
        };
        assert_eq!(
            target_for(&google, &name("www.google.com."), RecordType::A),
            Some(GOOGLE_TARGET)
        );
        assert_eq!(
            target_for(&google, &name("www.google.co.uk."), RecordType::AAAA),
            Some(GOOGLE_TARGET)
        );
        assert!(target_for(&google, &name("www.bing.com."), RecordType::A).is_none());

        let bing = SafeSearchConfig {
            enabled: true,
            google: false,
            bing: true,
        };
        assert_eq!(
            target_for(&bing, &name("www.bing.com."), RecordType::A),
            Some(BING_TARGET)
        );
        assert_eq!(
            target_for(&bing, &name("edgeservices.bing.com."), RecordType::CNAME),
            Some(BING_TARGET)
        );
        assert!(target_for(&bing, &name("www.google.com."), RecordType::A).is_none());
        assert!(target_for(&bing, &name("www.bing.com."), RecordType::TXT).is_none());
    }

    #[test]
    fn canonical_targets_are_never_rewritten() {
        let both = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: true,
        };
        assert!(is_target(&name(GOOGLE_TARGET)));
        assert!(is_target(&name(BING_TARGET)));
        assert!(target_for(&both, &name(GOOGLE_TARGET), RecordType::A).is_none());
        assert!(target_for(&both, &name(BING_TARGET), RecordType::A).is_none());
        assert!(target_for(&both, &name("unrelated.example."), RecordType::A).is_none());
    }
}
