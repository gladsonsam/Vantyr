//! Real UDP/TCP tests for local list + selected-service filtering in the DNS
//! worker, including durable material, atomic reload/restart and controller
//! preservation. No URL is fetched and no host network setting is changed.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_dns::{
    prepare_filter_material, Config, DecisionObservation, DnsEventDto, DnsServer, DurableOptions,
    EventQueue, ReloadError, WriteHooks,
};
use hickory_server::proto::op::{Message, ResponseCode};
use hickory_server::proto::rr::RecordType;
use support::*;

const WORKER: &str = "dns-filter-worker";
const STAMP: &str = "2026-11-26T10:00:00Z";
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn mapped() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2))
}
fn unknown() -> IpAddr {
    // A bindable loopback alias that is not assigned to any configured device.
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 3))
}

struct Fixture {
    dir: PathBuf,
    config: PathBuf,
    state: PathBuf,
    hosts: PathBuf,
    abp: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-filter-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    Fixture {
        config: dir.join("dns.json"),
        state: dir.join("state.json"),
        hosts: dir.join("hosts.txt"),
        abp: dir.join("ads.txt"),
        dir,
    }
}

impl Fixture {
    fn write_lists(&self, hosts: &str, abp: &str) {
        fs::write(&self.hosts, hosts).unwrap();
        fs::write(&self.abp, abp).unwrap();
    }

    fn sources(&self) -> String {
        format!(
            r#"[
              {{"id":"hosts-local","format":"hosts","path":"{}"}},
              {{"id":"abp-local","format":"abp","path":"{}","source_url":"https://example.invalid/operator-list.txt"}}
            ]"#,
            self.hosts.display(),
            self.abp.display()
        )
    }

    fn sources_with_paths(&self, hosts: &Path, abp: &Path) -> String {
        format!(
            r#"[
              {{"id":"hosts-local","format":"hosts","path":"{}"}},
              {{"id":"abp-local","format":"abp","path":"{}"}}
            ]"#,
            hosts.display(),
            abp.display()
        )
    }

    fn config(&self, revision: u64, published: Option<&str>) -> String {
        self.config_with_sources(revision, published, self.sources())
    }

    fn config_with_sources(
        &self,
        revision: u64,
        published: Option<&str>,
        sources: String,
    ) -> String {
        self.config_with_options(revision, published, sources, "")
    }

    /// `extras` is appended verbatim (comma-prefixed) after `devices` so a
    /// rewrite test can add operator rewrites, SafeSearch or cache settings
    /// without disturbing the shared policy/list template.
    fn config_with_options(
        &self,
        revision: u64,
        published: Option<&str>,
        sources: String,
        extras: &str,
    ) -> String {
        let published = published
            .map(|at| format!("\"policy_published_at\": \"{at}\","))
            .unwrap_or_default();
        format!(
            r#"{{
  "household_id": "{HOUSEHOLD}",
  {published}
  "policy_revision": {revision},
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "deny": {{ "mode": "nxdomain" }},
  "local_zones": {{ "filter.example.": [
    {{ "type": "a", "name": "ok.filter.example.", "ttl": 60, "addr": "192.0.2.50" }},
    {{ "type": "a", "name": "blocked.filter.example.", "ttl": 60, "addr": "192.0.2.51" }},
    {{ "type": "a", "name": "other.filter.example.", "ttl": 60, "addr": "192.0.2.52" }},
    {{ "type": "a", "name": "ads.filter.example.", "ttl": 60, "addr": "192.0.2.53" }},
    {{ "type": "a", "name": "important.filter.example.", "ttl": 60, "addr": "192.0.2.54" }},
    {{ "type": "a", "name": "except.filter.example.", "ttl": 60, "addr": "192.0.2.55" }},
    {{ "type": "a", "name": "social.filter.example.", "ttl": 60, "addr": "192.0.2.56" }},
    {{ "type": "a", "name": "unselected.filter.example.", "ttl": 60, "addr": "192.0.2.57" }},
    {{ "type": "a", "name": "service.filter.example.", "ttl": 60, "addr": "192.0.2.58" }},
    {{ "type": "a", "name": "sub.service.filter.example.", "ttl": 60, "addr": "192.0.2.59" }},
    {{ "type": "a", "name": "target.filter.example.", "ttl": 60, "addr": "192.0.2.60" }},
    {{ "type": "a", "name": "baseline.filter.example.", "ttl": 60, "addr": "192.0.2.61" }},
    {{ "type": "cname", "name": "cname.filter.example.", "ttl": 60, "target": "blocked.filter.example." }},
    {{ "type": "cname", "name": "alias2.filter.example.", "ttl": 60, "target": "target.filter.example." }},
    {{ "type": "a", "name": "listed.filter.example.", "ttl": 120, "addr": "192.0.2.71" }},
    {{ "type": "a", "name": "cname-only.filter.example.", "ttl": 120, "addr": "192.0.2.72" }},
    {{ "type": "a", "name": "safe-target.filter.example.", "ttl": 120, "addr": "192.0.2.75" }},
    {{ "type": "a", "name": "www.suffix.filter.example.", "ttl": 120, "addr": "192.0.2.76" }},
    {{ "type": "a", "name": "notsuffix.filter.example.", "ttl": 120, "addr": "192.0.2.77" }},
    {{ "type": "aaaa", "name": "op-a-only.filter.example.", "ttl": 120, "addr": "2001:db8::74" }}
  ]}},
  "baseline": [
    {{ "effect": "deny", "match": {{ "type": "exact", "value": "baseline.filter.example" }}, "reason": "safety baseline" }}
  ],
  "profiles": {{
    "adult": [
      {{ "effect": "deny", "match": {{ "type": "exact", "value": "never.filter.example" }}, "reason": "adult never" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "filter.example" }}, "reason": "adult filter" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "adult google" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "example" }}, "reason": "restricted" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{MAPPED_DEVICE}",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}]{extras},
  "filter": {{
    "sources": {sources},
    "catalog": {{
      "version": "v1",
      "services": [
        {{"id":"social","label":"Social","version":"1",
          "domains":[{{"type":"exact","value":"social.filter.example"}},
                     {{"type":"suffix","value":"service.filter.example"}}],
          "source":"operator-provided","evidence":"operator selection"}},
        {{"id":"unselected","label":"Unselected","version":"1",
          "domains":[{{"type":"exact","value":"unselected.filter.example"}}]}}
      ]
    }},
    "selected_services": ["social"]
  }}
}}"#
        )
    }

    fn options(&self, now: DateTime<Utc>) -> DurableOptions {
        DurableOptions {
            state_path: self.state.clone(),
            worker_id: WORKER.to_owned(),
            config_path: Some(self.config.clone()),
            now,
            hooks: None,
        }
    }

    fn disk(&self) -> Vec<u8> {
        fs::read(&self.state).unwrap()
    }
}

