//! End-to-end tests over real UDP and TCP sockets. Every listener is an
//! ephemeral loopback port; no host resolver, firewall or privileged port is
//! touched.

mod support;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use std::time::{Duration, Instant};

use family_dns::{Config, DnsServer};
use family_policy::EffectiveIdentity;
use hickory_server::proto::op::ResponseCode;
use hickory_server::proto::rr::RecordType;
use support::*;

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}
fn unknown() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 3))
}

async fn query(
    source: IpAddr,
    server: SocketAddr,
    name: &str,
    qtype: RecordType,
    tcp: bool,
) -> hickory_server::proto::op::Message {
    if tcp {
        tcp_query(source, server, name, qtype).await
    } else {
        udp_query(source, server, name, qtype).await
    }
}

#[tokio::test]
async fn udp_and_tcp_serve_allowed_and_blocked_queries() {
    let config = Config::parse(test_config(0, "").as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    for tcp in [false, true] {
        let allowed = query(mapped(), addr, "www.lab.example.", RecordType::A, tcp).await;
        assert_code(&allowed, ResponseCode::NoError);
        let mut ips = addresses(&allowed);
        ips.sort();
        assert_eq!(
            ips,
            vec![
                IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10)),
                IpAddr::V4(Ipv4Addr::new(192, 0, 2, 11)),
            ],
            "both A records must survive in one record set"
        );

        let denied = query(mapped(), addr, "blocked.lab.example.", RecordType::A, tcp).await;
        assert_code(&denied, ResponseCode::NXDomain);
        assert!(addresses(&denied).is_empty());
    }

    let observations = server.observations();
    assert!(
        observations.iter().any(|o| {
            o.name == "www.lab.example."
                && o.allow
                && o.policy_revision == 7
                && o.reason_code == "device_profile_allow"
                && o.device_id.is_some()
        }),
        "allow decision must be observable with revision and reason: {observations:?}"
    );
    assert!(
        observations.iter().any(|o| {
            o.name == "blocked.lab.example." && !o.allow && o.reason_code == "device_profile_deny"
        }),
        "deny decision must be observable with its reason"
    );
    server.stop().await;
}

