//! Real-socket behaviour tests for Vantyr Proxy. All listeners are ephemeral
//! loopback sockets; no DNS, DHCP, router, firewall or CA state is touched.

mod support;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use family_policy::Effect;
use family_proxy::{DestinationConfig, MatchSpec, ProxyServer, RuleSpec};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn http_get(authority: &str, path: &str, auth: Option<&str>) -> String {
    let auth = auth
        .map(|value| format!("Proxy-Authorization: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "GET http://{authority}{path} HTTP/1.1\r\nHost: {authority}\r\n{auth}Connection: close\r\n\r\n"
    )
}

fn connect_req(host: &str, port: u16, auth: Option<&str>) -> String {
    let auth = auth
        .map(|value| format!("Proxy-Authorization: {value}\r\n"))
        .unwrap_or_default();
    format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{auth}\r\n")
}

#[tokio::test]
async fn authenticated_http_forward_reaches_origin_and_strips_credentials() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &http_get(
            &format!("origin.test:{}", origin.addr.port()),
            "/allowed?q=1",
            Some(GOOD_AUTH),
        ),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 200, "response was: {head:?}");
    assert!(head.to_ascii_lowercase().contains("content-length: 2"));
    assert_eq!(origin.connections(), 1, "exactly one origin dial");

    let seen = origin.seen.lock().unwrap().clone();
    let request = &seen[0];
    assert!(
        request.starts_with("GET /allowed?q=1 HTTP/1.1"),
        "{request:?}"
    );
    assert!(
        !request.to_ascii_lowercase().contains("proxy-authorization"),
        "Proxy-Authorization must never reach the origin"
    );
    assert!(
        !request.to_ascii_lowercase().contains("proxy-connection"),
        "proxy hop-by-hop headers must be stripped"
    );
    assert!(request.to_ascii_lowercase().contains("host: origin.test"));
    proxy.stop().await;
}

#[tokio::test]
async fn policy_denied_domain_and_unapproved_literals_never_contact_origin() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    for target in ["blocked.test", "not-approved.test", "169.254.169.254"] {
        let mut client = connect(proxy.bind_addr()).await;
        send(
            &mut client,
            &http_get(
                &format!("{target}:{}", origin.addr.port()),
                "/",
                Some(GOOD_AUTH),
            ),
        )
        .await;
        let head = read_head(&mut client).await;
        assert_eq!(status_line(&head), 403, "denied {target}: {head:?}");
    }
    assert_eq!(
        origin.connections(),
        0,
        "no origin contact for denied targets"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn missing_and_wrong_credentials_are_rejected_before_egress() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    for auth in [None, Some(WRONG_AUTH)] {
        let mut client = connect(proxy.bind_addr()).await;
        send(
            &mut client,
            &http_get(&format!("origin.test:{}", origin.addr.port()), "/", auth),
        )
        .await;
        let head = read_head(&mut client).await;
        assert_eq!(
            status_line(&head),
            407,
            "missing/wrong credential: {head:?}"
        );
        assert!(head
            .to_ascii_lowercase()
            .contains("proxy-authenticate: basic"));
    }
    assert_eq!(
        origin.connections(),
        0,
        "no origin contact without valid auth"
    );

    // A CONNECT handshake must not return 200 either.
    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req("echo.test", echo.addr.port(), None),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 407, "unauthenticated CONNECT: {head:?}");
    assert_eq!(echo.connections(), 0, "no tunnel without valid auth");
    proxy.stop().await;
}

#[tokio::test]
async fn connect_tunnel_echoes_bytes_through_the_pinned_socket() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req("echo.test", echo.addr.port(), Some(GOOD_AUTH)),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 200, "CONNECT response: {head:?}");
    // Eager egress: the upstream socket is established before the 200 is sent.
    assert_eq!(
        echo.connections(),
        1,
        "egress must be dialled before CONNECT ack"
    );

    client.write_all(b"hello-vantyr").await.unwrap();
    let mut reply = [0u8; 12];
    tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut reply))
        .await
        .expect("tunnel read timeout")
        .expect("tunnel read failed");
    assert_eq!(&reply, b"hello-vantyr");
    proxy.stop().await;
}

