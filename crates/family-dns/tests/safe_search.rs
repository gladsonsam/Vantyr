//! Real UDP tests for the global SafeSearch opt-in slice.
//!
//! Providers use only the hostnames named by their official support documents:
//! the checked-in `www.<supported Google domain>` catalog (including
//! www.google.com.au and www.google.co.nz) -> forcesafesearch.google.com,
//! www.bing.com / edgeservices.bing.com -> strict.bing.com, and the five exact
//! YouTube aliases -> restrict.youtube.com (strict) or
//! restrictmoderate.youtube.com (moderate). The document's do-not-CNAME names
//! are never rewritten. No provider IP is configured: the worker follows the
//! CNAME through its configured upstream with the maintained Hickory resolver
//! and returns usable A/AAAA glue.
//!
//! Every upstream here is a second in-process Vantyr server with authoritative
//! local zones for the target names. No test sends traffic to a public
//! resolver, touches the host resolver, edits hosts files or opens a socket
//! outside loopback.

mod support;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use family_dns::{Config, DnsServer};
use hickory_server::proto::op::{Message, ResponseCode};
use hickory_server::proto::rr::{RData, RecordType};
use support::{addresses, assert_code, cname_targets, udp_query};

const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GOOGLE_TARGET: &str = "forcesafesearch.google.com.";
const BING_TARGET: &str = "strict.bing.com.";
const YOUTUBE_STRICT_TARGET: &str = "restrict.youtube.com.";
const YOUTUBE_MODERATE_TARGET: &str = "restrictmoderate.youtube.com.";

const GOOGLE_ONLY: &str = r#"{"enabled":true,"google":true,"bing":false}"#;
const BING_ONLY: &str = r#"{"enabled":true,"google":false,"bing":true}"#;
const BOTH: &str = r#"{"enabled":true,"google":true,"bing":true}"#;
const DISABLED_BUT_REQUESTED: &str = r#"{"enabled":false,"google":true,"bing":true}"#;
const YOUTUBE_STRICT: &str = r#"{"enabled":true,"google":false,"bing":false,"youtube":"strict"}"#;
const YOUTUBE_MODERATE: &str =
    r#"{"enabled":true,"google":false,"bing":false,"youtube":"moderate"}"#;
const YOUTUBE_OFF: &str = r#"{"enabled":true,"google":false,"bing":false,"youtube":"off"}"#;

/// The five exact aliases named by the YouTube DNS instruction.
const YOUTUBE_ALIASES: &[&str] = &[
    "www.youtube.com.",
    "m.youtube.com.",
    "youtubei.googleapis.com.",
    "youtube.googleapis.com.",
    "www.youtube-nocookie.com.",
];
fn source() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

fn v4(value: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(192, 0, 2, value))
}

