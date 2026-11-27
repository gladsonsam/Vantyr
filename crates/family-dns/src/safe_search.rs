//! Provider-backed SafeSearch mappings, taken from official provider support
//! documentation and verified on 2026-11-27.
//!
//! Google, "Lock SafeSearch for accounts, devices & networks you manage":
//! <https://support.google.com/websearch/answer/186669> states, for a managed
//! network, "Set the DNS entry for www.google.com (and any other Google country
//! or region domains that your users may use) to be a CNAME for
//! forcesafesearch.google.com." The allowed owners are the checked-in
//! `www.<supported Google domain>` catalog in `safe_search_catalog`, derived
//! from <https://www.google.com/supported_domains> on 2026-11-27. The IP printed
//! in the hosts-file example is explicitly an example to be discovered by
//! pinging the VIP, so no address is stored here.
//!
//! Microsoft, "Blocking explicit content with SafeSearch":
//! <https://support.microsoft.com/en-us/topic/blocking-adult-content-with-safesearch-or-blocking-chat-946059ed-992b-46a0-944a-28e8fb8f1814>
//! states, "Set the DNS entry for www.bing.com to be a CNAME for strict.bing.com"
//! and "Similarly, set edgeservices.bing.com to be the CNAME for strict.bing.com
//! to force SafeSearch in the Edge sidebar." It also says to "use a CNAME rather
//! than the strict.bing.com IP as the CNAME will continue to work even if the IP
//! for strict.bing.com changes."
//!
//! Google, "Control YouTube content available to users":
//! <https://support.google.com/a/answer/6214622> states, for a managed
//! network, to add a CNAME for exactly `www.youtube.com`, `m.youtube.com`,
//! `youtubei.googleapis.com`, `youtube.googleapis.com` and
//! `www.youtube-nocookie.com`, pointing to `restrict.youtube.com` for strict
//! or `restrictmoderate.youtube.com` for moderate. It explicitly says not to
//! CNAME other YouTube hostnames (`youtube.com`, `s.ytimg.com`, `youtu.be`,
//! `googleapis.com`, `youtubeeducation.com`). Only the five exact aliases are
//! selected here: no wildcard and no blanket YouTube/googleapis rewrite.
//!
//! Every target is a hostname. The configured upstream resolves it through
//! the maintained Hickory resolver, so no provider IP, provider HTTP fetch,
//! second DNS engine or custom crypto is needed here. Only names named by the
//! three documents are selected; the mapping never invents a provider.

use hickory_server::proto::rr::{Name, RecordType};

use crate::config::{SafeSearchConfig, YouTubeSafeSearch};

/// Official Google SafeSearch VIP hostname (not an address).
pub(crate) const GOOGLE_TARGET: &str = "forcesafesearch.google.com.";
/// Official Bing strict SafeSearch hostname (not an address).
pub(crate) const BING_TARGET: &str = "strict.bing.com.";
/// Official YouTube strict Restricted Mode hostname (not an address).
pub(crate) const YOUTUBE_STRICT_TARGET: &str = "restrict.youtube.com.";
/// Official YouTube moderate Restricted Mode hostname (not an address).
pub(crate) const YOUTUBE_MODERATE_TARGET: &str = "restrictmoderate.youtube.com.";

/// Only exact owners from the checked-in official catalog are selected.
const GOOGLE_DOMAINS: &[&str] = crate::safe_search_catalog::GOOGLE_SEARCH_DOMAINS;
const BING_DOMAINS: &[&str] = &[
    "www.bing.com.",
    // The Microsoft document names this domain for the Edge sidebar.
    "edgeservices.bing.com.",
];
/// The five exact aliases named by the YouTube DNS instruction. The
/// do-not-CNAME hostnames in that document are deliberately not here.
const YOUTUBE_DOMAINS: &[&str] = &[
    "www.youtube.com.",
    "m.youtube.com.",
    "youtubei.googleapis.com.",
    "youtube.googleapis.com.",
    "www.youtube-nocookie.com.",
];

