use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Router;

use crate::config::{
    Limits, QueryPolicy, SourceMetadata, SubscriptionConfig, SubscriptionSource, MAX_SOURCES,
};
use crate::error::Error;
use crate::resolve::{is_public_global, vet_public_addrs, VettedResolver};
use crate::test_support::StaticLookup;
use crate::transport::{sanitize_header, HttpTransport, ReqwestTransport, TransportResponse};
use crate::url::ValidatedUrl;
use crate::{CandidateValidator, CompilationSummary, Fetcher};

fn source(id: &str, url: &str) -> SubscriptionSource {
    SubscriptionSource {
        id: id.into(),
        url: url.into(),
        enabled: true,
        interval_secs: None,
        max_stale_secs: None,
        metadata: SourceMetadata {
            title: "Public blocklist".into(),
            publisher: "Operator".into(),
            license: "operator-approved".into(),
        },
    }
}

fn config(url: &str) -> SubscriptionConfig {
    SubscriptionConfig {
        sources: vec![source("public", url)],
        ..Default::default()
    }
}

fn always_ok() -> impl CandidateValidator {
    |_: &[u8]| Ok::<_, crate::ValidationError>(CompilationSummary { rule_count: 1 })
}

#[test]
fn only_public_global_addresses_are_accepted() {
    let rejected_v4 = [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "203.0.113.9",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
    ];
    for ip in rejected_v4 {
        let parsed: Ipv4Addr = ip.parse().unwrap();
        assert!(
            !is_public_global(IpAddr::V4(parsed)),
            "v4 {ip} must be rejected"
        );
    }
    let rejected_v6 = [
        "::1",
        "::",
        "fc00::1",
        "fd00::1",
        "fe80::1",
        "ff02::1",
        "2001:db8::1",
        "64:ff9b::808:808",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "2002::1",
    ];
    for ip in rejected_v6 {
        let parsed: Ipv6Addr = ip.parse().unwrap();
        assert!(
            !is_public_global(IpAddr::V6(parsed)),
            "v6 {ip} must be rejected"
        );
    }
    let accepted_v4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34"];
    for ip in accepted_v4 {
        let parsed: Ipv4Addr = ip.parse().unwrap();
        assert!(
            is_public_global(IpAddr::V4(parsed)),
            "v4 {ip} must be accepted"
        );
    }
    let accepted_v6 = ["2606:4700:4700::1111", "::ffff:8.8.8.8"];
    for ip in accepted_v6 {
        let parsed: Ipv6Addr = ip.parse().unwrap();
        assert!(
            is_public_global(IpAddr::V6(parsed)),
            "v6 {ip} must be accepted"
        );
    }
}

#[test]
fn vetting_rejects_empty_mixed_and_oversized_sets() {
    assert!(vet_public_addrs(vec![]).is_err());
    let good: SocketAddr = "8.8.8.8:443".parse().unwrap();
    let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
    assert!(vet_public_addrs(vec![good]).is_ok());
    assert!(vet_public_addrs(vec![private]).is_err());
    assert!(vet_public_addrs(vec![good, private]).is_err());
    let mapped = SocketAddr::V6(SocketAddrV6::new(
        "::ffff:169.254.169.254".parse().unwrap(),
        443,
        0,
        0,
    ));
    assert!(vet_public_addrs(vec![mapped]).is_err());
    let many: Vec<SocketAddr> = (1..=17)
        .map(|i| format!("8.8.8.{i}:443").parse().unwrap())
        .collect();
    assert!(vet_public_addrs(many).is_err());
}

#[test]
fn url_policy_is_https_only_without_userinfo_fragment_or_default_query() {
    let reject = QueryPolicy::Reject;
    let cases = [
        "http://example.com/list.txt",
        "https://user:pass@example.com/list.txt",
        "https://example.com/list.txt#section",
        "https://example.com/list.txt?token=secret",
        "https://192.168.1.1/list.txt",
        "https://169.254.169.254/latest/meta-data",
    ];
    for raw in cases {
        assert!(
            ValidatedUrl::parse(raw, &reject, 512).is_err(),
            "{raw} must be rejected"
        );
    }
    let ok = ValidatedUrl::parse("https://example.com/lists/block.txt", &reject, 512).unwrap();
    assert!(ok
        .safe_display()
        .starts_with("https://example.com/lists/block.txt"));
}