const GOOD_HOSTS: &str = "blocked.filter.example\ntarget.filter.example\n";
const GOOD_ABP: &str = "||ads.filter.example^\n||important.filter.example^$important\n||except.filter.example^\n@@||except.filter.example^\n||baseline.filter.example^\n@@||baseline.filter.example^\n||ok.filter.example^\n@@||ok.filter.example^\n";

async fn query(server: &DnsServer, tcp: bool, name: &str, source: IpAddr) -> Message {
    query_type(server, tcp, name, RecordType::A, source).await
}

async fn query_type(
    server: &DnsServer,
    tcp: bool,
    name: &str,
    qtype: RecordType,
    source: IpAddr,
) -> Message {
    if tcp {
        tcp_query(source, server.bind_addr(), name, qtype).await
    } else {
        udp_query(source, server.bind_addr(), name, qtype).await
    }
}

fn assert_denied(message: &Message) {
    assert_code(message, ResponseCode::NXDomain);
    assert_flags(message);
}

fn assert_allowed(message: &Message) {
    assert_code(message, ResponseCode::NoError);
    assert_flags(message);
}

fn observation(server: &DnsServer, name: &str) -> DecisionObservation {
    server
        .observations()
        .into_iter()
        .rev()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("no observation for {name}"))
}

// Final events are distinct from the synchronous policy evaluation log.
// Wait for the actual emitted query event, including answer shaping/alias denial.
async fn final_event(queue: &EventQueue, name: &str) -> DnsEventDto {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(event) = queue
                .drain(64)
                .into_iter()
                .find(|event| event.name == name.trim_end_matches('.'))
            {
                return event;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("final query event was not emitted")
}

fn persisted_sha(disk: &[u8], list_id: &str) -> String {
    let value: serde_json::Value = serde_json::from_slice(disk).unwrap();
    let lists = value["policy"]["filter"]["lists"].as_array().unwrap();
    lists.iter().find(|list| list["id"] == list_id).unwrap()["sha256_hex"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn hostname_regex_rules_enforce_on_udp_tcp_and_durable_restart() {
    let st = fixture("hostname-regex");
    let rules = r"/^ads\.filter\.example$/
/^except\.filter\.example$/
@@/^except\.filter\.example$/
/^important\.filter\.example$/$important
@@||important.filter.example^
/^ok\.filter\.example$/$important
@@||ok.filter.example^$important
/^xn--bcher-kva\.filter\.example$/
@@/^baseline\.filter\.example$/
";
    st.write_lists(GOOD_HOSTS, rules);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();
    for tcp in [false, true] {
        assert_denied(&query(&server, tcp, "ads.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "important.filter.example.", mapped()).await);
        assert_allowed(&query(&server, tcp, "except.filter.example.", mapped()).await);
        assert_allowed(&query(&server, tcp, "ok.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "xn--bcher-kva.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "bücher.filter.example.", mapped()).await);
        // Neither exception family can grant access against household policy
        // or the restrictive unknown-device profile.
        assert_denied(&query(&server, tcp, "baseline.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "ok.filter.example.", unknown()).await);
    }
    let blocked = observation(&server, "ads.filter.example.");
    assert!(blocked.filter_blocked);
    assert_eq!(blocked.filter_source_id.as_deref(), Some("abp-local"));
    assert_eq!(
        blocked.filter_rule.as_deref(),
        Some(r"/^ads\.filter\.example$/")
    );
    let generation = server.status().bundle_generation;
    server.stop().await;

    // Restart recompiles the accepted bytes, rather than adopting a changed
    // source file or losing the regex rule's original evidence.
    fs::write(&st.abp, "||unrelated.example^\n").unwrap();
    let restarted = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();
    assert_denied(&query(&restarted, true, "ads.filter.example.", mapped()).await);
    assert_allowed(&query(&restarted, false, "except.filter.example.", mapped()).await);
    assert_eq!(restarted.status().bundle_generation, generation);
    assert_eq!(
        observation(&restarted, "ads.filter.example.")
            .filter_rule
            .as_deref(),
        Some(r"/^ads\.filter\.example$/")
    );
    restarted.stop().await;
}

#[tokio::test]
async fn hosts_abp_exception_important_and_services_apply_on_udp_and_tcp() {
    let st = fixture("mixed");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    for tcp in [false, true] {
        assert_denied(&query(&server, tcp, "blocked.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "ads.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "important.filter.example.", mapped()).await);
        // A valid @@ exception is list-layer only: policy still allows it.
        assert_allowed(&query(&server, tcp, "except.filter.example.", mapped()).await);
        assert_allowed(&query(&server, tcp, "ok.filter.example.", mapped()).await);

        // Only the selected service blocks; unselected service domains stay open.
        assert_denied(&query(&server, tcp, "social.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "service.filter.example.", mapped()).await);
        assert_denied(&query(&server, tcp, "sub.service.filter.example.", mapped()).await);
        assert_allowed(&query(&server, tcp, "unselected.filter.example.", mapped()).await);
    }
    server.stop().await;
}

#[tokio::test]
async fn evidence_is_truthful_about_source_kind_rule_and_no_url_history() {
    let st = fixture("evidence");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    server.clear_observations();
    assert_denied(&query(&server, false, "blocked.filter.example.", mapped()).await);
    let hosts = observation(&server, "blocked.filter.example.");
    assert!(hosts.filter_blocked);
    assert_eq!(hosts.filter_source_id.as_deref(), Some("hosts-local"));
    assert_eq!(hosts.filter_source_kind.as_deref(), Some("list"));
    assert!(
        hosts.filter_rule.is_none(),
        "Hickory exposes no matched entry; never fabricate a per-line rule"
    );
    assert!(hosts.filter_note.unwrap().contains("no matched entry"));

    server.clear_observations();
    assert_denied(&query(&server, false, "ads.filter.example.", mapped()).await);
    let abp = observation(&server, "ads.filter.example.");
    assert_eq!(abp.filter_source_id.as_deref(), Some("abp-local"));
    let rule = abp.filter_rule.unwrap();
    assert!(rule.contains("ads.filter.example"), "{rule}");

    server.clear_observations();
    assert_denied(&query(&server, false, "social.filter.example.", mapped()).await);
    let service = observation(&server, "social.filter.example.");
    assert_eq!(service.filter_source_kind.as_deref(), Some("service"));
    assert_eq!(service.filter_source_id.as_deref(), Some("social"));
    assert!(service.filter_rule.is_none());

    let encoded = format!("{:?}", server.observations());
    assert!(
        !encoded.contains("example.invalid"),
        "source_url metadata must never appear in per-query observations"
    );
    server.stop().await;
}

#[tokio::test]
async fn list_exception_cannot_override_baseline_or_household_deny() {
    let st = fixture("authority");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    // A ABP @@ exception cannot beat the core safety baseline for the mapped
    // device, nor the household default deny for an unknown source.
    assert_denied(&query(&server, false, "baseline.filter.example.", mapped()).await);
    assert_denied(&query(&server, true, "baseline.filter.example.", unknown()).await);
    assert_allowed(&query(&server, false, "ok.filter.example.", mapped()).await);
    assert_denied(&query(&server, false, "ok.filter.example.", unknown()).await);
    let restricted = observation(&server, "ok.filter.example.");
    assert!(!restricted.allow);
    assert!(
        !restricted.filter_blocked,
        "household deny must win without being misreported as a list block"
    );
    assert_eq!(
        restricted.reason_code, "device_profile_deny",
        "unknown sources use the restrictive default device profile"
    );
    assert!(matches!(
        restricted.identity,
        family_policy::EffectiveIdentity::Unknown
    ));
    server.stop().await;
}

#[tokio::test]
async fn alias_to_blocked_target_is_denied_and_unsupported_qtypes_are_explicit() {
    let st = fixture("alias");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    // CNAME chain and differing-owner A answer both land on blocked targets.
    assert_denied(&query(&server, false, "cname.filter.example.", mapped()).await);
    assert_denied(&query(&server, true, "alias2.filter.example.", mapped()).await);
    let alias = observation(&server, "target.filter.example.");
    assert_eq!(
        alias.denied_alias_target.as_deref(),
        Some("target.filter.example.")
    );

    // Only A/AAAA/CNAME are evaluated. A TXT question is not given list
    // semantics by the worker; it follows the ordinary catalog/policy path.
    let txt = support::udp_query(
        mapped(),
        server.bind_addr(),
        "blocked.filter.example.",
        RecordType::TXT,
    )
    .await;
    assert_flags(&txt);
    assert!(
        txt.response_code != ResponseCode::NXDomain
            || observation(&server, "blocked.filter.example.").filter_blocked,
        "unsupported qtypes must not be list-blocked"
    );
    let observed = observation(&server, "blocked.filter.example.");
    assert_eq!(observed.query_type, RecordType::TXT);
    assert!(!observed.filter_blocked);
    server.stop().await;
}

#[tokio::test]
async fn atomic_reload_changes_answers_without_mixed_revisions_under_concurrency() {
    let st = fixture("reload");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = Arc::new(
        DnsServer::start_durable(st.options(Utc::now()))
            .await
            .unwrap(),
    );
    assert_denied(&query(&server, false, "blocked.filter.example.", mapped()).await);

    fs::write(&st.hosts, "other.filter.example\n").unwrap();
    let candidate = st.config(3, None);
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let server = Arc::clone(&server);
        tasks.push(tokio::spawn(async move {
            for _ in 0..24 {
                let _ = query(&server, false, "blocked.filter.example.", mapped()).await;
            }
        }));
    }
    tokio::time::sleep(Duration::from_millis(4)).await;
    let outcome = server.reload(candidate.as_bytes(), Utc::now()).unwrap();
    assert_eq!(outcome.revision, 3);
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(server.revision(), 3);
    assert_allowed(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert_denied(&query(&server, true, "other.filter.example.", mapped()).await);

    for entry in server.observations() {
        if entry.name != "blocked.filter.example." {
            continue;
        }
        let blocked = !entry.allow && entry.filter_blocked;
        assert_eq!(
            blocked,
            entry.policy_revision == 2,
            "answer and revision came from different snapshots"
        );
    }
    Arc::try_unwrap(server)
        .ok()
        .expect("no query task keeps the server")
        .stop()
        .await;
}

#[tokio::test]
async fn bad_candidates_retain_the_whole_old_runtime_and_disk() {
    let st = fixture("bad-candidates");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();
    let committed = st.disk();
    let original_sha = persisted_sha(&committed, "hosts-local");

    // Missing source file.
    let missing = st.dir.join("gone.txt");
    let mut candidate =
        st.config_with_sources(3, Some(STAMP), st.sources_with_paths(&missing, &st.abp));
    assert!(matches!(
        server.reload(candidate.as_bytes(), Utc::now()),
        Err(ReloadError::FilterFailed(_))
    ));
    assert_eq!(st.disk(), committed);
    assert_eq!(server.revision(), 2);
    assert_denied(&query(&server, false, "blocked.filter.example.", mapped()).await);

    // Unsupported ABP modifier must be diagnosed, never silently matched.
    fs::write(&st.abp, "||ads.filter.example^$third-party\n").unwrap();
    candidate = st.config(4, Some(STAMP));
    assert!(matches!(
        server.reload(candidate.as_bytes(), Utc::now()),
        Err(ReloadError::FilterFailed(_))
    ));
    assert_eq!(st.disk(), committed);
    assert_eq!(server.revision(), 2);

    // Malformed UTF-8 and an oversized file are rejected before compile.
    fs::write(&st.hosts, [0xff, 0xfe, 0x00]).unwrap();
    candidate = st.config(5, Some(STAMP));
    assert!(matches!(
        server.reload(candidate.as_bytes(), Utc::now()),
        Err(ReloadError::FilterFailed(_))
    ));
    fs::write(&st.hosts, vec![b'a'; 8 * 1024 * 1024 + 1]).unwrap();
    candidate = st.config(6, Some(STAMP));
    assert!(matches!(
        server.reload(candidate.as_bytes(), Utc::now()),
        Err(ReloadError::FilterFailed(_))
    ));
    assert_eq!(st.disk(), committed);
    assert_eq!(persisted_sha(&st.disk(), "hosts-local"), original_sha);
    assert_denied(&query(&server, true, "blocked.filter.example.", mapped()).await);
    server.stop().await;
}

#[tokio::test]
async fn symlinked_source_file_is_not_a_regular_file() {
    let st = fixture("symlink");
    fs::write(&st.abp, GOOD_ABP).unwrap();
    let real = st.dir.join("real-hosts.txt");
    fs::write(&real, "linked.filter.example\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &st.hosts).unwrap();
    #[cfg(not(unix))]
    fs::write(&st.hosts, "linked.filter.example\n").unwrap();
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now())).await;
    #[cfg(unix)]
    assert!(server.is_err(), "a symlinked list source must be rejected");
    #[cfg(not(unix))]
    assert!(server.is_ok());
    if let Ok(server) = server {
        server.stop().await;
    }
}

#[tokio::test]
async fn restart_preserves_persisted_bytes_when_source_file_changes_or_vanishes() {
    let st = fixture("restart");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let first = DnsServer::start_durable(st.options(now)).await.unwrap();
    let committed = st.disk();
    let original_sha = persisted_sha(&committed, "hosts-local");
    assert_eq!(first.published_at(), now);
    first.stop().await;

    // Both the file content and the configured path move on while the worker
    // is down. Neither may affect the filter that was actually applied.
    fs::write(&st.hosts, "other.filter.example\n").unwrap();
    let vanished = st.dir.join("vanished.txt");
    fs::write(
        &st.config,
        st.config_with_sources(
            99,
            Some("2026-11-26T11:00:00Z"),
            st.sources_with_paths(&vanished, &st.abp),
        ),
    )
    .unwrap();
    let restarted = DnsServer::start_durable(st.options(now)).await.unwrap();
    assert_eq!(restarted.revision(), 2);
    assert_eq!(restarted.published_at(), now);
    assert_denied(&query(&restarted, false, "blocked.filter.example.", mapped()).await);
    assert_allowed(&query(&restarted, false, "other.filter.example.", mapped()).await);
    assert_eq!(st.disk(), committed);
    assert_eq!(persisted_sha(&st.disk(), "hosts-local"), original_sha);
    restarted.stop().await;

    // The same holds with no config file at all: the bundle is authoritative.
    fs::remove_file(&st.hosts).unwrap();
    let mut options = st.options(now);
    options.config_path = None;
    let from_state = DnsServer::start_durable(options).await.unwrap();
    assert_denied(&query(&from_state, true, "blocked.filter.example.", mapped()).await);
    from_state.stop().await;
}

#[tokio::test]
async fn controller_pull_after_local_filter_change_keeps_the_new_filter() {
    let st = fixture("controller-basis");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let server = DnsServer::start_durable(st.options(now)).await.unwrap();

    // A local filter change wins revision 3 and replaces the material.
    fs::write(&st.hosts, "other.filter.example\n").unwrap();
    server
        .reload(st.config(3, Some(STAMP)).as_bytes(), now)
        .unwrap();
    assert_allowed(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert_denied(&query(&server, false, "other.filter.example.", mapped()).await);
    let new_sha = {
        let cfg = server.local_config();
        let (material, _) = prepare_filter_material(&cfg.filter, 3, &family_dns::no_remote)
            .unwrap()
            .unwrap();
        material
            .lists
            .iter()
            .find(|list| list.id == "hosts-local")
            .unwrap()
            .sha256_hex
            .clone()
    };

    // A controller policy at a higher revision uses the current local config
    // and material as its compile basis, never the startup bundle.
    let mut policy_config = server.local_config();
    policy_config.policy_revision = 4;
    let policy = policy_config.policy_at(now);
    let outcome = server.apply_controller_policy(&policy, now).unwrap();
    assert!(matches!(
        outcome,
        family_dns::SyncCapability::AppliedLocally { revision: 4 }
    ));
    assert_allowed(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert_denied(&query(&server, false, "other.filter.example.", mapped()).await);
    let entry = observation(&server, "other.filter.example.");
    assert_eq!(entry.filter_source_id.as_deref(), Some("hosts-local"));
    assert_eq!(persisted_sha(&st.disk(), "hosts-local"), new_sha);
    server.stop().await;
}

#[tokio::test]
async fn typed_material_apply_seam_uses_the_same_persist_publish_path() {
    let st = fixture("material-seam");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let server = DnsServer::start_durable(st.options(now)).await.unwrap();
    let committed = st.disk();

    // A future fetch layer can hand validated material straight to the seam.
    let next_hosts = st.dir.join("candidate-hosts.txt");
    fs::write(&next_hosts, "other.filter.example\n").unwrap();
    let cfg = server.local_config();
    let source_json = st.sources_with_paths(&next_hosts, &st.abp);
    let mut candidate_cfg = cfg.clone();
    candidate_cfg.filter = serde_json::from_str(&format!(
        r#"{{"sources":{source_json},"catalog":{},"selected_services":["social"]}}"#,
        serde_json::to_string(&cfg.filter.catalog).unwrap()
    ))
    .unwrap();
    let (material, _snapshot) =
        prepare_filter_material(&candidate_cfg.filter, 2, &family_dns::no_remote)
            .unwrap()
            .unwrap();

    let before = server.status();
    let outcome = server
        .apply_filter_material(material.clone(), before.bundle_generation, now)
        .unwrap();
    assert!(matches!(
        outcome,
        family_dns::MaterialOutcome::Applied {
            policy_revision: 2,
            ..
        }
    ));
    let after = server.status();
    assert_eq!(after.policy_revision, before.policy_revision);
    assert_eq!(after.policy_published_at, before.policy_published_at);
    assert_eq!(after.bundle_generation, before.bundle_generation + 1);
    assert_eq!(after.filter_generation, before.filter_generation + 1);
    assert_eq!(server.revision(), 2);
    assert_allowed(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert_denied(&query(&server, false, "other.filter.example.", mapped()).await);
    assert_ne!(st.disk(), committed);

    // A mismatched material identity is rejected without touching either the
    // live filter or the durable bundle.
    let mut bad = material;
    bad.lists[0].id = "not-configured".to_owned();
    let committed_after_apply = st.disk();
    assert!(matches!(
        server.apply_filter_material(bad, server.status().bundle_generation, now),
        Err(ReloadError::FilterFailed(_))
    ));
    assert_eq!(
        st.disk(),
        committed_after_apply,
        "rejected apply never writes disk"
    );
    assert_eq!(
        server.status(),
        after,
        "rejected apply never advances a counter"
    );
    assert_eq!(server.revision(), 2);
    assert_allowed(&query(&server, true, "blocked.filter.example.", mapped()).await);
    server.stop().await;
}

static FAIL_RENAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn injected_failure(_path: &Path) -> std::io::Result<()> {
    if FAIL_RENAME.load(Ordering::SeqCst) {
        Err(std::io::Error::other("injected pre-rename failure"))
    } else {
        Ok(())
    }
}

#[tokio::test]
async fn persistence_failure_keeps_old_filter_material_and_disk() {
    FAIL_RENAME.store(false, Ordering::SeqCst);
    let st = fixture("persist-failure");
    st.write_lists(GOOD_HOSTS, GOOD_ABP);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let opts = DurableOptions {
        hooks: Some(WriteHooks {
            before_rename: injected_failure,
            ..WriteHooks::default()
        }),
        ..st.options(Utc::now())
    };
    let server = DnsServer::start_durable(opts).await.unwrap();
    let committed = st.disk();

    fs::write(&st.hosts, "other.filter.example\n").unwrap();
    FAIL_RENAME.store(true, Ordering::SeqCst);
    let error = server
        .reload(st.config(3, Some(STAMP)).as_bytes(), Utc::now())
        .unwrap_err();
    assert!(matches!(
        &error,
        ReloadError::PersistFailed(detail) if detail.contains("before rename")
    ));
    assert_eq!(st.disk(), committed);
    assert_eq!(server.revision(), 2);
    assert_denied(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert_allowed(&query(&server, false, "other.filter.example.", mapped()).await);

    FAIL_RENAME.store(false, Ordering::SeqCst);
    server
        .reload(st.config(3, Some(STAMP)).as_bytes(), Utc::now())
        .unwrap();
    assert_denied(&query(&server, false, "other.filter.example.", mapped()).await);
    server.stop().await;
}

#[test]
fn old_configs_without_filter_remain_valid() {
    let config = Config::parse(support::test_config(15353, "").as_bytes()).unwrap();
    assert_eq!(config.filter.sources.len(), 0);
    assert!(config.filter.catalog.is_none());
    assert!(config.filter.selected_services.is_empty());
}

#[tokio::test]
async fn list_dnsrewrite_record_sets_shape_udp_tcp_ttl_and_owner() {
    let st = fixture("rewrite-shaping");
    const RULES: &str = "\
||listed.filter.example^$dnsrewrite=192.0.2.70
||multi.filter.example^$dnsrewrite=192.0.2.2
||multi.filter.example^$dnsrewrite=192.0.2.3
||multi.filter.example^$dnsrewrite=2001:db8::2
||multi.filter.example^$dnsrewrite=2001:db8::3
||cname-only.filter.example^$dnsrewrite=NOERROR;CNAME;safe-target.filter.example
||suffix.filter.example^$dnsrewrite=192.0.2.80
||xn--bcher-kva.filter.example^$dnsrewrite=192.0.2.81
";
    st.write_lists(GOOD_HOSTS, RULES);
    fs::write(&st.config, st.config(2, None)).unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    for tcp in [false, true] {
        let answer = query(&server, tcp, "listed.filter.example.", mapped()).await;
        assert_allowed(&answer);
        assert_eq!(
            addresses(&answer),
            vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 70))]
        );
        assert!(answer.answers.iter().all(|record| record.ttl == 60));
        assert_eq!(
            answer.answers[0].name.to_string().to_ascii_lowercase(),
            "listed.filter.example."
        );
    }

    // Every distinct value survives: A keeps both A records, AAAA keeps both
    // AAAA records, ANY keeps all four, all with the fixed list TTL.
    let multi_a = query(&server, false, "multi.filter.example.", mapped()).await;
    assert_allowed(&multi_a);
    assert_eq!(
        addresses(&multi_a),
        vec![
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 3)),
        ]
    );
    let multi_aaaa = query_type(
        &server,
        true,
        "multi.filter.example.",
        RecordType::AAAA,
        mapped(),
    )
    .await;
    assert_allowed(&multi_aaaa);
    assert_eq!(
        addresses(&multi_aaaa),
        vec![
            IpAddr::V6(Ipv6Addr::from_str("2001:db8::2").unwrap()),
            IpAddr::V6(Ipv6Addr::from_str("2001:db8::3").unwrap()),
        ]
    );
    let multi_any = query_type(
        &server,
        false,
        "multi.filter.example.",
        RecordType::ANY,
        mapped(),
    )
    .await;
    assert_allowed(&multi_any);
    assert_eq!(multi_any.answers.len(), 4);
    assert!(multi_any.answers.iter().all(|record| record.ttl == 60));

    let alias = query_type(
        &server,
        true,
        "cname-only.filter.example.",
        RecordType::CNAME,
        mapped(),
    )
    .await;
    assert_allowed(&alias);
    assert_eq!(
        cname_targets(&alias),
        vec!["safe-target.filter.example.".to_owned()]
    );
    assert!(alias.answers.iter().all(|record| record.ttl == 60));
    // MatchedEmpty is NODATA for the claimed owner, not a catalog fallback
    // even though the local zone has an A record at this exact name.
    let nodata = query(&server, false, "cname-only.filter.example.", mapped()).await;
    assert_allowed(&nodata);
    assert!(
        nodata.answers.is_empty(),
        "matched-empty rewrite must not fall through"
    );

    // A subdomain inherits the owner's set but the answer is still owned by
    // the original question; lookalikes and IDN variants are not confused.
    let sub = query(&server, false, "www.suffix.filter.example.", mapped()).await;
    assert_eq!(
        addresses(&sub),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 80))]
    );
    assert_eq!(
        sub.answers[0].name.to_string().to_ascii_lowercase(),
        "www.suffix.filter.example."
    );
    let lookalike = query(&server, false, "notsuffix.filter.example.", mapped()).await;
    assert_eq!(
        addresses(&lookalike),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 77))]
    );
    for idn in ["bücher.filter.example.", "xn--bcher-kva.filter.example."] {
        let answer = query(&server, false, idn, mapped()).await;
        assert_eq!(
            addresses(&answer),
            vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 81))],
            "{idn}"
        );
    }
    // The restrictive household policy denies an unknown source before any
    // rewrite is considered.
    assert_denied(&query(&server, false, "multi.filter.example.", unknown()).await);

    let observed = observation(&server, "listed.filter.example.");
    assert!(observed.allow);
    assert!(!observed.filter_blocked);
    assert!(observed.filter_rule.is_none());
    assert!(observed.filter_note.is_none());
    server.stop().await;
}

