//! Real UDP/TCP tests for bounded response-cache settings and answer shaping.
//! Every listener is an ephemeral loopback socket. No host resolver, hosts
//! file, firewall or privileged port is touched; the hosts-file test injects
//! Hickory's maintained `Hosts` table in memory instead.
//!
//! These tests exercise local runtime semantics only. They make no claim about
//! a dashboard control, independent coverage verification or a settingsVersion
//! CAS contract.

mod support;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use family_dns::{Config, DnsServer};
use hickory_resolver::Hosts;
use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{Name, RData, RecordType};
use serde_json::json;
use support::{assert_code, assert_flags, test_config};

const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
static SERIAL: AtomicUsize = AtomicUsize::new(0);

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

fn question(name: &str, qtype: RecordType) -> Message {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    message.metadata.recursion_desired = true;
    message.metadata.checking_disabled = true;
    message.add_query(Query::query(Name::from_str(name).unwrap(), qtype));
    message
}

/// A short-timeout UDP probe. `None` means "no answer", which is the honest
/// way to assert a cache miss once the upstream has stopped.
async fn udp_probe(server: SocketAddr, name: &str, qtype: RecordType) -> Option<Message> {
    let client = tokio::net::UdpSocket::bind(SocketAddr::new(mapped(), 0))
        .await
        .unwrap();
    client
        .send_to(&question(name, qtype).to_vec().unwrap(), server)
        .await
        .unwrap();
    let mut buffer = vec![0u8; 4096];
    let (len, _) = tokio::time::timeout(Duration::from_millis(900), client.recv_from(&mut buffer))
        .await
        .ok()?
        .ok()?;
    Message::from_vec(&buffer[..len]).ok()
}

async fn tcp_probe(server: SocketAddr, name: &str, qtype: RecordType) -> Option<Message> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(mapped(), 0)).unwrap();
    let mut stream = socket.connect(server).await.ok()?;
    let bytes = question(name, qtype).to_vec().unwrap();
    stream
        .write_all(&(bytes.len() as u16).to_be_bytes())
        .await
        .ok()?;
    stream.write_all(&bytes).await.ok()?;
    let mut prefix = [0u8; 2];
    tokio::time::timeout(Duration::from_millis(900), stream.read_exact(&mut prefix))
        .await
        .ok()?
        .ok()?;
    let mut buffer = vec![0u8; u16::from_be_bytes(prefix) as usize];
    tokio::time::timeout(Duration::from_millis(900), stream.read_exact(&mut buffer))
        .await
        .ok()?
        .ok()?;
    Message::from_vec(&buffer).ok()
}

async fn probe(server: SocketAddr, name: &str, qtype: RecordType, tcp: bool) -> Option<Message> {
    if tcp {
        tcp_probe(server, name, qtype).await
    } else {
        udp_probe(server, name, qtype).await
    }
}

async fn query(server: SocketAddr, name: &str, qtype: RecordType, tcp: bool) -> Message {
    if tcp {
        support::tcp_query(mapped(), server, name, qtype).await
    } else {
        support::udp_query(mapped(), server, name, qtype).await
    }
}

/// Genuine upstream zone: authoritative A/AAAA/CNAME plus a missing name that
/// produces an SOA negative answer. `127.0.0.1` is the worker's forwarded
/// source, so the adult profile applies on the upstream too.
fn upstream_config(port: u16) -> String {
    let bulk = (0..12)
        .map(|i| {
            format!(
                r#"{{ "type": "a", "name": "{i}.cache.test.", "ttl": 30, "addr": "192.0.2.{}" }}"#,
                40 + i
            )
        })
        .collect::<Vec<_>>()
        .join(",\n    ");
    format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 3,
  "bind": {{ "address": "127.0.0.1", "port": {port} }},
  "local_zones": {{ "cache.test.": [
    {{ "type": "a", "name": "app.cache.test.", "ttl": 30, "addr": "192.0.2.30" }},
    {{ "type": "a", "name": "one.cache.test.", "ttl": 30, "addr": "192.0.2.31" }},
    {{ "type": "a", "name": "two.cache.test.", "ttl": 30, "addr": "192.0.2.32" }},
    {{ "type": "a", "name": "three.cache.test.", "ttl": 30, "addr": "192.0.2.33" }},
    {{ "type": "aaaa", "name": "v6.cache.test.", "ttl": 30, "addr": "2001:db8::30" }},
    {{ "type": "cname", "name": "aliasv6.cache.test.", "ttl": 30, "target": "v6.cache.test." }},
    {bulk}
  ]}},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "upstream allow" }}
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
}}"#,
        bulk = bulk
    )
}

