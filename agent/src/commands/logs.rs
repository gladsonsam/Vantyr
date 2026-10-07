//! Log viewer commands: list the readable log sources and tail one of them.

use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{ListLogSources, ReadLogTail};
use crate::permissions::Generation;

pub(super) fn list_log_sources(
    cmd: ListLogSources,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let sources: Vec<serde_json::Value> = crate::host::log_sources::list_log_sources()
            .into_iter()
            .filter_map(|s| serde_json::to_value(s).ok())
            .collect();

        let payload = serde_json::json!({
            "type": "log_sources",
            "request_id": request_id,
            "sources": sources,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
    });
}

pub(super) fn read_log_tail(
    cmd: ReadLogTail,
    generation: Option<Generation>,
    out_tx: mpsc::Sender<Message>,
) {
    const MAX_LOG_KIND_CHARS: usize = 64;
    const MAX_KB_DEFAULT: u32 = 512;
    const MAX_KB_LIMIT: u32 = 2048;

    let request_id = cmd.request_id.trim().to_string();
    if request_id.is_empty() {
        return;
    }
    let kind = cmd
        .kind
        .as_deref()
        .unwrap_or("local_agent")
        .trim()
        .chars()
        .take(MAX_LOG_KIND_CHARS)
        .collect::<String>();
    if kind.is_empty() {
        return;
    }
    let max_kb = cmd
        .max_kb
        .map_or(MAX_KB_DEFAULT, |u| u as u32)
        .min(MAX_KB_LIMIT);
    let max_bytes = (max_kb as usize).saturating_mul(1024);

    let out = out_tx;
    crate::permissions::spawn_for_command(generation, async move {
        let path = match crate::host::log_sources::resolve_log_kind(kind.as_str()) {
            Ok(p) => p,
            Err(e) => {
                let payload = serde_json::json!({
                    "type": "log_tail",
                    "request_id": request_id,
                    "kind": kind,
                    "text": format!("(Could not resolve log source: {e})"),
                })
                .to_string();
                let _ = out
                    .send(crate::permissions::tag_message(
                        Message::Text(payload),
                        generation,
                    ))
                    .await;
                return;
            }
        };

        let read_res = tokio::task::spawn_blocking(move || {
            match crate::host::log_sources::read_log_tail_display(&path, max_bytes) {
                Ok(s) => s,
                Err(e) => format!("(Could not read log: {e})"),
            }
        })
        .await;

        let text = match read_res {
            Ok(s) => s,
            Err(e) => format!("(Log read task failed: {e})"),
        };

        let payload = serde_json::json!({
            "type": "log_tail",
            "request_id": request_id,
            "kind": kind,
            "text": text,
        })
        .to_string();
        let _ = out
            .send(crate::permissions::tag_message(
                Message::Text(payload),
                generation,
            ))
            .await;
    });
}
