//! Real UDP tests for the global SafeSearch opt-in slice.
//!
//! Both providers use the hostnames named by their official support documents:
//! www.google.com -> forcesafesearch.google.com and
//! www.bing.com / edgeservices.bing.com -> strict.bing.com. No provider IP is
//! configured: the worker follows the CNAME through its configured upstream
//! with the maintained Hickory resolver and returns usable A/AAAA glue.
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

const GOOGLE_ONLY: &str = r#"{"enabled":true,"google":true,"bing":false}"#;
const BING_ONLY: &str = r#"{"enabled":true,"google":false,"bing":true}"#;
const BOTH: &str = r#"{"enabled":true,"google":true,"bing":true}"#;
const DISABLED_BUT_REQUESTED: &str = r#"{"enabled":false,"google":true,"bing":true}"#;

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
    "www.bing.com.": [
      {{ "type": "a", "name": "www.bing.com.", "ttl": 30, "addr": "192.0.2.20" }}
    ],
    "unrelated.test.": [
      {{ "type": "a", "name": "unrelated.test.", "ttl": 30, "addr": "192.0.2.50" }}
    ]
  }},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "upstream google" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "bing.com" }}, "reason": "upstream bing" }},
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
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "bing.com" }}, "reason": "bing" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "test" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "restricted google" }},
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

    for name in ["www.google.com.", "www.bing.com."] {
        let answer = udp_query(source(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
        assert!(
            cname_targets(&answer).is_empty(),
            "{name} rewritten while disabled"
        );
        let expected = if name.starts_with("www.google") {
            v4(10)
        } else {
            v4(20)
        };
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
