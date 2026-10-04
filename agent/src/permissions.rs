//! Device-owned grants. Config/IPC/server policy never grants a module.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::OpenOptions, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
    Clipboard,
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
    Module::Clipboard,
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
#[cfg(test)]
thread_local! {
    static TEST_STORE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub fn with_test_store<T>(state: &State, f: impl FnOnce() -> T) -> T {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("permissions.json");
    std::fs::write(&p, serde_json::to_vec(state).unwrap()).unwrap();
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_STORE.with(|s| *s.borrow_mut() = None);
        }
    }
    TEST_STORE.with(|s| {
        assert!(s.borrow().is_none());
        *s.borrow_mut() = Some(p);
    });
    let _reset = Reset;
    f()
}
fn path() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_STORE.with(|s| s.borrow().clone()) {
        return p;
    }
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
pub fn available(m: Module) -> bool {
    m != Module::Clipboard || crate::clipboard::available()
}
fn with_cached<T>(f: impl FnOnce(&State) -> T) -> T {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() >= std::time::Duration::from_millis(100))
    {
        *cache = Some((std::time::Instant::now(), load().unwrap_or_default()));
    }
    f(&cache.as_ref().unwrap().1)
}
pub fn allowed(m: Module) -> bool {
    with_cached(|s| s.enabled(m))
}
/// A lease belongs to exactly one locally authorized generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Generation {
    pub module: Module,
    pub revision: u64,
}
impl Generation {
    pub fn capture(module: Module) -> Option<Self> {
        let s = load().ok()?;
        Self::from_state(&s, module)
    }
    pub fn from_state(s: &State, module: Module) -> Option<Self> {
        s.modules.get(&module).filter(|g| g.enabled).map(|g| Self {
            module,
            revision: g.revision,
        })
    }
    pub fn matches(self, s: &State) -> bool {
        Self::from_state(s, self.module) == Some(self)
    }
    pub fn valid_fresh(self) -> bool {
        load().is_ok_and(|s| self.matches(&s))
    }
    pub fn valid(self) -> bool {
        with_cached(|s| self.matches(s))
    }
}
static WORKERS: std::sync::Mutex<Option<std::collections::HashMap<Generation, usize>>> =
    std::sync::Mutex::new(None);
/// Register before scheduling work; Drop is the local stop barrier.
pub struct WorkerLease {
    generation: Generation,
}
impl WorkerLease {
    pub fn new(generation: Generation) -> Self {
        let mut workers = WORKERS.lock().unwrap_or_else(|e| e.into_inner());
        *workers
            .get_or_insert_with(Default::default)
            .entry(generation)
            .or_default() += 1;
        Self { generation }
    }
}
/// Preserve the admitted command binding at every lower helper. Register before
/// reading the store so revocation barriers can see startup work as well.
pub fn command_worker(generation: Generation, module: Module) -> anyhow::Result<WorkerLease> {
    anyhow::ensure!(generation.module == module, "wrong command module");
    let lease = WorkerLease::new(generation);
    anyhow::ensure!(
        generation.valid_fresh(),
        "command grant revoked or replaced"
    );
    Ok(lease)
}

