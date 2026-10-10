//! Wake-on-LAN: parse MAC from stored `agent_info` JSON and send a magic packet.

use std::net::SocketAddr;

use serde_json::Value;

fn adapter_is_loopback(name: &str, desc: &str, obj: &serde_json::Map<String, Value>) -> bool {
    let n = name.to_lowercase();
    let d = desc.to_lowercase();
    if n.contains("loopback")
        || d.contains("loopback")
        || n.contains("pseudo")
        || d.contains("pseudo")
        || n.contains("localhost")
    {
        return true;
    }
    if let Some(arr) = obj.get("ips").and_then(|v| v.as_array()) {
        if !arr.is_empty()
            && arr.iter().all(|ip| {
                let s = ip.as_str().unwrap_or("").to_lowercase();
                s == "127.0.0.1" || s == "::1"
            })
        {
            return true;
        }
    }
    false
}

pub fn parse_mac_str(s: &str) -> Option<[u8; 6]> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s
        .split(|c| [':', '-'].contains(&c))
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(out)
}

/// First non-loopback adapter MAC from agent `agent_info` payload (matches dashboard Specs shape).
pub fn mac_bytes_from_agent_info(info: &Value) -> Option<[u8; 6]> {
    let adapters = info.get("adapters")?.as_array()?;
    for ad in adapters {
        let obj = ad.as_object()?;
        let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let desc = obj
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if adapter_is_loopback(name, desc, obj) {
            continue;
        }
        let mac_s = obj.get("mac").and_then(|v| v.as_str())?;
        if let Some(b) = parse_mac_str(mac_s) {
            return Some(b);
        }
    }
    None
}

pub fn format_mac_colon(mac: &[u8; 6]) -> String {
    mac.iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut pkt = [0u8; 102];
    pkt[0..6].fill(0xff);
    for i in 0..16 {
        let start = 6 + i * 6;
        pkt[start..start + 6].copy_from_slice(&mac);
    }
    pkt
}

pub async fn send_wake(mac: [u8; 6], broadcast: &str, port: u16) -> anyhow::Result<()> {
    let packet = magic_packet(mac);
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
    socket.set_broadcast(true)?;
    let addr: SocketAddr = format!("{broadcast}:{port}").parse()?;
    socket.send_to(&packet, addr).await?;
    Ok(())
}
