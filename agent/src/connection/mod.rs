//! Talking to the Vantyr server: the agent loop that owns a session
//! ([`agent_loop`]), the WebSocket client, reconnect backoff, enrollment, and
//! LAN discovery of servers (Windows).

pub mod agent_loop;
pub mod enrollment;
#[cfg(windows)]
pub mod mdns;
pub mod reconnect;
pub mod ws_client;