impl Drop for WorkerLease {
    fn drop(&mut self) {
        let mut workers = WORKERS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(workers) = workers.as_mut() {
            if let Some(n) = workers.get_mut(&self.generation) {
                *n -= 1;
                if *n == 0 {
                    workers.remove(&self.generation);
                }
            }
        }
    }
}
pub fn active_workers(generation: Generation) -> usize {
    WORKERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&generation))
        .copied()
        .unwrap_or(0)
}
/// Cross-process Windows worker completion is not implied by a local barrier.
pub async fn disable_and_wait(v: &serde_json::Value) -> serde_json::Value {
    let mut ack = remote_disable(v);
    if ack["status"] != "disabled" {
        return ack;
    }
    let Ok(module) = serde_json::from_value(v["module"].clone()) else {
        return ack;
    };
    let generation = Generation {
        module,
        revision: v["expected_revision"].as_u64().unwrap_or(0),
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while active_workers(generation) > 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let pending = active_workers(generation);
    ack["local_workers_pending"] = pending.into();
    ack["local_registered_workers_stopped"] = (pending == 0).into();
    // Some synchronous sources are not yet registered and Windows companions
    // have independent registries. Until all participants confirm, stay honest.
    ack["stop_status"] = if pending == 0 {
        "registered_local_workers_drained_global_unconfirmed"
    } else {
        "local_barrier_timeout"
    }
    .into();
    ack
}
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
    context_generations: crate::recall_context::Generations,
}
/// Add secondary fences without changing VGN1 or its original flattened generation.
pub fn tag_recall_binary(
    b: Vec<u8>,
    generation: Option<Generation>,
    context_generations: crate::recall_context::Generations,
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
fn prepare_binary_in(b: &[u8], state: &State) -> Option<Vec<u8>> {
    let n = u32::from_le_bytes(b.get(4..8)?.try_into().ok()?) as usize;
    let start = 8usize.checked_add(n)?;
    let fence: BinaryFence = serde_json::from_slice(b.get(8..start)?).ok()?;
    let payload = b.get(start..)?;
    let module = if payload.starts_with(b"HST\0") {
        Module::Recall
    } else if payload.starts_with(b"AUD\0") {
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
        let context = serde_json::from_value::<crate::recall_context::Context>(raw)
            .ok()
            .filter(|c| c.version == 1 && c.scope == "session_foreground" && c.bracket_ms <= 1000);
        if let Some(mut c) = context {
            c.sanitize_in(state, fence.context_generations);
            object.insert("context".into(), serde_json::to_value(c).ok()?);
        }
    }
    let header_bytes = serde_json::to_vec(&header).ok()?;
    let mut output = b"HST\0".to_vec();
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
            serde_json::json!({"type":"module_disable_ack","command_id":v["command_id"],"module":v["module"],"ok":matches!(r,DisableResult::Disabled|DisableResult::Duplicate),"status":format!("{r:?}").to_lowercase(),"persisted":matches!(r,DisableResult::Disabled|DisableResult::Duplicate),"stopped":false,"stop_status":"unconfirmed","state":s.wire()})
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
        "ClipboardRead" | "ClipboardWrite" => Module::Clipboard,
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
fn command_allowed_in(s: &State, v: &serde_json::Value) -> bool {
    if v.get("__module_generation").is_some() {
        let Ok(g) = serde_json::from_value::<Generation>(v["__module_generation"].clone()) else {
            return false;
        };
        if command_module(v["type"].as_str().unwrap_or("")) != Some(g.module) || !g.matches(s) {
            return false;
        }
    }
    let kind = v["type"].as_str().unwrap_or("");
    match command_module(kind) {
        Some(m) => s.enabled(m),
        // Explicit non-collecting protocol/config commands. Recall settings are
        // tunables only: capture still checks its independent local grant.
        None => matches!(
            kind,
            "ClipboardCancel"
                | "disable_module"
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
/// Runtime checks use the shared cache; WebSocket admission reads the store freshly.
pub fn command_allowed(v: &serde_json::Value) -> bool {
    with_cached(|s| command_allowed_in(s, v))
}
fn admit_command_in(s: &State, v: serde_json::Value) -> Option<serde_json::Value> {
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_recall_writer_preserves_pixels_identity_and_closes_secondary_regrant_race() {
        use crate::recall_context::{Context, Generations, Snapshot, Source};
        let mut state = State::default();
        state.local_set(Module::Recall, true).unwrap();
        state.local_set(Module::WindowActivity, true).unwrap();
        let recall = Generation::from_state(&state, Module::Recall);
        let metadata = Generations::from_state(&state);
        let sample = Snapshot {
            identity: "window".into(),
            app: "editor".into(),
            title: "private title".into(),
            source: Source::Hyprland,
            title_truncated: false,
        };
        let c = Context::around(
            Ok(sample.clone()),
            Ok(sample),
            std::time::Duration::ZERO,
            metadata,
        );
        let header =
            serde_json::json!({"uid":"stable-id","captured_at":"2026-10-04T01:02:03Z","context":c});
        let h = serde_json::to_vec(&header).unwrap();
        let mut payload = b"HST\0".to_vec();
        payload.extend_from_slice(&(h.len() as u32).to_le_bytes());
        payload.extend(h);
        payload.extend([7, 8, 9]);
        let queued = tag_recall_binary(payload.clone(), recall, metadata);
        let decode = |b: Vec<u8>| {
            let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
            (
                serde_json::from_slice::<serde_json::Value>(&b[8..8 + n]).unwrap(),
                b[8 + n..].to_vec(),
            )
        };
        let (before, _) = decode(prepare_binary_in(&queued, &state).unwrap());
        assert_eq!(before["context"]["window"]["title"], "private title");
        state.local_set(Module::WindowActivity, false).unwrap();
        state.local_set(Module::WindowActivity, true).unwrap();
        let (after, jpeg) = decode(prepare_binary_in(&queued, &state).unwrap());
        assert!(after["context"]["window"]["title"].is_null());
        assert_eq!(after["uid"], header["uid"]);
        assert_eq!(after["captured_at"], header["captured_at"]);
        assert_eq!(jpeg, vec![7, 8, 9]);
        // Missing secondary fence never grants metadata, even while module enabled.
        let (old, _) = decode(prepare_binary_in(&tag_binary(payload, recall), &state).unwrap());
        assert!(old["context"]["window"]["app"].is_null());
        state.local_set(Module::Recall, false).unwrap();
        state.local_set(Module::Recall, true).unwrap();
        assert!(prepare_binary_in(&queued, &state).is_none());
        assert!(prepare_binary_in(b"VGN1", &state).is_none());
    }
    #[test]
    fn lower_command_workers_cannot_adopt_regrants_or_wrong_modules() {
        for module in [
            Module::Terminal,
            Module::LiveScreen,
            Module::LiveAudio,
            Module::SoftwareInventory,
        ] {
            let mut old = State::default();
            old.local_set(module, true).unwrap();
            let g = Generation::from_state(&old, module).unwrap();
            with_test_store(&old, || {
                assert!(command_worker(g, module).is_ok());
                assert!(command_worker(g, Module::Files).is_err());
                transaction(
                    |s| {
                        s.local_set(module, false)?;
                        s.local_set(module, true)
                    },
                    true,
                )
                .unwrap();
                assert!(Generation::capture(module).is_some());
                assert!(command_worker(g, module).is_err());
                assert_eq!(active_workers(g), 0);
                // Final outputs still carry the admitted generation and are denied.
                let current = load().unwrap();
                assert!(!outbound_allowed_in(
                    &current,
                    &stamp(serde_json::json!({"type":"unclassified_result"}), Some(g))
                ));
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn actual_linux_helpers_reject_commands_rotated_after_admission_before_start() {
        let mut old = State::default();
        for module in [
            Module::Terminal,
            Module::LiveScreen,
            Module::SoftwareInventory,
        ] {
            old.local_set(module, true).unwrap();
        }
        with_test_store(&old, || {
            let binding = |kind: &str| {
                let admitted = admit_command(serde_json::json!({"type":kind})).unwrap();
                serde_json::from_value::<Generation>(admitted["__module_generation"].clone())
                    .unwrap()
            };
            let terminal = binding("TerminalStart");
            let screen = binding("start_capture");
            let inventory = binding("CollectSoftware");
            transaction(
                |s| {
                    for module in [
                        Module::Terminal,
                        Module::LiveScreen,
                        Module::SoftwareInventory,
                    ] {
                        s.local_set(module, false)?;
                        s.local_set(module, true)?;
                    }
                    Ok(())
                },
                true,
            )
            .unwrap();
            let (out, mut messages) = tokio::sync::mpsc::channel(8);
            let id = uuid::Uuid::new_v4();
            crate::platform::terminal::start(id, 80, 24, out.clone(), terminal);
            assert!(!crate::platform::linux::terminal::has_session_for_test(id));
            let (frames, mut pixels) = tokio::sync::mpsc::channel(8);
            let settings =
                crate::capture::CaptureSettings::from_server_command(&serde_json::json!({}));
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            assert!(crate::platform::desktop_capture::start_capture(
                frames.clone(),
                stop.clone(),
                settings,
                screen
            )
            .is_err());
            assert!(crate::capture::start_capture(frames, stop, settings, screen).is_err());
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(crate::platform::software_inventory::send_inventory(
                    out, inventory,
                ));
            assert!(messages.try_recv().is_err());
            assert!(pixels.try_recv().is_err());
            for g in [terminal, screen, inventory] {
                assert_eq!(active_workers(g), 0);
            }
        });
    }

    #[test]
    fn command_allowed_rejects_old_server_revision_after_regrant() {
        let mut s = State::default();
        s.local_set(Module::RemoteInput, true).unwrap();
        let old = Generation::from_state(&s, Module::RemoteInput).unwrap();
        let command = stamp(serde_json::json!({"type":"KeyChar", "char":"a"}), Some(old));
        assert!(command_allowed_in(&s, &command));
        assert_eq!(admit_command_in(&s, command.clone()), Some(command.clone()));
        s.local_set(Module::RemoteInput, false).unwrap();
        s.local_set(Module::RemoteInput, true).unwrap();
        assert!(!command_allowed_in(&s, &command));
        assert!(admit_command_in(&s, command).is_none());
        let current = Generation::from_state(&s, Module::RemoteInput).unwrap();
        let legacy = serde_json::json!({"type":"KeyChar", "char":"a"});
        let admitted = admit_command_in(&s, legacy.clone()).unwrap();
        assert_eq!(admitted, stamp(legacy, Some(current)));
        assert!(command_allowed_in(&s, &admitted));
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!({"module":"files","revision":current.revision}),
            serde_json::json!({"module":"unknown","revision":current.revision}),
        ] {
            let mut command = admitted.clone();
            command["__module_generation"] = invalid;
            assert!(!command_allowed_in(&s, &command));
            assert!(admit_command_in(&s, command).is_none());
        }
    }

    #[test]
    fn buffered_events_require_their_original_generation() {
        let mut s = State::default();
        s.local_set(Module::Files, true).unwrap();
        let g = Generation::from_state(&s, Module::Files).unwrap();
        let v = stamp(
            serde_json::json!({"type":"file_chunk","data":"old"}),
            Some(g),
        );
        assert!(outbound_allowed_in(&s, &v));
        assert!(!outbound_allowed_in(
            &s,
            &serde_json::json!({"type":"file_chunk"})
        ));
        s.local_set(Module::Files, false).unwrap();
        s.local_set(Module::Files, true).unwrap();
        assert!(!outbound_allowed_in(&s, &v));
        assert!(!outbound_allowed_in(
            &s,
            &serde_json::json!({"type":"batch","events":[v]})
        ));
        let wrong = stamp(
            serde_json::json!({"type":"terminal_output"}),
            Generation::from_state(&s, Module::Files),
        );
        assert!(!outbound_allowed_in(&s, &wrong));
    }
    #[test]
    fn old_generation_never_matches_after_regrant() {
        let mut s = State::default();
        s.local_set(Module::Scripts, true).unwrap();
        let old = Generation::from_state(&s, Module::Scripts).unwrap();
        s.local_set(Module::Scripts, false).unwrap();
        assert!(!old.matches(&s));
        s.local_set(Module::Scripts, true).unwrap();
        assert!(!old.matches(&s));
        let new = Generation::from_state(&s, Module::Scripts).unwrap();
        assert!(new.matches(&s));
        assert_ne!(old, new);
    }
    #[test]
    fn module_changes_do_not_cancel_other_generations() {
        let mut s = State::default();
        s.local_set(Module::Recall, true).unwrap();
        let g = Generation::from_state(&s, Module::Recall).unwrap();
        s.local_set(Module::Files, true).unwrap();
        assert!(g.matches(&s));
    }
    #[test]
    fn local_barrier_tracks_work_until_lease_drop() {
        let g = Generation {
            module: Module::LiveAudio,
            revision: 998877,
        };
        let a = WorkerLease::new(g);
        let b = WorkerLease::new(g);
        assert_eq!(active_workers(g), 2);
        drop(a);
        assert_eq!(active_workers(g), 1);
        drop(b);
        assert_eq!(active_workers(g), 0);
    }
    #[test]
    fn binary_fence_preserves_existing_payload() {
        let g = Generation {
            module: Module::LiveScreen,
            revision: 12,
        };
        let payload = vec![1, 2, 3];
        let b = tag_binary(payload.clone(), Some(g));
        assert_eq!(&b[..4], b"VGN1");
        let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
        assert_eq!(
            serde_json::from_slice::<Generation>(&b[8..8 + n]).unwrap(),
            g
        );
        assert_eq!(&b[8 + n..], payload);
    }
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
fn outbound_allowed_in(s: &State, v: &serde_json::Value) -> bool {
    #[cfg(target_os = "windows")]
    if v["type"] == "clipboard_result" && !crate::clipboard_session::console_current(v) {
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
            let module = if payload.starts_with(b"HST\0") {
                Module::Recall
            } else if payload.starts_with(b"AUD\0") {
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
/// may finish; script children use kill_on_drop in remote_script.
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