#[tokio::test]
async fn connect_to_private_metadata_and_mapped_literals_never_returns_200() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    for target in [
        "169.254.169.254",
        "10.0.0.1",
        "127.0.0.1",
        "[::ffff:169.254.169.254]",
        "[::ffff:127.0.0.1]",
        "not-approved.test",
    ] {
        let mut client = connect(proxy.bind_addr()).await;
        send(
            &mut client,
            &connect_req(target, echo.addr.port(), Some(GOOD_AUTH)),
        )
        .await;
        let head = read_head(&mut client).await;
        let code = status_line(&head);
        assert_ne!(
            code, 200,
            "CONNECT {target} must never be acknowledged: {head:?}"
        );
        assert!(
            code == 403 || code == 502 || code == 504 || code == 400,
            "unexpected failure code for {target}: {head:?}"
        );
    }
    assert_eq!(
        echo.connections(),
        0,
        "no tunnel may reach a denied destination"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn pinned_destination_ignores_a_hostile_rebinding_resolver() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let proxy = ProxyServer::start_with(
        test_config(origin.addr, echo.addr),
        RebindingResolver {
            calls: calls.clone(),
        },
    )
    .await
    .unwrap();

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req("rebind.test", echo.addr.port(), Some(GOOD_AUTH)),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 200, "pinned CONNECT: {head:?}");
    assert_eq!(
        echo.connections(),
        1,
        "only the pinned socket may be dialled"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a pinned destination must not consult DNS at all"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn connection_limit_drops_excess_clients() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config_with_limits(origin.addr, echo.addr, 1, 60)).await;

    // The first accepted connection holds the only permit while idle.
    let holder = connect(proxy.bind_addr()).await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    let mut overflow = connect(proxy.bind_addr()).await;
    send(
        &mut overflow,
        &http_get(
            &format!("origin.test:{}", origin.addr.port()),
            "/",
            Some(GOOD_AUTH),
        ),
    )
    .await;
    let result = tokio::time::timeout(Duration::from_millis(400), async {
        let mut buf = [0u8; 64];
        overflow.read(&mut buf).await
    })
    .await;
    match result {
        Err(_) => {}
        Ok(Ok(0)) => {}
        // A dropped socket may surface as EOF or as an immediate reset; both
        // mean the over-limit connection was not served.
        Ok(Err(_)) => {}
        Ok(Ok(n)) => panic!("over-limit connection returned {n} bytes"),
    }
    assert_eq!(origin.connections(), 0);
    drop(holder);
    proxy.stop().await;
}

#[tokio::test]
async fn idle_tunnel_is_bounded() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config_with_limits(origin.addr, echo.addr, 8, 1)).await;

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req("echo.test", echo.addr.port(), Some(GOOD_AUTH)),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 200);

    // With no byte progress the maintained relay closes the tunnel.
    tokio::time::sleep(Duration::from_millis(1400)).await;
    let mut buf = [0u8; 8];
    let closed = tokio::time::timeout(Duration::from_secs(2), client.read(&mut buf))
        .await
        .expect("idle tunnel read timeout");
    assert_eq!(closed.unwrap_or(0), 0, "idle tunnel must close");
    proxy.stop().await;
}

#[tokio::test]
async fn websocket_upgrade_is_rejected_honestly() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    let mut client = connect(proxy.bind_addr()).await;
    let request = format!(
        "GET http://origin.test/ws HTTP/1.1\r\nHost: origin.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: {GOOD_AUTH}\r\n\r\n"
    );
    send(&mut client, &request).await;
    let head = read_head(&mut client).await;
    assert_eq!(
        status_line(&head),
        405,
        "upgrade must not silently pass: {head:?}"
    );
    assert_eq!(origin.connections(), 0);
    proxy.stop().await;
}