/// Authoritative loopback upstream. The official target names resolve only
/// here, from in-memory zones, so an answer proves resolution through the
/// configured upstream rather than a remembered provider address.
fn upstream_config(port: u16) -> String {
    format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 3,
  "bind": {{ "address": "127.0.0.1", "port": {port} }},
  "local_zones": {{
    "forcesafesearch.google.com.": [
      {{ "type": "a", "name": "forcesafesearch.google.com.", "ttl": 60, "addr": "192.0.2.120" }},
      {{ "type": "aaaa", "name": "forcesafesearch.google.com.", "ttl": 60, "addr": "2001:db8::120" }}
    ],
    "strict.bing.com.": [
      {{ "type": "a", "name": "strict.bing.com.", "ttl": 60, "addr": "192.0.2.220" }},
      {{ "type": "aaaa", "name": "strict.bing.com.", "ttl": 60, "addr": "2001:db8::220" }}
    ],
    "www.google.com.": [
      {{ "type": "a", "name": "www.google.com.", "ttl": 30, "addr": "192.0.2.10" }}
    ],
    "www.google.com.au.": [
      {{ "type": "a", "name": "www.google.com.au.", "ttl": 30, "addr": "192.0.2.30" }}
    ],
    "www.google.co.nz.": [
      {{ "type": "a", "name": "www.google.co.nz.", "ttl": 30, "addr": "192.0.2.31" }}
    ],
    "mail.google.com.": [
      {{ "type": "a", "name": "mail.google.com.", "ttl": 30, "addr": "192.0.2.32" }}
    ],
    "www.bing.com.": [
      {{ "type": "a", "name": "www.bing.com.", "ttl": 30, "addr": "192.0.2.20" }}
    ],
    "unrelated.test.": [
      {{ "type": "a", "name": "unrelated.test.", "ttl": 30, "addr": "192.0.2.50" }}
    ],
    "restrict.youtube.com.": [
      {{ "type": "a", "name": "restrict.youtube.com.", "ttl": 60, "addr": "192.0.2.140" }},
      {{ "type": "aaaa", "name": "restrict.youtube.com.", "ttl": 60, "addr": "2001:db8::140" }}
    ],
    "restrictmoderate.youtube.com.": [
      {{ "type": "a", "name": "restrictmoderate.youtube.com.", "ttl": 60, "addr": "192.0.2.150" }},
      {{ "type": "aaaa", "name": "restrictmoderate.youtube.com.", "ttl": 60, "addr": "2001:db8::150" }}
    ],
    "www.youtube.com.": [
      {{ "type": "a", "name": "www.youtube.com.", "ttl": 30, "addr": "192.0.2.60" }}
    ],
    "m.youtube.com.": [
      {{ "type": "a", "name": "m.youtube.com.", "ttl": 30, "addr": "192.0.2.61" }}
    ],
    "youtubei.googleapis.com.": [
      {{ "type": "a", "name": "youtubei.googleapis.com.", "ttl": 30, "addr": "192.0.2.62" }}
    ],
    "youtube.googleapis.com.": [
      {{ "type": "a", "name": "youtube.googleapis.com.", "ttl": 30, "addr": "192.0.2.63" }}
    ],
    "www.youtube-nocookie.com.": [
      {{ "type": "a", "name": "www.youtube-nocookie.com.", "ttl": 30, "addr": "192.0.2.64" }}
    ],
    "youtube.com.": [
      {{ "type": "a", "name": "youtube.com.", "ttl": 30, "addr": "192.0.2.65" }}
    ],
    "s.ytimg.com.": [
      {{ "type": "a", "name": "s.ytimg.com.", "ttl": 30, "addr": "192.0.2.66" }}
    ],
    "youtu.be.": [
      {{ "type": "a", "name": "youtu.be.", "ttl": 30, "addr": "192.0.2.67" }}
    ],
    "googleapis.com.": [
      {{ "type": "a", "name": "googleapis.com.", "ttl": 30, "addr": "192.0.2.68" }}
    ],
    "youtubeeducation.com.": [
      {{ "type": "a", "name": "youtubeeducation.com.", "ttl": 30, "addr": "192.0.2.69" }}
    ]
  }},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "upstream google" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com.au" }}, "reason": "upstream google au" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.co.nz" }}, "reason": "upstream google nz" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "bing.com" }}, "reason": "upstream bing" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtube.com" }}, "reason": "upstream youtube" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "googleapis.com" }}, "reason": "upstream googleapis" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtube-nocookie.com" }}, "reason": "upstream nocookie" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "ytimg.com" }}, "reason": "upstream ytimg" }},
      {{ "effect": "allow", "match": {{ "type": "exact", "value": "youtu.be" }}, "reason": "upstream youtu.be" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtubeeducation.com" }}, "reason": "upstream youtubeeducation" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "upstream test" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "upstream deny" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{DEVICE}",
    "default_profile": "adult",
    "source_ips": ["127.0.0.1", "127.0.0.2"]
  }}]
}}"#
    )
}

/// `extra_rules` is inserted before the allow rules so a test can add a
/// deny-before-rewrite guard without changing the rest of the profile.
fn worker_config(upstream: SocketAddr, safe_search: &str, extra_rules: &str) -> String {
    format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 7,
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "upstreams": ["{upstream}"],
  "safe_search": {safe_search},
  "profiles": {{
    "adult": [
      {extra_rules}
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "google" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com.au" }}, "reason": "google au" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.co.nz" }}, "reason": "google nz" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "bing.com" }}, "reason": "bing" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtube.com" }}, "reason": "youtube" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "googleapis.com" }}, "reason": "googleapis" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtube-nocookie.com" }}, "reason": "nocookie" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "ytimg.com" }}, "reason": "ytimg" }},
      {{ "effect": "allow", "match": {{ "type": "exact", "value": "youtu.be" }}, "reason": "youtu.be" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "youtubeeducation.com" }}, "reason": "youtubeeducation" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "test" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "restricted google" }},
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "google.com.au" }}, "reason": "restricted google au" }},
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "google.co.nz" }}, "reason": "restricted google nz" }},
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "bing.com" }}, "reason": "restricted bing" }},
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "restricted test" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{DEVICE}",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}]
}}"#
    )
}