#[tokio::test]
async fn unknown_source_uses_the_restrictive_default_and_reports_unknown_identity() {
    let config = Config::parse(test_config(0, "").as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    let mapped_result = udp_query(mapped(), addr, "www.lab.example.", RecordType::A).await;
    assert_code(&mapped_result, ResponseCode::NoError);
    let unknown_result = udp_query(unknown(), addr, "www.lab.example.", RecordType::A).await;
    assert_code(&unknown_result, ResponseCode::NXDomain);
    assert!(addresses(&unknown_result).is_empty());

    let observations = server.observations();
    let unknown_observation = observations
        .iter()
        .find(|o| o.source_ip == unknown())
        .expect("unknown source must produce an observation");
    assert!(!unknown_observation.allow);
    assert!(unknown_observation.device_id.is_none());
    assert_eq!(unknown_observation.identity, EffectiveIdentity::Unknown);
    assert_eq!(unknown_observation.policy_revision, 7);
    server.stop().await;
}

#[tokio::test]
async fn deny_precedes_allow_within_one_profile() {
    let config = Config::parse(test_config(0, "").as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    // The adult profile allows the `example` suffix but denies this exact
    // name; the narrow deny must win (no "most permissive rule wins").
    let denied = udp_query(mapped(), addr, "blocked.lab.example.", RecordType::A).await;
    assert_code(&denied, ResponseCode::NXDomain);
    let allowed = udp_query(mapped(), addr, "www.lab.example.", RecordType::A).await;
    assert_code(&allowed, ResponseCode::NoError);
    server.stop().await;
}

#[tokio::test]
async fn local_zone_keeps_multiple_a_aaaa_and_cname_records() {
    let config = Config::parse(test_config(0, "").as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    let a = udp_query(mapped(), addr, "www.lab.example.", RecordType::A).await;
    assert_code(&a, ResponseCode::NoError);
    assert_eq!(addresses(&a).len(), 2);
    let aaaa = udp_query(mapped(), addr, "www.lab.example.", RecordType::AAAA).await;
    assert_code(&aaaa, ResponseCode::NoError);
    let mut v6 = addresses(&aaaa);
    v6.sort();
    assert_eq!(
        v6,
        vec![
            IpAddr::from_str("2001:db8::10").unwrap(),
            IpAddr::from_str("2001:db8::11").unwrap(),
        ]
    );
    let cname = udp_query(mapped(), addr, "alias.lab.example.", RecordType::CNAME).await;
    assert_code(&cname, ResponseCode::NoError);
    assert_eq!(cname_targets(&cname), vec!["www.lab.example.".to_owned()]);
    server.stop().await;
}

#[tokio::test]
async fn allowed_alias_cannot_chain_to_a_denied_target() {
    let config = Config::parse(test_config(0, "").as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    for tcp in [false, true] {
        let good = query(mapped(), addr, "alias.lab.example.", RecordType::A, tcp).await;
        assert_code(&good, ResponseCode::NoError);
        assert_eq!(addresses(&good).len(), 2);

        let bad = query(mapped(), addr, "badalias.lab.example.", RecordType::A, tcp).await;
        assert_code(&bad, ResponseCode::NXDomain);
        assert!(
            addresses(&bad).is_empty(),
            "a denied CNAME target must not leak addresses"
        );
    }

    let observations = server.observations();
    assert!(
        observations.iter().any(|o| {
            !o.allow && o.denied_alias_target.as_deref() == Some("blocked.lab.example.")
        }),
        "chain denial must record the denied target: {observations:?}"
    );
    server.stop().await;
}

#[tokio::test]
async fn negative_cache_is_reused_and_outage_does_not_widen_access() {
    // The upstream is another real server: its local zone produces genuine
    // authoritative NXDOMAIN + SOA records through Hickory.
    let upstream = DnsServer::start(Config::parse(upstream_config(0).as_bytes()).unwrap())
        .await
        .unwrap();
    let extra = format!(r#","upstreams":["{}"]"#, upstream.bind_addr());
    let config = Config::parse(test_config(0, &extra).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();
    upstream.clear_observations();

    for _ in 0..2 {
        let answer = udp_query(mapped(), addr, "missing.upstream.test.", RecordType::A).await;
        assert_code(&answer, ResponseCode::NXDomain);
        assert!(
            answer
                .authorities
                .iter()
                .any(|record| record.record_type() == RecordType::SOA),
            "negative answer must carry the upstream SOA/TTL"
        );
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let forwarded = upstream
        .observations()
        .iter()
        .filter(|o| o.name == "missing.upstream.test.")
        .count();
    assert_eq!(
        forwarded, 1,
        "the second identical query should be answered from the forwarder cache"
    );

    upstream.stop().await;
    // A fresh allowed name cannot be answered while the upstream is down.
    let outage = udp_query(mapped(), addr, "fresh.upstream.test.", RecordType::A).await;
    assert!(
        addresses(&outage).is_empty(),
        "upstream outage must not widen access"
    );
    // Denials remain enforced regardless of upstream state.
    let denied = udp_query(mapped(), addr, "blocked.lab.example.", RecordType::A).await;
    assert_code(&denied, ResponseCode::NXDomain);
    assert!(server
        .observations()
        .iter()
        .any(|o| o.name == "blocked.lab.example." && !o.allow));
    server.stop().await;
}

#[tokio::test]
async fn stalled_upstream_does_not_serialize_local_queries() {
    let blackhole = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let extra = format!(r#","upstreams":["{}"]"#, blackhole.local_addr().unwrap());
    let config = Config::parse(test_config(0, &extra).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    let stalled = {
        let resolver_addr = addr;
        tokio::spawn(async move {
            let _ = udp_query(
                mapped(),
                resolver_addr,
                "stalled.remote.test.",
                RecordType::A,
            )
            .await;
        })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        !stalled.is_finished(),
        "the forwarded query should still be waiting on the black-hole upstream"
    );

    let started = Instant::now();
    let local = tokio::time::timeout(
        Duration::from_secs(1),
        udp_query(mapped(), addr, "www.lab.example.", RecordType::A),
    )
    .await
    .expect("local query waited on the stalled upstream");
    assert_eq!(addresses(&local).len(), 2);
    assert!(started.elapsed() < Duration::from_secs(1));

    stalled.abort();
    let _ = stalled.await;
    drop(blackhole);
    server.stop().await;
}

#[tokio::test]
async fn sinkhole_and_refused_denial_modes_are_configurable() {
    let sinkhole = r#","deny":{"mode":"sinkhole","ipv4":"192.0.2.0","ttl":30}"#;
    let config = Config::parse(test_config(0, sinkhole).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let response = udp_query(
        mapped(),
        server.bind_addr(),
        "blocked.lab.example.",
        RecordType::A,
    )
    .await;
    assert_code(&response, ResponseCode::NoError);
    assert_eq!(
        addresses(&response),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 0))]
    );
    assert_eq!(response.answers[0].ttl, 30);
    server.stop().await;

    let refused = r#","deny":{"mode":"refused"}"#;
    let config = Config::parse(test_config(0, refused).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let response = udp_query(
        mapped(),
        server.bind_addr(),
        "blocked.lab.example.",
        RecordType::A,
    )
    .await;
    assert_code(&response, ResponseCode::Refused);
    server.stop().await;
}