#[tokio::test]
async fn stalled_upstream_http_request_expires_and_releases_connection_permit() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let stall = StallOrigin::start().await;
    let mut config = test_config_with_limits(origin.addr, echo.addr, 1, 60);
    config.limits.request_timeout_secs = 1;
    config.destinations.push(DestinationConfig {
        host: "stall.test".into(),
        port: stall.addr.port(),
        pin: Some(format!("127.0.0.1:{}", stall.addr.port())),
    });
    config
        .profiles
        .get_mut("restricted")
        .unwrap()
        .push(RuleSpec {
            effect: Effect::Allow,
            matcher: MatchSpec::Suffix {
                value: "stall.test".into(),
            },
            reason: None,
        });
    config.validate().unwrap();
    let proxy = start_proxy(config).await;

    let mut first = connect(proxy.bind_addr()).await;
    let started = Instant::now();
    send(
        &mut first,
        &http_get(
            &format!("stall.test:{}", stall.addr.port()),
            "/",
            Some(GOOD_AUTH),
        ),
    )
    .await;
    let head = read_head(&mut first).await;
    assert_eq!(status_line(&head), 504, "stalled upstream: {head:?}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "full request deadline must fire, not only connect timeout"
    );
    assert_eq!(stall.connections(), 1);
    drop(first);

    // The connection permit must have been released so a second client works.
    let mut second = connect(proxy.bind_addr()).await;
    send(
        &mut second,
        &http_get(
            &format!("origin.test:{}", origin.addr.port()),
            "/",
            Some(GOOD_AUTH),
        ),
    )
    .await;
    let head = read_head(&mut second).await;
    assert_eq!(
        status_line(&head),
        200,
        "next request after deadline: {head:?}"
    );
    assert_eq!(origin.connections(), 1);
    proxy.stop().await;
}

#[tokio::test]
async fn header_count_size_and_body_limits_reject_before_origin_contact() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let mut config = test_config_with_limits(origin.addr, echo.addr, 8, 60);
    config.limits.max_body_bytes = 1024;
    config.validate().unwrap();
    let proxy = start_proxy(config).await;

    let mut too_many = format!(
        "GET http://origin.test:{}/ HTTP/1.1\r\nHost: origin.test\r\nProxy-Authorization: {GOOD_AUTH}\r\n",
        origin.addr.port()
    );
    for index in 0..120 {
        too_many.push_str(&format!("X-Test-{index}: v\r\n"));
    }
    too_many.push_str("\r\n");
    let mut client = connect(proxy.bind_addr()).await;
    send(&mut client, &too_many).await;
    let head = read_head(&mut client).await;
    let code = status_line(&head);
    assert!(
        code == 400 || code == 431 || code == 0,
        "excess headers must not be forwarded: {head:?}"
    );
    drop(client);

    let oversized = format!(
        "GET http://origin.test:{}/ HTTP/1.1\r\nHost: origin.test\r\nProxy-Authorization: {GOOD_AUTH}\r\nX-Big: {}\r\n\r\n",
        origin.addr.port(),
        "v".repeat(40_000)
    );
    let mut client = connect(proxy.bind_addr()).await;
    send(&mut client, &oversized).await;
    let head = read_head(&mut client).await;
    let code = status_line(&head);
    assert!(
        code == 400 || code == 431 || code == 0,
        "oversized header must not be forwarded: {head:?}"
    );
    drop(client);

    let over_body = format!(
        "POST http://origin.test:{}/ HTTP/1.1\r\nHost: origin.test\r\nProxy-Authorization: {GOOD_AUTH}\r\nContent-Length: 5000\r\n\r\n{}",
        origin.addr.port(),
        "x".repeat(5000)
    );
    let mut client = connect(proxy.bind_addr()).await;
    send(&mut client, &over_body).await;
    let head = read_head(&mut client).await;
    assert_ne!(
        status_line(&head),
        200,
        "oversized body must not succeed: {head:?}"
    );
    assert_eq!(
        origin.connections(),
        0,
        "no over-limit request reaches origin"
    );
    proxy.stop().await;
}

#[tokio::test]
async fn stopping_the_proxy_closes_active_tunnels() {
    let origin = HttpOrigin::start().await;
    let echo = EchoOrigin::start().await;
    let proxy = start_proxy(test_config(origin.addr, echo.addr)).await;

    let mut client = connect(proxy.bind_addr()).await;
    send(
        &mut client,
        &connect_req("echo.test", echo.addr.port(), Some(GOOD_AUTH)),
    )
    .await;
    assert_eq!(status_line(&read_head(&mut client).await), 200);

    proxy.stop().await;
    let mut buf = [0u8; 8];
    let closed = tokio::time::timeout(Duration::from_secs(3), client.read(&mut buf))
        .await
        .expect("active tunnel must close on shutdown");
    assert_eq!(
        closed.unwrap_or(0),
        0,
        "active tunnel left running after stop"
    );
}
