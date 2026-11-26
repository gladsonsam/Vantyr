//! Real process lifecycle: Ctrl-C during an in-flight scheduled download must
//! cancel and join the integrator before consuming the listener, exit 0 with
//! no panic and no leaked task.
//!
//! The URL is an unreachable but public HTTPS literal: production SSRF/TLS
//! policy stays fully enabled and no public provider is contacted for data.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use support::HOUSEHOLD;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn fixture(name: &str) -> PathBuf {
    let serial = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-sub-process-{}-{name}-{serial}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_fixture(dir: &Path) {
    let url = "https://8.8.8.8:81/list";
    let cache = dir.join("cache");
    fs::create_dir_all(&cache).unwrap();
    let bytes = b"blocked.proc.example\n";
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let snapshot = json!({
        "schema": 1,
        "source_id": "public-list",
        "url": url,
        "revision": 1,
        "validator_version": 1,
        "bytes_b64": encoded,
        "sha256": digest,
        "rule_count": 1,
        "checked_at": "2026-11-26T10:00:00Z",
        "fetched_at": "2026-11-26T10:00:00Z",
        "content_updated_at": null,
        "etag": null,
        "last_modified": null
    });
    fs::write(
        cache.join("public-list.json"),
        serde_json::to_vec(&snapshot).unwrap(),
    )
    .unwrap();

    let config = format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 2,
  "bind": {{ "address": "127.0.0.1", "port": 0 }},
  "deny": {{ "mode": "nxdomain" }},
  "local_zones": {{ "proc.example.": [
    {{ "type": "a", "name": "blocked.proc.example.", "ttl": 60, "addr": "192.0.2.10" }}
  ]}},
  "profiles": {{
    "adult": [{{ "effect": "allow", "match": {{ "type": "suffix", "value": "proc.example" }}, "reason": "adult" }}],
    "restricted": [{{ "effect": "deny", "match": {{ "type": "suffix", "value": "example" }}, "reason": "restricted" }}]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}],
  "filter": {{ "subscriptions": {{
    "cache_path": "{}",
    "sources": [{{
      "id": "public-list", "url": "{}", "format": "hosts", "enabled": true,
      "metadata": {{ "title": "Operator list", "publisher": "Operator", "license": "asserted" }}
    }}]
  }} }}
}}"#,
        cache.display(),
        url
    );
    fs::write(dir.join("dns.json"), config).unwrap();

    let subscriptions = json!({
        "cache_path": cache,
        "sources": [{
            "id": "public-list",
            "url": url,
            "format": "hosts",
            "enabled": true,
            "metadata": {
                "title": "Operator list",
                "publisher": "Operator",
                "license": "asserted"
            }
        }]
    });
    fs::write(
        dir.join("subscriptions.json"),
        serde_json::to_vec(&subscriptions).unwrap(),
    )
    .unwrap();
}

#[cfg(unix)]
#[test]
fn ctrl_c_during_in_flight_download_joins_runtime_and_exits_cleanly() {
    let dir = fixture("sigint");
    write_fixture(&dir);
    let stderr = Arc::new(Mutex::new(String::new()));
    let reader_stderr = stderr.clone();

    let mut child = Command::new(env!("CARGO_BIN_EXE_vantyr-dns"))
        .arg("--config")
        .arg(dir.join("dns.json"))
        .arg("--state")
        .arg(dir.join("state.json"))
        .arg("--worker")
        .arg("dns-sub-process")
        .arg("--subscriptions")
        .arg(dir.join("subscriptions.json"))
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let handle = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(handle).lines() {
            let Ok(line) = line else { break };
            let mut sink = reader_stderr.lock().unwrap();
            sink.push_str(&line);
            sink.push('\n');
        }
    });

    // Wait until the listener exists and the integrator has started its first
    // (stalled) download to the unreachable public endpoint.
    let deadline = Instant::now() + Duration::from_secs(30);
    // The durable bundle is written before the listener binds, so it is a
    // reliable readiness signal independent of stderr pipe buffering.
    while !dir.join("state.json").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!(
                "worker exited early with {status}: {}",
                stderr.lock().unwrap()
            );
        }
        assert!(
            Instant::now() < deadline,
            "worker never bootstrapped: {}",
            stderr.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(400));
    assert!(
        child.try_wait().unwrap().is_none(),
        "worker exited before SIGINT"
    );

    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
    let started = Instant::now();
    let mut exited = None;
    while started.elapsed() < Duration::from_secs(12) {
        if let Some(status) = child.try_wait().unwrap() {
            exited = Some(status);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let status = exited.expect("worker did not exit after SIGINT");
    assert!(
        status.success(),
        "non-zero exit: {}",
        stderr.lock().unwrap()
    );
    reader.join().unwrap();
    let output = stderr.lock().unwrap();
    assert!(!output.contains("panic"), "worker panicked: {output}");
    assert!(
        output.contains("stopped"),
        "worker did not finish shutdown: {output}"
    );
    assert!(
        dir.join("state.json").exists(),
        "durable bundle must survive shutdown"
    );
}
