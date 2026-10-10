//! Grant generations and the worker leases that make revocation a local stop
//! barrier.

use serde::{Deserialize, Serialize};

use super::modules::Module;
use super::store::{load, remote_disable, with_cached, State};

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