#[tokio::test]
async fn household_blocks_and_list_exceptions_do_not_grant_rewrites() {
    let st = fixture("rewrite-precedence");
    const RULES: &str = "\
||blocked.filter.example^$dnsrewrite=192.0.2.90
||baseline.filter.example^$dnsrewrite=192.0.2.91
||never.filter.example^$dnsrewrite=192.0.2.92
||list-except.filter.example^$dnsrewrite=192.0.2.93
@@||list-except.filter.example^
||denied-target.filter.example^
||canonical-alias.filter.example^$dnsrewrite=NOERROR;CNAME;denied-target.filter.example
";
    let extras = r#",
  "rewrites": [
    {"type":"a","name":"list-except.filter.example.","ttl":45,"addr":"192.0.2.96"}
  ]"#;
    st.write_lists(GOOD_HOSTS, RULES);
    fs::write(
        &st.config,
        st.config_with_options(2, None, st.sources(), extras),
    )
    .unwrap();
    let events = Arc::new(EventQueue::new(64));
    let server = DnsServer::start_durable_with_events(st.options(Utc::now()), None, events.clone())
        .await
        .unwrap();

    // A hosts block, the safety baseline and an exact household deny all win
    // over a rewrite on the same owner. None is misreported as a rewrite.
    assert_denied(&query(&server, false, "blocked.filter.example.", mapped()).await);
    assert!(observation(&server, "blocked.filter.example.").filter_blocked);
    assert_denied(&query(&server, false, "baseline.filter.example.", mapped()).await);
    assert_denied(&query(&server, false, "never.filter.example.", mapped()).await);

    // An ordinary list exception suppresses the list rewrite but not the
    // operator's exact rewrite of that same owner.
    let operator = query(&server, false, "list-except.filter.example.", mapped()).await;
    assert_allowed(&operator);
    assert_eq!(
        addresses(&operator),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 96))]
    );
    assert!(operator.answers.iter().all(|record| record.ttl == 45));
    let observed = observation(&server, "list-except.filter.example.");
    assert!(observed.allow);
    assert!(!observed.filter_blocked);

    // A list CNAME pointing at a blocked target is still denied through the
    // same alias inspection used by every other answer path.
    assert_denied(
        &query_type(
            &server,
            true,
            "canonical-alias.filter.example.",
            RecordType::CNAME,
            mapped(),
        )
        .await,
    );
    let alias = final_event(&events, "canonical-alias.filter.example.").await;
    assert!(!alias.allow);
    assert_eq!(
        alias.denied_alias_target.as_deref(),
        Some("denied-target.filter.example")
    );
    server.stop().await;
}