async fn start_worker(safe_search: &str, extra_rules: &str) -> (DnsServer, DnsServer) {
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let worker = DnsServer::start(
        Config::parse(worker_config(upstream.bind_addr(), safe_search, extra_rules).as_bytes())
            .unwrap(),
    )
    .await
    .unwrap();
    (worker, upstream)
}

/// Address records must belong to the canonical target, not to the original
/// question name. This is what proves the CNAME was actually followed.
fn addresses_owned_by(message: &Message, target: &str) -> bool {
    message.answers.iter().any(|record| {
        matches!(&record.data, RData::A(_) | RData::AAAA(_))
            && record.name.to_string().eq_ignore_ascii_case(target)
    })
}

#[tokio::test]
async fn google_selected_domain_is_rewritten_and_resolved_through_upstream() {
    let (worker, upstream) = start_worker(GOOGLE_ONLY, "").await;
    let addr = worker.bind_addr();

    let a = udp_query(source(), addr, "www.google.com.", RecordType::A).await;
    assert_code(&a, ResponseCode::NoError);
    assert!(
        cname_targets(&a).contains(&GOOGLE_TARGET.to_owned()),
        "missing official Google CNAME: {:?}",
        a.answers
    );
    assert!(
        addresses(&a).contains(&v4(120)),
        "no usable A glue: {:?}",
        a.answers
    );
    assert!(addresses_owned_by(&a, GOOGLE_TARGET));

    let aaaa = udp_query(source(), addr, "www.google.com.", RecordType::AAAA).await;
    assert_code(&aaaa, ResponseCode::NoError);
    let v6: IpAddr = "2001:db8::120".parse().unwrap();
    assert!(
        addresses(&aaaa).contains(&v6),
        "no usable AAAA glue: {:?}",
        aaaa.answers
    );
    assert!(addresses_owned_by(&aaaa, GOOGLE_TARGET));

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn google_regional_domains_are_rewritten_and_resolved_through_upstream() {
    let (worker, upstream) = start_worker(GOOGLE_ONLY, "").await;
    let addr = worker.bind_addr();
    let v6: IpAddr = "2001:db8::120".parse().unwrap();

    for name in ["www.google.com.au.", "www.google.co.nz."] {
        let a = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&a, ResponseCode::NoError);
        assert!(
            cname_targets(&a).contains(&GOOGLE_TARGET.to_owned()),
            "missing official Google CNAME for {name}: {:?}",
            a.answers
        );
        assert!(
            addresses(&a).contains(&v4(120)),
            "no usable A glue for {name}"
        );
        assert!(addresses_owned_by(&a, GOOGLE_TARGET));

        let aaaa = udp_query(source(), addr, name, RecordType::AAAA).await;
        assert_code(&aaaa, ResponseCode::NoError);
        assert!(
            addresses(&aaaa).contains(&v6),
            "no usable AAAA glue for {name}: {:?}",
            aaaa.answers
        );
        assert!(addresses_owned_by(&aaaa, GOOGLE_TARGET));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn non_catalog_google_owner_is_not_rewritten() {
    let (worker, upstream) = start_worker(BOTH, "").await;
    let addr = worker.bind_addr();

    // `mail.google.com` matches the fixture's `google.com` suffix allow rule,
    // but it is not one of the exact `www.` catalog owners.
    let answer = udp_query(source(), addr, "mail.google.com.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NoError);
    assert!(
        cname_targets(&answer).is_empty(),
        "a non-catalog google owner was rewritten"
    );
    assert!(addresses(&answer).contains(&v4(32)));

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn bing_selected_domains_are_rewritten_and_resolved_through_upstream() {
    let (worker, upstream) = start_worker(BING_ONLY, "").await;
    let addr = worker.bind_addr();

    for name in ["www.bing.com.", "edgeservices.bing.com."] {
        let a = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&a, ResponseCode::NoError);
        assert!(
            cname_targets(&a).contains(&BING_TARGET.to_owned()),
            "missing official Bing CNAME for {name}: {:?}",
            a.answers
        );
        assert!(
            addresses(&a).contains(&v4(220)),
            "no usable A glue for {name}"
        );
        assert!(addresses_owned_by(&a, BING_TARGET));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn unrelated_domain_is_unchanged() {
    let (worker, upstream) = start_worker(BOTH, "").await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, "unrelated.test.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NoError);
    assert!(
        cname_targets(&answer).is_empty(),
        "unrelated name was rewritten"
    );
    assert!(addresses(&answer).contains(&v4(50)));

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn disabled_opt_in_leaves_selected_domains_on_the_normal_path() {
    let (worker, upstream) = start_worker(DISABLED_BUT_REQUESTED, "").await;
    let addr = worker.bind_addr();

    for (name, expected) in [
        ("www.google.com.", v4(10)),
        ("www.google.com.au.", v4(30)),
        ("www.google.co.nz.", v4(31)),
        ("www.bing.com.", v4(20)),
    ] {
        let answer = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
        assert!(
            cname_targets(&answer).is_empty(),
            "{name} rewritten while disabled"
        );
        assert!(addresses(&answer).contains(&expected));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn denied_question_precedes_safe_search_rewrite() {
    let deny = r#"{ "effect": "deny", "match": {"type": "exact", "value": "www.google.com"}, "reason": "question deny" },"#;
    let (worker, upstream) = start_worker(GOOGLE_ONLY, deny).await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, "www.google.com.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NXDomain);
    assert!(cname_targets(&answer).is_empty());
    assert!(addresses(&answer).is_empty());

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn denied_canonical_target_blocks_the_rewritten_answer() {
    let deny = r#"{ "effect": "deny", "match": {"type": "exact", "value": "forcesafesearch.google.com"}, "reason": "target deny" },"#;
    let (worker, upstream) = start_worker(GOOGLE_ONLY, deny).await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, "www.google.com.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NXDomain);
    assert!(cname_targets(&answer).is_empty());
    assert!(addresses(&answer).is_empty());

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn canonical_target_query_is_not_rewritten() {
    let (worker, upstream) = start_worker(BOTH, "").await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, GOOGLE_TARGET, RecordType::A).await;
    assert_code(&answer, ResponseCode::NoError);
    assert!(
        cname_targets(&answer).is_empty(),
        "canonical target was rewritten"
    );
    assert!(addresses(&answer).contains(&v4(120)));

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn upstream_failure_never_releases_an_unfollowed_cname() {
    let (worker, upstream) = start_worker(GOOGLE_ONLY, "").await;
    upstream.stop().await;

    let answer = udp_query(
        source(),
        worker.bind_addr(),
        "www.google.com.",
        RecordType::A,
    )
    .await;
    assert_code(&answer, ResponseCode::ServFail);
    assert!(
        cname_targets(&answer).is_empty(),
        "a bare CNAME escaped on failure"
    );
    assert!(addresses(&answer).is_empty());

    worker.stop().await;
}

#[tokio::test]
async fn youtube_strict_aliases_are_rewritten_and_resolved_through_upstream() {
    let (worker, upstream) = start_worker(YOUTUBE_STRICT, "").await;
    let addr = worker.bind_addr();
    let v6: IpAddr = "2001:db8::140".parse().unwrap();

    for name in YOUTUBE_ALIASES {
        let a = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&a, ResponseCode::NoError);
        assert!(
            cname_targets(&a).contains(&YOUTUBE_STRICT_TARGET.to_owned()),
            "missing strict CNAME for {name}: {:?}",
            a.answers
        );
        assert!(
            addresses(&a).contains(&v4(140)),
            "no usable A glue for {name}: {:?}",
            a.answers
        );
        assert!(addresses_owned_by(&a, YOUTUBE_STRICT_TARGET));

        let aaaa = udp_query(source(), addr, name, RecordType::AAAA).await;
        assert_code(&aaaa, ResponseCode::NoError);
        assert!(
            addresses(&aaaa).contains(&v6),
            "no usable AAAA glue for {name}: {:?}",
            aaaa.answers
        );
        assert!(addresses_owned_by(&aaaa, YOUTUBE_STRICT_TARGET));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_moderate_aliases_are_rewritten_and_resolved_through_upstream() {
    let (worker, upstream) = start_worker(YOUTUBE_MODERATE, "").await;
    let addr = worker.bind_addr();
    let v6: IpAddr = "2001:db8::150".parse().unwrap();

    for name in YOUTUBE_ALIASES {
        let a = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&a, ResponseCode::NoError);
        assert!(
            cname_targets(&a).contains(&YOUTUBE_MODERATE_TARGET.to_owned()),
            "missing moderate CNAME for {name}: {:?}",
            a.answers
        );
        assert!(
            addresses(&a).contains(&v4(150)),
            "no usable A glue for {name}: {:?}",
            a.answers
        );
        assert!(addresses_owned_by(&a, YOUTUBE_MODERATE_TARGET));

        let aaaa = udp_query(source(), addr, name, RecordType::AAAA).await;
        assert_code(&aaaa, ResponseCode::NoError);
        assert!(
            addresses(&aaaa).contains(&v6),
            "no usable AAAA glue for {name}: {:?}",
            aaaa.answers
        );
        assert!(addresses_owned_by(&aaaa, YOUTUBE_MODERATE_TARGET));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_off_leaves_aliases_on_the_normal_path() {
    let (worker, upstream) = start_worker(YOUTUBE_OFF, "").await;
    let addr = worker.bind_addr();

    for (name, expected) in [
        ("www.youtube.com.", v4(60)),
        ("m.youtube.com.", v4(61)),
        ("youtubei.googleapis.com.", v4(62)),
        ("youtube.googleapis.com.", v4(63)),
        ("www.youtube-nocookie.com.", v4(64)),
    ] {
        let answer = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
        assert!(
            cname_targets(&answer).is_empty(),
            "{name} rewritten while YouTube mode is off"
        );
        assert!(
            addresses(&answer).contains(&expected),
            "{name} did not keep its normal answer: {:?}",
            answer.answers
        );
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_do_not_cname_domains_are_never_rewritten() {
    let (worker, upstream) = start_worker(YOUTUBE_STRICT, "").await;
    let addr = worker.bind_addr();

    for (name, expected) in [
        ("youtube.com.", v4(65)),
        ("s.ytimg.com.", v4(66)),
        ("youtu.be.", v4(67)),
        ("googleapis.com.", v4(68)),
        ("youtubeeducation.com.", v4(69)),
    ] {
        let answer = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
        assert!(
            cname_targets(&answer).is_empty(),
            "do-not-CNAME name {name} was rewritten"
        );
        assert!(
            addresses(&answer).contains(&expected),
            "do-not-CNAME name {name} changed: {:?}",
            answer.answers
        );
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_canonical_targets_are_not_rewritten() {
    let (worker, upstream) = start_worker(YOUTUBE_STRICT, "").await;
    let addr = worker.bind_addr();

    for (name, expected) in [
        (YOUTUBE_STRICT_TARGET, v4(140)),
        (YOUTUBE_MODERATE_TARGET, v4(150)),
    ] {
        let answer = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
        assert!(
            cname_targets(&answer).is_empty(),
            "canonical target {name} was rewritten"
        );
        assert!(addresses(&answer).contains(&expected));
    }

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_question_deny_precedes_rewrite() {
    let deny = r#"{ "effect": "deny", "match": {"type": "exact", "value": "www.youtube.com"}, "reason": "question deny" },"#;
    let (worker, upstream) = start_worker(YOUTUBE_STRICT, deny).await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, "www.youtube.com.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NXDomain);
    assert!(cname_targets(&answer).is_empty());
    assert!(addresses(&answer).is_empty());

    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn youtube_canonical_target_deny_blocks_the_rewritten_answer() {
    let deny = r#"{ "effect": "deny", "match": {"type": "exact", "value": "restrict.youtube.com"}, "reason": "target deny" },"#;
    let (worker, upstream) = start_worker(YOUTUBE_STRICT, deny).await;
    let addr = worker.bind_addr();

    let answer = udp_query(source(), addr, "www.youtube.com.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NXDomain);
    assert!(cname_targets(&answer).is_empty());
    assert!(addresses(&answer).is_empty());

    worker.stop().await;
    upstream.stop().await;
}

#[test]
fn malformed_youtube_mode_is_rejected() {
    let upstream: SocketAddr = "127.0.0.1:5353".parse().unwrap();
    for bad in [
        r#"{"enabled":true,"youtube":"bogus"}"#,
        r#"{"enabled":true,"youtube":true}"#,
        r#"{"enabled":true,"youtube":"strict","unknown":1}"#,
    ] {
        assert!(
            Config::parse(worker_config(upstream, bad, "").as_bytes()).is_err(),
            "malformed YouTube mode accepted: {bad}"
        );
    }
    for good in [YOUTUBE_OFF, YOUTUBE_MODERATE, YOUTUBE_STRICT] {
        assert!(
            Config::parse(worker_config(upstream, good, "").as_bytes()).is_ok(),
            "valid YouTube mode rejected: {good}"
        );
    }
}
