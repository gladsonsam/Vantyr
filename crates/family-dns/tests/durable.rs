//! Durable bundle and atomic reload tests over real sockets and real files.
//! Every state directory is unique and removed on drop; no listener is left
//! behind on a failed validation.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_dns::{DnsServer, DurableOptions, ReloadError, WriteHooks};
use hickory_server::proto::op::ResponseCode;
use hickory_server::proto::rr::rdata::A as AData;
use hickory_server::proto::rr::{RData, RecordType};
use support::*;

const WORKER: &str = "dns-worker-1";
const STAMP: &str = "2026-11-26T10:00:00Z";

static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);
static FAIL_BEFORE_RENAME: AtomicBool = AtomicBool::new(false);

fn failing_hook(_path: &Path) -> std::io::Result<()> {
    if FAIL_BEFORE_RENAME.load(Ordering::SeqCst) {
        Err(std::io::Error::other("injected pre-rename failure"))
    } else {
        Ok(())
    }
}

struct TestState {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn new_state(name: &str, json: &str) -> TestState {
    let serial = DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-durable-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let config = dir.join("dns.json");
    let state = dir.join("state.json");
    fs::write(&config, json).unwrap();
    TestState { dir, config, state }
}

fn cfg(port: u16, revision: u64, first: &str, second: &str, published: Option<&str>) -> String {
    let mut json = test_config(port, "");
    json = json.replace(
        "\"policy_revision\": 7",
        &format!("\"policy_revision\": {revision}"),
    );
    json = json.replace(
        "\"addr\": \"192.0.2.10\"",
        &format!("\"addr\": \"{first}\""),
    );
    json = json.replace(
        "\"addr\": \"192.0.2.11\"",
        &format!("\"addr\": \"{second}\""),
    );
    if let Some(at) = published {
        json = json.replace(
            "\"policy_revision\":",
            &format!("\"policy_published_at\": \"{at}\",\n\"policy_revision\":"),
        );
    }
    json
}

fn options(st: &TestState, now: DateTime<Utc>) -> DurableOptions {
    DurableOptions {
        state_path: st.state.clone(),
        worker_id: WORKER.to_owned(),
        config_path: Some(st.config.clone()),
        now,
        hooks: None,
    }
}

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}

fn v4(message: &hickory_server::proto::op::Message) -> Vec<IpAddr> {
    message
        .answers
        .iter()
        .filter_map(|record| match &record.data {
            RData::A(AData(ip)) => Some(IpAddr::V4(*ip)),
            _ => None,
        })
        .collect()
}

async fn answer(server: &DnsServer, tcp: bool) -> hickory_server::proto::op::Message {
    let name = "www.lab.example.";
    if tcp {
        tcp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    } else {
        udp_query(mapped(), server.bind_addr(), name, RecordType::A).await
    }
}

fn group_a() -> Vec<IpAddr> {
    vec!["192.0.2.10".parse().unwrap(), "192.0.2.11".parse().unwrap()]
}

fn group_b() -> Vec<IpAddr> {
    vec!["192.0.2.20".parse().unwrap(), "192.0.2.21".parse().unwrap()]
}

fn disk_bytes(st: &TestState) -> Vec<u8> {
    fs::read(&st.state).unwrap()
}

