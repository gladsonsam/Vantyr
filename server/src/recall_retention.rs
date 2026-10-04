//! Retryable Recall cleanup for one server process. Cooperating ingestion/read
//! paths share device gates; this is not a sandbox against local-admin path swaps
//! or a distributed lock for multiple server processes sharing the blob root.
use std::{
    fs::ReadDir,
    io,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::{NaiveDate, Utc};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, OwnedRwLockWriteGuard};
use uuid::Uuid;

use crate::{db, state::AppState};

const RUN_BUDGET: Duration = Duration::from_secs(30);
const IO_WAIT: Duration = Duration::from_secs(5);
const DB_WAIT: Duration = Duration::from_secs(5);
const GATE_WAIT: Duration = Duration::from_secs(2);
const SCAN_ENTRIES: usize = 512;
const CANDIDATES: usize = 32;

#[derive(Default)]
pub struct Coordinator {
    running: Arc<AsyncMutex<()>>,
    scan: Arc<Mutex<Scan>>,
}

#[derive(Default)]
struct Scan {
    agents: Option<ReadDir>,
    current: Option<(Uuid, PathBuf, ReadDir)>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub partitions_dropped: u64,
    pub scanned: usize,
    /// True only when this pass reached the end of the retained scan cursor.
    pub scan_complete: bool,
    /// Four drops can mean that additional old partitions remain for a later pass.
    pub partition_batch_full: bool,
    pub candidates: usize,
    pub removed: usize,
    pub protected: usize,
    pub skipped_running: bool,
    pub budget_exhausted: bool,
    pub failures: Vec<String>,
}

#[derive(Debug)]
struct Candidate {
    agent: Uuid,
    day: NaiveDate,
    path: PathBuf,
}

#[derive(Debug)]
struct Batch {
    complete: bool,
    candidates: Vec<Candidate>,
    scanned: usize,
    failures: Vec<String>,
}

/// Accepted jobs own their state and lock independently of their caller. Caller
/// cancellation cannot abandon the DB-check/removal critical section. The job
/// has bounded query/gate waits and a run deadline; non-abortable filesystem work
/// additionally retains its own job and device locks until it actually exits.
pub async fn prune(state: Arc<AppState>, days: i64) -> Result<Report> {
    anyhow::ensure!(days > 0, "Recall retention days must be positive");
    let duration = chrono::Duration::try_days(days).context("invalid Recall retention days")?;
    let cutoff = Utc::now()
        .checked_sub_signed(duration)
        .context("invalid Recall cutoff")?
        .date_naive();
    prune_at(state, cutoff).await
}

async fn prune_at(state: Arc<AppState>, cutoff: NaiveDate) -> Result<Report> {
    let Ok(job) = state.recall_retention.running.clone().try_lock_owned() else {
        let report = Report {
            skipped_running: true,
            ..Report::default()
        };
        tracing::debug!(
            skipped_running = report.skipped_running,
            "Recall retention pass skipped; another job still owns its locks"
        );
        return Ok(report);
    };
    let job = Arc::new(job);
    tokio::spawn(async move { run(state, cutoff, job).await }).await?
}

async fn run(
    state: Arc<AppState>,
    cutoff: NaiveDate,
    job: Arc<OwnedMutexGuard<()>>,
) -> Result<Report> {
    let deadline = tokio::time::Instant::now() + RUN_BUDGET;
    let mut report = Report::default();
    match tokio::time::timeout(
        Duration::from_secs(12),
        db::prune_screen_history_partitions(&state.db, cutoff),
    )
    .await
    {
        Ok(Ok(dropped)) => {
            report.partitions_dropped = dropped;
            report.partition_batch_full = dropped == 4;
        }
        Ok(Err(error)) => report.failures.push(format!("partition prune: {error}")),
        Err(_) => report.failures.push("partition prune timed out".into()),
    }
    match tokio::time::timeout(DB_WAIT, db::prune_narrative_before(&state.db, cutoff)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => report.failures.push(format!("narrative prune: {error}")),
        Err(_) => report.failures.push("narrative prune timed out".into()),
    }
    let root = state.screen_history_dir.clone();
    let scan = state.recall_retention.scan.clone();
    let scan_job = job.clone();
    let scan_worker = tokio::task::spawn_blocking(move || {
        let _job = scan_job;
        scan.lock()
            .map_err(|_| io::Error::other("Recall scan lock poisoned"))?
            .batch(&root, cutoff)
    });
    let batch = match tokio::time::timeout_at(
        deadline.min(tokio::time::Instant::now() + IO_WAIT),
        scan_worker,
    )
    .await
    {
        Ok(Ok(Ok(batch))) => batch,
        other => {
            report
                .failures
                .push(format!("blob directory scan failed: {other:?}"));
            return finish(report);
        }
    };
    report.scanned = batch.scanned;
    report.scan_complete = batch.complete;
    report.candidates = batch.candidates.len();
    report.failures.extend(batch.failures);
    for candidate in batch.candidates {
        if tokio::time::Instant::now() >= deadline {
            report.budget_exhausted = true;
            break;
        }
        let gate = state.agent_lifecycle.for_agent(candidate.agent);
        let lease = match tokio::time::timeout_at(
            deadline.min(tokio::time::Instant::now() + GATE_WAIT),
            gate.write_owned(),
        )
        .await
        {
            Ok(lease) => lease,
            Err(_) => {
                report
                    .failures
                    .push(format!("device {} gate timed out", candidate.agent));
                continue;
            }
        };
        let indexed = tokio::time::timeout_at(
            deadline.min(tokio::time::Instant::now() + DB_WAIT),
            db::screen_history_day_is_indexed(&state.db, candidate.agent, candidate.day),
        )
        .await;
        match indexed {
            Ok(Ok(true)) => {
                report.protected += 1;
                continue;
            }
            Ok(Ok(false)) => {}
            other => {
                report.failures.push(format!(
                    "reference check for {} failed: {other:?}",
                    candidate.path.display()
                ));
                continue;
            }
        }
        let root = state.screen_history_dir.clone();
        let path = candidate.path.clone();
        let worker = removal_worker(job.clone(), lease, move || remove_day(&root, &path));
        match tokio::time::timeout_at(deadline.min(tokio::time::Instant::now() + IO_WAIT), worker)
            .await
        {
            Ok(Ok(Ok(()))) => report.removed += 1,
            other => report.failures.push(format!(
                "removal of {} failed: {other:?}",
                candidate.path.display()
            )),
        }
    }
    finish(report)
}

