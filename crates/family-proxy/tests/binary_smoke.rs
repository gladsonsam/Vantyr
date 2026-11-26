//! Real-process smoke tests for the public `vantyr-proxy` binary. They only
//! use ephemeral loopback sockets and a temporary private config file.

mod support;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_vantyr-proxy");

fn write_config(name: &str, json: &str, mode: u32) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "vantyr-proxy-smoke-{}-{name}.json",
        std::process::id()
    ));
    std::fs::write(&path, json).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    path
}

fn valid_json(bind_port: u16, origin_port: u16) -> String {
    serde_json::json!({
        "household_id": "11111111-2222-3333-4444-555555555555",
        "policy_revision": 1,
        "bind": { "address": "127.0.0.1", "port": bind_port },
        "profiles": { "restricted": [
            { "effect": "allow", "match": { "type": "suffix", "value": "origin.test" } }
        ]},
        "default_device_profile": "restricted",
        "devices": [{ "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "default_profile": "restricted" }],
        "clients": [{
            "id": "22222222-3333-4444-5555-666666666666",
            "token": "good-token",
            "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        }],
        "destinations": [{
            "host": "origin.test",
            "port": origin_port,
            "pin": format!("127.0.0.1:{origin_port}")
        }]
    })
    .to_string()
}

#[test]
fn help_version_and_check_config_work_in_a_real_process() {
    let help = Command::new(BIN).arg("--help").output().unwrap();
    assert!(help.status.success());
    let out = String::from_utf8_lossy(&help.stdout);
    assert!(out.contains("Vantyr Proxy"));
    assert!(out.contains("vantyr-proxy --check-config"));
    assert!(out.contains("TLS inspection and HTTP/2 are NOT"));

    let version = Command::new(BIN).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains("Vantyr Proxy 0.1.0"));

    let path = write_config("check", &valid_json(15354, 18443), 0o600);
    let checked = Command::new(BIN)
        .arg("--check-config")
        .arg(&path)
        .output()
        .unwrap();
    assert!(checked.status.success());
    assert!(String::from_utf8_lossy(&checked.stdout).contains("configuration valid"));

    let bad = write_config("bad", "{\"household_id\": 42}", 0o600);
    let rejected = Command::new(BIN)
        .arg("--check-config")
        .arg(&bad)
        .output()
        .unwrap();
    assert!(!rejected.status.success());

    let loose = write_config("loose", &valid_json(15354, 18443), 0o644);
    let rejected = Command::new(BIN)
        .arg("--check-config")
        .arg(&loose)
        .output()
        .unwrap();
    assert!(!rejected.status.success(), "0644 config must be refused");
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(&bad).unwrap();
    std::fs::remove_file(&loose).unwrap();
}

#[tokio::test]
async fn binary_forwards_a_real_request_then_stops() {
    let origin = HttpOrigin::start().await;
    let proxy_addr = free_addr();
    let path = write_config(
        "live",
        &valid_json(proxy_addr.port(), origin.addr.port()),
        0o600,
    );

    let mut child = Command::new(BIN)
        .arg("--config")
        .arg(&path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut listening = false;
    for _ in 0..50 {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if line.contains("listening on") {
                    listening = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(listening, "binary never reported a bound listener");

    let mut client = connect(proxy_addr).await;
    send(
        &mut client,
        &format!(
            "GET http://origin.test:{}/ HTTP/1.1\r\nHost: origin.test:{}\r\nProxy-Authorization: {GOOD_AUTH}\r\nConnection: close\r\n\r\n",
            origin.addr.port(),
            origin.addr.port()
        ),
    )
    .await;
    let head = read_head(&mut client).await;
    assert_eq!(status_line(&head), 200, "binary forward: {head:?}");
    assert_eq!(origin.connections(), 1);

    child.kill().unwrap();
    let _ = child.wait();
    std::fs::remove_file(&path).unwrap();
}