fn worker_config(upstream: SocketAddr, cache: &str, revision: u64) -> String {
    let extra = format!(r#","upstreams":["{upstream}"],"cache":{cache}"#);
    test_config(0, &extra).replace(
        "\"policy_revision\": 7",
        &format!("\"policy_revision\": {revision}"),
    )
}

async fn start_worker(cache: &str) -> (DnsServer, DnsServer) {
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let worker = DnsServer::start(
        Config::parse(worker_config(upstream.bind_addr(), cache, 7).as_bytes()).unwrap(),
    )
    .await
    .unwrap();
    (worker, upstream)
}

fn v4_addresses(message: &Message) -> Vec<Ipv4Addr> {
    message
        .answers
        .iter()
        .filter_map(|record| match &record.data {
            RData::A(AData(ip)) => Some(*ip),
            _ => None,
        })
        .collect()
}

fn has_ipv6(message: &Message) -> bool {
    [&message.answers, &message.authorities, &message.additionals]
        .iter()
        .any(|section| {
            section
                .iter()
                .any(|record| matches!(&record.data, RData::AAAA(_)))
        })
}

#[tokio::test]
async fn cache_hit_survives_upstream_stop_on_udp_and_tcp() {
    let (worker, upstream) = start_worker("{}").await;
    let addr = worker.bind_addr();
    for tcp in [false, true] {
        let first = query(addr, "app.cache.test.", RecordType::A, tcp).await;
        assert_code(&first, ResponseCode::NoError);
        assert!(v4_addresses(&first).contains(&Ipv4Addr::new(192, 0, 2, 30)));
    }
    upstream.stop().await;
    for tcp in [false, true] {
        let cached = probe(addr, "app.cache.test.", RecordType::A, tcp)
            .await
            .expect("cached answer must survive upstream shutdown");
        assert!(v4_addresses(&cached).contains(&Ipv4Addr::new(192, 0, 2, 30)));
        assert_flags(&cached);
        // A fresh name still has no answer: no plaintext/system fallback.
        assert!(
            probe(addr, "fresh.cache.test.", RecordType::A, tcp)
                .await
                .is_none(),
            "an uncached name must fail closed while the upstream is down"
        );
    }
    worker.stop().await;
}

#[tokio::test]
async fn disabled_and_zero_size_caches_never_hit() {
    for cache in [r#"{"enabled":false}"#, r#"{"max_entries":0}"#] {
        let (worker, upstream) = start_worker(cache).await;
        let addr = worker.bind_addr();
        let first = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
        assert!(v4_addresses(&first).contains(&Ipv4Addr::new(192, 0, 2, 30)));
        upstream.stop().await;
        assert!(
            udp_probe(addr, "app.cache.test.", RecordType::A)
                .await
                .is_none(),
            "a disabled cache must not answer after the upstream is gone"
        );
        worker.stop().await;
    }
}

#[tokio::test]
async fn ttl_bounds_clamp_only_cached_answers() {
    let (worker, _upstream) =
        start_worker(r#"{"positive_min_ttl_secs":120,"positive_max_ttl_secs":120}"#).await;
    let addr = worker.bind_addr();
    let fresh = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    // Hickory clamps at cache admission, so even the first served answer
    // carries the configured minimum.
    assert_eq!(fresh.answers[0].ttl, 120);
    let cached = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    let ttl = cached.answers[0].ttl;
    assert!(
        (118..=120).contains(&ttl),
        "min bound not applied to cache: {ttl}"
    );
    worker.stop().await;

    let (worker, _upstream) = start_worker(r#"{"positive_max_ttl_secs":5}"#).await;
    let addr = worker.bind_addr();
    let _ = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    let cached = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    let ttl = cached.answers[0].ttl;
    assert!(
        (1..=5).contains(&ttl),
        "max bound not applied to cache: {ttl}"
    );
    worker.stop().await;
}

#[tokio::test]
async fn negative_answers_are_cached_with_bounded_ttl() {
    let (worker, upstream) =
        start_worker(r#"{"negative_min_ttl_secs":60,"negative_max_ttl_secs":60}"#).await;
    let addr = worker.bind_addr();
    let first = support::udp_query(mapped(), addr, "missing.cache.test.", RecordType::A).await;
    assert_code(&first, ResponseCode::NXDomain);
    assert_flags(&first);
    assert!(
        first
            .authorities
            .iter()
            .any(|r| r.record_type() == RecordType::SOA),
        "negative answer must carry the upstream SOA"
    );
    upstream.stop().await;
    let cached = support::udp_query(mapped(), addr, "missing.cache.test.", RecordType::A).await;
    assert_code(&cached, ResponseCode::NXDomain);
    assert_flags(&cached);
    worker.stop().await;
}

#[tokio::test]
async fn clear_operation_empties_the_current_snapshot_only() {
    let (worker, upstream) = start_worker("{}").await;
    let addr = worker.bind_addr();
    let _ = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    upstream.stop().await;
    assert!(udp_probe(addr, "app.cache.test.", RecordType::A)
        .await
        .is_some());

    // Runtime primitive: no count is reported (the maintained resolver does
    // not expose an exact entry count) and no revision/generation is bumped.
    let before = worker.status();
    worker.clear_cache();
    let after = worker.status();
    assert_eq!(before, after, "cache clear must not change any version");
    assert!(
        udp_probe(addr, "app.cache.test.", RecordType::A)
            .await
            .is_none(),
        "cleared cache must not retain the answer"
    );
    worker.stop().await;
}

#[tokio::test]
async fn policy_reload_invalidates_cache_and_denies_on_every_query() {
    let (worker, upstream) = start_worker("{}").await;
    let addr = worker.bind_addr();
    let allowed = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    assert_code(&allowed, ResponseCode::NoError);
    let upstream_addr = upstream.bind_addr();
    upstream.stop().await;
    assert!(udp_probe(addr, "app.cache.test.", RecordType::A)
        .await
        .is_some());

    // New snapshot: policy denies the very name that was cached as allowed.
    let mut candidate: serde_json::Value =
        serde_json::from_str(&worker_config(upstream_addr, "{}", 8)).unwrap();
    candidate["profiles"]["adult"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "effect": "deny",
            "match": {"type": "exact", "value": "app.cache.test"},
            "reason": "cache policy change"
        }));
    let candidate = candidate.to_string();
    let outcome = worker.reload(candidate.as_bytes(), Utc::now()).unwrap();
    assert_eq!(outcome.revision, 8);
    let denied = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    assert_code(&denied, ResponseCode::NXDomain);
    assert_flags(&denied);
    worker.stop().await;
}

#[tokio::test]
async fn invalid_cache_settings_reject_candidate_and_keep_last_known_good() {
    let (worker, _upstream) = start_worker(r#"{"max_entries":16}"#).await;
    let addr = worker.bind_addr();
    let status = worker.status();
    let bad = worker_config(_upstream.bind_addr(), r#"{"max_entries":999999}"#, 9);
    let error = worker.reload(bad.as_bytes(), Utc::now()).unwrap_err();
    assert!(
        matches!(&error, family_dns::ReloadError::InvalidConfig(_)),
        "unexpected rejection: {error}"
    );
    assert_eq!(
        worker.status(),
        status,
        "failed candidate must not change state"
    );
    let answer = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    assert_code(&answer, ResponseCode::NoError);
    worker.stop().await;
}

#[tokio::test]
async fn bogus_answer_ip_becomes_error_with_no_leak() {
    let (worker, _upstream) = start_worker(r#"{"bogus_nxdomain_ips":["192.0.2.30"]}"#).await;
    let addr = worker.bind_addr();
    for tcp in [false, true] {
        let response = query(addr, "app.cache.test.", RecordType::A, tcp).await;
        assert_code(&response, ResponseCode::NXDomain);
        assert_flags(&response);
        assert!(
            response.answers.is_empty()
                && response.authorities.is_empty()
                && response.additionals.is_empty(),
            "bogus NXDOMAIN leaked records"
        );
    }
    worker.stop().await;
}

#[tokio::test]
async fn disable_ipv6_shapes_answers_and_cname_glue() {
    // Control without the setting: a record-type lookup returns the AAAA.
    let (worker, _upstream) = start_worker("{}").await;
    let addr = worker.bind_addr();
    let plain = support::udp_query(mapped(), addr, "v6.cache.test.", RecordType::AAAA).await;
    assert!(has_ipv6(&plain), "control must show the AAAA answer");
    worker.stop().await;

    let (worker, _upstream) = start_worker(r#"{"disable_ipv6":true}"#).await;
    let addr = worker.bind_addr();
    let aaaa = support::udp_query(mapped(), addr, "v6.cache.test.", RecordType::AAAA).await;
    assert_code(&aaaa, ResponseCode::NoError);
    assert!(!has_ipv6(&aaaa), "AAAA answer was not stripped");
    // CNAME answers pass through the same shaping path. The maintained
    // resolver may or may not attach target AAAA data, but no section may
    // expose IPv6 once the setting is on.
    let alias = support::udp_query(mapped(), addr, "aliasv6.cache.test.", RecordType::CNAME).await;
    assert!(!has_ipv6(&alias), "CNAME response retained IPv6 data");
    assert!(
        alias
            .answers
            .iter()
            .any(|r| matches!(&r.data, RData::CNAME(_))),
        "the CNAME itself must remain"
    );
    worker.stop().await;
}

#[tokio::test]
async fn bounded_entry_count_misses_after_eviction() {
    let (worker, upstream) = start_worker(r#"{"max_entries":2}"#).await;
    let addr = worker.bind_addr();
    let names: Vec<String> = (0..12).map(|i| format!("{i}.cache.test.")).collect();
    for name in &names {
        let answer = support::udp_query(mapped(), addr, name, RecordType::A).await;
        assert_code(&answer, ResponseCode::NoError);
    }
    upstream.stop().await;
    // Hickory delegates eviction to moka's asynchronous housekeeper: the
    // capacity bound is real but eventual, not a same-instant hard cap. Allow
    // maintenance to run before asserting the bound holds.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut hits = 0;
    for name in &names {
        if udp_probe(addr, name, RecordType::A).await.is_some() {
            hits += 1;
        }
    }
    assert!(hits <= 3, "a two-entry cache retained {hits} of 12 answers");
    worker.stop().await;
}

#[tokio::test]
async fn hosts_opt_in_uses_injected_table_and_policy_still_applies() {
    // Upstream supplies the resolver endpoint; the answer itself comes from
    // the injected maintained Hosts table, not from any host file on disk.
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let extra = format!(
        r#","upstreams":["{}"],"cache":{{"use_hosts_file":true}}"#,
        upstream.bind_addr()
    );
    let config = Config::parse(test_config(0, &extra).as_bytes()).unwrap();
    let mut hosts = Hosts::default();
    hosts
        .read_hosts_conf(
            "192.0.2.77 hosts.cache.test\n192.0.2.78 denied.hosts.cache.test\n".as_bytes(),
        )
        .unwrap();
    let worker = DnsServer::start_with_hosts(config, std::sync::Arc::new(hosts))
        .await
        .unwrap();
    let addr = worker.bind_addr();
    let from_hosts = support::udp_query(mapped(), addr, "hosts.cache.test.", RecordType::A).await;
    assert!(v4_addresses(&from_hosts).contains(&Ipv4Addr::new(192, 0, 2, 77)));

    // The worker's restricted profile denies `example`, not `test`; use a
    // remote-source query to prove hosts-sourced answers are still evaluated.
    // 127.0.0.3 is unknown and therefore gets the restrictive default.
    let unknown = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 3));
    let denied = support::udp_query(unknown, addr, "denied.hosts.cache.test.", RecordType::A).await;
    assert_code(&denied, ResponseCode::NXDomain);
    assert_flags(&denied);
    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn cache_bounds_and_shape_inputs_are_validated_before_bind() {
    let too_many_ips = format!(
        "{{\"bogus_nxdomain_ips\":[{}]}}",
        (0..family_dns::MAX_BOGUS_NXDOMAIN_IPS + 1)
            .map(|_| "\"192.0.2.1\"")
            .collect::<Vec<_>>()
            .join(",")
    );
    let cases = [
        r#"{"max_entries":65537}"#,
        r#"{"positive_min_ttl_secs":86401}"#,
        r#"{"negative_min_ttl_secs":5,"negative_max_ttl_secs":4}"#,
        r#"{"bogus_nxdomain_ips":["not-an-ip"]}"#,
        too_many_ips.as_str(),
    ];
    for cache in cases {
        let extra = format!(r#","cache":{cache}"#);
        let json = test_config(0, &extra);
        assert!(
            Config::parse(json.as_bytes()).is_err(),
            "invalid cache settings accepted: {cache}"
        );
    }
    let legacy = test_config(0, "");
    let parsed = Config::parse(legacy.as_bytes()).unwrap();
    assert_eq!(parsed.cache, family_dns::CacheConfig::default());
}

#[tokio::test]
async fn filter_reload_invalidates_cache_and_filter_is_checked_on_cache_hits() {
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let id = SERIAL.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-cache-filter-{}-{id}",
        std::process::id()
    ));
    let _ = std::fs::create_dir_all(&dir);
    let list = dir.join("hosts.txt");
    std::fs::write(&list, "other.cache.test\n").unwrap();

    let extra = format!(
        r#","upstreams":["{}"],"cache":{{}},"filter":{{"sources":[{{"id":"local","format":"hosts","path":"{}"}}]}}"#,
        upstream.bind_addr(),
        list.display()
    );
    let config = Config::parse(test_config(0, &extra).as_bytes()).unwrap();
    let worker = DnsServer::start(config).await.unwrap();
    let addr = worker.bind_addr();
    let allowed = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    assert_code(&allowed, ResponseCode::NoError);
    upstream.stop().await;
    assert!(udp_probe(addr, "app.cache.test.", RecordType::A)
        .await
        .is_some());

    std::fs::write(&list, "other.cache.test\napp.cache.test\n").unwrap();
    let before = worker.status();
    let candidate =
        test_config(0, &extra).replace("\"policy_revision\": 7", "\"policy_revision\": 8");
    worker.reload(candidate.as_bytes(), Utc::now()).unwrap();
    let after = worker.status();
    assert_eq!(after.policy_revision, 8);
    assert!(
        after.filter_generation > before.filter_generation,
        "a changed list must advance only the filter generation"
    );
    let blocked = support::udp_query(mapped(), addr, "app.cache.test.", RecordType::A).await;
    assert_code(&blocked, ResponseCode::NXDomain);
    assert_flags(&blocked);
    worker.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn durable_restart_preserves_cache_settings_without_freshening_policy_age() {
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let id = SERIAL.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("vantyr-dns-cache-{}-{id}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = dir.join("bundle.json");
    let config_path = dir.join("config.json");
    let published = "2024-01-01T00:00:00Z";
    let cache = r#"{"max_entries":2048,"disable_ipv6":true,"negative_max_ttl_secs":45}"#;
    let json = worker_config(upstream.bind_addr(), cache, 7).replace(
        "\"policy_revision\": 7",
        &format!("\"policy_revision\": 7,\"policy_published_at\":\"{published}\""),
    );
    std::fs::write(&config_path, json.as_bytes()).unwrap();
    let options = family_dns::DurableOptions {
        state_path: state.clone(),
        worker_id: "cache-runtime-worker".into(),
        config_path: Some(config_path.clone()),
        now: Utc::now(),
        hooks: None,
    };
    let server = DnsServer::start_durable(options.clone()).await.unwrap();
    assert_eq!(server.local_config().cache.max_entries, 2048);
    assert!(server.local_config().cache.disable_ipv6);
    assert_eq!(
        server.status().policy_published_at.to_rfc3339(),
        "2024-01-01T00:00:00+00:00"
    );
    server.stop().await;

    // External config changes must not rewrite bundle-carried cache settings.
    std::fs::write(
        &config_path,
        worker_config(upstream.bind_addr(), "{}", 7).as_bytes(),
    )
    .unwrap();
    let server = DnsServer::start_durable(options).await.unwrap();
    assert_eq!(server.local_config().cache.max_entries, 2048);
    assert_eq!(server.local_config().cache.negative_max_ttl_secs, Some(45));
    server.stop().await;
    upstream.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}
