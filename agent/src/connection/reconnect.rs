//! Helpers shared by the reconnecting WebSocket loops (`agent_loop` and
//! `ws_client`).

use std::sync::Mutex;
use std::time::Duration;

use crate::config::AgentStatus;

/// Exponential reconnect backoff parameters (WAN-friendly).
const RECONNECT_BACKOFF_BASE_MS: u64 = 750;
const RECONNECT_BACKOFF_MAX_MS: u64 = 30_000;

/// Delay before reconnect attempt `attempt` (1-based): exponential from
/// [`RECONNECT_BACKOFF_BASE_MS`] up to [`RECONNECT_BACKOFF_MAX_MS`], plus
/// 0..499ms of jitter.
pub fn reconnect_backoff_delay(attempt: u32) -> Duration {
    // Exponential backoff with small jitter, no RNG dependency.
    let pow = attempt.min(6); // cap exponential growth (2^6 = 64x)
    let exp = 1u64.checked_shl(pow).unwrap_or(u64::MAX);
    let base = RECONNECT_BACKOFF_BASE_MS.saturating_mul(exp);
    let capped = base.min(RECONNECT_BACKOFF_MAX_MS);
    let jitter_ms = u64::from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis(),
    ) % 500; // 0..499ms
    Duration::from_millis(capped.saturating_add(jitter_ms))
}

/// Write to the shared status mutex, ignoring lock-poison errors.
pub fn set_status(status: &Mutex<AgentStatus>, s: AgentStatus) {
    if let Ok(mut guard) = status.lock() {
        *guard = s;
    }
}
