//! Real UDP/TCP tests for local list + selected-service filtering in the DNS
//! worker, including durable material, atomic reload/restart and controller
//! preservation. No URL is fetched and no host network setting is changed.

mod support;

use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use family_dns::{
    prepare_filter_material, Config, DecisionObservation, DnsServer, DurableOptions, ReloadError,
    WriteHooks,
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
    {{ "type": "cname", "name": "alias2.filter.example.", "ttl": 60, "target": "target.filter.example." }}
  ]}},
  "baseline": [
    {{ "effect": "deny", "match": {{ "type": "exact", "value": "baseline.filter.example" }}, "reason": "safety baseline" }}
  ],
  "profiles": {{
    "adult": [
      {{ "effect": "deny", "match": {{ "type": "exact", "value": "never.filter.example" }}, "reason": "adult never" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "filter.example" }}, "reason": "adult filter" }}
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
  }}],
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
    let qtype = RecordType::A;
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
