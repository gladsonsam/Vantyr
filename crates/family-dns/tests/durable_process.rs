//! Real-process durability and local-control tests for `vantyr-dns`.
//! Every child is killed and waited for, and every temporary directory is
//! removed, even when an assertion fails.

mod support;

use std::fs;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use support::test_config;

const WORKER: &str = "dns-worker-1";
const STAMP: &str = "2026-11-26T10:00:00Z";

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn free_port() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket.local_addr().unwrap().port()
}

struct ProcessGuard {
    dir: PathBuf,
    child: Option<Child>,
}

impl ProcessGuard {
    fn spawn(&mut self, exe: &str, config: &Path, state: &Path) {
        let child = Command::new(exe)
            .args([
                "--config",
                &config.to_string_lossy(),
                "--state",
                &state.to_string_lossy(),
                "--worker",
                WORKER,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        self.child = Some(child);
    }

    fn stop_child(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.stop_child();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let id = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "vantyr-dns-proc-{}-{name}-{id}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_config(
    path: &PathBuf,
    port: u16,
    revision: u64,
    first: &str,
    second: &str,
    published: &str,
) {
    let mut json = test_config(port, "").replace(
        "\"source_ips\": [\"127.0.0.2\"]",
        "\"source_ips\": [\"127.0.0.1\"]",
    );
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
    json = json.replace(
        "\"policy_revision\":",
        &format!("\"policy_published_at\": \"{published}\",\n\"policy_revision\":"),
    );
    fs::write(path, json).unwrap();
}

fn dig(port: u16, name: &str) -> String {
    let output = Command::new("dig")
        .args([
            "@127.0.0.1",
            "-p",
            &port.to_string(),
            name,
            "A",
            "+short",
            "+time=1",
            "+tries=1",
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Poll until the named address appears, or panic with the last answer.
fn wait_for(guard: &mut ProcessGuard, port: u16, expected: &str) -> String {
    let mut last = String::new();
    for _ in 0..80 {
        let child = guard.child.as_mut().expect("worker must be running");
        if let Some(status) = child.try_wait().unwrap() {
            panic!("vantyr-dns exited early with {status}; last answer '{last}'");
        }
        last = dig(port, "www.lab.example.");
        if last.contains(expected) {
            return last;
        }
        thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {expected}; last answer '{last}'");
}

#[test]
fn abrupt_restart_loads_the_bundle_and_keeps_the_original_publication_time() {
    let exe = env!("CARGO_BIN_EXE_vantyr-dns");
    let port = free_port();
    let dir = temp_dir("restart");
    let config = dir.join("dns.json");
    let state = dir.join("state.json");
    write_config(&config, port, 2, "192.0.2.10", "192.0.2.11", STAMP);

    let mut guard = ProcessGuard { dir, child: None };
    guard.spawn(exe, &config, &state);
    wait_for(&mut guard, port, "192.0.2.10");

    // Simulate a lost ack: the process dies without any orderly shutdown.
    guard.stop_child();

    // The controller-side config advances while the worker is down.
    write_config(
        &config,
        port,
        99,
        "192.0.2.20",
        "192.0.2.21",
        "2026-11-26T11:00:00Z",
    );
    guard.spawn(exe, &config, &state);
    let answer = wait_for(&mut guard, port, "192.0.2.10");
    assert!(
        !answer.contains("192.0.2.20"),
        "restart adopted the changed config instead of the bundle: '{answer}'"
    );

    let status = Command::new(exe)
        .args([
            "--state-status",
            "--state",
            &state.to_string_lossy(),
            "--worker",
            WORKER,
        ])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "state-status failed: {}",
        String::from_utf8_lossy(&status.stderr)
    );
    let text = String::from_utf8_lossy(&status.stdout);
    assert!(text.contains("revision 2"), "{text}");
    assert!(
        text.contains("published_at 2026-11-26T10:00:00"),
        "restart rejuvenated the policy age: {text}"
    );
}

#[cfg(unix)]
#[test]
fn sighup_reloads_one_atomic_version() {
    let exe = env!("CARGO_BIN_EXE_vantyr-dns");
    let port = free_port();
    let dir = temp_dir("sighup");
    let config = dir.join("dns.json");
    let state = dir.join("state.json");
    write_config(&config, port, 2, "192.0.2.10", "192.0.2.11", STAMP);

    let mut guard = ProcessGuard { dir, child: None };
    guard.spawn(exe, &config, &state);
    wait_for(&mut guard, port, "192.0.2.10");

    write_config(&config, port, 3, "192.0.2.20", "192.0.2.21", STAMP);
    let pid = guard.child.as_ref().unwrap().id().to_string();
    let signal = Command::new("kill").args(["-HUP", &pid]).status().unwrap();
    assert!(signal.success());
    let answer = wait_for(&mut guard, port, "192.0.2.20");
    assert!(
        !answer.contains("192.0.2.10"),
        "SIGHUP left an old answer behind: '{answer}'"
    );
    assert!(
        guard.child.as_mut().unwrap().try_wait().unwrap().is_none(),
        "SIGHUP must not stop the listener"
    );

    let pid = guard.child.as_ref().unwrap().id().to_string();
    assert!(Command::new("kill")
        .args(["-INT", &pid])
        .status()
        .unwrap()
        .success());
}