#[tokio::test]
async fn operator_rewrite_owner_wins_including_nodata() {
    let st = fixture("rewrite-operator");
    const RULES: &str = "\
||op-a-only.filter.example^$dnsrewrite=192.0.2.99
||op-exact.filter.example^$dnsrewrite=192.0.2.98
";
    let extras = r#",
  "rewrites": [
    {"type":"a","name":"op-a-only.filter.example.","ttl":45,"addr":"192.0.2.94"},
    {"type":"a","name":"op-exact.filter.example.","ttl":45,"addr":"192.0.2.97"}
  ]"#;
    st.write_lists(GOOD_HOSTS, RULES);
    fs::write(
        &st.config,
        st.config_with_options(2, None, st.sources(), extras),
    )
    .unwrap();
    let server = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    // The operator owner wins over the list value on both UDP and TCP.
    for tcp in [false, true] {
        let answer = query(&server, tcp, "op-exact.filter.example.", mapped()).await;
        assert_allowed(&answer);
        assert_eq!(
            addresses(&answer),
            vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 97))]
        );
        assert!(answer.answers.iter().all(|record| record.ttl == 45));
    }
    // A matched operator owner with no AAAA record is NODATA, even though the
    // local zone and the list both have data for this name.
    let nodata = query_type(
        &server,
        false,
        "op-a-only.filter.example.",
        RecordType::AAAA,
        mapped(),
    )
    .await;
    assert_allowed(&nodata);
    assert!(nodata.answers.is_empty());
    let a = query(&server, false, "op-a-only.filter.example.", mapped()).await;
    assert_eq!(
        addresses(&a),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 94))]
    );
    server.stop().await;
}

