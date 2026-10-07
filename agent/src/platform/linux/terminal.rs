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
use vantyr_protocol::agent_message::{TerminalExit, TerminalOutput};
use vantyr_protocol::AgentMessage;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    generation: crate::permissions::Generation,
    tree: super::process_tree::ProcessTree,
    _lease: crate::permissions::WorkerLease,
}

fn registry() -> &'static Mutex<HashMap<Uuid, Session>> {
    static REGISTRY: OnceLock<Mutex<HashMap<Uuid, Session>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exit_frame(session_id: Uuid) -> Message {
    Message::Text(
        AgentMessage::TerminalExit(TerminalExit::new(session_id))
            .to_value()
            .to_string(),
    )
}

pub fn start(
    session_id: Uuid,
    _cols: u16,
    _rows: u16,
    out_tx: mpsc::Sender<Message>,
    generation: crate::permissions::Generation,
) {
    let Ok(_startup_lease) =
        crate::permissions::command_worker(generation, crate::permissions::Module::Terminal)
    else {
        return;
    };

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
    let Some(pid) = child.process_id() else {
        return;
    };
    let tree = match super::process_tree::ProcessTree::attach_session(pid) {
        Ok(tree) => tree,
        Err(_) => return,
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
            generation,
            tree,
            _lease: crate::permissions::WorkerLease::new(generation),
        },
    );

    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if !generation.valid() {
            close_generation(session_id, generation);
            break;
        }
        if !registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&session_id)
        {
            break;
        }
    });
    let reader_lease = crate::permissions::WorkerLease::new(generation);
    std::thread::spawn(move || {
        let _lease = reader_lease;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let frame =
                        AgentMessage::TerminalOutput(TerminalOutput::new(session_id, data_b64))
                            .to_value()
                            .to_string();
                    if out_tx
                        .try_send(crate::permissions::tag_message(
                            Message::Text(frame),
                            Some(generation),
                        ))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = out_tx.try_send(exit_frame(session_id));
        close_generation(session_id, generation);
    });
}

pub fn input(session_id: Uuid, data: &str) {
    if !crate::permissions::allowed(crate::permissions::Module::Terminal) {
        close(session_id);
        return;
    }
    if let Some(session) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&session_id)
    {
        if !session.generation.valid() {
            return;
        }
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
    close_matching(session_id, None);
}
fn close_generation(session_id: Uuid, generation: crate::permissions::Generation) {
    close_matching(session_id, Some(generation));
}
fn close_matching(session_id: Uuid, generation: Option<crate::permissions::Generation>) {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if generation.is_some_and(|g| map.get(&session_id).is_some_and(|s| s.generation != g)) {
        return;
    }
    let session = map.remove(&session_id);
    drop(map);
    if let Some(mut session) = session {
        drop(session.tree);
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

#[cfg(test)]
pub(crate) fn has_session_for_test(id: Uuid) -> bool {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&id)
}