#[test]
fn raw_github_is_plain_https_and_html_blob_pages_are_rejected() {
    let reject = QueryPolicy::Reject;
    let raw = ValidatedUrl::parse(
        "https://raw.githubusercontent.com/example/repo/main/lists/ads.txt",
        &reject,
        512,
    )
    .unwrap();
    assert_eq!(raw.host(), "raw.githubusercontent.com");
    assert_eq!(raw.path(), "/example/repo/main/lists/ads.txt");
    assert!(ValidatedUrl::parse(
        "https://raw.githubusercontent.com/example/repo/main/lists/ads.txt?x=1",
        &reject,
        512,
    )
    .is_err());
    let err = ValidatedUrl::parse(
        "https://github.com/example/repo/blob/main/lists/ads.txt",
        &reject,
        512,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("raw.githubusercontent.com"),
        "{err}"
    );
}

#[test]
fn explicit_public_query_allowlist_still_rejects_secrets_and_controls() {
    let allow = QueryPolicy::AllowPublic {
        keys: vec!["format".into(), "v".into()],
    };
    assert!(ValidatedUrl::parse("https://example.com/list?format=hosts&v=2", &allow, 512).is_ok());
    assert!(ValidatedUrl::parse("https://example.com/list?token=secret", &allow, 512).is_err());
    assert!(ValidatedUrl::parse("https://example.com/list?format=a%0Ab", &allow, 512).is_ok());
    assert!(ValidatedUrl::parse(
        "https://example.com/list?format=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        &allow,
        64,
    )
    .is_err());
    assert!(sanitize_header("ok", 16).is_some());
    assert!(sanitize_header("bad\r\nheader", 16).is_none());
    assert!(sanitize_header("x".repeat(17).as_str(), 16).is_none());
}

#[test]
fn interval_and_source_count_limits_are_enforced() {
    let mut cfg = config("https://example.com/list.txt");
    cfg.sources[0].interval_secs = Some(60);
    assert!(cfg.validate().is_err(), "below 5 min must fail");
    cfg.sources[0].interval_secs = Some(8 * 24 * 3600);
    assert!(cfg.validate().is_err(), "above 7 days must fail");
    cfg.sources[0].interval_secs = Some(24 * 3600);
    assert!(cfg.validate().is_ok());

    let mut many = SubscriptionConfig::default();
    for i in 0..MAX_SOURCES + 1 {
        many.sources
            .push(source(&format!("s{i}"), "https://example.com/list.txt"));
    }
    assert!(many.validate().is_err());
    many.sources.pop();
    assert!(many.validate().is_ok());

    cfg.sources[0].id = "../escape".into();
    assert!(cfg.validate().is_err(), "path-like id must fail");
}

#[tokio::test]
async fn private_dns_answer_never_opens_a_socket() {
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded = hits.clone();
    let router = Router::new().fallback(move || {
        recorded.fetch_add(1, Ordering::SeqCst);
        async { StatusCode::OK.into_response() }
    });
    let (_base, _ca) = crate::test_support::spawn_tls_server(router).await;

    let limits = Limits {
        request_timeout_secs: 2,
        connect_timeout_secs: 1,
        ..Limits::default()
    };
    let lookup = Arc::new(StaticLookup(vec!["127.0.0.1:443".parse().unwrap()]));
    let resolver: Arc<dyn reqwest::dns::Resolve> = Arc::new(VettedResolver::new(lookup));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(resolver)
        .build()
        .unwrap();
    let transport =
        ReqwestTransport::from_client(client, limits.max_header_bytes, Duration::from_secs(2));
    let url = ValidatedUrl::parse(
        "https://public.example.com/list.txt",
        &QueryPolicy::Reject,
        512,
    )
    .unwrap();
    let err = transport
        .get(&url, Default::default(), limits.max_candidate_bytes)
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Transport(..)), "{err:?}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "no request may reach any origin"
    );
}

#[tokio::test]
async fn redirects_are_reported_and_never_followed() {
    let hits = Arc::new(AtomicUsize::new(0));
    let second = hits.clone();
    let router = Router::new()
        .route(
            "/list",
            axum::routing::get(|| async {
                (
                    StatusCode::FOUND,
                    [("location", "https://elsewhere.example.com/secret")],
                )
                    .into_response()
            }),
        )
        .route(
            "/secret",
            axum::routing::get(move || {
                second.fetch_add(1, Ordering::SeqCst);
                async { StatusCode::OK.into_response() }
            }),
        );
    let (base, ca) = crate::test_support::spawn_tls_server(router).await;
    let cfg = config(&format!("{base}/list"));
    let dir = tempfile::tempdir().unwrap();
    let fetcher = crate::test_support::fetcher_with_loopback(
        dir.path(),
        &cfg,
        always_ok(),
        &base,
        &ca,
        Arc::new(crate::clock::TestClock::new(
            chrono::DateTime::from_timestamp_millis(1_700_000_000_000).unwrap(),
        )),
        Arc::new(crate::clock::TestRng::default()),
    );
    let err = fetcher.refresh("public", true).await.unwrap_err();
    assert!(matches!(err, Error::RedirectUnsupported(..)), "{err:?}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "redirect target was never fetched"
    );
}

