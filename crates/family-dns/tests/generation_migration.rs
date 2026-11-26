//! Explicit schema-1 generation migration and on-disk material tamper checks.
//! Legacy payloads are accepted only in the recognized shape; impossible or
//! mixed counters are rejected before a listener exists.

mod support;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use family_dns::{DnsServer, DurableOptions, ReloadError};
use hickory_server::proto::op::ResponseCode;
use hickory_server::proto::rr::RecordType;
use serde_json::{json, Value};
use support::{assert_code, udp_query, HOUSEHOLD};

const WORKER: &str = "dns-migration-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
static COUNTER: AtomicU64 = AtomicU64::new(0);

type Mutation = Box<dyn Fn(&mut Value)>;

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
    disk: Mutex<Vec<u8>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    fn disk(&self) -> Vec<u8> {
        fs::read(&self.state).unwrap()
    }
    fn options(&self) -> DurableOptions {
        DurableOptions {
            state_path: self.state.clone(),
            worker_id: WORKER.to_owned(),
            config_path: Some(self.config.clone()),
            now: STAMP.parse::<DateTime<Utc>>().unwrap(),
            hooks: None,
        }
    }
    fn snapshot(&self) {
        *self.disk.lock().unwrap() = fs::read(&self.state).unwrap();
    }
    fn restore(&self) {
        fs::write(&self.state, &*self.disk.lock().unwrap()).unwrap();
    }
}

fn fixture(name: &str, with_filter: bool) -> Fixture {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-migrate-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let config = dir.join("dns.json");
    let state = dir.join("state.json");
    let hosts = dir.join("hosts.txt");
    fs::write(&hosts, "blocked.migrate.example\n").unwrap();
    let filter = if with_filter {
        format!(
            r#","filter":{{"sources":[{{"id":"local","format":"hosts","path":"{}"}}]}}"#,
            hosts.display()
        )
    } else {
        String::new()
    };
    let cfg = format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_published_at": "{STAMP}",
  "policy_revision": 3,
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "deny": {{ "mode": "nxdomain" }},
  "local_zones": {{ "migrate.example.": [
    {{ "type": "a", "name": "ok.migrate.example.", "ttl": 60, "addr": "192.0.2.10" }},
    {{ "type": "a", "name": "blocked.migrate.example.", "ttl": 60, "addr": "192.0.2.11" }}
  ]}},
  "profiles": {{
    "adult": [{{ "effect": "allow", "match": {{ "type": "suffix", "value": "migrate.example" }}, "reason": "adult" }}],
    "restricted": [{{ "effect": "deny", "match": {{ "type": "suffix", "value": "example" }}, "reason": "restricted" }}]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}]
  {filter}
}}"#
    );
    fs::write(&config, cfg).unwrap();
    Fixture {
        dir,
        config,
        state,
        disk: Mutex::new(Vec::new()),
    }
}

async fn bootstrap(fixture: &Fixture) {
    let server = DnsServer::start_durable(fixture.options()).await.unwrap();
    server.stop().await;
    fixture.snapshot();
}

fn mutate(fixture: &Fixture, change: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&fixture.disk()).unwrap();
    change(&mut value);
    fs::write(&fixture.state, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::read(&fixture.state).unwrap()
}

fn drop_counters(bundle: &mut Value) {
    let obj = bundle["policy"].as_object_mut().unwrap();
    obj.remove("generation");
    obj.remove("policy_highwater");
    obj.remove("filter_generation");
}

#[tokio::test]
async fn legacy_counters_are_migrated_without_freshening_policy_age() {
    let st = fixture("legacy-plain", false);
    bootstrap(&st).await;
    mutate(&st, drop_counters);
    let server = DnsServer::start_durable(st.options()).await.unwrap();
    let status = server.status();
    assert_eq!(status.policy_revision, 3);
    assert_eq!(
        status.bundle_generation, 3,
        "legacy highwater becomes generation"
    );
    assert_eq!(status.filter_generation, 0);
    assert_eq!(
        server.published_at(),
        STAMP.parse::<DateTime<Utc>>().unwrap()
    );
    let message = udp_query(
        "127.0.0.2".parse().unwrap(),
        server.bind_addr(),
        "ok.migrate.example.",
        RecordType::A,
    )
    .await;
    assert_code(&message, ResponseCode::NoError);
    server.stop().await;
}

