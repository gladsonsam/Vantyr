//! The on-disk grant store: [`State`], locked read/write transactions and the
//! short-lived in-process cache.

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::OpenOptions, path::PathBuf};

use super::modules::{Module, MODULES};

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
    pub(super) receipts: BTreeMap<String, Receipt>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Receipt {
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
pub(super) fn read(p: &std::path::Path) -> anyhow::Result<State> {
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
pub(super) fn transaction<T>(
    f: impl FnOnce(&mut State) -> anyhow::Result<T>,
    write: bool,
) -> anyhow::Result<(State, T)> {
    transaction_at(&path(), f, write)
}
pub(super) fn transaction_at<T>(
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
    m != Module::Clipboard || crate::input::clipboard::available()
}
pub(super) fn with_cached<T>(f: impl FnOnce(&State) -> T) -> T {
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