#[tokio::test]
async fn safesearch_wins_over_operator_and_list_rewrite() {
    let st = fixture("rewrite-safesearch");
    let upstream_config = format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 3,
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "local_zones": {{ "forcesafesearch.google.com.": [
    {{ "type": "a", "name": "forcesafesearch.google.com.", "ttl": 60, "addr": "192.0.2.120" }}
  ]}},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "upstream google" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "google.com" }}, "reason": "restricted google" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{MAPPED_DEVICE}",
    "default_profile": "adult",
    "source_ips": ["127.0.0.1"]
  }}]
}}"#
    );
    let upstream = DnsServer::start(Config::parse(upstream_config.as_bytes()).unwrap())
        .await
        .unwrap();
    let extras = format!(
        r#",
  "upstreams": ["{}"],
  "safe_search": {{"enabled":true,"google":true}},
  "rewrites": [
    {{"type":"a","name":"www.google.com.","ttl":45,"addr":"192.0.2.97"}}
  ]"#,
        upstream.bind_addr()
    );
    st.write_lists(GOOD_HOSTS, "||www.google.com^$dnsrewrite=192.0.2.98\n");
    fs::write(
        &st.config,
        st.config_with_options(2, None, st.sources(), &extras),
    )
    .unwrap();
    let worker = DnsServer::start_durable(st.options(Utc::now()))
        .await
        .unwrap();

    let answer = query(&worker, false, "www.google.com.", mapped()).await;
    assert_allowed(&answer);
    assert_eq!(
        cname_targets(&answer),
        vec!["forcesafesearch.google.com.".to_owned()]
    );
    let resolved = addresses(&answer);
    assert!(resolved.contains(&IpAddr::V4(Ipv4Addr::new(192, 0, 2, 120))));
    assert!(!resolved.contains(&IpAddr::V4(Ipv4Addr::new(192, 0, 2, 97))));
    assert!(!resolved.contains(&IpAddr::V4(Ipv4Addr::new(192, 0, 2, 98))));
    worker.stop().await;
    upstream.stop().await;
}

