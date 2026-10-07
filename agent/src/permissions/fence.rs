//! Generation fences on the wire: tagging outbound frames, admitting server
//! commands, and the final outbound filter.

use serde::{Deserialize, Serialize};

use super::modules::{command_module, Module};
use super::store::{load, with_cached, State};
use super::workers::{Generation, WorkerLease};
use vantyr_protocol::frames::{AUDIO_FRAME_MAGIC, HISTORY_FRAME_MAGIC};
use vantyr_protocol::{Gate, ServerCommand};

pub fn stamp(mut v: serde_json::Value, generation: Option<Generation>) -> serde_json::Value {
    if let Some(g) = generation {
        v["__module_generation"] = serde_json::to_value(g).unwrap();
    }
    v
}
pub fn tag_message(
    msg: tokio_tungstenite::tungstenite::Message,
    generation: Option<Generation>,
) -> tokio_tungstenite::tungstenite::Message {
    use tokio_tungstenite::tungstenite::Message;
    match msg {
        Message::Text(t) => Message::Text(
            stamp(serde_json::from_str(&t).unwrap_or_default(), generation).to_string(),
        ),
        Message::Binary(b) => Message::Binary(tag_binary(b, generation)),
        other => other,
    }
}
pub fn tag_binary(b: Vec<u8>, generation: Option<Generation>) -> Vec<u8> {
    let Some(g) = generation else {
        return b;
    };
    let header = serde_json::to_vec(&g).unwrap();
    let mut result = b"VGN1".to_vec();
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend(header);
    result.extend(b);
    result
}
#[derive(Serialize, Deserialize)]
struct BinaryFence {
    #[serde(flatten)]
    generation: Generation,
    #[serde(default)]
    context_generations: crate::capture::recall_context::Generations,
}
/// Add secondary fences without changing VGN1 or its original flattened generation.
pub fn tag_recall_binary(
    b: Vec<u8>,
    generation: Option<Generation>,
    context_generations: crate::capture::recall_context::Generations,
) -> Vec<u8> {
    let Some(generation) = generation else {
        return b;
    };
    let header = serde_json::to_vec(&BinaryFence {
        generation,
        context_generations,
    })
    .unwrap();
    let mut result = b"VGN1".to_vec();
    result.extend_from_slice(&(header.len() as u32).to_le_bytes());
    result.extend(header);
    result.extend(b);
    result
}
pub(super) fn prepare_binary_in(b: &[u8], state: &State) -> Option<Vec<u8>> {
    let n = u32::from_le_bytes(b.get(4..8)?.try_into().ok()?) as usize;
    let start = 8usize.checked_add(n)?;
    let fence: BinaryFence = serde_json::from_slice(b.get(8..start)?).ok()?;
    let payload = b.get(start..)?;
    let module = if payload.starts_with(HISTORY_FRAME_MAGIC) {
        Module::Recall
    } else if payload.starts_with(AUDIO_FRAME_MAGIC) {
        Module::LiveAudio
    } else {
        Module::LiveScreen
    };
    if fence.generation.module != module || !fence.generation.matches(state) {
        return None;
    }
    if module != Module::Recall {
        return Some(payload.to_vec());
    }
    let hlen = u32::from_le_bytes(payload.get(4..8)?.try_into().ok()?) as usize;
    if hlen > 1024 * 1024 {
        return None;
    }
    let hend = 8usize.checked_add(hlen)?;
    let mut header: serde_json::Value = serde_json::from_slice(payload.get(8..hend)?).ok()?;
    let object = header.as_object_mut()?;
    if let Some(raw) = object.remove("context") {
        let context = serde_json::from_value::<crate::capture::recall_context::Context>(raw)
            .ok()
            .filter(|c| c.version == 1 && c.scope == "session_foreground" && c.bracket_ms <= 1000);
        if let Some(mut c) = context {
            c.sanitize_in(state, fence.context_generations);
            object.insert("context".into(), serde_json::to_value(c).ok()?);
        }
    }
    let header_bytes = serde_json::to_vec(&header).ok()?;
    let mut output = HISTORY_FRAME_MAGIC.to_vec();
    output.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    output.extend(header_bytes);
    output.extend_from_slice(payload.get(hend..)?);
    Some(output)
}
/// Only the final network writer strips internal fences; IPC preserves them.
pub fn prepare_message(
    msg: tokio_tungstenite::tungstenite::Message,
) -> Option<tokio_tungstenite::tungstenite::Message> {
    use tokio_tungstenite::tungstenite::Message;
    if !message_allowed(&msg) {
        return None;
    }
    match msg {
        Message::Text(t) => {
            let mut v: serde_json::Value = serde_json::from_str(&t).ok()?;
            fn strip(v: &mut serde_json::Value) {
                if v["type"] == "keys" {
                    let context_ok =
                        serde_json::from_value::<Generation>(v["__window_generation"].clone())
                            .is_ok_and(|g| g.module == Module::WindowActivity && g.valid_fresh());
                    if !context_ok {
                        for field in ["app", "app_display", "window"] {
                            v[field] = "".into();
                        }
                    }
                }
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("__module_generation");
                    obj.remove("__clipboard_session");
                    obj.remove("__window_generation");
                }
                if let Some(es) = v
                    .get_mut("events")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for e in es {
                        strip(e);
                    }
                }
            }
            strip(&mut v);
            Some(Message::Text(v.to_string()))
        }
        Message::Binary(b) if b.starts_with(b"VGN1") => {
            // Fresh authoritative read at the last writer: pump/enqueue checks are not enough.
            let state = load().ok()?;
            prepare_binary_in(&b, &state).map(Message::Binary)
        }
        other => Some(other),
    }
}
pub(super) fn command_allowed_in(s: &State, v: &serde_json::Value) -> bool {
    if v.get("__module_generation").is_some() {
        let Ok(g) = serde_json::from_value::<Generation>(v["__module_generation"].clone()) else {
            return false;
        };
        if command_module(v["type"].as_str().unwrap_or("")) != Some(g.module) || !g.matches(s) {
            return false;
        }
    }
    // Gated commands need their module granted. Everything else must be an explicit
    // non-collecting protocol/config command (`disable_module` included: the agent
    // answers it itself). Recall settings are tunables only: capture still checks
    // its independent local grant.
    match ServerCommand::from_kind(v["type"].as_str().unwrap_or("")).gate() {
        Gate::Module(m) => s.enabled(m),
        Gate::Protocol | Gate::DisableModule => true,
        Gate::Denied => false,
    }
}
/// Runtime checks use the shared cache; WebSocket admission reads the store freshly.
pub fn command_allowed(v: &serde_json::Value) -> bool {
    with_cached(|s| command_allowed_in(s, v))
}
pub(super) fn admit_command_in(s: &State, v: serde_json::Value) -> Option<serde_json::Value> {
    if !command_allowed_in(s, &v) {
        return None;
    }
    // Preserve a server binding exactly. A missing stamp is legacy compatibility,
    // bound once here before any queue or cross-process IPC forwarding.
    if v.get("__module_generation").is_some() {
        return Some(v);
    }
    let generation =
        command_module(v["type"].as_str().unwrap_or("")).and_then(|m| Generation::from_state(s, m));
    Some(stamp(v, generation))
}
pub fn admit_command(v: serde_json::Value) -> Option<serde_json::Value> {
    admit_command_in(&load().unwrap_or_default(), v)
}

