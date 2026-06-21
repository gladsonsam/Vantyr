//! Linux software inventory via the system package managers.
//!
//! Collects packages from pacman, dpkg, rpm, and flatpak (whichever are
//! present), normalised to the shared `software_inventory` item shape. Each
//! collector runs in `spawn_blocking` and a missing manager is simply skipped.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub use crate::software_inventory::cmp_str_ascii_case_insensitive;

fn run_command(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn collect_items() -> Vec<serde_json::Value> {
    let mut items = Vec::new();

    if let Some(out) = run_command("pacman", &["-Q"]) {
        for line in out.lines().take(8000) {
            let mut parts = line.splitn(2, ' ');
            let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                continue;
            };
            let version = parts.next().unwrap_or("").trim();
            items.push(serde_json::json!({
                "name": name,
                "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                "publisher": "pacman",
                "install_location": serde_json::Value::Null,
                "install_date": serde_json::Value::Null,
            }));
        }
    }

    if let Some(out) = run_command("dpkg-query", &["-W", "-f=${Package}\t${Version}\n"]) {
        for line in out.lines().take(8000) {
            let mut parts = line.splitn(2, '\t');
            let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                continue;
            };
            let version = parts.next().unwrap_or("").trim();
            items.push(serde_json::json!({
                "name": name,
                "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                "publisher": "dpkg",
                "install_location": serde_json::Value::Null,
                "install_date": serde_json::Value::Null,
            }));
        }
    }

    if let Some(out) = run_command("rpm", &["-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"]) {
        for line in out.lines().take(8000) {
            let mut parts = line.splitn(2, '\t');
            let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                continue;
            };
            let version = parts.next().unwrap_or("").trim();
            items.push(serde_json::json!({
                "name": name,
                "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                "publisher": "rpm",
                "install_location": serde_json::Value::Null,
                "install_date": serde_json::Value::Null,
            }));
        }
    }

    if let Some(out) = run_command(
        "flatpak",
        &["list", "--app", "--columns=application,version"],
    ) {
        for line in out.lines().take(8000) {
            let mut parts = line.splitn(2, '\t');
            let Some(name) = parts.next().filter(|s| !s.is_empty()) else {
                continue;
            };
            let version = parts.next().unwrap_or("").trim();
            items.push(serde_json::json!({
                "name": name,
                "version": if version.is_empty() { serde_json::Value::Null } else { serde_json::json!(version) },
                "publisher": "flatpak",
                "install_location": serde_json::Value::Null,
                "install_date": serde_json::Value::Null,
            }));
        }
    }

    items.sort_by(|a, b| {
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        cmp_str_ascii_case_insensitive(na, nb)
    });
    items.truncate(8000);
    items
}

fn fingerprint_items(items: &[serde_json::Value]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    items.len().hash(&mut h);
    for item in items {
        item["name"].as_str().unwrap_or("").hash(&mut h);
        item["version"].as_str().unwrap_or("").hash(&mut h);
        item["publisher"].as_str().unwrap_or("").hash(&mut h);
    }
    h.finish()
}

pub async fn send_inventory(out_tx: mpsc::Sender<Message>) {
    let items = tokio::task::spawn_blocking(collect_items)
        .await
        .unwrap_or_default();
    let payload = serde_json::json!({
        "type": "software_inventory",
        "items": items,
        "captured_at": crate::unix_timestamp_secs(),
    })
    .to_string();
    let _ = out_tx.send(Message::Text(payload)).await;
}

pub async fn send_inventory_if_changed(
    out_tx: mpsc::Sender<Message>,
    last_fingerprint: &tokio::sync::Mutex<Option<u64>>,
) {
    let items = tokio::task::spawn_blocking(collect_items)
        .await
        .unwrap_or_default();
    let fp = fingerprint_items(&items);
    let mut guard = last_fingerprint.lock().await;
    if guard.as_ref() == Some(&fp) {
        return;
    }
    *guard = Some(fp);
    drop(guard);
    let payload = serde_json::json!({
        "type": "software_inventory",
        "items": items,
        "captured_at": crate::unix_timestamp_secs(),
    })
    .to_string();
    let _ = out_tx.send(Message::Text(payload)).await;
}