#[tokio::test]
async fn list_dnsrewrite_answers_pass_bogus_and_ipv6_shaping() {
    let st = fixture("rewrite-shaping-settings");
    const RULES: &str = "\
||bogus.filter.example^$dnsrewrite=192.0.2.70
||v6.filter.example^$dnsrewrite=2001:db8::70
";
    let extras = r#",
  "cache": {
    "bogus_nxdomain_ips": ["192.0.2.70"],
    "disable_ipv6": true
  }"#;
    st.write_lists(GOOD_HOSTS, RULES);
    fs::write(
        &st.config,
        st.config_with_options(2, None, st.sources(), extras),
    )
    .unwrap();
    let events = Arc::new(EventQueue::new(64));
    let server = DnsServer::start_durable_with_events(st.options(Utc::now()), None, events.clone())
        .await
        .unwrap();

    assert_denied(&query(&server, false, "bogus.filter.example.", mapped()).await);
    let bogus = final_event(&events, "bogus.filter.example.").await;
    assert!(!bogus.allow);
    assert_eq!(bogus.reason_code, "bogus_answer_ip");
    assert!(!bogus.filter_blocked, "a shaped answer is not a list block");

    let stripped = query_type(
        &server,
        true,
        "v6.filter.example.",
        RecordType::AAAA,
        mapped(),
    )
    .await;
    assert_allowed(&stripped);
    assert!(addresses(&stripped).is_empty(), "AAAA must be stripped");
    server.stop().await;
}

