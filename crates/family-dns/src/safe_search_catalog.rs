//! Checked-in canonical Google Search domain catalog for the SafeSearch slice.
//!
//! Source and derivation (verified 2026-11-27):
//! - <https://www.google.com/supported_domains> lists the official Google
//!   country/region Search domains. Every entry below is exactly
//!   `www.<supported domain>`; there is no wildcard and no domain outside
//!   that list.
//! - <https://support.google.com/websearch/answer/186669> says, for a managed
//!   network, "Set the DNS entry for www.google.com (and any other Google
//!   country or region domains that your users may use) to be a CNAME for
//!   forcesafesearch.google.com."
//!
//! This is a bounded snapshot, not a live feed. Google can add or retire a
//! supported domain; refreshing this catalog is a deliberate, reviewed update
//! against the source above. The rewrite target is a hostname, not an address:
//! the configured upstream resolves it through the maintained Hickory
//! resolver. No provider IP, custom DNS server or second engine is stored here.

/// Exact `www.<supported Google domain>` owners selected for the Google
/// SafeSearch rewrite. 187 entries, derived 1:1 from the official list.
pub(crate) const GOOGLE_SEARCH_DOMAINS: &[&str] = &[
    "www.google.com.",
    "www.google.ad.",
    "www.google.ae.",
    "www.google.com.af.",
    "www.google.com.ag.",
    "www.google.al.",
    "www.google.am.",
    "www.google.co.ao.",
    "www.google.com.ar.",
    "www.google.as.",
    "www.google.at.",
    "www.google.com.au.",
    "www.google.az.",
    "www.google.ba.",
    "www.google.com.bd.",
    "www.google.be.",
    "www.google.bf.",
    "www.google.bg.",
    "www.google.com.bh.",
    "www.google.bi.",
    "www.google.bj.",
    "www.google.com.bn.",
    "www.google.com.bo.",
    "www.google.com.br.",
    "www.google.bs.",
    "www.google.bt.",
    "www.google.co.bw.",
    "www.google.by.",
    "www.google.com.bz.",
    "www.google.ca.",
    "www.google.cd.",
    "www.google.cf.",
    "www.google.cg.",
    "www.google.ch.",
    "www.google.ci.",
    "www.google.co.ck.",
    "www.google.cl.",
    "www.google.cm.",
    "www.google.cn.",
    "www.google.com.co.",
    "www.google.co.cr.",
    "www.google.com.cu.",
    "www.google.cv.",
    "www.google.com.cy.",
    "www.google.cz.",
    "www.google.de.",
    "www.google.dj.",
    "www.google.dk.",
    "www.google.dm.",
    "www.google.com.do.",
    "www.google.dz.",
    "www.google.com.ec.",
    "www.google.ee.",
    "www.google.com.eg.",
    "www.google.es.",
    "www.google.com.et.",
    "www.google.fi.",
    "www.google.com.fj.",
    "www.google.fm.",
    "www.google.fr.",
    "www.google.ga.",
    "www.google.ge.",
    "www.google.gg.",
    "www.google.com.gh.",
    "www.google.com.gi.",
    "www.google.gl.",
    "www.google.gm.",
    "www.google.gr.",
    "www.google.com.gt.",
    "www.google.gy.",
    "www.google.com.hk.",
    "www.google.hn.",
    "www.google.hr.",
    "www.google.ht.",
    "www.google.hu.",
    "www.google.co.id.",
    "www.google.ie.",
    "www.google.co.il.",
    "www.google.im.",
    "www.google.co.in.",
    "www.google.iq.",
    "www.google.is.",
    "www.google.it.",
    "www.google.je.",
    "www.google.com.jm.",
    "www.google.jo.",
    "www.google.co.jp.",
    "www.google.co.ke.",
    "www.google.com.kh.",
    "www.google.ki.",
    "www.google.kg.",
    "www.google.co.kr.",
    "www.google.com.kw.",
    "www.google.kz.",
    "www.google.la.",
    "www.google.com.lb.",
    "www.google.li.",
    "www.google.lk.",
    "www.google.co.ls.",
    "www.google.lt.",
    "www.google.lu.",
    "www.google.lv.",
    "www.google.com.ly.",
    "www.google.co.ma.",
    "www.google.md.",
    "www.google.me.",
    "www.google.mg.",
    "www.google.mk.",
    "www.google.ml.",
    "www.google.com.mm.",
    "www.google.mn.",
    "www.google.com.mt.",
    "www.google.mu.",
    "www.google.mv.",
    "www.google.mw.",
    "www.google.com.mx.",
    "www.google.com.my.",
    "www.google.co.mz.",
    "www.google.com.na.",
    "www.google.com.ng.",
    "www.google.com.ni.",
    "www.google.ne.",
    "www.google.nl.",
    "www.google.no.",
    "www.google.com.np.",
    "www.google.nr.",
    "www.google.nu.",
    "www.google.co.nz.",
    "www.google.com.om.",
    "www.google.com.pa.",
    "www.google.com.pe.",
    "www.google.com.pg.",
    "www.google.com.ph.",
    "www.google.com.pk.",
    "www.google.pl.",
    "www.google.pn.",
    "www.google.com.pr.",
    "www.google.ps.",
    "www.google.pt.",
    "www.google.com.py.",
    "www.google.com.qa.",
    "www.google.ro.",
    "www.google.ru.",
    "www.google.rw.",
    "www.google.com.sa.",
    "www.google.com.sb.",
    "www.google.sc.",
    "www.google.se.",
    "www.google.com.sg.",
    "www.google.sh.",
    "www.google.si.",
    "www.google.sk.",
    "www.google.com.sl.",
    "www.google.sn.",
    "www.google.so.",
    "www.google.sm.",
    "www.google.sr.",
    "www.google.st.",
    "www.google.com.sv.",
    "www.google.td.",
    "www.google.tg.",
    "www.google.co.th.",
    "www.google.com.tj.",
    "www.google.tl.",
    "www.google.tm.",
    "www.google.tn.",
    "www.google.to.",
    "www.google.com.tr.",
    "www.google.tt.",
    "www.google.com.tw.",
    "www.google.co.tz.",
    "www.google.com.ua.",
    "www.google.co.ug.",
    "www.google.co.uk.",
    "www.google.com.uy.",
    "www.google.co.uz.",
    "www.google.com.vc.",
    "www.google.co.ve.",
    "www.google.co.vi.",
    "www.google.com.vn.",
    "www.google.vu.",
    "www.google.ws.",
    "www.google.rs.",
    "www.google.co.za.",
    "www.google.co.zm.",
    "www.google.co.zw.",
    "www.google.cat.",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_bounded_exact_and_covers_australia_and_new_zealand() {
        assert_eq!(GOOGLE_SEARCH_DOMAINS.len(), 187);
        let mut seen = std::collections::BTreeSet::new();
        for name in GOOGLE_SEARCH_DOMAINS {
            assert!(name.starts_with("www.google."), "unexpected entry {name}");
            assert!(name.ends_with('.'), "not a canonical name {name}");
            assert!(!name.contains('*'), "wildcard is not allowed {name}");
            assert!(seen.insert(*name), "duplicate entry {name}");
        }
        assert!(GOOGLE_SEARCH_DOMAINS.contains(&"www.google.com."));
        assert!(GOOGLE_SEARCH_DOMAINS.contains(&"www.google.com.au."));
        assert!(GOOGLE_SEARCH_DOMAINS.contains(&"www.google.co.nz."));
        assert!(GOOGLE_SEARCH_DOMAINS.contains(&"www.google.co.uk."));
        assert!(!GOOGLE_SEARCH_DOMAINS.contains(&"google.com."));
        assert!(!GOOGLE_SEARCH_DOMAINS.contains(&"www.google.com.au.invalid."));
        assert!(!GOOGLE_SEARCH_DOMAINS.contains(&"www.notgoogle.com."));
    }
}
