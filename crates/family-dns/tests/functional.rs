//! End-to-end tests over real UDP and TCP sockets. Every listener is an
//! ephemeral loopback port; no host resolver, firewall or privileged port is
//! touched.

mod support;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;
use std::time::{Duration, Instant};

use chrono::Utc;
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
        assert_flags(&allowed);
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
        assert_flags(&denied);
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
        assert_flags(&good);
        assert_eq!(addresses(&good).len(), 2);

        let bad = query(mapped(), addr, "badalias.lab.example.", RecordType::A, tcp).await;
        assert_code(&bad, ResponseCode::NXDomain);
        assert_flags(&bad);
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
    assert_flags(&response);
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
    assert_flags(&response);
    server.stop().await;
}

#[tokio::test]
async fn ipv4_mapped_bind_and_source_share_the_ipv4_device_profile() {
    // Bind an IPv4-mapped loopback address; the device is configured with the
    // plain IPv4 spelling. Both native and mapped clients must select it.
    let json = test_config(0, "")
        .replace(
            "\"address\": \"127.0.0.1\"",
            "\"address\": \"::ffff:127.0.0.1\"",
        )
        .replace(
            "\"source_ips\": [\"127.0.0.2\"]",
            "\"source_ips\": [\"127.0.0.1\"]",
        );
    let server = DnsServer::start(Config::parse(json.as_bytes()).unwrap())
        .await
        .unwrap();
    let addr = server.bind_addr();

    for (label, source) in [
        ("native IPv4", IpAddr::V4(Ipv4Addr::LOCALHOST)),
        ("mapped IPv6", ipv4_mapped_loopback()),
    ] {
        // The mapped listener is dual-stack; choose the destination family
        // that matches the client socket.
        let dest = if source.is_ipv4() {
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), addr.port())
        } else {
            SocketAddr::new(ipv4_mapped_loopback(), addr.port())
        };
        let response = udp_query(source, dest, "www.lab.example.", RecordType::A).await;
        assert_code(&response, ResponseCode::NoError);
        assert_flags(&response);
        assert_eq!(addresses(&response).len(), 2, "{label} source was denied");
    }
    let tcp_response = tcp_query(
        ipv4_mapped_loopback(),
        SocketAddr::new(ipv4_mapped_loopback(), addr.port()),
        "www.lab.example.",
        RecordType::A,
    )
    .await;
    assert_code(&tcp_response, ResponseCode::NoError);
    assert_flags(&tcp_response);
    assert_eq!(addresses(&tcp_response).len(), 2);

    assert!(
        server.observations().iter().all(|o| o.device_id.is_some()),
        "mapped sources must not silently fall back to the unknown profile"
    );
    server.stop().await;
}

#[tokio::test]
async fn exact_rewrites_are_served_over_udp_and_tcp_with_configured_ttl() {
    let extra = r#","rewrites":[
        {"type":"a","name":"rewrite.lab.example.","ttl":45,"addr":"192.0.2.40"},
        {"type":"a","name":"rewrite.lab.example.","ttl":45,"addr":"192.0.2.41"},
        {"type":"aaaa","name":"rewrite.lab.example.","ttl":45,"addr":"2001:db8::40"},
        {"type":"cname","name":"aliasrewrite.lab.example.","ttl":30,"target":"www.lab.example."}
    ]"#;
    let config = Config::parse(test_config(0, extra).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    for tcp in [false, true] {
        let a = query(mapped(), addr, "rewrite.lab.example.", RecordType::A, tcp).await;
        assert_code(&a, ResponseCode::NoError);
        assert_flags(&a);
        let mut ips = addresses(&a);
        ips.sort();
        assert_eq!(
            ips,
            vec![
                IpAddr::V4(Ipv4Addr::new(192, 0, 2, 40)),
                IpAddr::V4(Ipv4Addr::new(192, 0, 2, 41)),
            ],
            "all addresses for one exact owner must be summed"
        );
        assert!(a.answers.iter().all(|record| record.ttl == 45));

        let aaaa = query(
            mapped(),
            addr,
            "rewrite.lab.example.",
            RecordType::AAAA,
            tcp,
        )
        .await;
        assert_code(&aaaa, ResponseCode::NoError);
        assert_flags(&aaaa);
        assert_eq!(
            addresses(&aaaa),
            vec![IpAddr::from_str("2001:db8::40").unwrap()]
        );
        assert!(aaaa.answers.iter().all(|record| record.ttl == 45));

        let cname = query(
            mapped(),
            addr,
            "aliasrewrite.lab.example.",
            RecordType::CNAME,
            tcp,
        )
        .await;
        assert_code(&cname, ResponseCode::NoError);
        assert_flags(&cname);
        assert_eq!(cname_targets(&cname), vec!["www.lab.example.".to_owned()]);
        assert!(cname.answers.iter().all(|record| record.ttl == 30));

        // A matching owner with no record of the queried type is a deliberate
        // NODATA answer, not a fall-through to a zone or an upstream.
        let nodata = query(mapped(), addr, "rewrite.lab.example.", RecordType::TXT, tcp).await;
        assert_code(&nodata, ResponseCode::NoError);
        assert_flags(&nodata);
        assert!(nodata.answers.is_empty());

        // The override is exact: a sibling name keeps its own zone answer and
        // a subdomain does not inherit the configured address.
        let sibling = query(mapped(), addr, "www.lab.example.", RecordType::A, tcp).await;
        assert_code(&sibling, ResponseCode::NoError);
        assert_eq!(addresses(&sibling).len(), 2);
        let sub = query(
            mapped(),
            addr,
            "sub.rewrite.lab.example.",
            RecordType::A,
            tcp,
        )
        .await;
        assert!(!addresses(&sub).contains(&IpAddr::V4(Ipv4Addr::new(192, 0, 2, 40))));
    }
    server.stop().await;
}

