//! Device-owned grants. Config/IPC/server policy never grants a module.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::OpenOptions, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Module {
    KeyboardText,
    IdleActivity,
    WindowActivity,
    BrowserUrls,
    Recall,
    LiveScreen,
    LiveAudio,
    RemoteInput,
    Files,
    Terminal,
    Scripts,
    SoftwareInventory,
    ResourceMetrics,
    SystemInfo,
    SystemControl,
    AppPolicy,
    NetworkPolicy,
    Logs,
}
pub const MODULES: &[Module] = &[
    Module::KeyboardText,
    Module::IdleActivity,
    Module::WindowActivity,
    Module::BrowserUrls,
    Module::Recall,
    Module::LiveScreen,
    Module::LiveAudio,
    Module::RemoteInput,
    Module::Files,
    Module::Terminal,
    Module::Scripts,
    Module::SoftwareInventory,
    Module::ResourceMetrics,
    Module::SystemInfo,
    Module::SystemControl,
    Module::AppPolicy,
    Module::NetworkPolicy,
    Module::Logs,
];
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Grant {
    pub enabled: bool,
    pub revision: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct State {
    pub revision: u64,
    pub modules: BTreeMap<Module, Grant>,
    receipts: BTreeMap<String, Receipt>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Receipt {
    module: Module,
    expected_revision: u64,
    revision: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum DisableResult {
    Disabled,
    Duplicate,
    Stale,
    Conflict,
}
impl State {
    pub fn enabled(&self, m: Module) -> bool {
        self.modules.get(&m).is_some_and(|g| g.enabled)
    }
    pub fn local_set(&mut self, m: Module, enabled: bool) -> anyhow::Result<()> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("revision exhausted"))?;
        self.modules.insert(
            m,
            Grant {
                enabled,
                revision: self.revision,
            },
        );
        Ok(())
    }
    pub fn disable(&mut self, m: Module, expected: u64, id: &str) -> anyhow::Result<DisableResult> {
        anyhow::ensure!(!id.is_empty() && id.len() <= 128, "invalid command_id");
        if let Some(r) = self.receipts.get(id) {
            return Ok(if r.module == m && r.expected_revision == expected {
                DisableResult::Duplicate
            } else {
                DisableResult::Conflict
            });
        }
        if self.modules.get(&m).map_or(0, |g| g.revision) != expected {
            return Ok(DisableResult::Stale);
        }
        // Never evict IDs: a forgotten replay could disable a later local grant.
        anyhow::ensure!(self.receipts.len() < 100_000, "receipt capacity reached");
        self.local_set(m, false)?;
        self.receipts.insert(
            id.to_owned(),
            Receipt {
                module: m,
                expected_revision: expected,
                revision: self.revision,
            },
        );
        Ok(DisableResult::Disabled)
    }
    pub fn wire(&self) -> serde_json::Value {
        serde_json::json!({"type":"module_states", "schema_version":1, "revision":self.revision,
            "modules": MODULES.iter().map(|m| { let g = self.modules.get(m).cloned().unwrap_or_default();
                serde_json::json!({"module":m,"available":available(*m),"enabled":g.enabled && available(*m),"revision":g.revision,"authorization_required":!g.enabled}) }).collect::<Vec<_>>()})
    }
}
fn path() -> PathBuf {
    crate::config::config_path().with_file_name("module-permissions.json")
}
fn read(p: &std::path::Path) -> anyhow::Result<State> {
    match std::fs::read(p) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.into()),
    }
}
/// Reads use the same cross-process lock as writes (including on Windows rename).
pub fn load() -> anyhow::Result<State> {
    transaction(|_| Ok(()), false).map(|(s, _)| s)
}
fn transaction<T>(
    f: impl FnOnce(&mut State) -> anyhow::Result<T>,
    write: bool,
) -> anyhow::Result<(State, T)> {
    transaction_at(&path(), f, write)
}
fn transaction_at<T>(
    p: &std::path::Path,
    f: impl FnOnce(&mut State) -> anyhow::Result<T>,
    write: bool,
) -> anyhow::Result<(State, T)> {
    let parent = p
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing parent"))?;
    std::fs::create_dir_all(parent)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(p.with_extension("lock"))?;
    lock.lock()?;
    let mut state = read(&p)?;
    let result = f(&mut state)?;
    if write {
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tmp.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut tmp, &state)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&p).map_err(|e| e.error)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok((state, result))
}
/// Grants are cached briefly for source loops/input latency. Every process
/// refreshes under the cross-process file lock at least every 100ms. Local
/// mutations invalidate immediately. A read error replaces the cache with off.
static CACHE: std::sync::Mutex<Option<(std::time::Instant, State)>> = std::sync::Mutex::new(None);
fn invalidate_cache() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}
pub fn available(_m: Module) -> bool {
    true
}
pub fn allowed(m: Module) -> bool {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() >= std::time::Duration::from_millis(100))
    {
        *cache = Some((std::time::Instant::now(), load().unwrap_or_default()));
    }
    cache.as_ref().is_some_and(|(_, s)| s.enabled(m))
}
pub fn local_set(m: Module, enabled: bool) -> anyhow::Result<State> {
    let result = transaction(|s| s.local_set(m, enabled), true).map(|(s, _)| s);
    invalidate_cache();
    result
}
/// Only remote operation: revoke. Success is returned after durable persistence.
pub fn remote_disable(v: &serde_json::Value) -> serde_json::Value {
    let result = (|| -> anyhow::Result<_> {
        let m = serde_json::from_value(v["module"].clone())?;
        let revision = v["expected_revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("expected_revision required"))?;
        let id = v["command_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("command_id required"))?;
        transaction(|s| s.disable(m, revision, id), true)
    })();
    invalidate_cache();
    match result {
        Ok((s, r)) => {
            serde_json::json!({"type":"module_disable_ack","command_id":v["command_id"],"module":v["module"],"ok":matches!(r,DisableResult::Disabled|DisableResult::Duplicate),"status":format!("{r:?}").to_lowercase(),"state":s.wire()})
        }
        Err(e) => {
            serde_json::json!({"type":"module_disable_ack","command_id":v["command_id"],"module":v["module"],"ok":false,"status":"error","error":e.to_string()})
        }
    }
}
pub fn command_module(kind: &str) -> Option<Module> {
    Some(match kind {
        "start_capture" => Module::LiveScreen,
        "start_audio" => Module::LiveAudio,
        "MouseMove" | "MouseClick" | "MouseDoubleClick" | "MouseDown" | "MouseUp"
        | "MouseScroll" | "Scroll" | "KeyDown" | "KeyUp" | "KeyPress" | "KeyChar" | "TypeText"
        | "Notify" => Module::RemoteInput,
        "TerminalStart" | "TerminalInput" | "TerminalResize" => Module::Terminal,
        "RunScript" => Module::Scripts,
        "ListDir" | "ReadFile" | "WriteFileChunk" | "Mkdir" | "RenamePath" | "DeletePath"
        | "CopyPath" => Module::Files,
        "CollectSoftware" => Module::SoftwareInventory,
        "RequestInfo" => Module::SystemInfo,
        "LockHost" | "RestartHost" | "ShutdownHost" => Module::SystemControl,
        "set_app_block_rules" => Module::AppPolicy,
        "set_network_policy" | "set_internet_block_rules" => Module::NetworkPolicy,
        "ListLogSources" | "ReadLogTail" => Module::Logs,
        _ => return None,
    })
}
pub fn command_allowed(v: &serde_json::Value) -> bool {
    let kind = v["type"].as_str().unwrap_or("");
    match command_module(kind) {
        Some(m) => allowed(m),
        // Explicit non-collecting protocol/config commands. Recall settings are
        // tunables only: capture still checks its independent local grant.
        None => matches!(
            kind,
            "disable_module"
                | "stop_capture"
                | "stop_audio"
                | "TerminalClose"
                | "set_recall_settings"
                | "set_auto_update"
                | "update_now"
                | "agent_deleted"
                | "agent_credentials_revoked"
                | "history_frame_ack"
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_registry_and_input_commands() {
        assert!(serde_json::from_str::<Module>("\"unknown\"").is_err());
        for command in [
            "MouseMove",
            "MouseClick",
            "MouseDoubleClick",
            "MouseDown",
            "MouseUp",
            "MouseScroll",
            "TypeText",
            "KeyPress",
            "KeyDown",
            "KeyUp",
            "KeyChar",
            "Notify",
        ] {
            assert_eq!(command_module(command), Some(Module::RemoteInput));
        }
        for command in [
            "screenshot",
            "Screenshot",
            "grant_module",
            "enable_module",
            "arbitrary_unknown",
            "set_local_ui_password_hash",
        ] {
            assert!(!command_allowed(&serde_json::json!({"type":command})));
        }
        assert_eq!(command_module("start_capture"), Some(Module::LiveScreen));
        assert_eq!(command_module("start_audio"), Some(Module::LiveAudio));
    }
    #[test]
    fn serialized_writers_preserve_all_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permissions.json");
        std::thread::scope(|scope| {
            for &m in MODULES {
                let p = &path;
                scope.spawn(move || {
                    transaction_at(p, |s| s.local_set(m, true), true).unwrap();
                });
            }
        });
        let s = read(&path).unwrap();
        assert_eq!(s.revision, MODULES.len() as u64);
        for &m in MODULES {
            assert!(s.enabled(m));
        }
    }
    #[test]
    fn durable_replay_and_corrupt_store_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("permissions.json");
        transaction_at(&p, |s| s.disable(Module::Recall, 0, "id"), true).unwrap();
        let (_, r) = transaction_at(&p, |s| s.disable(Module::Recall, 0, "id"), true).unwrap();
        assert_eq!(r, DisableResult::Duplicate);
        std::fs::write(&p, b"corrupt").unwrap();
        assert!(transaction_at(&p, |s| s.local_set(Module::Recall, true), true).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"corrupt");
    }
    #[test]
    fn legacy_off() {
        let s: State = serde_json::from_str("{}").unwrap();
        for &m in MODULES {
            assert!(!s.enabled(m));
        }
    }
    #[test]
    fn revoke_replay_cannot_revoke_later_grant() {
        let mut s = State::default();
        s.local_set(Module::Recall, true).unwrap();
        assert_eq!(
            s.disable(Module::Recall, 1, "a").unwrap(),
            DisableResult::Disabled
        );
        s.local_set(Module::Recall, true).unwrap();
        assert_eq!(
            s.disable(Module::Recall, 1, "a").unwrap(),
            DisableResult::Duplicate
        );
        assert!(s.enabled(Module::Recall));
        assert_eq!(
            s.disable(Module::Recall, 1, "b").unwrap(),
            DisableResult::Stale
        );
        assert_eq!(
            s.disable(Module::Files, 0, "a").unwrap(),
            DisableResult::Conflict
        );
    }
    #[test]
    fn persisted_receipts() {
        let mut s = State::default();
        s.disable(Module::Files, 0, "x").unwrap();
        let mut s: State = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(
            s.disable(Module::Files, 0, "x").unwrap(),
            DisableResult::Duplicate
        );
    }
    #[test]
    fn invalid_ids_and_overflow_fail_without_grant() {
        let mut s = State::default();
        assert!(s.disable(Module::Recall, 0, "").is_err());
        s.revision = u64::MAX;
        assert!(s.local_set(Module::Recall, true).is_err());
        assert!(!s.enabled(Module::Recall));
    }
}

/// Final socket/IPC boundary: discard previously queued sensitive payloads.
pub fn outbound_allowed(v: &serde_json::Value) -> bool {
    let module = match v["type"].as_str().unwrap_or("") {
        "batch" => {
            return v["events"]
                .as_array()
                .is_some_and(|es| es.iter().all(outbound_allowed))
        }
        "keys" => Module::KeyboardText,
        "afk" | "active" => Module::IdleActivity,
        "window_focus" | "app_icon" => Module::WindowActivity,
        "url" | "url_session" => Module::BrowserUrls,
        "software_inventory" => Module::SoftwareInventory,
        "metrics" | "resource_metrics" => Module::ResourceMetrics,
        "terminal_output" => Module::Terminal,
        "script_result" => Module::Scripts,
        "dir_list" | "file_chunk" | "file_upload_result" | "fs_op_result" => Module::Files,
        "log_tail" | "log_sources" => Module::Logs,
        _ => return true,
    };
    allowed(module)
}
pub fn message_allowed(msg: &tokio_tungstenite::tungstenite::Message) -> bool {
    use tokio_tungstenite::tungstenite::Message;
    match msg {
        Message::Text(t) => serde_json::from_str(t).is_ok_and(|v| outbound_allowed(&v)),
        Message::Binary(b) => allowed(if b.starts_with(b"HST\0") {
            Module::Recall
        } else if b.starts_with(b"AUD\0") {
            Module::LiveAudio
        } else {
            Module::LiveScreen
        }),
        _ => true,
    }
}

/// Cancel pending async work on revocation. Existing synchronous OS operations
/// may finish; script children use kill_on_drop in remote_script.
pub fn spawn_for_command(
    module: Option<Module>,
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if module.is_some_and(|m| !allowed(m)) {
            return;
        }
        tokio::select! {
            _ = future => {},
            _ = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if module.is_some_and(|m| !allowed(m)) { return; }
                }
            } => {},
        }
    })
}