#[tokio::test]
async fn disabled_source_is_not_fetched_and_reports_disabled() {
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded = hits.clone();
    let router = Router::new().route(
        "/list",
        axum::routing::get(move || {
            recorded.fetch_add(1, Ordering::SeqCst);
            async { "domain=ads.example.com" }
        }),
    );
    let (base, ca) = crate::test_support::spawn_tls_server(router).await;
    let cfg = config(&format!("{base}/list"));
    let dir = tempfile::tempdir().unwrap();
    let fetcher = crate::test_support::fetcher_with_loopback(
        dir.path(),
        &cfg,
        always_ok(),
        &base,
        &ca,
        Arc::new(crate::clock::TestClock::new(
            chrono::DateTime::from_timestamp_millis(1_700_000_000_000).unwrap(),
        )),
        Arc::new(crate::clock::TestRng::default()),
    );
    fetcher.set_enabled("public", false).unwrap();
    assert_eq!(
        fetcher.status("public").unwrap().status,
        crate::SubscriptionStatus::Disabled
    );
    assert!(matches!(
        fetcher.refresh("public", true).await,
        Err(Error::Disabled(_))
    ));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    let _ = Fetcher::source_url(&fetcher, "public").unwrap();
}

// Make a TransportResponse usable in assertions without constructing a client.
#[test]
fn transport_response_default_is_empty() {
    let response = TransportResponse::default();
    assert_eq!(response.status, 0);
    assert!(response.body.is_empty());
}

// Run environment-sensitive proxy checks in a child test process, never mutate
// the environment of the parallel test runner.
#[test]
fn production_transport_ignores_environment_proxy() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::security::production_proxy_probe_child",
            "--nocapture",
        ])
        .env("VANTYR_PROXY_PROBE_CHILD", "1")
        .env("HTTPS_PROXY", &proxy)
        .env("https_proxy", &proxy)
        .env("HTTP_PROXY", &proxy)
        .env("http_proxy", &proxy)
        .env("ALL_PROXY", &proxy)
        .env("all_proxy", &proxy)
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let mut contacts = 0;
    while let Ok((_, _)) = listener.accept() {
        contacts += 1;
    }
    // Positive control uses reqwest's default environment proxy. Production
    // must add no second connection, even though the proxy is an IP literal.
    assert_eq!(
        contacts, 1,
        "only the positive-control client may contact the proxy"
    );
}

#[test]
fn production_proxy_probe_child() {
    if std::env::var_os("VANTYR_PROXY_PROBE_CHILD").is_none() {
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let raw_url = "https://public.example.com/list";
            let control = reqwest::Client::builder()
                .timeout(Duration::from_millis(200))
                .build()
                .unwrap();
            assert!(control.get(raw_url).send().await.is_err());
            let url = ValidatedUrl::parse(raw_url, &QueryPolicy::Reject, 512).unwrap();
            let transport = ReqwestTransport::new(
                &Limits::default(),
                None,
                Some(Arc::new(StaticLookup(vec!["127.0.0.1:443"
                    .parse()
                    .unwrap()]))),
            )
            .unwrap();
            assert!(transport.get(&url, Default::default(), 1024).await.is_err());
        });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_sources_cannot_exceed_raw_aggregate_cap() {
    struct BothReady(tokio::sync::Barrier);
    #[async_trait::async_trait]
    impl HttpTransport for BothReady {
        async fn get(
            &self,
            _: &ValidatedUrl,
            _: crate::transport::ConditionalHeaders,
            _: u64,
        ) -> Result<TransportResponse, Error> {
            self.0.wait().await;
            Ok(TransportResponse {
                status: 200,
                body: b"abcd".to_vec(),
                ..Default::default()
            })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let config = SubscriptionConfig {
        sources: vec![
            source("a", "https://example.com/a"),
            source("b", "https://example.com/b"),
        ],
        limits: Limits {
            max_candidate_bytes: 4,
            max_aggregate_bytes: 6,
            ..Default::default()
        },
        ..Default::default()
    };
    let fetcher = Arc::new(
        Fetcher::with_transport(
            dir.path(),
            &config,
            always_ok(),
            Arc::new(BothReady(tokio::sync::Barrier::new(2))),
        )
        .unwrap(),
    );
    let a = fetcher.clone();
    let first = tokio::spawn(async move { a.refresh("a", true).await });
    let b = fetcher.clone();
    let second = tokio::spawn(async move { b.refresh("b", true).await });
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        fetcher.status_all().iter().map(|s| s.bytes).sum::<usize>(),
        4
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