#[tokio::test]
async fn exact_rewrites_cannot_bypass_denials_or_alias_target_policy() {
    let extra = r#","rewrites":[
        {"type":"a","name":"blocked.lab.example.","ttl":45,"addr":"192.0.2.40"},
        {"type":"cname","name":"rewrittenalias.lab.example.","ttl":30,"target":"blocked.lab.example."}
    ]"#;
    let config = Config::parse(test_config(0, extra).as_bytes()).unwrap();
    let server = DnsServer::start(config).await.unwrap();
    let addr = server.bind_addr();

    for tcp in [false, true] {
        let denied = query(mapped(), addr, "blocked.lab.example.", RecordType::A, tcp).await;
        assert_code(&denied, ResponseCode::NXDomain);
        assert_flags(&denied);
        assert!(
            addresses(&denied).is_empty(),
            "a household deny must win over an exact rewrite"
        );

        let aliased = query(
            mapped(),
            addr,
            "rewrittenalias.lab.example.",
            RecordType::A,
            tcp,
        )
        .await;
        assert_code(&aliased, ResponseCode::NXDomain);
        assert_flags(&aliased);
        assert!(
            addresses(&aliased).is_empty(),
            "a rewrite CNAME must not leak a denied canonical target"
        );
    }

    let observations = server.observations();
    assert!(observations
        .iter()
        .any(|o| { o.name == "blocked.lab.example." && !o.allow && o.device_id.is_some() }));
    assert!(observations.iter().any(|o| {
        o.name == "rewrittenalias.lab.example."
            && !o.allow
            && o.denied_alias_target.as_deref() == Some("blocked.lab.example.")
    }));
    server.stop().await;
}

#[tokio::test]
async fn reload_swaps_exact_rewrites_on_one_immutable_snapshot() {
    let server = DnsServer::start(Config::parse(test_config(0, "").as_bytes()).unwrap())
        .await
        .unwrap();
    let addr = server.bind_addr();
    let before = udp_query(mapped(), addr, "rewrite.lab.example.", RecordType::A).await;
    assert!(addresses(&before).is_empty());

    let extra =
        r#","rewrites":[{"type":"a","name":"rewrite.lab.example.","ttl":50,"addr":"192.0.2.50"}]"#;
    let candidate =
        test_config(0, extra).replace("\"policy_revision\": 7", "\"policy_revision\": 8");
    let outcome = server.reload(candidate.as_bytes(), Utc::now()).unwrap();
    assert_eq!(outcome.revision, 8);
    assert_eq!(outcome.generation, 8);
    assert_eq!(server.status().bundle_generation, 8);

    for tcp in [false, true] {
        let after = query(mapped(), addr, "rewrite.lab.example.", RecordType::A, tcp).await;
        assert_code(&after, ResponseCode::NoError);
        assert_flags(&after);
        assert_eq!(
            addresses(&after),
            vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 50))]
        );
        assert!(after.answers.iter().all(|record| record.ttl == 50));
    }
    assert!(server
        .observations()
        .iter()
        .any(|o| { o.name == "rewrite.lab.example." && o.allow && o.policy_revision == 8 }));
    server.stop().await;
}

#[tokio::test]
async fn mapped_selfloop_is_rejected_before_any_listener_exists() {
    // Same listener spelled as IPv4-mapped IPv6 on bind and plain IPv4 on the
    // upstream. Validation must reject it without binding either socket.
    let probe = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let json = test_config(port, &format!(r#","upstreams":["127.0.0.1:{port}"]"#)).replace(
        "\"address\": \"127.0.0.1\"",
        "\"address\": \"::ffff:127.0.0.1\"",
    );
    assert!(Config::parse(json.as_bytes()).is_err());
    let rebound = tokio::net::UdpSocket::bind(("127.0.0.1", port)).await;
    assert!(
        rebound.is_ok(),
        "a rejected self-loop must not leave a listener behind"
    );
}