#[tokio::test]
async fn reload_changes_answers_on_udp_and_tcp_with_consistent_revision() {
    let st = new_state("reload", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let now = Utc::now();
    let server = DnsServer::start_durable(options(&st, now)).await.unwrap();
    assert!(server.is_durable());
    assert_eq!(server.revision(), 2);

    for tcp in [false, true] {
        let before = answer(&server, tcp).await;
        assert_code(&before, ResponseCode::NoError);
        assert_flags(&before);
        let mut ips = v4(&before);
        ips.sort();
        assert_eq!(ips, group_a());
    }

    let candidate = cfg(0, 3, "192.0.2.20", "192.0.2.21", None);
    let outcome = server.reload(candidate.as_bytes(), now).unwrap();
    assert_eq!(outcome.revision, 3);
    assert_eq!(server.revision(), 3);

    for tcp in [false, true] {
        let after = answer(&server, tcp).await;
        assert_code(&after, ResponseCode::NoError);
        assert_flags(&after);
        let mut ips = v4(&after);
        ips.sort();
        assert_eq!(ips, group_b(), "tcp={tcp} still served the old version");
    }
    assert!(server
        .observations()
        .iter()
        .any(|o| { o.name == "www.lab.example." && o.allow && o.policy_revision == 3 }));

    let on_disk: serde_json::Value = serde_json::from_slice(&disk_bytes(&st)).unwrap();
    assert_eq!(on_disk["schema"], 1);
    assert_eq!(on_disk["highwater"], 3);
    // The snapshot's `policy` field holds the whole bundle; the policy itself
    // is nested one level deeper.
    assert_eq!(on_disk["policy"]["policy"]["revision"], 3);
    assert_eq!(on_disk["worker_id"], WORKER);
    server.stop().await;
}

#[tokio::test]
async fn concurrent_queries_and_reloads_only_see_whole_versions() {
    let st = new_state("concurrent", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let now = Utc::now();
    let server = Arc::new(DnsServer::start_durable(options(&st, now)).await.unwrap());
    let stop = Arc::new(AtomicBool::new(false));

    let mut readers = Vec::new();
    for _ in 0..6 {
        let server = Arc::clone(&server);
        let stop = Arc::clone(&stop);
        readers.push(tokio::spawn(async move {
            let mut seen_a = 0;
            let mut seen_b = 0;
            while !stop.load(Ordering::Relaxed) {
                let response = answer(&server, false).await;
                assert_code(&response, ResponseCode::NoError);
                let mut ips = v4(&response);
                ips.sort();
                assert!(
                    ips == group_a() || ips == group_b(),
                    "mixed version: {ips:?}"
                );
                if ips == group_a() {
                    seen_a += 1;
                } else {
                    seen_b += 1;
                }
            }
            (seen_a, seen_b)
        }));
    }

    for revision in 3..25 {
        let (first, second) = if revision % 2 == 0 {
            ("192.0.2.20", "192.0.2.21")
        } else {
            ("192.0.2.10", "192.0.2.11")
        };
        server
            .reload(cfg(0, revision, first, second, None).as_bytes(), now)
            .unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    stop.store(true, Ordering::Relaxed);
    let mut total = (0, 0);
    for reader in readers {
        let (a, b) = reader.await.unwrap();
        assert!(a + b > 0, "reader saw no responses");
        total.0 += a;
        total.1 += b;
    }
    assert!(total.0 + total.1 > 100);
    let server = Arc::try_unwrap(server)
        .ok()
        .expect("no reader keeps the server");
    server.stop().await;
}

#[tokio::test]
async fn invalid_stale_foreign_and_bind_change_reload_keeps_the_old_version() {
    let st = new_state("invalid", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let now = Utc::now();
    let server = DnsServer::start_durable(options(&st, now)).await.unwrap();
    let committed = disk_bytes(&st);

    let foreign = cfg(0, 9, "192.0.2.20", "192.0.2.21", None).replace(
        "11111111-2222-3333-4444-555555555555",
        "99999999-2222-3333-4444-555555555555",
    );
    let cases: Vec<(&str, Vec<u8>, bool)> = vec![
        (
            "same revision",
            cfg(0, 2, "192.0.2.20", "192.0.2.21", None).into_bytes(),
            false,
        ),
        (
            "older revision",
            cfg(0, 1, "192.0.2.20", "192.0.2.21", None).into_bytes(),
            false,
        ),
        (
            "bind change",
            cfg(15_354, 9, "192.0.2.20", "192.0.2.21", None).into_bytes(),
            true,
        ),
        ("foreign household", foreign.into_bytes(), false),
        ("malformed json", b"{not-json".to_vec(), false),
        (
            "invalid record",
            cfg(0, 9, "not-an-ip", "192.0.2.21", None).into_bytes(),
            false,
        ),
    ];

    for (label, candidate, transport) in cases {
        let error = server.reload(&candidate, now).unwrap_err();
        if transport {
            assert!(
                matches!(error, ReloadError::TransportChange(_)),
                "{label}: {error}"
            );
        } else {
            assert!(
                matches!(
                    error,
                    ReloadError::InvalidConfig(_) | ReloadError::NotNewer { .. }
                ),
                "{label}: {error}"
            );
        }
        assert_eq!(server.revision(), 2, "{label} changed the running version");
        assert_eq!(disk_bytes(&st), committed, "{label} changed the disk state");
        let mut ips = v4(&answer(&server, false).await);
        ips.sort();
        assert_eq!(ips, group_a(), "{label} changed served answers");
    }
    assert_eq!(
        fs::read_dir(&st.dir).unwrap().count(),
        2,
        "one config + one state file"
    );
    server.stop().await;
}

#[tokio::test]
async fn persistence_failure_keeps_the_old_runtime_and_disk() {
    FAIL_BEFORE_RENAME.store(false, Ordering::SeqCst);
    let st = new_state("persist", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let now = Utc::now();
    let hooks = WriteHooks {
        before_rename: failing_hook,
        ..WriteHooks::default()
    };
    let mut opts = options(&st, now);
    opts.hooks = Some(hooks);
    let server = DnsServer::start_durable(opts).await.unwrap();
    let committed = disk_bytes(&st);

    FAIL_BEFORE_RENAME.store(true, Ordering::SeqCst);
    let error = server
        .reload(cfg(0, 3, "192.0.2.20", "192.0.2.21", None).as_bytes(), now)
        .unwrap_err();
    assert!(
        matches!(&error, ReloadError::PersistFailed(detail) if detail.contains("before rename")),
        "{error}"
    );
    assert_eq!(disk_bytes(&st), committed);
    assert_eq!(server.revision(), 2);
    let mut ips = v4(&answer(&server, true).await);
    ips.sort();
    assert_eq!(ips, group_a());
    assert_eq!(
        fs::read_dir(&st.dir).unwrap().count(),
        2,
        "a failed rename must not leak a temp file"
    );

    FAIL_BEFORE_RENAME.store(false, Ordering::SeqCst);
    server
        .reload(cfg(0, 3, "192.0.2.20", "192.0.2.21", None).as_bytes(), now)
        .unwrap();
    assert_eq!(server.revision(), 3);
    server.stop().await;
}

#[tokio::test]
async fn restart_loads_the_bundle_and_ignores_a_changed_config() {
    let st = new_state(
        "restart",
        &cfg(0, 2, "192.0.2.10", "192.0.2.11", Some(STAMP)),
    );
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let first = DnsServer::start_durable(options(&st, now)).await.unwrap();
    let mut ips = v4(&answer(&first, false).await);
    ips.sort();
    assert_eq!(ips, group_a());
    assert_eq!(first.published_at(), now);
    first.stop().await;

    // The controller-side config moved on while the worker was down. The
    // worker must keep serving the last bundle it actually persisted.
    fs::write(
        &st.config,
        cfg(
            0,
            42,
            "192.0.2.20",
            "192.0.2.21",
            Some("2026-11-26T11:00:00Z"),
        ),
    )
    .unwrap();
    let restarted = DnsServer::start_durable(options(&st, now)).await.unwrap();
    let mut ips = v4(&answer(&restarted, true).await);
    ips.sort();
    assert_eq!(
        ips,
        group_a(),
        "restart silently adopted the changed config"
    );
    assert_eq!(restarted.revision(), 2);
    assert_eq!(
        restarted.published_at(),
        now,
        "restart rejuvenated policy age"
    );

    let on_disk: serde_json::Value = serde_json::from_slice(&disk_bytes(&st)).unwrap();
    assert_eq!(on_disk["highwater"], 2);
    assert_eq!(on_disk["policy"]["policy"]["published_at"], STAMP);

    // A genuinely newer revision is still accepted after the restart.
    restarted
        .reload(
            cfg(
                0,
                43,
                "192.0.2.20",
                "192.0.2.21",
                Some("2026-11-26T11:00:00Z"),
            )
            .as_bytes(),
            now,
        )
        .unwrap();
    let mut ips = v4(&answer(&restarted, false).await);
    ips.sort();
    assert_eq!(ips, group_b());
    restarted.stop().await;
}

#[tokio::test]
async fn restart_preserves_exact_rewrites_from_the_last_persisted_bundle() {
    let rewrites =
        r#","rewrites":[{"type":"a","name":"rewrite.lab.example.","ttl":55,"addr":"192.0.2.55"}]"#;
    let json = test_config(0, rewrites).replace("\"policy_revision\": 7", "\"policy_revision\": 5");
    let st = new_state("rewrite-restart", &json);
    let now = Utc::now();
    let first = DnsServer::start_durable(options(&st, now)).await.unwrap();

    let response = udp_query(
        mapped(),
        first.bind_addr(),
        "rewrite.lab.example.",
        RecordType::A,
    )
    .await;
    assert_code(&response, ResponseCode::NoError);
    assert_flags(&response);
    assert_eq!(v4(&response), vec!["192.0.2.55".parse().unwrap()]);
    assert_eq!(response.answers[0].ttl, 55);
    first.stop().await;

    // A changed on-disk config while the worker is down must not replace the
    // rewrite that was actually persisted.
    fs::write(
        &st.config,
        test_config(0, "").replace("\"policy_revision\": 7", "\"policy_revision\": 9"),
    )
    .unwrap();
    let restarted = DnsServer::start_durable(options(&st, now)).await.unwrap();
    let response = tcp_query(
        mapped(),
        restarted.bind_addr(),
        "rewrite.lab.example.",
        RecordType::A,
    )
    .await;
    assert_code(&response, ResponseCode::NoError);
    assert_flags(&response);
    assert_eq!(v4(&response), vec!["192.0.2.55".parse().unwrap()]);
    assert_eq!(restarted.revision(), 5);
    assert_eq!(restarted.status().bundle_generation, 5);
    restarted.stop().await;
}

#[tokio::test]
async fn stale_policy_age_fails_closed_until_a_fresh_reload() {
    let st = new_state(
        "stale",
        &cfg(
            0,
            2,
            "192.0.2.10",
            "192.0.2.11",
            Some("2026-11-20T00:00:00Z"),
        ),
    );
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let server = DnsServer::start_durable(options(&st, now)).await.unwrap();
    let denied = answer(&server, false).await;
    assert_code(&denied, ResponseCode::NXDomain);
    assert!(v4(&denied).is_empty());
    assert!(server
        .observations()
        .iter()
        .any(|o| { o.name == "www.lab.example." && o.reason_code == "stale_policy_fail_closed" }));

    server
        .reload(
            cfg(0, 3, "192.0.2.10", "192.0.2.11", Some(STAMP)).as_bytes(),
            now,
        )
        .unwrap();
    let allowed = answer(&server, true).await;
    assert_code(&allowed, ResponseCode::NoError);
    let mut ips = v4(&allowed);
    ips.sort();
    assert_eq!(ips, group_a());
    server.stop().await;
}

#[tokio::test]
async fn corrupt_foreign_and_wrong_worker_state_fail_before_a_listener_exists() {
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();

    // Corrupt state: parse fails before any socket is created.
    let corrupt = new_state("corrupt", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    fs::write(&corrupt.state, b"{\"schema\":").unwrap();
    let probe = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    let mut listener_cfg = cfg(port, 2, "192.0.2.10", "192.0.2.11", None);
    fs::write(&corrupt.config, &listener_cfg).unwrap();
    assert!(DnsServer::start_durable(options(&corrupt, now))
        .await
        .is_err());
    drop(probe);
    assert!(
        std::net::UdpSocket::bind(("127.0.0.1", port)).is_ok(),
        "a rejected state file must not leave a listener"
    );

    // A valid bundle with a different worker id is rejected on restart.
    let foreign = new_state("worker", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let first = DnsServer::start_durable(options(&foreign, now))
        .await
        .unwrap();
    first.stop().await;
    let mut wrong_worker = options(&foreign, now);
    wrong_worker.worker_id = "another-worker".to_owned();
    assert!(DnsServer::start_durable(wrong_worker).await.is_err());

    // A different household cannot take over an existing bundle either.
    listener_cfg = cfg(0, 2, "192.0.2.10", "192.0.2.11", None).replace(
        "11111111-2222-3333-4444-555555555555",
        "99999999-2222-3333-4444-555555555555",
    );
    fs::write(&foreign.config, &listener_cfg).unwrap();
    assert!(DnsServer::start_durable(options(&foreign, now))
        .await
        .is_err());
}

#[cfg(unix)]
#[test]
fn one_bundle_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let st = new_state("mode", &cfg(0, 2, "192.0.2.10", "192.0.2.11", None));
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let store = bootstrap_store(st.state.clone(), now);
    drop(store);
    let mode = fs::metadata(&st.state).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(fs::read_dir(&st.dir).unwrap().count(), 2);
}

// Small synchronous bootstrap helper for the file-permission test; it shows
// the typed store can be used directly with a bundle payload.
#[cfg(unix)]
fn bootstrap_store(state: PathBuf, now: DateTime<Utc>) -> family_dns::BundleStore {
    use family_dns::{Bundle, BundleStore, BundleValidator, Config};
    let config = Config::parse(cfg(0, 2, "192.0.2.10", "192.0.2.11", None).as_bytes()).unwrap();
    let store = BundleStore::open(
        state,
        config.household_id.parse().unwrap(),
        WORKER,
        BundleValidator,
    )
    .unwrap();
    store
        .apply(Bundle::build(&config, now).unwrap(), now)
        .unwrap();
    store
}

#[cfg(unix)]
#[test]
fn malformed_bundle_identity_is_rejected_without_panicking_on_load_or_apply() {
    use family_dns::{Bundle, BundleStore, BundleValidator, Config};
    let st = new_state(
        "invalid-identity",
        &cfg(0, 2, "192.0.2.10", "192.0.2.11", None),
    );
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let store = bootstrap_store(st.state.clone(), now);
    let original = fs::read(&st.state).unwrap();
    let config = Config::parse(fs::read(&st.config).unwrap().as_slice()).unwrap();
    let mut candidate = Bundle::build(&config, now).unwrap();
    candidate.config.household_id = "NOT-A-UUID".into();
    assert!(store.apply(candidate, now).is_err());
    assert_eq!(fs::read(&st.state).unwrap(), original);

    let mut json: serde_json::Value = serde_json::from_slice(&original).unwrap();
    json["policy"]["config"]["household_id"] = "NOT-A-UUID".into();
    fs::write(&st.state, serde_json::to_vec(&json).unwrap()).unwrap();
    assert!(BundleStore::open_from_snapshot(&st.state, WORKER, BundleValidator).is_err());
}

#[test]
fn bundle_rejects_divergent_policy_and_future_publication_time() {
    use family_dns::{Bundle, Config};
    let config = Config::parse(cfg(0, 2, "192.0.2.10", "192.0.2.11", None).as_bytes()).unwrap();
    let now = Utc::now();
    let mut policy = config.policy_at(now);
    policy.device_profiles.clear();
    assert!(Bundle::new(config.clone(), policy).is_err());

    let future = now + chrono::Duration::days(365);
    assert!(Bundle::build(&config, future).is_err());
    let mut declared_future = config;
    declared_future.policy_published_at = Some(future);
    assert!(declared_future.validate().is_err());
}
