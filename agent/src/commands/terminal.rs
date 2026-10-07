//! Interactive terminal (ConPTY on Windows, PTY on Linux); gated server-side.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{TerminalInput, TerminalSession, TerminalSize};
use crate::permissions::Generation;

pub(super) fn start(
    cmd: TerminalSize,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    let Some(command_generation) = generation else {
        return;
    };
    if let Some(sid) = cmd.session_id {
        let cols = cmd.cols.unwrap_or(80).clamp(2, 500) as u16;
        let rows = cmd.rows.unwrap_or(24).clamp(1, 200) as u16;
        crate::platform::terminal::start(sid, cols, rows, out_tx, command_generation);
    }
}

pub(super) fn input(cmd: TerminalInput) {
    if let Some(sid) = cmd.session_id {
        if let Some(data) = cmd.data {
            crate::platform::terminal::input(sid, &data);
        }
    }
}

pub(super) fn resize(cmd: TerminalSize) {
    if let Some(sid) = cmd.session_id {
        let cols = cmd.cols.unwrap_or(80).clamp(2, 500) as u16;
        let rows = cmd.rows.unwrap_or(24).clamp(1, 200) as u16;
        crate::platform::terminal::resize(sid, cols, rows);
    }
}

pub(super) fn close(cmd: TerminalSession) {
    if let Some(sid) = cmd.session_id {
        crate::platform::terminal::close(sid);
    }
}
