//! App blocking enforcement.
//!
//! The server pushes a list of `BlockRule`s via `set_app_block_rules`.
//! `run_enforcer` loops every 2 seconds, kills matching processes, and
//! reports each kill back to the server via a channel that the agent loop drains
//! and forwards over the WebSocket.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::{StoredBlockRule, StoredScheduleWindow};
use crate::policy::schedule;

// Process enumeration and termination are the only OS-specific parts.
#[cfg(not(windows))]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
use self::linux::scan_and_kill_matching_processes;
#[cfg(windows)]
use self::windows::scan_and_kill_matching_processes;

// ── Rule types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Exact,
    Contains,
}

impl MatchMode {
    fn from_str(s: &str) -> Self {
        if s == "exact" {
            Self::Exact
        } else {
            Self::Contains
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRule {
    pub id: i64,
    pub exe_pattern: String,
    pub match_mode: MatchMode,
    #[serde(default)]
    pub schedules: Vec<StoredScheduleWindow>,
}

impl BlockRule {
    pub fn from_stored(s: &StoredBlockRule) -> Self {
        Self {
            id: s.id,
            exe_pattern: s.exe_pattern.clone(),
            match_mode: MatchMode::from_str(&s.match_mode),
            schedules: s.schedules.clone(),
        }
    }

    pub fn to_stored(&self) -> StoredBlockRule {
        StoredBlockRule {
            id: self.id,
            exe_pattern: self.exe_pattern.clone(),
            match_mode: match self.match_mode {
                MatchMode::Exact => "exact".into(),
                MatchMode::Contains => "contains".into(),
            },
            schedules: self.schedules.clone(),
        }
    }

    fn matches(&self, exe: &str) -> bool {
        let exe_lower = exe.to_lowercase();
        let pat = self.exe_pattern.to_lowercase();
        match self.match_mode {
            MatchMode::Exact => exe_lower == pat,
            MatchMode::Contains => exe_lower.contains(pat.as_str()),
        }
    }
}

// ── Kill event reported back to server ───────────────────────────────────────

#[derive(Debug, Clone)]
pub struct KillEvent {
    pub generation: crate::permissions::Generation,
    pub rule_id: i64,
    pub rule_name: String,
    pub exe_name: String,
}

// ── Shared state ──────────────────────────────────────────────────────────────

pub type SharedRules = Arc<Mutex<Vec<BlockRule>>>;

/// Holds the sender side of the kill-report channel; set/cleared each session.
pub type KillReportTx = Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<KillEvent>>>>;

pub fn new_shared_rules() -> SharedRules {
    Arc::new(Mutex::new(Vec::new()))
}

pub fn new_kill_report_tx() -> KillReportTx {
    Arc::new(Mutex::new(None))
}

// ── Enforcer loop ─────────────────────────────────────────────────────────────

pub async fn run_enforcer(rules: SharedRules, kill_tx: KillReportTx) {
    let mut poll = tokio::time::interval(Duration::from_secs(2));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        poll.tick().await;
        if !crate::permissions::allowed(crate::permissions::Module::AppPolicy) {
            continue;
        }
        let Some(generation) =
            crate::permissions::Generation::capture(crate::permissions::Module::AppPolicy)
        else {
            continue;
        };
        let _lease = crate::permissions::WorkerLease::new(generation);
        let active: Vec<BlockRule> = {
            let lock = rules.lock().unwrap_or_else(|e| e.into_inner());
            if lock.is_empty() {
                continue;
            }
            lock.iter()
                .filter(|r| schedule::is_active_now_local(&r.schedules))
                .cloned()
                .collect()
        };
        if active.is_empty() {
            continue;
        }
        let kills = scan_and_kill_matching_processes(&active, generation);
        if !kills.is_empty() {
            if let Some(tx) = kill_tx.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                for ev in kills {
                    let _ = tx.send(ev);
                }
            }
        }
    }
}
