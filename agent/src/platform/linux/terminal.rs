//! Linux interactive terminal backend (PTY via `portable-pty`).
//!
//! Implements the same server terminal WebSocket contract as Windows ConPTY:
//! base64 `terminal_output` frames and a `terminal_exit` frame on close, keyed
//! per session id. Server-side `ALLOW_REMOTE_SCRIPT_EXECUTION` gating is
//! unchanged.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn registry() -> &'static Mutex<HashMap<Uuid, Session>> {
    static REGISTRY: OnceLock<Mutex<HashMap<Uuid, Session>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exit_frame(session_id: Uuid) -> Message {
    Message::Text(
        serde_json::json!({ "type": "terminal_exit", "session_id": session_id }).to_string(),
    )
}

pub fn start(session_id: Uuid, _cols: u16, _rows: u16, out_tx: mpsc::Sender<Message>) {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: _rows.max(1),
        cols: _cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match pty_system.openpty(size) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("terminal: openpty failed: {e}");
            let _ = out_tx.try_send(exit_frame(session_id));
            return;
        }
    };
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let cmd = CommandBuilder::new(shell);
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!("terminal: spawn shell failed: {e}");
            let _ = out_tx.try_send(exit_frame(session_id));
            return;
        }
    };
    drop(pair.slave);
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            tracing::warn!("terminal: clone reader failed: {e}");
            let _ = out_tx.try_send(exit_frame(session_id));
            return;
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            tracing::warn!("terminal: take writer failed: {e}");
            let _ = out_tx.try_send(exit_frame(session_id));
            return;
        }
    };

    registry().lock().unwrap_or_else(|e| e.into_inner()).insert(
        session_id,
        Session {
            master: pair.master,
            writer,
            child,
        },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let frame = serde_json::json!({
                        "type": "terminal_output",
                        "session_id": session_id,
                        "data_b64": data_b64,
                    })
                    .to_string();
                    if out_tx.blocking_send(Message::Text(frame)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = out_tx.blocking_send(exit_frame(session_id));
        close(session_id);
    });
}

pub fn input(session_id: Uuid, data: &str) {
    if let Some(session) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&session_id)
    {
        let _ = session.writer.write_all(data.as_bytes());
        let _ = session.writer.flush();
    }
}

pub fn resize(session_id: Uuid, cols: u16, rows: u16) {
    if let Some(session) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&session_id)
    {
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        if let Err(e) = session.master.resize(size) {
            tracing::warn!("terminal: resize failed for {session_id}: {e}");
        }
    }
}

pub fn close(session_id: Uuid) {
    if let Some(mut session) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&session_id)
    {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}