#[tokio::test]
async fn list_dnsrewrite_survives_reload_and_restart_from_persisted_bytes() {
    let st = fixture("rewrite-durable");
    const RULES: &str = "\
||stable.filter.example^$dnsrewrite=192.0.2.70
||cname-stable.filter.example^$dnsrewrite=NOERROR;CNAME;safe-target.filter.example
";
    st.write_lists(GOOD_HOSTS, RULES);
    fs::write(&st.config, st.config(2, Some(STAMP))).unwrap();
    let now = STAMP.parse::<DateTime<Utc>>().unwrap();
    let first = DnsServer::start_durable(st.options(now)).await.unwrap();
    let initial = first.status();
    let original_sha = persisted_sha(&st.disk(), "abp-local");
    assert_eq!(
        addresses(&query(&first, false, "stable.filter.example.", mapped()).await),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 70))]
    );

    // Re-applying identical bytes at a new policy revision keeps the same
    // filter identity and generation, and the compiled answer is unchanged.
    fs::write(&st.abp, RULES).unwrap();
    first
        .reload(st.config(3, Some(STAMP)).as_bytes(), now)
        .unwrap();
    let reloaded = first.status();
    assert_eq!(reloaded.filter_identity, initial.filter_identity);
    assert_eq!(reloaded.filter_generation, initial.filter_generation);
    assert_eq!(persisted_sha(&st.disk(), "abp-local"), original_sha);
    assert_eq!(
        addresses(&query(&first, true, "stable.filter.example.", mapped()).await),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 70))]
    );
    first.stop().await;

    // Restart uses the exact persisted list bytes even after the source file
    // and the on-disk config are changed while the worker is down.
    fs::write(&st.abp, "||unrelated.example^\n").unwrap();
    let vanished = st.dir.join("vanished.txt");
    fs::write(
        &st.config,
        st.config_with_sources(99, Some(STAMP), st.sources_with_paths(&st.hosts, &vanished)),
    )
    .unwrap();
    let restarted = DnsServer::start_durable(st.options(now)).await.unwrap();
    assert_eq!(restarted.status(), reloaded);
    assert_eq!(persisted_sha(&st.disk(), "abp-local"), original_sha);
    assert_eq!(
        addresses(&query(&restarted, false, "stable.filter.example.", mapped()).await),
        vec![IpAddr::V4(Ipv4Addr::new(192, 0, 2, 70))]
    );
    let alias = query_type(
        &restarted,
        true,
        "cname-stable.filter.example.",
        RecordType::CNAME,
        mapped(),
    )
    .await;
    assert_allowed(&alias);
    assert_eq!(
        cname_targets(&alias),
        vec!["safe-target.filter.example.".to_owned()]
    );
    restarted.stop().await;
}