fn finish(report: Report) -> Result<Report> {
    if report.failures.is_empty() {
        tracing::info!(?report, "Recall retention bounded pass completed");
        Ok(report)
    } else {
        tracing::warn!(
            ?report,
            "Recall retention incomplete; remaining directories retry on later passes"
        );
        anyhow::bail!("Recall retention incomplete: {report:?}")
    }
}

fn removal_worker<T: Send + 'static>(
    job: Arc<OwnedMutexGuard<()>>,
    lease: OwnedRwLockWriteGuard<()>,
    work: impl FnOnce() -> T + Send + 'static,
) -> tokio::task::JoinHandle<T> {
    tokio::task::spawn_blocking(move || {
        let _job = job;
        let _lease = lease;
        work()
    })
}

fn day_name(value: &str) -> Option<NaiveDate> {
    if value.len() != 8 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let day = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
    (day.format("%Y%m%d").to_string() == value).then_some(day)
}

/// Validate every configured-root ancestor as well as root/UUID/day. We reject
/// parent traversal and static symlinks before enumeration and again before
/// removal. Concurrent external replacement requires OS-level isolation.
fn checked_directory(path: &Path) -> io::Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(io::Error::other("Recall path has parent traversal"))
            }
            _ => current.push(component),
        }
        let meta = std::fs::symlink_metadata(&current)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(io::Error::other("unsafe Recall directory"));
        }
    }
    Ok(())
}

fn remove_day(root: &Path, path: &Path) -> io::Result<()> {
    checked_directory(root)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io::Error::other("invalid Recall day path"))?;
    let parts: Vec<_> = relative.components().collect();
    if parts.len() != 2 || parts.iter().any(|p| !matches!(p, Component::Normal(_))) {
        return Err(io::Error::other("invalid Recall day path"));
    }
    let owner = parts[0]
        .as_os_str()
        .to_str()
        .ok_or_else(|| io::Error::other("invalid device"))?;
    let agent = Uuid::parse_str(owner).map_err(io::Error::other)?;
    if owner != agent.to_string() || day_name(parts[1].as_os_str().to_str().unwrap_or("")).is_none()
    {
        return Err(io::Error::other("invalid Recall day path"));
    }
    checked_directory(path)?;
    std::fs::remove_dir_all(path)
}

impl Scan {
    fn batch(&mut self, root: &Path, cutoff: NaiveDate) -> io::Result<Batch> {
        if let Err(error) = checked_directory(root) {
            self.agents = None;
            self.current = None;
            return Err(error);
        }
        if self.agents.is_none() {
            self.agents = Some(std::fs::read_dir(root)?);
        }
        let mut batch = Batch {
            complete: false,
            candidates: Vec::new(),
            scanned: 0,
            failures: Vec::new(),
        };
        while batch.scanned < SCAN_ENTRIES && batch.candidates.len() < CANDIDATES {
            if let Some((agent, path, days)) = self.current.as_mut() {
                if let Err(error) = checked_directory(path) {
                    batch
                        .failures
                        .push(format!("device directory {}: {error}", path.display()));
                    self.current = None;
                    continue;
                }
                match days.next() {
                    Some(Ok(entry)) => {
                        batch.scanned += 1;
                        let Some(day) = entry.file_name().to_str().and_then(day_name) else {
                            continue;
                        };
                        if day >= cutoff {
                            continue;
                        }
                        match checked_directory(&entry.path()) {
                            Ok(()) => batch.candidates.push(Candidate {
                                agent: *agent,
                                day,
                                path: entry.path(),
                            }),
                            Err(error) => batch
                                .failures
                                .push(format!("day directory {}: {error}", entry.path().display())),
                        }
                    }
                    Some(Err(error)) => {
                        batch.scanned += 1;
                        batch.failures.push(format!("day enumeration: {error}"));
                    }
                    None => self.current = None,
                }
            } else {
                match self.agents.as_mut().unwrap().next() {
                    Some(Ok(entry)) => {
                        batch.scanned += 1;
                        let name = entry.file_name();
                        let Some(owner) = name.to_str() else {
                            continue;
                        };
                        let Ok(agent) = Uuid::parse_str(owner) else {
                            continue;
                        };
                        if agent.to_string() != owner {
                            continue;
                        }
                        let path = entry.path();
                        let days = checked_directory(&path).and_then(|()| std::fs::read_dir(&path));
                        match days {
                            Ok(days) => self.current = Some((agent, path, days)),
                            Err(error) => batch
                                .failures
                                .push(format!("device directory {}: {error}", path.display())),
                        }
                    }
                    Some(Err(error)) => {
                        batch.scanned += 1;
                        batch.failures.push(format!("device enumeration: {error}"));
                    }
                    None => {
                        self.agents = None;
                        batch.complete = true;
                        break;
                    }
                }
            }
        }
        Ok(batch)
    }
}

#[cfg(test)]
#[path = "recall_retention_tests.rs"]
mod tests;