/// Final socket/IPC boundary: discard previously queued sensitive payloads.
fn event_module(v: &serde_json::Value) -> Option<Module> {
    Some(match v["type"].as_str().unwrap_or("") {
        "keys" => Module::KeyboardText,
        "afk" | "active" => Module::IdleActivity,
        "window_focus" | "app_icon" => Module::WindowActivity,
        "url" | "url_session" => Module::BrowserUrls,
        "software_inventory" => Module::SoftwareInventory,
        "metrics" | "resource_metrics" => Module::ResourceMetrics,
        "app_block_kill" => Module::AppPolicy,
        "terminal_output" => Module::Terminal,
        "script_result" => Module::Scripts,
        "clipboard_result" => Module::Clipboard,
        "dir_list" | "file_chunk" | "file_upload_result" | "fs_op_result" => Module::Files,
        "log_tail" | "log_sources" => Module::Logs,
        "agent_info" if !v["hostname"].is_null() => Module::SystemInfo,
        _ => return None,
    })
}
pub(super) fn outbound_allowed_in(s: &State, v: &serde_json::Value) -> bool {
    if v["type"] == "clipboard_result" && !crate::input::clipboard::reply_session_current(v) {
        return false;
    }
    if v["type"] == "batch" {
        return v["events"]
            .as_array()
            .is_some_and(|es| es.iter().all(|e| outbound_allowed_in(s, e)));
    }
    let generation = if v["__module_generation"].is_null() {
        None
    } else {
        let Ok(g) = serde_json::from_value::<Generation>(v["__module_generation"].clone()) else {
            return false;
        };
        if !g.matches(s) {
            return false;
        }
        Some(g)
    };
    event_module(v).is_none_or(|m| generation.is_some_and(|g| g.module == m))
}
pub fn outbound_allowed(v: &serde_json::Value) -> bool {
    outbound_allowed_in(&load().unwrap_or_default(), v)
}
pub fn message_allowed(msg: &tokio_tungstenite::tungstenite::Message) -> bool {
    use tokio_tungstenite::tungstenite::Message;
    match msg {
        Message::Text(t) => serde_json::from_str(t).is_ok_and(|v| outbound_allowed(&v)),
        Message::Binary(b) if b.starts_with(b"VGN1") => {
            let Some(len) = b.get(4..8).and_then(|v| <[u8; 4]>::try_from(v).ok()) else {
                return false;
            };
            let n = u32::from_le_bytes(len) as usize;
            let Some(g) = b
                .get(8..8 + n)
                .and_then(|h| serde_json::from_slice::<Generation>(h).ok())
            else {
                return false;
            };
            let Some(payload) = b.get(8 + n..) else {
                return false;
            };
            let module = if payload.starts_with(HISTORY_FRAME_MAGIC) {
                Module::Recall
            } else if payload.starts_with(AUDIO_FRAME_MAGIC) {
                Module::LiveAudio
            } else {
                Module::LiveScreen
            };
            g.module == module && g.valid_fresh()
        }
        // Never reinterpret an old/unversioned queued frame as a new grant.
        Message::Binary(_) => false,
        _ => true,
    }
}

/// Cancel pending async work on revocation. Existing synchronous OS operations
/// may finish; script children use kill_on_drop in commands::scripts.
pub fn spawn_for_command(
    generation: Option<Generation>,
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let lease = generation.map(WorkerLease::new);
    tokio::spawn(async move {
        let _lease = lease;
        if generation.is_some_and(|g| !g.valid()) {
            return;
        }
        tokio::select! {
            _ = future => {},
            _ = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if generation.is_some_and(|g| !g.valid()) { return; }
                }
            } => {},
        }
    })
}
