//! Real-socket test helpers. Messages are encoded and decoded by Hickory;
//! only the two-byte TCP length prefix is written here.

#![allow(dead_code)]

use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::time::Duration;

use hickory_server::proto::op::{Message, MessageType, OpCode, Query, ResponseCode};
use hickory_server::proto::rr::rdata::{A as AData, AAAA as AaaaData};
use hickory_server::proto::rr::{Name, RData, RecordType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, UdpSocket};

pub const HOUSEHOLD: &str = "11111111-2222-3333-4444-555555555555";
pub const MAPPED_DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/// Configuration used by the socket tests. `extra` is appended verbatim so a
/// test can add upstreams or change the denial mode without touching policy.
pub fn test_config(port: u16, extra: &str) -> String {
    format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 7,
  "bind": {{ "address": "127.0.0.1", "port": {port} }},
  "local_zones": {{
    "lab.example.": [
      {{ "type": "a", "name": "www.lab.example.", "ttl": 120, "addr": "192.0.2.10" }},
      {{ "type": "a", "name": "www.lab.example.", "ttl": 120, "addr": "192.0.2.11" }},
      {{ "type": "aaaa", "name": "www.lab.example.", "ttl": 120, "addr": "2001:db8::10" }},
      {{ "type": "aaaa", "name": "www.lab.example.", "ttl": 120, "addr": "2001:db8::11" }},
      {{ "type": "cname", "name": "alias.lab.example.", "ttl": 90, "target": "www.lab.example." }},
      {{ "type": "cname", "name": "badalias.lab.example.", "ttl": 90, "target": "blocked.lab.example." }},
      {{ "type": "a", "name": "blocked.lab.example.", "ttl": 60, "addr": "192.0.2.99" }}
    ]
  }},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "example" }}, "reason": "adult example" }},
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "adult test" }},
      {{ "effect": "deny", "match": {{ "type": "exact", "value": "blocked.lab.example" }}, "reason": "blocked exact" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "example" }}, "reason": "restricted example" }},
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "restricted test" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{MAPPED_DEVICE}",
    "label": "Mapped test device",
    "default_profile": "adult",
    "source_ips": ["127.0.0.2"]
  }}]
  {extra}
}}"#
    )
}

fn question(name: &str, qtype: RecordType) -> Message {
    let mut message = Message::new(0x4a21, MessageType::Query, OpCode::Query);
    // The forwarding zone refuses queries without the recursion-desired bit.
    message.metadata.recursion_desired = true;
    message.add_query(Query::query(Name::from_str(name).unwrap(), qtype));
    message
}

pub async fn udp_query(
    source: IpAddr,
    server: SocketAddr,
    name: &str,
    qtype: RecordType,
) -> Message {
    let client = UdpSocket::bind(SocketAddr::new(source, 0)).await.unwrap();
    let bytes = question(name, qtype).to_vec().unwrap();
    client.send_to(&bytes, server).await.unwrap();
    let mut buffer = vec![0u8; 4096];
    let (len, _) = tokio::time::timeout(Duration::from_secs(6), client.recv_from(&mut buffer))
        .await
        .expect("UDP query timed out")
        .unwrap();
    Message::from_vec(&buffer[..len]).unwrap()
}

pub async fn tcp_query(
    source: IpAddr,
    server: SocketAddr,
    name: &str,
    qtype: RecordType,
) -> Message {
    let socket = TcpSocket::new_v4().unwrap();
    socket
        .bind(SocketAddr::new(source, 0))
        .expect("test source must be IPv4");
    let mut stream = socket.connect(server).await.unwrap();
    let bytes = question(name, qtype).to_vec().unwrap();
    stream
        .write_all(&(bytes.len() as u16).to_be_bytes())
        .await
        .unwrap();
    stream.write_all(&bytes).await.unwrap();
    let mut prefix = [0u8; 2];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut prefix))
        .await
        .expect("TCP response header timed out")
        .unwrap();
    let mut buffer = vec![0u8; u16::from_be_bytes(prefix) as usize];
    tokio::time::timeout(Duration::from_secs(6), stream.read_exact(&mut buffer))
        .await
        .expect("TCP response body timed out")
        .unwrap();
    Message::from_vec(&buffer).unwrap()
}

pub fn assert_code(message: &Message, code: ResponseCode) {
    assert_eq!(
        message.response_code, code,
        "unexpected response code; answers={:?} authorities={:?}",
        message.answers, message.authorities
    );
}

pub fn addresses(message: &Message) -> Vec<IpAddr> {
    message
        .answers
        .iter()
        .filter_map(|record| match &record.data {
            RData::A(AData(ip)) => Some(IpAddr::V4(*ip)),
            RData::AAAA(AaaaData(ip)) => Some(IpAddr::V6(*ip)),
            _ => None,
        })
        .collect()
}

pub fn cname_targets(message: &Message) -> Vec<String> {
    message
        .answers
        .iter()
        .filter_map(|record| match &record.data {
            RData::CNAME(target) => Some(target.0.to_string().to_ascii_lowercase()),
            _ => None,
        })
        .collect()
}

/// A second real Vantyr DNS server used as an upstream. Its authoritative
/// local zone supplies genuine SOA/negative-cache answers, so the test never
/// needs a hand-built DNS message.
pub fn upstream_config(port: u16) -> String {
    format!(
        r#"{{
  "household_id": "{HOUSEHOLD}",
  "policy_revision": 3,
  "bind": {{ "address": "127.0.0.1", "port": {port} }},
  "local_zones": {{ "upstream.test.": [
    {{ "type": "a", "name": "app.upstream.test.", "ttl": 30, "addr": "192.0.2.30" }}
  ]}},
  "profiles": {{
    "adult": [
      {{ "effect": "allow", "match": {{ "type": "suffix", "value": "test" }}, "reason": "upstream allow" }}
    ],
    "restricted": [
      {{ "effect": "deny", "match": {{ "type": "suffix", "value": "test" }}, "reason": "upstream default deny" }}
    ]
  }},
  "default_device_profile": "restricted",
  "devices": [{{
    "id": "{MAPPED_DEVICE}",
    "default_profile": "adult",
    "source_ips": ["127.0.0.1"]
  }}]
}}"#
    )
}
