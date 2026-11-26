//! Real process smoke test for the public `vantyr-dns` binary.

mod support;

use std::fs;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use support::test_config;

/// Always kill the spawned worker and remove its config file, even if an
/// assertion panics mid-test.
struct SmokeGuard {
    child: Option<Child>,
    path: PathBuf,
}

impl SmokeGuard {
    fn child(&mut self) -> &mut Child {
        self.child.as_mut().expect("test child is still running")
    }
}

impl Drop for SmokeGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_file(&self.path);
    }
}

fn free_port() -> u16 {
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket.local_addr().unwrap().port()
}

fn config_file(port: u16) -> PathBuf {
    // `dig` runs from the loopback address, so map that source explicitly.
    let json = test_config(port, "").replace(
        "\"source_ips\": [\"127.0.0.2\"]",
        "\"source_ips\": [\"127.0.0.1\"]",
    );
    let path = std::env::temp_dir().join(format!("vantyr-dns-smoke-{port}.json"));
    fs::write(&path, json).unwrap();
    path
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

#[test]
fn binary_help_check_and_live_query_smoke() {
    let exe = env!("CARGO_BIN_EXE_vantyr-dns");

    let help = Command::new(exe).arg("--help").output().unwrap();
    assert!(help.status.success());
    let help_text = String::from_utf8_lossy(&help.stdout);
    assert!(help_text.contains("Vantyr DNS"));
    assert!(help_text.contains("--check-config"));

    let port = free_port();
    let path = config_file(port);
    let check = Command::new(exe)
        .arg("--check-config")
        .arg(&path)
        .output()
        .unwrap();
    assert!(check.status.success(), "check-config failed: {check:?}");
    assert!(String::from_utf8_lossy(&check.stdout).contains("configuration valid"));

    let child = Command::new(exe)
        .args(["--config", &path.to_string_lossy()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut guard = SmokeGuard {
        child: Some(child),
        path,
    };

    let mut allowed = String::new();
    for _ in 0..40 {
        if let Some(status) = guard.child().try_wait().unwrap() {
            panic!("vantyr-dns exited early with {status}");
        }
        allowed = dig(port, "www.lab.example.");
        if !allowed.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        allowed.contains("192.0.2.10") && allowed.contains("192.0.2.11"),
        "dig did not receive both allowed addresses: '{allowed}'"
    );
    let blocked = dig(port, "blocked.lab.example.");
    assert!(
        blocked.is_empty(),
        "blocked name leaked an answer: '{blocked}'"
    );

    let mut child = guard.child.take().unwrap();
    let signal = Command::new("kill")
        .arg("-INT")
        .arg(child.id().to_string())
        .status()
        .unwrap();
    assert!(signal.success());
    let status = child.wait().unwrap();
    assert!(status.success(), "orderly Ctrl-C shutdown failed: {status}");
}

#[test]
fn binary_rejects_oversized_config_without_starting_a_listener() {
    let exe = env!("CARGO_BIN_EXE_vantyr-dns");
    let path =
        std::env::temp_dir().join(format!("vantyr-dns-oversized-{}.json", std::process::id()));
    fs::write(&path, vec![b'x'; family_dns::MAX_CONFIG_BYTES + 1]).unwrap();
    let _guard = SmokeGuard {
        child: None,
        path: path.clone(),
    };

    let output = Command::new(exe)
        .arg("--config")
        .arg(&path)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "oversized config was accepted");
    assert!(stderr.contains("exceeds"), "unexpected error: {stderr}");
    assert!(
        !stderr.contains("listening"),
        "no listener may start before validation: {stderr}"
    );
}
