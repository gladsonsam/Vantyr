//! Pending agent RPC replies: one-shot waiters keyed by request id, and the
//! per-session sinks that route interactive-terminal output to its browser.
//!
//! Clipboard requests are deliberately not here: they are lease-fenced and live
//! in `ControlRuntime` under the `control` lock.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[derive(Default)]
pub struct RpcWaiters {
    /// One-shot waiters for agent `script_result` responses.
    script_waiters: Mutex<HashMap<Uuid, oneshot::Sender<Value>>>,
    /// One-shot waiters for agent log RPC responses (`log_tail`, `log_sources`).
    log_waiters: Mutex<HashMap<Uuid, oneshot::Sender<Value>>>,
    /// Active interactive-terminal sessions: `session_id` → sink that forwards
    /// agent terminal frames to the owning browser WebSocket.
    terminal_sessions: Mutex<HashMap<Uuid, mpsc::Sender<String>>>,
}

impl RpcWaiters {
    pub fn register_script_waiter(&self, id: Uuid, sender: oneshot::Sender<Value>) {
        self.script_waiters.lock().insert(id, sender);
    }

    pub fn remove_script_waiter(&self, id: Uuid) {
        self.script_waiters.lock().remove(&id);
    }

    /// Deliver an agent `script_result` to a waiting HTTP request, if any.
    pub fn try_complete_script_waiter(&self, id: Uuid, payload: Value) -> bool {
        if let Some(tx) = self.script_waiters.lock().remove(&id) {
            let _ = tx.send(payload);
            return true;
        }
        false
    }

    pub fn register_log_waiter(&self, id: Uuid, sender: oneshot::Sender<Value>) {
        self.log_waiters.lock().insert(id, sender);
    }

    pub fn remove_log_waiter(&self, id: Uuid) {
        self.log_waiters.lock().remove(&id);
    }

    /// Deliver an agent log RPC response (`log_tail` / `log_sources`) to a waiting HTTP request, if any.
    pub fn try_complete_log_waiter(&self, id: Uuid, payload: Value) -> bool {
        if let Some(tx) = self.log_waiters.lock().remove(&id) {
            let _ = tx.send(payload);
            return true;
        }
        false
    }

    pub fn register_terminal_session(&self, session_id: Uuid, tx: mpsc::Sender<String>) {
        self.terminal_sessions.lock().insert(session_id, tx);
    }

    pub fn remove_terminal_session(&self, session_id: Uuid) {
        self.terminal_sessions.lock().remove(&session_id);
    }

    /// Route a terminal output/exit frame to its owning browser session.
    /// Returns false when no such session exists (stale agent frame).
    pub fn route_terminal_output(&self, session_id: Uuid, frame: String) -> bool {
        let tx = self.terminal_sessions.lock().get(&session_id).cloned();
        tx.is_some_and(|tx| tx.try_send(frame).is_ok())
    }
}
