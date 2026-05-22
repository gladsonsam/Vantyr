//! Enumerate installed programs from Windows Uninstall registry keys.

use std::cmp::Ordering;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::unix_timestamp_secs;

const MAX_ITEMS: usize = 8000;

fn fingerprint_items(items: &[Value]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    items.len().hash(&mut h);
    for it in items {
        let name = it["name"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let version = it["version"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let publisher = it["publisher"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        name.hash(&mut h);
        version.hash(&mut h);
        publisher.hash(&mut h);
    }
    h.finish()
}

/// ASCII-only case folding; avoids per-comparison `to_lowercase()` allocations (MSRV-safe).
pub fn cmp_str_ascii_case_insensitive(a: &str, b: &str) -> Ordering {
    let mut ab = a.bytes().map(|x| x.to_ascii_lowercase());
    let mut bb = b.bytes().map(|x| x.to_ascii_lowercase());
    loop {
        match (ab.next(), bb.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match x.cmp(&y) {
                Ordering::Equal => {}
                o => return o,
            },
        }
    }
}

/// Windows often stores `InstallDate` as `REG_SZ` `YYYYMMDD` (or `YYYYMMDDHHmmss`). Present as ISO date.
#[cfg(windows)]
fn normalize_install_date(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let digits: String = s.chars().filter(char::is_ascii_digit).collect();
    let slice = if digits.len() >= 14 {
        match digits.get(..8) {
            Some(h) => h,
            None => return Some(s.to_string()),
        }
    } else if digits.len() == 8 {
        digits.as_str()
    } else {
        return Some(s.to_string());
    };
    let (Some(y), Some(m), Some(d)) = (
        slice.get(..4).and_then(|x| x.parse().ok()),
        slice.get(4..6).and_then(|x| x.parse().ok()),
        slice.get(6..8).and_then(|x| x.parse().ok()),
    ) else {
        return Some(s.to_string());
    };
    if !(1980..=2100).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Some(s.to_string());
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

#[cfg(windows)]
fn install_date_from_key(sub: &winreg::RegKey) -> Option<String> {
    let Ok(s) = sub.get_value::<String, _>("InstallDate") else {
        return None;
    };
    normalize_install_date(&s)
}

#[cfg(windows)]
fn read_uninstall_key(root: &winreg::RegKey, path: &str, out: &mut Vec<Value>) {
    let Ok(key) = root.open_subkey(path) else {
        return;
    };
    for res in key.enum_keys().flatten() {
        if out.len() >= MAX_ITEMS {
            break;
        }
        let Ok(sub) = key.open_subkey(&res) else {
            continue;
        };
        let name: String = sub.get_value("DisplayName").unwrap_or_default();
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let version: String = sub.get_value("DisplayVersion").unwrap_or_default();
        let publisher: String = sub.get_value("Publisher").unwrap_or_default();
        let loc: String = sub.get_value("InstallLocation").unwrap_or_default();
        let date_opt = install_date_from_key(&sub);
        out.push(json!({
            "name": name,
            "version": if version.is_empty() { Value::Null } else { json!(version) },
            "publisher": if publisher.is_empty() { Value::Null } else { json!(publisher) },
            "install_location": if loc.is_empty() { Value::Null } else { json!(loc) },
            "install_date": date_opt.map_or(Value::Null, |s| json!(s)),
        }));
    }
}

#[cfg(windows)]
pub fn collect_items() -> Vec<Value> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut out = Vec::new();
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    read_uninstall_key(
        &hklm,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        &mut out,
    );
    read_uninstall_key(
        &hklm,
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        &mut out,
    );
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    read_uninstall_key(
        &hkcu,
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        &mut out,
    );
    out.sort_by(|a, b| {
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        cmp_str_ascii_case_insensitive(na, nb)
    });
    out
}

#[cfg(not(windows))]
pub fn collect_items() -> Vec<Value> {
    Vec::new()
}

pub async fn send_inventory(out_tx: mpsc::Sender<Message>) {
    let items = tokio::task::spawn_blocking(collect_items)
        .await
        .unwrap_or_default();
    let n = items.len();
    let payload = serde_json::json!({
        "type": "software_inventory",
        "items": items,
        "captured_at": unix_timestamp_secs(),
    })
    .to_string();
    if out_tx.send(Message::Text(payload)).await.is_err() {
        warn!("Failed to send software_inventory (writer closed)");
    } else {
        info!("Sent software_inventory ({n} entries)");
    }
}

/// Collect and send a fresh snapshot only when it differs from the last sent fingerprint.
pub async fn send_inventory_if_changed(
    out_tx: mpsc::Sender<Message>,
    last_fingerprint: &tokio::sync::Mutex<Option<u64>>,
) {
    let items = tokio::task::spawn_blocking(collect_items)
        .await
        .unwrap_or_default();
    let n = items.len();
    let fp = fingerprint_items(&items);

    let mut g = last_fingerprint.lock().await;
    if g.as_ref() == Some(&fp) {
        return;
    }
    *g = Some(fp);
    drop(g);

    let payload = serde_json::json!({
        "type": "software_inventory",
        "items": items,
        "captured_at": unix_timestamp_secs(),
    })
    .to_string();
    if out_tx.send(Message::Text(payload)).await.is_err() {
        warn!("Failed to send software_inventory (writer closed)");
    } else {
        info!("Sent software_inventory ({n} entries; changed)");
    }
}