#[tokio::test]
async fn legacy_filter_material_migrates_with_generation_one() {
    let st = fixture("legacy-filter", true);
    bootstrap(&st).await;
    mutate(&st, drop_counters);
    let server = DnsServer::start_durable(st.options()).await.unwrap();
    let status = server.status();
    assert_eq!(status.filter_generation, 1);
    assert_eq!(status.bundle_generation, 3);
    assert_eq!(status.filter_identity.len(), 64);
    let message = udp_query(
        "127.0.0.2".parse().unwrap(),
        server.bind_addr(),
        "blocked.migrate.example.",
        RecordType::A,
    )
    .await;
    assert_code(&message, ResponseCode::NXDomain);
    server.stop().await;
}

#[tokio::test]
async fn invalid_or_mixed_counters_are_rejected_before_a_listener_exists() {
    let st = fixture("bad-counters", false);
    bootstrap(&st).await;

    let mut cases: Vec<(&str, Mutation)> = Vec::new();
    cases.push((
        "partial",
        Box::new(|value| {
            let obj = value["policy"].as_object_mut().unwrap();
            obj.remove("policy_highwater");
            obj.remove("filter_generation");
        }),
    ));
    cases.push((
        "zero generation",
        Box::new(|value| {
            value["policy"]["generation"] = json!(0);
            value["highwater"] = json!(0);
        }),
    ));
    cases.push((
        "mixed policy highwater",
        Box::new(|value| {
            value["policy"]["policy_highwater"] = json!(5);
        }),
    ));
    cases.push((
        "envelope disagrees",
        Box::new(|value| {
            value["policy"]["generation"] = json!(9);
        }),
    ));
    cases.push((
        "filter generation without material",
        Box::new(|value| {
            value["policy"]["filter_generation"] = json!(1);
        }),
    ));

    for (name, change) in cases {
        mutate(&st, |value| change(value));
        assert!(
            DnsServer::start_durable(st.options()).await.is_err(),
            "{name} bundle must be rejected"
        );
        st.restore();
    }
}

#[tokio::test]
async fn generation_overflow_is_explicit_and_never_wraps() {
    let st = fixture("overflow", false);
    bootstrap(&st).await;
    mutate(&st, |value| {
        value["policy"]["generation"] = json!(u64::MAX);
        value["highwater"] = json!(u64::MAX);
    });
    let server = DnsServer::start_durable(st.options()).await.unwrap();
    let committed = st.disk();
    let candidate =
        support::test_config(0, "").replace("\"policy_revision\": 7", "\"policy_revision\": 4");
    assert!(matches!(
        server.reload(candidate.as_bytes(), Utc::now()),
        Err(ReloadError::InvalidConfig(detail)) if detail.contains("overflow")
    ));
    assert_eq!(st.disk(), committed);
    assert_eq!(server.status().bundle_generation, u64::MAX);
    server.stop().await;
}

#[tokio::test]
async fn tampered_material_fails_before_a_listener_exists() {
    let st = fixture("tamper", true);
    bootstrap(&st).await;

    let mutations: Vec<(&str, Mutation)> = vec![
        (
            "sha",
            Box::new(|value| value["policy"]["filter"]["lists"][0]["sha256_hex"] = json!("00")),
        ),
        (
            "base64",
            Box::new(|value| {
                value["policy"]["filter"]["lists"][0]["bytes_b64"] = json!("!!!not-base64!!!");
            }),
        ),
        (
            "duplicate ids",
            Box::new(|value| {
                let lists = value["policy"]["filter"]["lists"].as_array_mut().unwrap();
                let first = lists[0].clone();
                lists.push(first);
            }),
        ),
        (
            "counts",
            Box::new(|value| {
                value["policy"]["filter"]["derivation"]["total_rules"] = json!(999_999);
            }),
        ),
    ];
    for (name, change) in mutations {
        mutate(&st, change);
        assert!(
            DnsServer::start_durable(st.options()).await.is_err(),
            "{name} material must be rejected"
        );
        st.restore();
    }
}