/// True for a canonical provider target. Such a name is never itself
/// rewritten, which is the recursion/loop guard for this slice.
pub(crate) fn is_target(name: &Name) -> bool {
    let lower = name.to_string().to_ascii_lowercase();
    lower == GOOGLE_TARGET
        || lower == BING_TARGET
        || lower == YOUTUBE_STRICT_TARGET
        || lower == YOUTUBE_MODERATE_TARGET
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
    if YOUTUBE_DOMAINS.contains(&owner.as_str()) {
        match config.youtube {
            YouTubeSafeSearch::Strict => return Some(YOUTUBE_STRICT_TARGET),
            YouTubeSafeSearch::Moderate => return Some(YOUTUBE_MODERATE_TARGET),
            YouTubeSafeSearch::Off => {}
        }
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
        assert!(target_for(&config, &name("www.youtube.com."), RecordType::A).is_none());
        assert_eq!(config.youtube, YouTubeSafeSearch::Off);
    }

    #[test]
    fn each_provider_uses_only_its_documented_target() {
        let google = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: false,
            youtube: YouTubeSafeSearch::Off,
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
            youtube: YouTubeSafeSearch::Off,
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
    fn google_regional_domains_from_the_catalog_are_selected() {
        let google = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: false,
            youtube: YouTubeSafeSearch::Off,
        };
        for owner in [
            "www.google.com.",
            "www.google.com.au.",
            "www.google.co.nz.",
            "www.google.co.uk.",
            "www.google.com.br.",
        ] {
            for qtype in [
                RecordType::A,
                RecordType::AAAA,
                RecordType::CNAME,
                RecordType::ANY,
            ] {
                assert_eq!(
                    target_for(&google, &name(owner), qtype),
                    Some(GOOGLE_TARGET),
                    "catalog owner {owner} not selected for {qtype:?}"
                );
            }
        }
    }

    #[test]
    fn non_catalog_google_lookalikes_are_not_selected() {
        let google = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: false,
            youtube: YouTubeSafeSearch::Off,
        };
        for owner in [
            "google.com.",
            "mail.google.com.",
            "www.google.com.au.invalid.",
            "www.notgoogle.com.",
            "www.google.example.",
            "www.google.",
        ] {
            assert!(
                target_for(&google, &name(owner), RecordType::A).is_none(),
                "non-catalog name {owner} was selected"
            );
        }
    }

    #[test]
    fn canonical_targets_are_never_rewritten() {
        let both = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: true,
            youtube: YouTubeSafeSearch::Strict,
        };
        for target in [
            GOOGLE_TARGET,
            BING_TARGET,
            YOUTUBE_STRICT_TARGET,
            YOUTUBE_MODERATE_TARGET,
        ] {
            assert!(is_target(&name(target)));
            assert!(target_for(&both, &name(target), RecordType::A).is_none());
        }
        assert!(target_for(&both, &name("unrelated.example."), RecordType::A).is_none());
    }

    #[test]
    fn youtube_modes_select_only_the_official_target() {
        let aliases = [
            "www.youtube.com.",
            "m.youtube.com.",
            "youtubei.googleapis.com.",
            "youtube.googleapis.com.",
            "www.youtube-nocookie.com.",
        ];
        for (mode, target) in [
            (YouTubeSafeSearch::Strict, YOUTUBE_STRICT_TARGET),
            (YouTubeSafeSearch::Moderate, YOUTUBE_MODERATE_TARGET),
        ] {
            let config = SafeSearchConfig {
                enabled: true,
                google: false,
                bing: false,
                youtube: mode,
            };
            for owner in aliases {
                for qtype in [
                    RecordType::A,
                    RecordType::AAAA,
                    RecordType::CNAME,
                    RecordType::ANY,
                ] {
                    assert_eq!(
                        target_for(&config, &name(owner), qtype),
                        Some(target),
                        "alias {owner} not selected for {qtype:?} in {mode:?} mode"
                    );
                }
            }
            assert!(target_for(&config, &name("www.youtube.com."), RecordType::TXT).is_none());
        }
    }

    #[test]
    fn youtube_off_and_do_not_cname_domains_select_nothing() {
        let off = SafeSearchConfig {
            enabled: true,
            google: false,
            bing: false,
            youtube: YouTubeSafeSearch::Off,
        };
        let strict = SafeSearchConfig {
            youtube: YouTubeSafeSearch::Strict,
            ..off.clone()
        };
        for owner in [
            "www.youtube.com.",
            "m.youtube.com.",
            "youtubei.googleapis.com.",
            "youtube.googleapis.com.",
            "www.youtube-nocookie.com.",
            "youtube.com.",
            "s.ytimg.com.",
            "youtu.be.",
            "googleapis.com.",
            "youtubeeducation.com.",
        ] {
            assert!(target_for(&off, &name(owner), RecordType::A).is_none());
        }
        // The document's do-not-CNAME names stay untouched even when a mode is
        // active, and the master switch still gates the YouTube provider.
        for owner in [
            "youtube.com.",
            "s.ytimg.com.",
            "youtu.be.",
            "googleapis.com.",
            "youtubeeducation.com.",
        ] {
            assert!(target_for(&strict, &name(owner), RecordType::A).is_none());
        }
        let master_off = SafeSearchConfig {
            enabled: false,
            youtube: YouTubeSafeSearch::Strict,
            ..off.clone()
        };
        assert!(target_for(&master_off, &name("www.youtube.com."), RecordType::A).is_none());
    }

    #[test]
    fn youtube_mode_is_independent_of_google_and_bing_switches() {
        let google_only = SafeSearchConfig {
            enabled: true,
            google: true,
            bing: false,
            youtube: YouTubeSafeSearch::Off,
        };
        assert!(target_for(&google_only, &name("www.youtube.com."), RecordType::A).is_none());

        let youtube_only = SafeSearchConfig {
            enabled: true,
            google: false,
            bing: false,
            youtube: YouTubeSafeSearch::Moderate,
        };
        assert_eq!(
            target_for(&youtube_only, &name("www.google.com."), RecordType::A),
            None
        );
        assert_eq!(
            target_for(&youtube_only, &name("www.bing.com."), RecordType::A),
            None
        );
        assert_eq!(
            target_for(&youtube_only, &name("m.youtube.com."), RecordType::A),
            Some(YOUTUBE_MODERATE_TARGET)
        );
    }
}
